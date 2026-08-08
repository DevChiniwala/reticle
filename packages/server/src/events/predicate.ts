import {
  ElementState,
  ReticleCommand,
  type CommandResult,
  type ElementQuery,
  type ReticleEvent,
  type MatchResult,
} from '@reticlehq/core';
import { selectPath, capDepth } from '../session/state-select.js';
import { predicateToExpectedLinks } from '../capsule/predicate-to-links.js';
import type { ExpectedLink } from '../capsule/divergence.js';
import { isAmbient, ambientKeyOf, type AmbientCounts } from '../journal/ambient.js';
import {
  PredicateSchema,
  matchValue,
  evalNet,
  evalRoute,
  evalConsole,
  evalAnimation,
  evalSignal,
  evalSettled,
  type Predicate,
  type EvalResult,
} from './predicate-eval.js';

export { PredicateSchema };
export type { Predicate, EvalResult };

/** The subset of Session the predicate engine needs — keeps it testable with a fake. */
export interface PredicateSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
  /** Milliseconds since connect — the same clock that stamps event `t` (injected, testable). */
  elapsed(): number;
  /**
   * Learned per-ref ambient-churn counts (real-time regions that churn with no action driving them).
   * The settle oracle drops events on learned-ambient refs so a chat/ticker page can still go quiet.
   * Optional: a session without ambient learning simply omits it and settle behaves as before.
   */
  ambientCounts?(): AmbientCounts;
  /**
   * Subscribe to session disconnect. Returns an unsubscribe function. Optional: a session without
   * this hook (e.g. tests that never disconnect) simply leaves in-flight predicates until timeout.
   */
  onDisconnect?(listener: () => void): () => void;
}

async function matchOnce(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
): Promise<MatchResult> {
  const res = await session.command(ReticleCommand.MATCH, { query, state });
  if (!res.ok) return { matched: false, count: 0, elements: [] };
  return (res.result ?? { matched: false, count: 0, elements: [] }) as MatchResult;
}

