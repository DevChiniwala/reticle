import { describe, expect, it, beforeEach } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

function countOn(target: EventTarget, key: string): { counts: number[]; cleanup: () => void } {
  const counts: number[] = [];
  const handler = (e: Event): void => {
    if ((e as KeyboardEvent).key === key) counts.push(1);
  };
  target.addEventListener('keydown', handler);
  return { counts, cleanup: () => target.removeEventListener('keydown', handler) };
}

/**
 * #1084: an agent reported that `press` may dispatch a key twice. A counter driven by
 * `keydown` would read 2 instead of 1 — a silent double-fire that breaks any app counting
 * key presses and produces false passes on counter-based assertions.
 *
 * Four listener sites, because an app can bind on any of them and the bubbling path visits
 * all four: element → parent → document → window. One keydown dispatched with `bubbles: true`
 * visits each exactly once; two dispatches would visit each twice.
 */
describe('press dispatches exactly one keydown per call (#1084)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('element listener sees exactly one keydown', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const { counts, cleanup } = countOn(el, 'ArrowRight');
    try {
      await executeAction(refs.refFor(el), ActionType.PRESS, { text: 'ArrowRight' });
    } finally {
      cleanup();
    }
    expect(counts.length, 'element should see exactly 1 keydown').toBe(1);
  });

  it('document listener sees exactly one keydown (via bubbling)', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const { counts, cleanup } = countOn(document, 'ArrowRight');
    try {
      await executeAction(refs.refFor(el), ActionType.PRESS, { text: 'ArrowRight' });
    } finally {
      cleanup();
    }
    expect(counts.length, 'document should see exactly 1 keydown').toBe(1);
  });

  it('window listener sees exactly one keydown (via bubbling)', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const { counts, cleanup } = countOn(window, 'ArrowRight');
    try {
      await executeAction(refs.refFor(el), ActionType.PRESS, { text: 'ArrowRight' });
    } finally {
      cleanup();
    }
    expect(counts.length, 'window should see exactly 1 keydown').toBe(1);
  });

  it('all three sites see exactly one each from one press', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const onEl = countOn(el, 'ArrowRight');
    const onDoc = countOn(document, 'ArrowRight');
    const onWin = countOn(window, 'ArrowRight');
    try {
      await executeAction(refs.refFor(el), ActionType.PRESS, { text: 'ArrowRight' });
    } finally {
      onEl.cleanup();
      onDoc.cleanup();
      onWin.cleanup();
    }
    expect(onEl.counts.length, 'element').toBe(1);
    expect(onDoc.counts.length, 'document').toBe(1);
    expect(onWin.counts.length, 'window').toBe(1);
  });

  it('also exactly one keyup per press', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const ups: number[] = [];
    const handler = (e: KeyboardEvent): void => {
      if ('ArrowRight' === e.key) ups.push(1);
    };
    el.addEventListener('keyup', handler);
    try {
      await executeAction(refs.refFor(el), ActionType.PRESS, { text: 'ArrowRight' });
    } finally {
      el.removeEventListener('keyup', handler);
    }
    expect(ups.length, 'element should see exactly 1 keyup').toBe(1);
  });
});

/**
 * A document-key press (no ref, global: true) also dispatches exactly once.
 * The target is the focused element or body — one dispatch, not one per target.
 */
describe('refless document-key press dispatches exactly once (#1084)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('a focused input sees exactly one keydown from a refless press', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const { counts, cleanup } = countOn(input, 'Escape');
    try {
      await executeAction('', ActionType.PRESS, { text: 'Escape' });
    } finally {
      cleanup();
    }
    expect(counts.length, 'focused input should see exactly 1 keydown').toBe(1);
  });

  it('document sees exactly one from a refless press (not two: one targeted + one global)', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const { counts, cleanup } = countOn(document, 'Escape');
    try {
      await executeAction('', ActionType.PRESS, { text: 'Escape' });
    } finally {
      cleanup();
    }
    expect(counts.length, 'document should see exactly 1 keydown').toBe(1);
  });
});
