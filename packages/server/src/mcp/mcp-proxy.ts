import * as http from 'node:http';
import { localInitializeResponse, isHandshakeLine } from './proxy-handshake.js';
import { ToolCatalogCache } from './tool-catalog-cache.js';
import * as net from 'node:net';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LOOPBACK_HOST,
  MCP_SSE_PATH,
  ReticleDir,
  ReticleEnv,
  CONTRACT_FINGERPRINT,
} from '@reticlehq/core';
import { SERVER_VERSION } from '../version/server-version.js';
import { PEER_VERSION_PARAM, PEER_CONTRACT_PARAM } from '../version/peer-announce.js';
import {
  onStreamDrop,
  onClientRequest,
  onReconnectBudgetSpent,
  onQueueExpired,
  OnDrop,
  OnRequest,
} from './proxy-lifecycle.js';
import { log } from '../log.js';
import { OutageStage, reportMcpOutage } from './mcp-outage.js';

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
 * How many consecutive failed reconnects before the proxy stops RETRYING. It does not stop serving:
 * the budget ends the retry loop and the proxy goes dormant, where the handshake and `tools/list`
 * are still answered and the next client request starts a daemon. See onReconnectBudgetSpent.
 *
 * At the capped backoff this is a few minutes — long enough to ride out a daemon restart without
 * spinning on a port that is wedged or held by a foreign process.
 */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 60;
/**
 * Overridable so the survival spec can reach exhaustion in seconds instead of minutes — the same
 * reason the idle windows take an env override. A positive integer only; anything else falls back,
 * so a typo cannot silently disable the retry loop.
 */
export const MAX_RECONNECT_ATTEMPTS = ((): number => {
  const raw = Number(process.env[ReticleEnv.RECONNECT_ATTEMPTS]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_RECONNECT_ATTEMPTS;
})();

export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_CAP_MS);
}

/** JSON-RPC id the proxy uses for its own replayed `initialize` — never one the client could send. */
export const RECONNECT_INITIALIZE_ID = '__reticle_proxy_reinit';

/**
 * Which port this proxy serves, for the log file name. Set once at startup.
 *
 * One file per port, matching `daemon-<port>.log`. A single shared file interleaved every proxy on
 * the machine into one stream, so the first question anyone asks of it — "what happened to MY
 * session?" — needed a filter before it could be answered.
 */
let logPort: number | undefined;

/** Name the proxy log after the port it serves. Called before anything can log. */
export function setProxyLogPort(port: number): void {
  logPort = port;
}

/** The proxy's own log file, so a silent drop leaves a readable trace the agent can go read. */
export function proxyLogPath(port: number | undefined = logPort): string {
  const name = port === undefined ? 'mcp-proxy.log' : `proxy-${String(port)}.log`;
  return join(homedir(), ReticleDir.ROOT, name);
}

/**
 * Log to stderr (which the agent host usually swallows) AND to ~/.reticle/proxy-<port>.log, which it
 * does not. A dropped MCP connection is invisible from the agent's side — no message, no exit code —
 * so the one thing that makes it diagnosable at all is a file somebody can read afterwards.
 *
 * EXPORTED because the crash handlers need it. `installProxyResilience` was wired to the bare stderr
 * logger, so the proxy's own uncaught exceptions and unhandled rejections — the exact events that
 * present to a human as "the MCP server disconnected" — were written to a stream the editor throws
 * away. The handler ran, the process kept serving, and the reason went nowhere. Reported as "the
 * proxy has no log file… when it dies the diagnostic dies with it", which was half right: the file
 * existed, and the one path that most needed it was not using it.
 */