async function evalElement(
  session: PredicateSession,
  query: ElementQuery,
  state: ElementState | undefined,
  absent: boolean,
  diagnose: boolean,
): Promise<EvalResult> {
  const match = await matchOnce(session, query, state);
  const subject = JSON.stringify(query);
  // A given-but-missing scope is handled ASYMMETRICALLY, because "absent" and "present" ask different
  // questions of a scope that no longer exists:
  //  - ABSENT: an element is trivially absent from a container that isn't there. This is also the
  //    everyday "wait for the #overlay/#spinner/#modal to disappear" pattern (scope the wait to the
  //    node being removed) — treating scopeMissing as a hard fail there burned the whole timeout and
  //    flipped a correct green to red. So scopeMissing satisfies an absence check.
  //  - PRESENT: you cannot confirm an element is present inside a scope that resolved to nothing, and
  //    silently widening to the whole page is the original false green. So scopeMissing FAILS presence
  //    (on the wait_for path this just keeps polling until the scope appears).
  if (absent) {
    if (match.scopeMissing === true) {
      return { pass: true, evidence: { absent: true, scopeMissing: true } };
    }
    return match.matched
      ? {
          pass: false,
          failureReason: `expected element to be absent but found ${String(match.count)}`,
          observed: `${String(match.count)} element(s) matching ${subject}`,
          expected: `no element matching ${subject}`,
          assertion: 'element.absent',
          evidence: match.elements,
        }
      : { pass: true, evidence: { absent: true } };
  }
  if (match.scopeMissing === true) {
    return {
      pass: false,
      failureReason: `scope resolved to no element — cannot confirm ${subject} is present`,
      observed: 'the requested scope is not on the page (unmounted or selector matched nothing)',
      expected: `an element matching ${subject} within an existing scope`,
      assertion: 'element.present',
      evidence: { scopeMissing: true },
    };
  }
  if (match.matched) return { pass: true, evidence: match.elements };

  // The near-miss diagnostic below costs one or two EXTRA MATCH round-trips. It only enriches a FAILED
  // verdict, and a wait loop's interim rechecks read nothing but `pass` — so on the poll path (diagnose
  // false) skip straight to the plain fail. Under an event flood a role+name element wait was firing
  // two live-DOM scans per recheck for a diagnostic no interim eval ever reads; the final timeout eval
  // still runs with diagnose=true and produces the full near-miss.
  if (!diagnose) {
    return {
      pass: false,
      failureReason: `no element matched ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
      observed: 'no matching element on the page',
      expected: `an element matching ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
      assertion: 'element.present',
    };
  }

  // Diagnostic near-miss: was it there but in the wrong state, or a similar element present?
  if (state !== undefined) {
    const relaxed = await matchOnce(session, query, undefined);
    if (relaxed.matched) {
      return {
        pass: false,
        failureReason: `element exists but not in state '${state}'`,
        observed: `element matching ${subject} is present, states: ${
          relaxed.elements[0]?.states.join(', ') ?? 'unknown'
        }`,
        expected: `element matching ${subject} in state '${state}'`,
        assertion: 'element.state',
        evidence: { nearMiss: relaxed.elements },
      };
    }
  }
  if (query.role !== undefined && query.name !== undefined) {
    const roleOnly = await matchOnce(session, { role: query.role }, state);
    if (roleOnly.matched) {
      return {
        pass: false,
        failureReason: `no '${query.role}' named '${query.name}'; saw: ${roleOnly.elements
          .map((e) => e.name)
          .filter((n) => n.length > 0)
          .join(', ')}`,
        observed: `${String(roleOnly.count)} '${query.role}' element(s), named: ${roleOnly.elements
          .map((e) => e.name)
          .filter((n) => n.length > 0)
          .join(', ')}`,
        expected: `a '${query.role}' named '${query.name}'`,
        assertion: 'element.role+name',
        evidence: { nearMiss: roleOnly.elements },
      };
    }
  }
  return {
    pass: false,
    failureReason: `no element matched ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
    observed: 'no matching element on the page',
    expected: `an element matching ${subject}${state === undefined ? '' : ` in state '${state}'`}`,
    assertion: 'element.present',
  };
}

async function evalState(
  session: PredicateSession,
  p: Extract<Predicate, { kind: 'state' }>,
): Promise<EvalResult> {
  const res = await session.command(
    ReticleCommand.STATE_READ,
    p.store !== undefined ? { store: p.store } : {},
  );
  if (!res.ok) {
    return {
      pass: false,
      failureReason: 'state read failed',
      observed: 'the store could not be read',
      expected: 'a readable registered store',
      assertion: 'state.unreadable',
    };
  }
  const stores = ((res.result ?? {}) as { stores?: Record<string, unknown> }).stores ?? {};
  const names = Object.keys(stores);
  const storeName = p.store ?? (names.length === 1 ? names[0] : undefined);
  if (storeName === undefined) {
    return {
      pass: false,
      failureReason:
        names.length === 0
          ? 'no registered store to read state from'
          : `multiple stores (${names.join(', ')}); name one with \`store\``,
    };
  }
  const selection = selectPath(stores[storeName], p.path);
  if (!selection.found) {
    return {
      pass: false,
      failureReason: `state path '${p.path}' not found in store '${storeName}'`,
      observed: `no path '${p.path}' in store '${storeName}'`,
      expected: `store '${storeName}' to expose '${p.path}'`,
      assertion: 'state.path-missing',
      evidence: { availableKeys: selection.availableKeys },
    };
  }
  const want = p.equals === undefined ? '*' : p.equals;
  if (matchValue(selection.value, want)) {
    return {
      pass: true,
      evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
    };
  }
  return {
    pass: false,
    failureReason: `state '${p.path}' is ${JSON.stringify(capDepth(selection.value, 0))}, expected ${JSON.stringify(want)}`,
    observed: `${p.path} = ${JSON.stringify(capDepth(selection.value, 0))}`,
    expected: `${p.path} = ${JSON.stringify(want)}`,
    assertion: 'state.equals',
    evidence: { store: storeName, path: p.path, value: capDepth(selection.value, 1) },
  };
}

