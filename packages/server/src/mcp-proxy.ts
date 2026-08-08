import * as http from 'node:http';
import * as net from 'node:net';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOOPBACK_HOST, MCP_SSE_PATH, ReticleDir } from '@reticlehq/core';
import { log } from './log.js';

/**
 * Max messages queued while waiting for the SSE endpoint event. Under normal operation 1-2 land here;
 * a runaway client or a zombie connection accumulating traffic is capped and the excess is logged+dropped.
 */
export const STDIN_QUEUE_CAP = 100;

/** How long after an SSE connection is established to wait for the endpoint event before reconnecting. */
export const ENDPOINT_TIMEOUT_MS = 5_000;

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 10_000;
/**
 * How long to wait for the spawned daemon's port to accept connections before giving up. The default
 * suits a normal machine; a slow CI/VM (heavy headless-browser launch) can raise it via the
 * RETICLE_DAEMON_READY_TIMEOUT_MS env var. Invalid/absent values fall back to the default.
 */
const envDaemonReadyTimeoutMs = Number(process.env['RETICLE_DAEMON_READY_TIMEOUT_MS']);
const DAEMON_READY_TIMEOUT_MS =
  Number.isFinite(envDaemonReadyTimeoutMs) && envDaemonReadyTimeoutMs > 0
    ? envDaemonReadyTimeoutMs
    : DEFAULT_DAEMON_READY_TIMEOUT_MS;
const DAEMON_POLL_INTERVAL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reconnect backoff: linear, capped, so a briefly-restarting daemon is picked up fast. */
const RECONNECT_BASE_MS = 250;
const RECONNECT_CAP_MS = 5_000;
/**
 * How many consecutive failed reconnects before the proxy gives up and exits. At the capped backoff
 * this is a few minutes — long enough to ride out a daemon restart, short enough that a genuinely
 * dead daemon lets the agent host respawn the proxy (which spawns a fresh daemon) instead of hanging.
 */
export const MAX_RECONNECT_ATTEMPTS = 60;

export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_CAP_MS);
}

/** JSON-RPC id the proxy uses for its own replayed `initialize` — never one the client could send. */
export const RECONNECT_INITIALIZE_ID = '__reticle_proxy_reinit';

/** The proxy's own log file, so a silent drop leaves a readable trace the agent can go read. */
export function proxyLogPath(): string {
  return join(homedir(), ReticleDir.ROOT, 'mcp-proxy.log');
}

/**
 * Log to stderr (which the agent host usually swallows) AND to ~/.reticle/mcp-proxy.log, which it
 * does not. A dropped MCP connection is invisible from the agent's side — no message, no exit code —
 * so the one thing that makes it diagnosable at all is a file somebody can read afterwards.
 */
function proxyLog(event: string, fields: Record<string, unknown> = {}): void {
  log(event, fields);
  try {
    const dir = join(homedir(), ReticleDir.ROOT);
    mkdirSync(dir, { recursive: true });
    appendFileSync(proxyLogPath(), `${JSON.stringify({ event, ...fields })}\n`, 'utf8');
  } catch {
    // Logging must never be the thing that kills the proxy.
  }
}

interface JsonRpcLike {
  id?: unknown;
  method?: unknown;
}

function parseJsonRpc(line: string): JsonRpcLike | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const INITIALIZE_METHOD = 'initialize';
const INITIALIZED_METHOD = 'notifications/initialized';

/**
 * Makes a reconnect invisible to the client.
 *
 * The daemon builds a FRESH `McpServer` per SSE connection, so a reconnected session has never seen
 * the client's `initialize` — every subsequent `tools/call` would hit an uninitialized server. The
 * proxy therefore remembers the handshake the client sent once and replays it into each new session.
 * The replay is re-issued under a reserved id so the daemon's response to it can be dropped rather
 * than reaching the client's stdout, where a duplicate JSON-RPC id would be a protocol violation.
 */
export class HandshakeReplay {
  #initialize: string | null = null;
  #initialized: string | null = null;
  #pendingReplayId: string | null = null;

