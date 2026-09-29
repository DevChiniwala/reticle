import { expect, it } from 'vitest';
import type { CommandResult, MatchResult } from '@reticlehq/core';

import { evalElement, ARIA_HIDDEN_NOTE } from './predicate-element.js';
import type { PredicateSession } from './predicate-session.js';

const session: PredicateSession = {
  command(name) {
    throw new Error(`invalid element query reached the browser: ${name}`);
  },
  eventsSince: () => [],
  onEvent: () => () => undefined,
  elapsed: () => 0,
};

/** A fake session whose `command` returns a sequence of scripted MatchResults. */
function scriptedSession(results: MatchResult[]): PredicateSession {
  let call = 0;
  return {
    command: () => {
      const result = results[call++];
      return Promise.resolve({ ok: true, result } as unknown as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

it('maps the query-tool role spelling in direct element evaluation', async () => {
  const result = await evalElement(
    session,
    { by: 'role', role: 'button', name: 'Save' },
    undefined,
    false,
    true,
  );
  expect(result.inconclusive).toContain('{"by":"role","value":"button","name":"Save"}');
  expect(result.inconclusive).toContain('{"role":"button","name":"Save"}');
});

it('names the aria-hidden exclusion on a terminal text miss', async () => {
  const miss: MatchResult = {
    matched: false,
    count: 0,
    elements: [],
    hint: {
      route: '/',
      presentTestids: [],
      presentRegions: [],
      knownEmptyState: false,
      ariaHiddenMatch: { ref: 'e1', role: 'text', name: '', states: [], visible: false },
    },
  };
  const result = await evalElement(scriptedSession([miss]), { text: 'F' }, undefined, false, true);
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain(ARIA_HIDDEN_NOTE);
});

it('names the aria-hidden exclusion on a state near-miss', async () => {
  const miss: MatchResult = {
    matched: false,
    count: 0,
    elements: [],
    hint: {
      route: '/',
      presentTestids: [],
      presentRegions: [],
      knownEmptyState: false,
      ariaHiddenMatch: { ref: 'e1', role: 'text', name: '', states: [], visible: false },
    },
  };
  const relaxed: MatchResult = {
    matched: true,
    count: 1,
    elements: [{ ref: 'e1', role: 'text', name: '', states: ['hidden'], visible: false }],
  };
  const result = await evalElement(
    scriptedSession([miss, relaxed]),
    { text: 'F' },
    'visible',
    false,
    true,
  );
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain(ARIA_HIDDEN_NOTE);
  expect(result.failureReason).toContain("not in state 'visible'");
});