export async function evaluatePredicate(
  session: PredicateSession,
  predicate: Predicate,
  since = 0,
  // Compute the (extra-round-trip) near-miss diagnostics on element failures. Default true so a
  // one-shot assert is fully diagnostic; the wait loop passes false on its interim polls (which read
  // only `pass`) and true on the final timeout eval, so a flood no longer pays for a diagnostic nobody
  // reads. Only element/text failures have a near-miss; everything else ignores this.
  diagnose = true,
): Promise<EvalResult> {
  const events = session.eventsSince(since);
  switch (predicate.kind) {
    case 'element':
      return evalElement(
        session,
        predicate.query,
        predicate.state,
        predicate.absent ?? false,
        diagnose,
      );
    case 'text':
      return evalElement(
        session,
        { text: predicate.contains },
        predicate.visible === true ? ElementState.VISIBLE : undefined,
        predicate.absent ?? false,
        diagnose,
      );
    case 'net':
      return evalNet(events, predicate);
    case 'route':
      return evalRoute(events, predicate);
    case 'console':
      return evalConsole(events, predicate);
    case 'animation':
      return evalAnimation(events, predicate);
    case 'signal':
      return evalSignal(events, predicate);
    case 'state':
      return evalState(session, predicate);
    case 'settled': {
      // Drop events on learned-ambient regions (chat/ticker churn) before the settle check — by ref
      // alone, NOT by attribution: window-attribution ("happened during the action window") is a time
      // heuristic, never causation, so a chat message arriving mid-window must not hold settle open.
      const counts = session.ambientCounts?.();
      const settleEvents =
        counts === undefined ? events : events.filter((e) => !isAmbient(counts, ambientKeyOf(e)));
      return evalSettled(settleEvents, predicate, session.elapsed());
    }
    case 'allOf': {
      const results = await Promise.all(
        predicate.predicates.map((p) => evaluatePredicate(session, p, since, diagnose)),
      );
      const failed = results.find((r) => !r.pass);
      return failed === undefined
        ? { pass: true, evidence: results.map((r) => r.evidence) }
        : {
            pass: false,
            failureReason: failed.failureReason ?? 'a sub-predicate of allOf failed',
            evidence: results,
          };
    }
    case 'anyOf': {
      const results = await Promise.all(
        predicate.predicates.map((p) => evaluatePredicate(session, p, since, diagnose)),
      );
      const passed = results.find((r) => r.pass);
      return passed !== undefined
        ? { pass: true, evidence: passed.evidence }
        : { pass: false, failureReason: 'no sub-predicate of anyOf matched', evidence: results };
    }
    case 'not': {
      const inner = await evaluatePredicate(session, predicate.predicate, since, diagnose);
      return inner.pass
        ? { pass: false, failureReason: 'negated predicate unexpectedly held', evidence: inner }
        : { pass: true };
    }
    default:
      return { pass: false, failureReason: 'unknown predicate' };
  }
}

/** Backstop poll cadence — guarantees a re-check even if no event fires (e.g. a `settled` wait). */
const POLL_INTERVAL_MS = 150;
/** Minimum gap between consecutive event-driven rechecks, so an event flood can't drive back-to-back
 *  DOM/STATE round-trips. Small enough that added pass-detection latency is negligible next to the
 *  poll cadence, large enough to collapse a per-frame event storm into a bounded recheck rate. */
const MIN_RECHECK_GAP_MS = 25;

