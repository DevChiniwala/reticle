import {
  EventType,
  RETICLE_DEFAULT_PORT,
  RETICLE_PROTOCOL_VERSION,
  RETICLE_URL_PARAM,
  bridgeWsUrl,
  ReticleCommand,
  MessageKind,
  SESSION_AUTO,
  SessionState,
  TRANSPORT_LIMITS,
  isLoopbackHostname,
  type CommandMessage,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import {
  createCommandRegistry,
  RELOAD_CACHE_BUST_PARAM,
  type CommandHandler,
} from './commands/commands.js';
import { Transport, type CommandOutcome } from './transport/transport.js';
import { adapterNames } from './registry/adapters.js';
import {
  registerCapabilities,
  hasCapabilities,
  type CapabilitiesInput,
} from './registry/capabilities.js';
import { installDom } from './observers/dom.js';
import { installStorage } from './observers/storage.js';
import { installStoreState } from './observers/state.js';
import { installFocus } from './observers/focus.js';
import { installBlindSpots } from './observers/blind-spots.js';
import { installNetwork } from './observers/network.js';
import { installPerf } from './observers/perf.js';
import { installRoute } from './observers/route.js';
import { installConsole } from './observers/console.js';
import { installAnimation } from './observers/animation.js';
import { installScroll } from './observers/scroll.js';
import { installHealth } from './observers/health.js';
import { installOverlay, type OverlayHandle } from './presenter/overlay.js';
import {
  Presenter,
  LOG_KIND,
  LOG_RESULT,
  type PresenterOptions,
  type LogHandle,
} from './presenter/presenter.js';
import { actionVerb } from './presenter/presenter-verbs.js';
import { str, refLabel, modeForCommand, presentStatus } from './reticle-presenter-helpers.js';
import { resetClock } from './timers/clock.js';
import { nativeWarn } from './timers/native-console.js';
import { installRecorder, type RecorderHandle } from './recorder/recorder.js';
import { Annotator } from './review/annotator.js';
import type { Teardown } from './observers/types.js';

export interface ReticleConnectOptions {
  /** WS endpoint of the local bridge. Defaults to ws://localhost:<port><path>. */
  url?: string;
  /** Human-friendly session label so the agent can target the right tab. */
  session?: string;
  /**
   * Stable project identity, normally stamped by the build plugin (e.g. "acme-web-9f3c1d"). Lets the
   * agent scope to the right app even when its dev server boots on an unexpected port. Optional.
   */
  projectId?: string;
  /** Browser/bridge pairing token. Required when either endpoint is non-localhost. */
  token?: string;
  /** Explicitly allow Reticle on a non-localhost page or bridge. Requires token. */
  allowNonLocalhost?: boolean;
  /**
   * Escape hatch for the production backstop. Reticle is dev-only and refuses to connect when the
   * build reports NODE_ENV=production (an SSR healthcheck or a prod bundle opened locally would
   * otherwise activate). The real fix is to gate the import behind `import.meta.env.DEV` so it's
   * tree-shaken out; this flag only exists for the rare intentional prod diagnostic.
   */
  allowInProduction?: boolean;
  /** Show a small in-page status chip (connection + event count). */
  overlay?: boolean;
  /**
   * Capture request/response bodies on net.request events (dev-only; text-like content only,
   * sensitive keys redacted, per-body capped). Off by default — bodies cost tokens and can carry PII.
   */
  captureNetworkBodies?: boolean;
  /** Presenter mode: glow border, animated cursor, click/hover effects, narration HUD. */
  present?: boolean;
  /** Per-action pacing (ms) in presenter mode so a human can follow. Default 450. */
  pace?: number;
  /** Min ms each narration line stays visible before the next replaces it (presenter). Default 3000. */
  narrationDwellMs?: number;
  /**
   * Border behavior in presenter mode: 'session' (default) persists the border for the whole
   * session; 'busy' restores the fade-after-idle behavior.
   */
  border?: 'session' | 'busy';
  /** Max accumulated activity-log rows before the oldest are pruned (presenter). Default 50. */
  logMax?: number;
  /**
   * Mount the floating human-recorder toolbar (Record/Stop/Annotate).
   * Default off — purely additive, dev-only.
   */
  recorder?: boolean;
  /**
   * Mount the "Flag a bug" annotator: the human clicks an element that looks wrong, types what's
   * wrong, and Reticle emits a HUMAN_MARK the agent drains via reticle_review. Defaults to ON with the
   * presenter (it's the human's side of the look→act→assert loop); pass `annotate: false` to suppress.
   */
  annotate?: boolean;
  /** Live-control: overridable ended-border fade delay (native timer). Default 4000. */
  endedFadeMs?: number;
  /** Session auto-end after this much agent idle (presenter). Default 5min; agent-tunable via reticle_session. */
  idleEndMs?: number;
}

/**
 * Runtime backstop for the dev-only SDK: block connecting when the build reports production, unless
 * explicitly overridden. Pure so it's testable; connect reads NODE_ENV safely (process may be absent
 * in a raw browser). This is defense-in-depth — the primary guard is the consumer gating the import
 * behind `import.meta.env.DEV` so the SDK is dead-code-eliminated from prod bundles entirely.
 */
export function shouldBlockProduction(
  nodeEnv: string | undefined,
  allowInProduction: boolean,
): boolean {
  return nodeEnv === 'production' && !allowInProduction;
}

export function connectionPolicy(
  pageHostname: string,
  bridgeUrl: string,
  allowNonLocalhost: boolean,
  token: string | undefined,
): { allowed: boolean; reason?: string } {
  let bridge: URL;
  try {
    bridge = new URL(bridgeUrl);
  } catch {
    return { allowed: false, reason: 'invalid Reticle bridge URL' };
  }
  if (bridge.protocol !== 'ws:' && bridge.protocol !== 'wss:') {
    return { allowed: false, reason: 'Reticle bridge URL must use ws:// or wss://' };
  }
  if ((token?.length ?? 0) > TRANSPORT_LIMITS.MAX_TOKEN_LENGTH) {
    return {
      allowed: false,
      reason: `Reticle pairing token exceeds ${String(TRANSPORT_LIMITS.MAX_TOKEN_LENGTH)} characters`,
    };
  }
  const remoteBridge = !isLoopbackHostname(bridge.hostname);
  if (remoteBridge && bridge.protocol !== 'wss:') {
    return { allowed: false, reason: 'a non-local Reticle bridge must use wss://' };
  }
  const remote = !isLoopbackHostname(pageHostname) || remoteBridge;
  if (!remote) return { allowed: true };
  if (!allowNonLocalhost) {
    return {
      allowed: false,
      reason:
        'Reticle is disabled outside localhost unless allowNonLocalhost is explicitly enabled',
    };
  }
  if (token === undefined || token.length === 0) {
    return { allowed: false, reason: 'a pairing token is required outside localhost' };
  }
  return { allowed: true };
}

/** HUD summary when the SDK self-ends a session because the bridge (server/agent) became unreachable. */
const BRIDGE_LOST_SUMMARY =
  'Session ended — lost connection to Reticle (the agent is no longer running).';

/**
 * Resolve the session label. An absent label or the `auto` sentinel yields a fresh per-tab id (via
 * the injected generator) so multi-tab / new-tab routes never collide; any other label is used
 * verbatim so tabs can intentionally share a session. `gen` is injected to keep this clock-free.
 */
export function resolveSessionLabel(option: string | undefined, gen: () => string): string {
  return option === undefined || option === SESSION_AUTO ? gen() : option;
}

// Re-exported from the protocol (the wire contract) so callers/tests can import it from the SDK too.
export { RETICLE_URL_PARAM };

/** Remove the `_reticle_reload` cache-buster a hard REFRESH left behind, via a native replaceState. */
function stripReloadCacheBustParam(): void {
  try {
    const current = new URL(window.location.href);
    if (!current.searchParams.has(RELOAD_CACHE_BUST_PARAM)) return;
    current.searchParams.delete(RELOAD_CACHE_BUST_PARAM);
    window.history.replaceState(window.history.state, '', current.toString());
  } catch {
    /* best-effort URL hygiene — never block connect() on it */
  }
}

/**
 * Extract Reticle identity overrides from a `location.search` string. Pure (takes the string, not the
 * window) so it's testable without a DOM. Explicit connect options still win over these.
 */
export function reticleParamsFromSearch(search: string): { session?: string; projectId?: string } {
  const params = new URLSearchParams(search);
  const out: { session?: string; projectId?: string } = {};
  const session = params.get(RETICLE_URL_PARAM.SESSION);
  const projectId = params.get(RETICLE_URL_PARAM.PROJECT);
  if (session !== null && session.length > 0) out.session = session;
  if (projectId !== null && projectId.length > 0) out.projectId = projectId;
  return out;
}

/**
 * Resolve the session + project identity for a connection: an explicit, non-`auto` option wins;
 * otherwise a launcher-stamped URL param is used; otherwise undefined (caller generates a per-tab id).
 * Crucially `auto` is treated like "unset" so an app that passes the auto sentinel still lets a pooled
 * launcher correlate the lease via __reticle_session. Pure for testability.
 */
export function resolveConnectIdentity(
  options: { session?: string; projectId?: string },
  search: string,
): { session: string | undefined; projectId: string | undefined } {
  const url = reticleParamsFromSearch(search);
  const explicitSession =
    options.session !== undefined && options.session !== SESSION_AUTO ? options.session : undefined;
  const projectId = options.projectId ?? url.projectId;
  return {
    session: explicitSession ?? url.session,
    projectId: projectId !== undefined && projectId.length > 0 ? projectId : undefined,
  };
}

/**
 * Assemble an event envelope. Pure: `seq` (monotonic per session) and `t` (elapsed clock) are
 * injected, never read here — so it is unit-testable and honors the clock-injection rule. The
 * causing action's id is attributed server-side by the settle window, so it is not stamped here.
 */
export function buildEvent(args: {
  seq: number;
  t: number;
  type: EventType;
  sessionId: string;
  data: Record<string, unknown>;
  ref?: string | undefined;
}): ReticleEvent {
  return {
    t: args.t,
    seq: args.seq,
    type: args.type,
    sessionId: args.sessionId,
    ref: args.ref,
    data: args.data,
  };
}

/**
 * The browser-side orchestrator. Wires observers -> events -> bridge, and bridge
 * commands -> handlers. Embedded in the host app (dev only).
 */
export class Reticle {
  #transport: Transport | undefined;
  #registry: Map<string, CommandHandler> = new Map();
  #teardowns: Teardown[] = [];
  #connected = false;
  #session = 'default';
  #start = 0;
  #overlay: OverlayHandle | undefined;
  #presenter: Presenter | undefined;
  #recorder: RecorderHandle | undefined;
  #annotator: Annotator | undefined;
  #eventCount = 0;
  #token: string | undefined;
  #projectId: string | undefined;
  /** Act-row log handle for the in-flight act/act_sequence, so its outcome stamps the right row. */
  #actHandle: LogHandle | undefined;

  connect(options: ReticleConnectOptions = {}): void {
    if (this.#connected) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // Dev-only backstop: refuse to activate in a production build (SSR healthcheck, prod bundle opened
    // on localhost). `process` may not exist in a raw browser, so read NODE_ENV off globalThis.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const nodeEnv = proc?.env?.NODE_ENV;
    if (shouldBlockProduction(nodeEnv, options.allowInProduction === true)) {
      globalThis.console.warn(
        '[Reticle] disabled in production (NODE_ENV=production). Gate the import behind ' +
          'import.meta.env.DEV, or pass allowInProduction:true to override.',
      );
      return;
    }

    // A `hard` REFRESH left a cache-busting `_reticle_reload=<nonce>` in the address bar. Strip it now
    // (before the route observer installs, so it emits no spurious ROUTE_CHANGE) — otherwise every hard
    // reload permanently pollutes the URL the app and the agent see.
    stripReloadCacheBustParam();

    const url = options.url ?? bridgeWsUrl(RETICLE_DEFAULT_PORT);
    const policy = connectionPolicy(
      window.location.hostname,
      url,
      options.allowNonLocalhost === true,
      options.token,
    );
    if (!policy.allowed) {
      globalThis.console.warn(`[Reticle] ${policy.reason ?? 'connection blocked'}`);
      return;
    }

    // A pooled/headless launcher can stamp identity via namespaced URL params; explicit (non-auto)
    // options win, but the `auto` sentinel defers to the URL param so leases correlate.
    const identity = resolveConnectIdentity(options, window.location.search);
    this.#session = resolveSessionLabel(identity.session, () =>
      typeof globalThis.crypto?.randomUUID === 'function'
        ? `s${globalThis.crypto.randomUUID()}`
        : `s${Date.now().toString(36)}`,
    );
    this.#token =
      options.token !== undefined && options.token.length > 0 ? options.token : undefined;
    this.#projectId = identity.projectId;
    this.#start = performance.now();
    this.#registry = createCommandRegistry();

    this.#transport = new Transport({
      url,
      hello: () => this.#hello(),
      handleCommand: (command) => this.#handleCommand(command),
      // Show the presenter HUD as soon as the agent bridge connects — the user immediately sees
      // the glow border and narration panel, even before the first tool call lands.
      onConnected: () => this.#presenter?.sessionStart(),
      // Liveness fallback: if the bridge stays unreachable (the agent killed the server process),
      // no server-pushed end can arrive — so end the run we're presenting ourselves. A returning
      // agent revives it via the normal sessionStart path on its next command.
      onConnectionLost: () => {
        // Restore real timers. A frozen clock is driven by the agent through the bridge; once the
        // bridge is gone nothing can ever advance it, so leaving it installed pins Date.now and
        // queues every setTimeout into a scheduler that will never run. Concretely that kills every
        // lodash debounce/throttle in the app (now - lastCall stays 0), so search boxes, autosave
        // and resize handlers stop firing until a reload — with nothing on screen explaining why.
        resetClock();
        if (this.#presenter?.sessionActive === true) {
          this.#presenter.setState(SessionState.ENDED, BRIDGE_LOST_SUMMARY);
        }
      },
      // First-connect never succeeded ⇒ the bridge is unreachable at this URL. Tell the developer
      // exactly what went wrong and how to fix it, instead of retrying silently forever.
      onUnreachable: ({ url: tried, attempts }) => {
        nativeWarn(
          `[Reticle] could not reach the bridge at ${tried} after ${String(attempts)} attempts. ` +
            `Is the Reticle daemon running on that port? If your app runs in a container/devcontainer/WSL, ` +
            `the daemon is on a different host — set the WS URL explicitly (Vite: VITE_RETICLE_WS_URL, ` +
            `or reticle.connect({ url })). Still retrying…`,
        );
      },
    });

    const emit = this.#emit;
    this.#teardowns = [
      installNetwork(emit, { captureBodies: options.captureNetworkBodies === true }),
      installPerf(emit),
      installRoute(emit),
      installConsole(emit),
      installAnimation(emit),
      installScroll(emit),
      installDom(emit),
      installStorage(emit), // storage WRITES → STORAGE_CHANGE diffs (pull remains the fallback)
      installStoreState(emit), // subscribed-store mutations → STATE_CHANGE path diffs
      installFocus(emit), // element focus movement → FOCUS_CHANGE (focus-to-body = a regression)
      installBlindSpots(emit), // cross-origin iframes the SDK can't see → BLIND_SPOT (coverage: partial)
      installHealth(emit), // page visibility/focus health + heartbeat
    ];

    if (options.overlay === true) {
      this.#overlay = installOverlay();
      this.#overlay.update({ connected: true, events: 0 });
    }

    if (options.present !== false) {
      const presenterOptions: PresenterOptions = {};
      if (options.pace !== undefined) presenterOptions.paceMs = options.pace;
      if (options.narrationDwellMs !== undefined) {
        presenterOptions.narrationDwellMs = options.narrationDwellMs;
      }
      if (options.border !== undefined) presenterOptions.border = options.border;
      if (options.logMax !== undefined) presenterOptions.logMax = options.logMax;
      if (options.endedFadeMs !== undefined) presenterOptions.endedFadeMs = options.endedFadeMs;
      if (options.idleEndMs !== undefined) presenterOptions.idleEndMs = options.idleEndMs;
      presenterOptions.sessionId = this.#session;
      // The panel calls this when the human pauses/resumes/ends or sends a message. We emit a
      // HUMAN_CONTROL event over the existing transport; #emit stamps `t` from the elapsed clock.
      presenterOptions.onControl = (intent) =>
        this.#emit(
          EventType.HUMAN_CONTROL,
          intent.text !== undefined
            ? { kind: intent.kind, text: intent.text }
            : { kind: intent.kind },
        );
      this.#presenter = new Presenter(presenterOptions);
      // Mount the overlay. The session (glow + HUD) activates on bridge connect via onConnected,
      // so the presenter is visible as soon as the agent is reachable — not just on first command.
      this.#presenter.mount();
    }

    if (options.recorder === true) {
      this.#recorder = installRecorder({ emit, now: () => Date.now() });
      this.#recorder.mount();
    }

    // The "Flag a bug" annotator rides with the presenter (the human surface) unless explicitly off.
    if (options.annotate ?? options.present !== false) {
      const presenter = this.#presenter;
      this.#annotator = new Annotator({
        emit,
        now: () => Date.now(),
        // Echo the flag into the live panel so the human watches their bug report land in the log.
        onMark: (note, label) => presenter?.log(LOG_KIND.HUMAN, `🚩 ${label}: ${note}`),
      });
      this.#annotator.mount();
    }

    this.#transport.connect();
    this.#connected = true;
  }

  /** Whether the in-page SDK is connected to the bridge (read by createReticleEmitter, P5a). */
  get connected(): boolean {
    return this.#connected;
  }

  /** Surface an arbitrary app-domain observation the DOM can't express. */
  signal(name: string, data: Record<string, unknown> = {}): void {
    this.#emit(EventType.SIGNAL, { name, data });
  }

  /** Report a framework/store state change the agent can observe and assert on. */
  state(name: string, value: unknown): void {
    this.#emit(EventType.STATE_CHANGE, { name, value });
  }

  /**
   * Report an aggregated count of React commits (the @reticlehq/react render meter calls this on a
   * throttle). Emits a single RENDER_COMMIT event per window so commit storms are observable without a
   * per-render flood. Dev-only, like the whole SDK.
   */
  renderCommit(commits: number): void {
    if (commits > 0) this.#emit(EventType.RENDER_COMMIT, { commits });
  }

  /** Advertise the app's testable surface so the agent learns it without reading source. */
  describe(input: CapabilitiesInput): void {
    registerCapabilities(input);
  }

  /** Live-control: end the session programmatically from the host app (drives the panel to ended). */
  endSession(): void {
    this.#presenter?.setState(SessionState.ENDED);
  }

  disconnect(): void {
    if (!this.#connected) return;
    for (const teardown of this.#teardowns) teardown();
    this.#teardowns = [];
    this.#transport?.close();
    this.#transport = undefined;
    this.#overlay?.destroy();
    this.#overlay = undefined;
    this.#presenter?.sessionEnd(); // fade the border out before tearing the overlay down
    this.#presenter?.destroy();
    this.#presenter = undefined;
    this.#recorder?.destroy();
    this.#recorder = undefined;
    this.#annotator?.destroy();
    this.#annotator = undefined;
    resetClock(); // restore any frozen timers
    this.#connected = false;
  }

  readonly #emit = (type: EventType, data: Record<string, unknown>, ref?: string): void => {
    const event = buildEvent({
      seq: this.#eventCount,
      t: Math.round(performance.now() - this.#start),
      type,
      sessionId: this.#session,
      data,
      ref,
    });
    // Guarded because #emit runs INLINE IN THE APP'S CALL STACK: every monkey-patch calls it from
    // inside the function it replaced. An exception here does not surface as an SDK error — it
    // propagates out of history.pushState (crashing a router's navigate), out of localStorage.setItem
    // after the write already succeeded, or out of console.log before the message reaches the console.
    // A dev-only observability SDK must never be able to break the app it is observing.
    try {
      this.#transport?.sendEvent(event);
      this.#eventCount += 1;
      this.#overlay?.update({ connected: true, events: this.#eventCount });
      // On a route change, re-scope the HUD's replay-flow chips to the page we're now on.
      if (type === EventType.ROUTE_CHANGE) this.#presenter?.refilterFlows();
    } catch {
      /* observation is best-effort; the host app's control flow is not */
    }
  };

  #hello(): HelloMessage {
    return {
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: this.#session,
      ...(this.#projectId === undefined ? {} : { projectId: this.#projectId }),
      url: location.href,
      title: document.title,
      adapters: adapterNames(),
      ...(this.#token === undefined ? {} : { token: this.#token }),
      hasCapabilities: hasCapabilities(),
    };
  }

  async #handleCommand(command: CommandMessage): Promise<CommandOutcome> {
    // NARRATE: the agent tells the human what it's about to do / decide (presenter HUD).
    if (command.name === ReticleCommand.NARRATE) {
      this.#presenter?.sessionStart(); // first agent activity → reveal the glow + panel
      this.#presenter?.narrate(str(command.args['text']), str(command.args['level'], 'info'));
      return { ok: true, result: { shown: this.#presenter !== undefined } };
    }

    // SESSION_CONFIG: the agent tunes the session for the app (currently the idle-end window).
    if (command.name === ReticleCommand.SESSION_CONFIG) {
      const idleEndMs = command.args['idleEndMs'];
      if (typeof idleEndMs === 'number') this.#presenter?.setIdleEndMs(idleEndMs);
      return { ok: true, result: { applied: this.#presenter !== undefined, idleEndMs } };
    }

    // Bridge → browser presenter pushes (PRESENTER state echo / FLOWS replay list). The presenter owns
    // the parsing; here we only report whether a panel was mounted to apply it. setState-only, so a
    // PRESENTER echo of a HUMAN_CONTROL can't loop back into a re-emit.
    if (command.name === ReticleCommand.PRESENTER || command.name === ReticleCommand.FLOWS) {
      this.#presenter?.handlePush(command);
      return { ok: true, result: { applied: this.#presenter !== undefined } };
    }

    const handler = this.#registry.get(command.name);
    if (handler === undefined) {
      return { ok: false, error: `unknown command '${command.name}'` };
    }

    this.#presenter?.sessionStart(); // first agent command → reveal the glow + panel
    await this.#presentBefore(command);
    try {
      const result = await handler(command.args);
      this.#actHandle?.result(LOG_RESULT.PASS);
      return { ok: true, result };
    } catch (error) {
      this.#actHandle?.result(LOG_RESULT.FAIL);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.#actHandle = undefined;
      this.#presenter?.scheduleIdle();
    }
  }

  /** Drive the presenter (cursor/effects/status) before the real action runs. */
  async #presentBefore(command: CommandMessage): Promise<void> {
    const p = this.#presenter;
    if (p === undefined) return;
    p.setMode(modeForCommand(command.name)); // paint reading vs acting intent first
    this.#actHandle = undefined;
    if (command.name === ReticleCommand.ACT) {
      const ref = str(command.args['ref']);
      const label = refLabel(ref);
      this.#actHandle = p.log(LOG_KIND.ACT, `${actionVerb(str(command.args['action']))} ${label}`);
      await p.beforeAct(ref, str(command.args['action']), label);
    } else if (command.name === ReticleCommand.ACT_SEQUENCE) {
      const steps = Array.isArray(command.args['steps']) ? command.args['steps'] : [];
      for (const step of steps) {
        const s = step as { ref?: unknown; action?: unknown };
        const ref = str(s.ref);
        const label = refLabel(ref);
        // one log row per step; the last handle carries the sequence outcome glyph
        this.#actHandle = p.log(LOG_KIND.ACT, `${actionVerb(str(s.action))} ${label}`);
        await p.beforeAct(ref, str(s.action), label);
      }
    } else {
      const label = presentStatus(command.name, command.args);
      p.status(label);
      p.log(LOG_KIND.READ, label);
    }
  }
}