export function proxyLog(event: string, fields: Record<string, unknown> = {}): void {
  log(event, fields);
  try {
    const dir = join(homedir(), ReticleDir.ROOT);
    mkdirSync(dir, { recursive: true });
    // WITH A TIMESTAMP. This file is the only record of an outage that survives the session, and
    // without one it cannot answer the two questions anyone brings to it: when did this happen, and
    // how often. A real 3,283-line log on a dev machine held a `gave_up` — the exact event that used
    // to precede `process.exit(1)` and cost the human a manual /mcp reconnect — and it was
    // impossible to tell whether it happened during that person's work or a test run hours earlier.
    // Evidence you cannot place in time is an anecdote.
    appendFileSync(
      proxyLogPath(),
      `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`,
      'utf8',
    );
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
    return 'object' === typeof parsed && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const INITIALIZE_METHOD = 'initialize';
/**
 * How long the handshake waits on the daemon before the proxy answers it.
 *
 * Long enough for a cold daemon start (which is seconds), short enough that a client does not sit
 * there. Measured failure: a listener that accepts and never serves SSE left `initialize` unanswered
 * past 25s with nothing on stderr, and the reported client gave up at 60s having run no tools.
 */
const LOCAL_HANDSHAKE_MS = 12_000;
const INITIALIZED_METHOD = 'notifications/initialized';

/**
 * JSON-RPC requests forwarded on behalf of the client that have not been answered yet.
 *
 * Only used at shutdown, where it is the difference between "the client closed stdin" and "the client
 * closed stdin and we dropped its `tools/list` on the floor while reporting exit 0". A request has an
 * id AND a method; a notification has no id and is owed nothing; a response has an id and no method.
 */
export class PendingRequests {
  #ids = new Set<string>();

  observeOutbound(line: string): void {
    const msg = parseJsonRpc(line);
    if (null === msg || msg.id === undefined || msg.method === undefined) return;
    this.#ids.add(JSON.stringify(msg.id));
  }

  observeInbound(line: string): void {
    const msg = parseJsonRpc(line);
    if (null === msg || msg.id === undefined) return;
    this.#ids.delete(JSON.stringify(msg.id));
  }

  get unanswered(): string[] {
    return [...this.#ids];
  }

  /**
   * Claim ONE unanswered id, so exactly one path may answer it. False means somebody already did —
   * a duplicate response to one id is a protocol violation, not a belt-and-braces retry.
   */
  take(id: unknown): boolean {
    return this.#ids.delete(JSON.stringify(id));
  }

  /** Take every unanswered id and forget them, so the same request is failed at most once. */
  drain(): string[] {
    const ids = [...this.#ids];
    this.#ids.clear();
    return ids;
  }
}

/**
 * JSON-RPC errors for every request that was in flight when the stream died.
 *
 * These are unrecoverable BY CONSTRUCTION: the daemon builds a fresh MCP session per SSE
 * connection, so the reconnected session has never seen them. Re-sending them is not an option
 * either — a `reticle_act` that already clicked would click twice, and inventing a second action in
 * somebody's app is worse than reporting a failure.
 *
 * So the proxy answers them itself, under each request's own id. Found by brute force: killing the
 * daemon under a live client left 20 of 20 concurrent calls hanging until the client's own timeout,
 * with the MCP server still perfectly alive. An agent cannot tell that apart from "still working".
 */
export function streamLossReplies(pending: PendingRequests, reason: string): string[] {
  return pending.drain().map((id) => transportLossReply(JSON.parse(id) as unknown, reason));
}

/**
 * -32001: a server-defined error. Not -32603 (internal): nothing went wrong INSIDE the call, the
 * transport under it went away, and the distinction is what tells a caller the action may be safe
 * to retry.
 */
const TRANSPORT_LOSS_CODE = -32001;

/** The one shape every "the transport ate your call" answer takes, whichever leg died. */
export function transportLossReply(id: unknown, reason: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: TRANSPORT_LOSS_CODE,
      message:
        `the daemon connection dropped (${reason}) before this call was answered — it did NOT ` +
        'complete. Reticle is recovering the connection; retry if the action is safe to repeat.',
    },
  });
}

/**
 * How long stdin closing gives the daemon to answer what is still in flight.
 *
 * A client can write its whole conversation and close in one flush; the daemon is a socket away and
 * answers in milliseconds, so this is generous. Overshooting only delays an exit that is already
 * ending the process.
 */
const SHUTDOWN_DRAIN_MS = 5_000;
/**
 * How long a request may sit in the queue, unsent, before the proxy answers it itself.
 *
 * The second population the stress test found. A request that was FORWARDED and lost is failed when
 * the stream drops; one that never got forwarded — queued while dormant or reconnecting — was
 * waiting for a session that, with a squatter holding the port, never arrives. It then hung until
 * the client's own timeout, or forever if the client has none.
 *
 * Comfortably longer than a daemon restart (~1-2s) so a normal blip still flushes and succeeds, and
 * well under the 60s an MCP client typically allows, so the answer comes from us with a reason
 * rather than from their timer with none.
 */
const QUEUE_WAIT_MS = 20_000;
const SHUTDOWN_DRAIN_POLL_MS = 25;

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
    if (null === msg) return;
    // The first initialize is the session's identity; a client re-issuing one does not change it.
    if (msg.method === INITIALIZE_METHOD && null === this.#initialize) this.#initialize = line;
    else if (msg.method === INITIALIZED_METHOD) this.#initialized = line;
  }

  /** Lines to POST into a freshly-established session, before any queued client traffic. */
  replayLines(): string[] {
    if (null === this.#initialize) return [];
    const msg = parseJsonRpc(this.#initialize);
    if (null === msg) return [];
    this.#pendingReplayId = RECONNECT_INITIALIZE_ID;
    const reinit = { ...msg, id: RECONNECT_INITIALIZE_ID };
    return null === this.#initialized
      ? [JSON.stringify(reinit)]
      : [JSON.stringify(reinit), this.#initialized];
  }

  /** True when this inbound daemon line is the echo of our replayed handshake and must not be forwarded. */
  shouldSuppressInbound(line: string): boolean {
    if (null === this.#pendingReplayId) return false;
    const msg = parseJsonRpc(line);
    if (null === msg || msg.id !== this.#pendingReplayId) return false;
    this.#pendingReplayId = null; // one response per replay — anything later is not ours to swallow
    return true;
  }
}

/** One parsed Server-Sent-Events frame: the event name (defaulted to "message") and its data. */
interface SseFrame {
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
      if ('' === line) {
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

/**
 * POST one JSON-RPC line into the daemon's session. Resolves null on success, or a short reason
 * when the request never reached a server that will answer it.
 *
 * It used to resolve `void` in every case, logging the failure and moving on. That is the THIRD way
 * a call goes unanswered, and the only one neither `streamLossReplies` nor the queue timer can see:
 * the SSE stream is healthy (so nothing drops) and the request was forwarded (so nothing is queued),
 * but the POST leg is its own TCP connection and an ECONNRESET on it means the daemon never received
 * the call. Nobody was ever going to reply, and the caller waited for its own timeout.
 */
function postToSession(url: string, body: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
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
      const rejected = status < 200 || status >= 300;
      if (rejected) {
        // A non-2xx from the daemon MCP endpoint used to be swallowed, hanging the JSON-RPC call
        // client-side with no diagnostic. It is a refusal: no response is coming over the stream.
        log('reticle_mcp_proxy_post_non2xx', { status, path: options.path });
      }
      res.resume(); // drain so the socket is reused
      resolve(rejected ? `daemon rejected the call with HTTP ${String(status)}` : null);
    });
    req.on('error', (err) => {
      log('reticle_mcp_proxy_post_error', { error: err.message });
      resolve(`post failed: ${err.message}`);
    });
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * Turn an `endpoint` frame's data into a POST target, or null when there is nothing usable in it.
 *
 * An empty (or whitespace) data field is the shape a malformed daemon response takes, and it used to
 * be accepted: `postUrl` became `''`, which is not `null`, so the proxy considered itself CONNECTED
 * and posted every subsequent message to the empty string. Each one failed, the queue never armed
 * its deadline because nothing was ever queued, and the agent held a session that could not carry a
 * single call. Refusing the frame keeps the proxy in its disconnected path, which already knows how
 * to reconnect and how to answer what it cannot send.
 */
export function buildSessionUrl(rawData: string, port: number): string | null {
  const trimmed = rawData.trim();
  if ('' === trimmed) return null;
  return trimmed.startsWith('/') ? `http://${LOOPBACK_HOST}:${port}${trimmed}` : trimmed;
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
export function startMcpProxy(
  port: number,
  /**
   * Bring a daemon back before reconnecting. Without it the proxy retried a DEAD port until the
   * budget ran out and then killed itself, taking the agent's whole Reticle surface with it — the
   * failure mode for a daemon that crashed, was stopped, or shut itself down as idle.
   */
  ensureDaemon?: () => Promise<void>,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    // Declared before the SSE handler that fills it: the handler is a closure created below but
    // invoked on the first daemon frame, and a `const` referenced before its declaration executes is
    // a runtime throw, not a type error.
    const catalog = new ToolCatalogCache();
    let postUrl: string | null = null;
    /**
     * No daemon is listening and the proxy has stopped chasing one.
     *
     * The alternative — respawning the moment the stream drops — turns an idle daemon's own
     * self-shutdown into a permanent spawn loop, because the daemon it brings back is just as idle.
     * Dormant means the next thing the CLIENT asks for is what brings Reticle back.
     */
    let dormant = false;
    const stdinQueue: string[] = [];
    /**
     * Fail anything still queued after QUEUE_WAIT_MS. Re-armed on every push and cleared on flush,
     * so a queue that drains normally never fires it.
     */
    let queueTimer: ReturnType<typeof setTimeout> | undefined;
    const clearQueueTimer = (): void => {
      if (queueTimer !== undefined) clearTimeout(queueTimer);
      queueTimer = undefined;
    };
    const armQueueTimer = (): void => {
      if (queueTimer !== undefined) return; // the oldest entry owns the deadline
      queueTimer = setTimeout(() => {
        queueTimer = undefined;
        if (stopped || 0 === stdinQueue.length) return;
        // Drop what we could never send, and answer it, so the caller is never left guessing.
        stdinQueue.splice(0);
        for (const reply of streamLossReplies(pending, 'no daemon could be reached')) emit(reply);
        // The expiry is the proof that the reconnect we believed was in flight is not coming — a
        // wedged port accepts the socket and never serves SSE, so `connect` neither resolves nor
        // rejects and `dormant` would otherwise stay false forever. Going dormant is what makes the
        // NEXT request re-probe the port instead of queueing behind a reconnect that will never
        // land, and it is the only path by which a daemon started AFTER we gave up is ever found.
        dormant = onQueueExpired() === OnDrop.DORMANT;
        proxyLog('reticle_mcp_proxy_queue_expired', {
          port,
          dormant,
          note: 'answered queued requests and went dormant; the next client request re-probes the port',
        });
      }, QUEUE_WAIT_MS);
      queueTimer.unref();
    };
    const replay = new HandshakeReplay();
    const pending = new PendingRequests();
    /** The ONE way a line reaches the client — so nothing can be answered without clearing the debt. */
    const emit = (line: string): void => {
      pending.observeInbound(line);
      process.stdout.write(`${line}\n`);
    };
    let stopped = false;
    let attempts = 0;

    /**
     * The ONE way a line leaves for the daemon — so a POST that never lands still owes an answer.
     *
     * Only requests we are holding in `pending` get one: a notification is owed nothing, and the
     * proxy's own replayed handshake carries a reserved id the client must never see a reply for.
     */
    const forward = (url: string, line: string): void => {
      void postToSession(url, line).then((failure) => {
        if (null === failure) return;
        const msg = parseJsonRpc(line);
        if (null === msg || msg.id === undefined || !pending.take(msg.id)) return;
        proxyLog('reticle_mcp_proxy_post_unanswered', {
          port,
          method: String(msg.method),
          reason: failure,
          note: 'the stream is still up, so nothing else would ever have answered this call',
        });
        emit(transportLossReply(msg.id, failure));
      });
    };

    function onSseEvent(event: string, data: string, p: number): void {
      if ('endpoint' === event) {
        const url = buildSessionUrl(data, p);
        if (null === url) {
          proxyLog('reticle_mcp_proxy_empty_endpoint', {
            port,
            note: 'endpoint frame carried no URL; staying disconnected rather than posting to nowhere',
          });
          return;
        }
        postUrl = url;
        // A stream that reached `endpoint` is a USABLE session — that, not a set of response
        // headers, is what earns a fresh retry budget. Resetting on headers let a daemon that
        // accepts SSE and drops it spin the reconnect loop at the 250ms floor forever, never backing
        // off and never reaching the budget that puts the proxy dormant. Measured: 32 retries in 8s.
        attempts = 0;
        // The new session's McpServer has never seen the client's initialize — replay it first, then
        // flush whatever the client sent while we were reconnecting.
        for (const line of replay.replayLines()) forward(url, line);
        clearQueueTimer();
        for (const queued of stdinQueue.splice(0)) forward(url, queued);
        handshakeAnswered = true;
        return;
      }
      if ('message' === event && !replay.shouldSuppressInbound(data)) {
        // Remember the tool catalog as it goes past: it is what makes a locally-answered handshake
        // useful rather than toolless. See tool-catalog-cache.
        catalog.observe(data);
        emit(data);
      }
    }

    function scheduleReconnect(reason: string, detail?: string, pendingLost = 0): void {
      if (stopped) return;
      postUrl = null;
      attempts++;
      // Once per process: this session has now lost its tools at least once, which is the number
      // that says whether the transport work actually landed for real users. `pendingLost` is the
      // part an agent can FEEL — almost every measured drop killed nothing in flight.
      reportMcpOutage(OutageStage.FIRST, { reason, attempts, pendingLost });
      // The severe stage: we are about to stop retrying. Reported so the share of sessions where
      // MCP never came back on its own is a number rather than an anecdote.
      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        reportMcpOutage(OutageStage.BUDGET_SPENT, { reason, attempts, pendingLost });
        // Stop RETRYING, never stop SERVING. See onReconnectBudgetSpent: exiting here made the
        // client mark the MCP server disconnected and left a human to reconnect it by hand.
        dormant = onReconnectBudgetSpent() === OnDrop.DORMANT;
        proxyLog('reticle_mcp_proxy_dormant_after_budget', {
          port,
          reason,
          attempts,
          note: 'stopped retrying; the next client request will start a daemon',
          ...(detail !== undefined ? { detail } : {}),
        });
        return;
      }
      const wait = reconnectDelayMs(attempts);
      proxyLog('reticle_mcp_proxy_reconnecting', {
        port,
        reason,
        attempt: attempts,
        retryInMs: wait,
        ...(detail !== undefined ? { detail } : {}),
      });
      setTimeout(() => {
        // Reattach to a daemon that is ALREADY there. Deliberately does not spawn one: a daemon that
        // shut itself down as idle would be respawned instantly, sit unused, shut down again, and
        // loop forever — measured at four processes in 200s before this. If nothing is listening the
        // proxy goes DORMANT and the next client request brings a daemon back (see the stdin reader).
        void probeDaemon(port).then((listening) => {
          if (onStreamDrop(listening) === OnDrop.REATTACH) {
            connect(false);
            return;
          }
          dormant = true;
          proxyLog('reticle_mcp_proxy_dormant', {
            port,
            note: 'no daemon listening; will start one when the client next sends a request',
          });
        });
      }, wait).unref();
    }

    function connect(first: boolean): void {
      // Announce this process to the daemon on the connect we already make — it is the single judge
      // of version skew, and this is the only moment it learns the agent's MCP server exists.
      const announce = `${MCP_SSE_PATH}?${PEER_VERSION_PARAM}=${encodeURIComponent(SERVER_VERSION)}&${PEER_CONTRACT_PARAM}=${encodeURIComponent(CONTRACT_FINGERPRINT)}`;
      const req = http.get({ host: LOOPBACK_HOST, port, path: announce }, (res) => {
        if (!first) proxyLog('reticle_mcp_proxy_reconnected', { port });
        res.setEncoding('utf8');
        // `end` and `error` can both fire on one response; only the first should drive a reconnect.
        let settled = false;
        const drop = (reason: string, detail?: string): void => {
          if (settled) return;
          settled = true;
          // Drain the queue BEFORE answering pending: a request can be in both (queued but tracked),
          // and leaving it in the queue means the reconnect will forward it, the daemon will answer,
          // and the client sees two responses for one id — a protocol violation.
          stdinQueue.splice(0);
          const lost = streamLossReplies(pending, reason);
          for (const reply of lost) emit(reply);
          // How many calls this drop actually killed. Zero means the agent could not feel it.
          scheduleReconnect(reason, detail, lost.length);
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
      req.on('error', (err) =>
        first ? reject(err) : scheduleReconnect('connect_error', err.message),
      );
    }

    connect(true);

    // ── stdin reader ─────────────────────────────────────────────────────────
    process.stdin.setEncoding('utf8');
    let handshakeAnswered = false;
    /**
     * Answer a queued `initialize` locally if the daemon has not produced an endpoint in time.
     *
     * Bounded because a hang is the worst outcome available here: no tools, no diagnosis, nothing to
     * retry. Cancelled implicitly — once `postUrl` exists the queue flushes and the daemon answers,
     * and `handshakeAnswered` keeps us from answering twice.
     */
    const armLocalHandshake = (line: string): void => {
      if (handshakeAnswered) return;
      const response = localInitializeResponse(line);
      if (null === response) return;
      setTimeout(() => {
        if (handshakeAnswered || postUrl !== null) return;
        handshakeAnswered = true;
        // Drop the handshake from the queue. Otherwise the daemon, whenever it finally arrives,
        // answers the SAME id a second time and the client sees two responses to one request — a
        // corrupted stream, which is worse than the hang this replaces. The daemon still gets its own
        // handshake: `replayLines` re-issues it under a distinct id and suppresses the echo.
        for (let i = stdinQueue.length - 1; i >= 0; i--) {
          const queued = stdinQueue[i];
          if (queued !== undefined && isHandshakeLine(queued)) stdinQueue.splice(i, 1);
        }
        proxyLog('reticle_mcp_local_handshake', { port, reason: 'daemon did not answer in time' });
        emit(response);
      }, LOCAL_HANDSHAKE_MS).unref();
    };

    let stdinBuffer = '';

    process.stdin.on('data', (chunk: string) => {
      stdinBuffer += chunk;
      const lines = stdinBuffer.split('\n');
      stdinBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if ('' === trimmed) continue;
        replay.observeOutbound(trimmed);
        pending.observeOutbound(trimmed);
        const action = onClientRequest(postUrl !== null, dormant);
        if (action === OnRequest.SEND && postUrl !== null) {
          forward(postUrl, trimmed);
          continue;
        }
        // A queued `tools/list` with no daemon is the state that leaves an agent "connected with no
        // tools" — the one a human has to fix by hand. If the catalog has been seen, answer it.
        if (handshakeAnswered) {
          const cached = catalog.answer(trimmed);
          if (cached !== null) {
            emit(cached);
            continue;
          }
        }
        stdinQueue.push(trimmed);
        armQueueTimer();
        // A queued `initialize` is the one message that must not wait indefinitely. If the daemon
        // port is held by something that never serves SSE — wedged, foreign, or leaked by another
        // project — the handshake never completes and the agent gets NO tools and no diagnosis.
        // Answer it ourselves after a bounded wait; the daemon still receives the client's own
        // initialize when a session is finally established (replayLines).
        armLocalHandshake(trimmed);
        // WAKE is the ONLY path allowed to start a daemon — see proxy-lifecycle.ts. The queue is
        // flushed once the new session's `endpoint` frame arrives.
        if (action === OnRequest.WAKE) {
          dormant = false;
          attempts = 0;
          void (ensureDaemon?.() ?? Promise.resolve())
            .then(() => connect(false))
            .catch((err: unknown) => {
              dormant = true;
              proxyLog('reticle_mcp_proxy_wake_failed', {
                port,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
      }
    });

    // The client going away is the one clean shutdown — stop reconnecting and exit.
    //
    // Exiting the INSTANT stdin ends drops whatever is still in flight and reports success for it: a
    // client that wrote `initialize` + `tools/list` and closed in the same flush got the handshake
    // answered, `tools/list` never, and exit 0 — so nothing supervising it could tell. A 4-second gap
    // between the writes made it "work", which is the signature of a teardown race, not of a client
    // that asked for too much. Drain first, and let the exit status carry the truth if it fails.
    process.stdin.on('end', () => {
      const quit = (code: number): void => {
        stopped = true;
        process.exit(code);
      };
      if (0 === pending.unanswered.length) {
        quit(0);
        return;
      }
      const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
      const poll = setInterval(() => {
        const stuck = pending.unanswered;
        if (0 === stuck.length) {
          clearInterval(poll);
          quit(0);
          return;
        }
        if (Date.now() < deadline) return;
        clearInterval(poll);
        proxyLog('reticle_mcp_proxy_unanswered_at_exit', { port, ids: stuck });
        quit(1);
      }, SHUTDOWN_DRAIN_POLL_MS);
    });
  });
}