/**
 * How long an exact-count predicate keeps watching AFTER it first reads true.
 *
 * A count only rises while a window is open, so "exactly N" is a statement about the END of one and
 * cannot be settled early — yet every wait here resolves the moment a check passes. Live, on a real
 * payments dashboard: a Refund confirm fired TWO POSTs 59 ms apart, and
 * `until: { kind:'net', method:'POST', urlContains:'/refund', count:1 }` returned
 * `pass: true, matched: 1`. Not a counting bug — `evalNet` counts occurrences correctly. The wait had
 * already stopped looking. So `count: 1` silently meant "at least 1", which is the assertion the
 * caller wrote `count` specifically to avoid, and the branch implementing it claims to catch "the
 * double-submit / useEffect-double-fire / retry-storm regression class".
 *
 * 300 ms is chosen against the measured defect: the observed double-submit gap was 59 ms, a React
 * double-effect fires within one commit, and a retry storm is faster still. It is a real ceiling, not
 * a proof — a duplicate arriving 400 ms later still passes. Widening it costs every exact-count
 * assertion that latency, so this trades an unbounded false green for a bounded one and says so.
 */
const COUNT_CONFIRM_MS = 300;

/**
 * Does this predicate assert an exact cardinality anywhere inside it?
 *
 * Only these hold after passing. A presence-only predicate ("at least one") IS satisfiable early and
 * must stay that way, or every ordinary wait pays the confirmation delay for nothing.
 */
function assertsExactCount(predicate: Predicate): boolean {
  if (predicate.kind === 'allOf' || predicate.kind === 'anyOf') {
    return predicate.predicates.some(assertsExactCount);
  }
  if (predicate.kind === 'not') return assertsExactCount(predicate.predicate);
  return predicate.kind === 'net' && predicate.count !== undefined;
}

/**
 * Evaluate now, else wait for it to become true (on each event + a poll) until timeout. `since` is
 * the event-time floor (see evaluatePredicate) so a waiter cannot resolve on a stale buffered event.
 */