  /** Record one outbound client line. Cheap enough to call for every stdin message. */
  observeOutbound(line: string): void {
    const msg = parseJsonRpc(line);
    if (msg === null) return;
    // The first initialize is the session's identity; a client re-issuing one does not change it.
    if (msg.method === INITIALIZE_METHOD && this.#initialize === null) this.#initialize = line;
    else if (msg.method === INITIALIZED_METHOD) this.#initialized = line;
  }

  /** Lines to POST into a freshly-established session, before any queued client traffic. */
  replayLines(): string[] {
    if (this.#initialize === null) return [];
    const msg = parseJsonRpc(this.#initialize);
    if (msg === null) return [];
    this.#pendingReplayId = RECONNECT_INITIALIZE_ID;
    const reinit = { ...msg, id: RECONNECT_INITIALIZE_ID };
    return this.#initialized === null
      ? [JSON.stringify(reinit)]
      : [JSON.stringify(reinit), this.#initialized];
  }

  /** True when this inbound daemon line is the echo of our replayed handshake and must not be forwarded. */
  shouldSuppressInbound(line: string): boolean {
    if (this.#pendingReplayId === null) return false;
    const msg = parseJsonRpc(line);
    if (msg === null || msg.id !== this.#pendingReplayId) return false;
    this.#pendingReplayId = null; // one response per replay — anything later is not ours to swallow
    return true;
  }
}

/** One parsed Server-Sent-Events frame: the event name (defaulted to "message") and its data. */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Incremental SSE frame parser for the MCP front door.
 *
 * A single SSE field can split across TCP reads (`da` in one chunk, `ta: {...}` in the next), and a
 * server may send CRLF or bare CR line endings — so the framing is stateful and edge-case-prone, yet it
 * carried every MCP message the agent sends and was only ever exercised end-to-end. Pulled out of the
 * socket handler as a pure, chunk-fed parser so those boundaries are unit-testable: feed raw chunks,
 * get back each complete frame (a blank line terminates a frame; `event:` names it, `data:` lines
 * accumulate newline-joined; `id:`/`retry:`/comments are ignored — not needed for the bridge).
 */
export class SseFrameParser {
  #buffer = '';
  #event = '';
  #data = '';

  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    // Normalise CRLF/CR so the splitter only handles \n, then hold the trailing partial line for the
    // next chunk (it may complete later).
    const normalised = this.#buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalised.split('\n');
    this.#buffer = lines.pop() ?? '';
    const frames: SseFrame[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.#data !== '') {
          frames.push({ event: this.#event !== '' ? this.#event : 'message', data: this.#data });
        }
        this.#event = '';
        this.#data = '';
      } else if (line.startsWith('event:')) {
        this.#event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const val = line.slice(5).trim();
        this.#data = this.#data !== '' ? `${this.#data}\n${val}` : val;
      }
    }
    return frames;
  }
}

/**
 * Returns true if something is already listening on the reticle port.
 * Uses a plain TCP probe so we don't create a side-effectful SSE session
 * inside the daemon just to check reachability.
 */
export function probeDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, LOOPBACK_HOST);
  });
}

/** Poll until the daemon's HTTP port accepts connections or the deadline is reached. */
export async function waitForDaemon(port: number): Promise<void> {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reachable = await probeDaemon(port);
    if (reachable) return;
    await delay(DAEMON_POLL_INTERVAL_MS);
  }
  throw new Error(
    `reticle daemon did not become ready on port ${port} within ${DAEMON_READY_TIMEOUT_MS}ms`,
  );
}

function postToSession(url: string, body: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const parsed = new URL(url);
    const bodyBuf = Buffer.from(body, 'utf8');
    const options: http.RequestOptions = {
      host: parsed.hostname,
      port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.byteLength,
      },
    };
    const req = http.request(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        // A non-2xx from the daemon MCP endpoint used to be swallowed, hanging the JSON-RPC call
        // client-side with no diagnostic. Surface it (the forward is still fire-and-forget).
        log('reticle_mcp_proxy_post_non2xx', { status, path: options.path });
      }
      res.resume(); // drain so the socket is reused
      resolve();
    });
    req.on('error', (err) => {
      log('reticle_mcp_proxy_post_error', { error: err.message });
      resolve();
    });
    req.write(bodyBuf);
    req.end();
  });
}

export function buildSessionUrl(rawData: string, port: number): string {
  return rawData.startsWith('/') ? `http://${LOOPBACK_HOST}:${port}${rawData}` : rawData;
}

/**
 * Bridge stdio ↔ SSE: connects to the running daemon's MCP endpoint and forwards
 * Claude Code's stdin/stdout JSON-RPC through it. Never resolves — runs until stdin closes.
 *
 * A dropped SSE stream used to exit the process, which is what made the agent's `reticle_*` tools
 * vanish mid-session with no message and no way for the agent to get them back — only a human running
 * `/mcp` could. The daemon demonstrably stays up across these drops, so the stream ending is a
 * transport event, not a shutdown: reconnect to it and replay the handshake instead of dying.
 */