export function waitForPredicate(
  session: PredicateSession,
  predicate: Predicate,
  timeoutMs: number,
  since = 0,
): Promise<EvalResult> {
  return new Promise<EvalResult>((resolve) => {
    let done = false;
    const failed = (error: unknown): EvalResult => ({
      pass: false,
      failureReason: error instanceof Error ? error.message : String(error),
    });
    let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
    // An exact-count wait keeps watching after it first reads true — see COUNT_CONFIRM_MS.
    const holdsForCount = assertsExactCount(predicate);
    let confirming = false;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: EvalResult): void => {
      if (done) return;
      done = true;
      unsub();
      unsubDisconnect?.();
      clearInterval(interval);
      clearTimeout(timer);
      if (cooldownTimer !== undefined) clearTimeout(cooldownTimer);
      if (confirmTimer !== undefined) clearTimeout(confirmTimer);
      resolve(result);
    };
    // Coalesce re-checks: at most ONE evaluatePredicate is ever in flight (each can be a browser
    // MATCH/STATE_READ round-trip). Events that arrive while one is running set a single trailing
    // re-check instead of each firing their own command — otherwise a page emitting an event per
    // animation frame fans out hundreds of concurrent round-trips and collapses under backpressure.
    //
    // Beyond coalescing, PACE the trailing rechecks: without a gap the next eval fired the instant the
    // previous finished, so under an event flood one round-trip was permanently in flight (~184/sec at
    // 5ms RTT) — each a live-DOM scan on the app's main thread, the "the dashboard is janky while the
    // agent waits" case. The FIRST check on an idle loop still runs immediately (leading edge, so fast
    // detection is unchanged); only back-to-back rechecks under sustained load wait MIN_RECHECK_GAP_MS.
    let inFlight = false;
    let cooling = false;
    let pendingRecheck = false;
    const check = (): void => {
      if (done) return;
      if (inFlight || cooling) {
        pendingRecheck = true;
        return;
      }
      inFlight = true;
      // Interim poll: read only `pass`, so skip the extra near-miss round-trips (diagnose=false). The
      // final timeout eval below runs with full diagnostics.
      void evaluatePredicate(session, predicate, since, false)
        .then((r) => {
          if (!r.pass) return;
          // "Exactly N" cannot be concluded from a passing sample — the count can still rise. Hold,
          // re-evaluate WITH diagnostics, and let that second read be the verdict: if an N+1th
          // arrived in the meantime it now fails, carrying observed/expected rather than a bare no.
          if (!holdsForCount) {
            finish(r);
            return;
          }
          if (confirming) return;
          confirming = true;
          confirmTimer = setTimeout(() => {
            void evaluatePredicate(session, predicate, since)
              .then(finish)
              .catch((error: unknown) => {
                finish(failed(error));
              });
          }, COUNT_CONFIRM_MS);
        })
        .catch((error: unknown) => {
          finish(failed(error));
        })
        .finally(() => {
          inFlight = false;
          if (done) return;
          // Enter a short cooldown; process a coalesced recheck when it ends. The 150ms poll is the
          // backstop, so a missed trailing edge is caught within one interval regardless.
          cooling = true;
          cooldownTimer = setTimeout(() => {
            cooling = false;
            if (pendingRecheck && !done) {
              pendingRecheck = false;
              check();
            }
          }, MIN_RECHECK_GAP_MS);
        });
    };
    const unsub = session.onEvent(() => {
      check();
    });
    const unsubDisconnect = session.onDisconnect?.(() => {
      finish({ pass: false, failureReason: 'session disconnected' });
    });
    const interval = setInterval(check, POLL_INTERVAL_MS);
    const timer = setTimeout(() => {
      void evaluatePredicate(session, predicate, since)
        .then((r) => {
          // Spread the near-miss, do NOT hand-copy two fields. The oracle computes observed / expected
          // / assertion — the structured cause the repair literature ranks above prose — and the old
          // `{ pass, evidence, failureReason }` construction DISCARDED them on every timed-out wait and
          // assert. So the highest-value localization signal was computed and then thrown away exactly
          // on the failure path where it matters, no matter what the schema declared.
          finish({
            ...r,
            pass: false,
            failureReason: r.failureReason ?? 'timed out waiting for predicate',
          });
        })
        .catch((error: unknown) => {
          finish(failed(error));
        });
    }, timeoutMs);
    check();
  });
}

/**
 * The ExpectedLinks a GREEN verdict actually PROVED — not merely the ones it declared. Identical to
 * predicateToExpectedLinks except for `anyOf`: an OR greens on a SINGLE branch, so only the branch that
 * held may contribute its link. Grading a green anyOf off the declared links would let the honesty grade
 * claim a signal/net consequence that was only one of the options and never fired — and a `minGrade:net`
 * gate would then trust a verdict that proved nothing but presence. That is the exact false green the
 * grade exists to prevent, sitting inside the grade itself.
 *
 * Call ONLY on a green verdict: a leaf and every `allOf` branch are returned unconditionally because a
 * green top verdict guarantees they held (allOf needs all; a bare leaf IS the verdict). Only anyOf, where
 * green ⇏ this-branch-held, re-checks each branch and keeps the winners.
 */
export async function provenExpectedLinks(
  session: PredicateSession,
  predicate: Predicate,
  since = 0,
): Promise<ExpectedLink[]> {
  if (predicate.kind === 'allOf') {
    const per = await Promise.all(
      predicate.predicates.map((p) => provenExpectedLinks(session, p, since)),
    );
    return per.flat();
  }
  if (predicate.kind === 'anyOf') {
    const per = await Promise.all(
      predicate.predicates.map(async (p) =>
        (await evaluatePredicate(session, p, since)).pass
          ? provenExpectedLinks(session, p, since)
          : [],
      ),
    );
    return per.flat();
  }
  return predicateToExpectedLinks(predicate);
}