export function startMcpProxy(port: number): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    let postUrl: string | null = null;
    const stdinQueue: string[] = [];
    const replay = new HandshakeReplay();
    let stopped = false;
    let attempts = 0;

    let endpointTimer: ReturnType<typeof setTimeout> | undefined;

    function onSseEvent(event: string, data: string, p: number): void {
      if (event === 'endpoint') {
        if (endpointTimer !== undefined) {
          clearTimeout(endpointTimer);
          endpointTimer = undefined;
        }
        const trimmed = data.trim();
        if (trimmed === '') {
          proxyLog('reticle_mcp_proxy_empty_endpoint', { port });
          return;
        }
        const url = buildSessionUrl(trimmed, p);
        postUrl = url;
        // The new session's McpServer has never seen the client's initialize — replay it first, then
        // flush whatever the client sent while we were reconnecting.
        for (const line of replay.replayLines()) void postToSession(url, line);
        for (const queued of stdinQueue.splice(0)) void postToSession(url, queued);
        return;
      }
      if (event === 'message' && !replay.shouldSuppressInbound(data)) {
        process.stdout.write(`${data}\n`);
      }
    }

    function scheduleReconnect(reason: string, detail?: string): void {
      if (stopped) return;
      postUrl = null;
      if (endpointTimer !== undefined) {
        clearTimeout(endpointTimer);
        endpointTimer = undefined;
      }
      attempts++;
      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        proxyLog('reticle_mcp_proxy_gave_up', {
          port,
          reason,
          attempts,
          ...(detail !== undefined ? { detail } : {}),
        });
        process.exit(1);
      }
      const wait = reconnectDelayMs(attempts);
      proxyLog('reticle_mcp_proxy_reconnecting', {
        port,
        reason,
        attempt: attempts,
        retryInMs: wait,
        ...(detail !== undefined ? { detail } : {}),
      });
      setTimeout(() => connect(false), wait).unref();
    }

    function connect(first: boolean): void {
      endpointTimer = setTimeout(() => {
        proxyLog('reticle_mcp_proxy_endpoint_timeout', { port, timeoutMs: ENDPOINT_TIMEOUT_MS });
        scheduleReconnect('endpoint_timeout');
      }, ENDPOINT_TIMEOUT_MS);
      endpointTimer.unref();

      const req = http.get({ host: LOOPBACK_HOST, port, path: MCP_SSE_PATH }, (res) => {
        attempts = 0; // a stream we actually established resets the budget
        if (!first) proxyLog('reticle_mcp_proxy_reconnected', { port });
        res.setEncoding('utf8');
        // `end` and `error` can both fire on one response; only the first should drive a reconnect.
        let settled = false;
        const drop = (reason: string, detail?: string): void => {
          if (settled) return;
          settled = true;
          if (endpointTimer !== undefined) {
            clearTimeout(endpointTimer);
            endpointTimer = undefined;
          }
          scheduleReconnect(reason, detail);
        };
        const sse = new SseFrameParser();
        res.on('data', (chunk: string) => {
          for (const frame of sse.push(chunk)) onSseEvent(frame.event, frame.data, port);
        });
        res.on('end', () => drop('sse_ended'));
        res.on('error', (err) => drop('sse_error', err.message));
        // A socket dying under us (daemon killed, network stack reset) emits NEITHER `end` nor
        // `error` — only `aborted`/`close`. Listening for just the first two is why the proxy sat
        // there afterwards holding a dead stream. `settled` keeps the clean case single-fire.
        res.on('aborted', () => drop('sse_aborted'));
        res.on('close', () => drop('sse_closed'));
      });

      // The very first connect failing means there is no daemon to talk to — that is a startup
      // failure the caller handles. Later ones are just the daemon bouncing: keep retrying.
      req.on('error', (err) => (first ? reject(err) : scheduleReconnect('connect_error', err.message)));
    }

    connect(true);

    // ── stdin reader ─────────────────────────────────────────────────────────
    process.stdin.setEncoding('utf8');
    let stdinBuffer = '';

    process.stdin.on('data', (chunk: string) => {
      stdinBuffer += chunk;
      const lines = stdinBuffer.split('\n');
      stdinBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        replay.observeOutbound(trimmed);
        if (postUrl === null) {
          if (stdinQueue.length >= STDIN_QUEUE_CAP) {
            proxyLog('reticle_mcp_proxy_stdin_queue_overflow', {
              port,
              dropped: stdinQueue.length - STDIN_QUEUE_CAP + 1,
            });
            stdinQueue.shift();
          }
          stdinQueue.push(trimmed);
        } else {
          void postToSession(postUrl, trimmed);
        }
      }
    });

    // The client going away is the one clean shutdown — stop reconnecting and exit.
    process.stdin.on('end', () => {
      stopped = true;
      process.exit(0);
    });
  });
}
