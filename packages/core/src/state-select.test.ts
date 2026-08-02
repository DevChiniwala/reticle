import { describe, it, expect } from 'vitest';
import { selectPath, capDepth } from './state-select.js';

describe('selectPath', () => {
  it('walks object keys and numeric array indices', () => {
    const root = { items: [{ id: 1 }, { id: 2 }] };
    expect(selectPath(root, 'items.1.id')).toEqual({ found: true, value: 2 });
  });

  it('reports found:false + availableKeys on a missing key', () => {
    const r = selectPath({ a: 1, b: 2 }, 'c');
    expect(r.found).toBe(false);
    expect(r.availableKeys).toEqual(['a', 'b']);
  });

  it('reports found:false for an out-of-range array index', () => {
    expect(selectPath({ xs: [10] }, 'xs.5').found).toBe(false);
  });

  it('rejects non-canonical numeric segments — 01 / 1e0 / " 1" are not array index 1', () => {
    const root = { xs: [10, 20, 30] };
    expect(selectPath(root, 'xs.1')).toEqual({ found: true, value: 20 }); // canonical still works
    for (const seg of ['01', '1e0', ' 1', '+1', '1.0']) {
      expect(selectPath(root, `xs.${seg}`).found, `xs.${seg} must not resolve to index 1`).toBe(
        false,
      );
    }
  });

  it('bounds availableKeys on a miss — a huge store does not return every key in the error', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 500; i++) wide[`k${String(i)}`] = i;
    const r = selectPath(wide, 'nope');
    expect(r.found).toBe(false);
    expect(r.availableKeys?.length).toBeLessThanOrEqual(50);
  });

  it('cannot reach a key that literally contains a dot (documented ambiguity)', () => {
    // 'v3.0' splits into ['v3','0'] — a float-looking key is unreachable via dot-path.
    expect(selectPath({ 'v3.0': { text: 'x' } }, 'v3.0.text').found).toBe(false);
  });

  it('returns the whole root for an empty path', () => {
    expect(selectPath({ a: 1 }, '')).toEqual({ found: true, value: { a: 1 } });
  });

  it('does NOT resolve prototype-chain keys — constructor/__proto__/toString are not state paths', () => {
    // `in` walked the prototype, so a typo'd path shadowing a builtin returned found:true against a
    // function from Object.prototype, and a state assertion on it silently passed. Only OWN keys count.
    for (const proto of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(selectPath({ a: 1 }, proto).found, `${proto} must not be found`).toBe(false);
    }
    // A real own key that happens to be named like a builtin is still reachable.
    expect(selectPath({ toString: 42 }, 'toString')).toEqual({ found: true, value: 42 });
  });
});

describe('selectPath — Map support', () => {
  it('walks into a Map by string key', () => {
    const state = { byId: new Map([['a', { name: 'alice' }]]) };
    expect(selectPath(state, 'byId.a.name')).toEqual({ found: true, value: 'alice' });
  });

  it('reports available Map keys on a miss', () => {
    const state = {
      byId: new Map([
        ['x', 1],
        ['y', 2],
      ]),
    };
    const r = selectPath(state, 'byId.z');
    expect(r.found).toBe(false);
    expect(r.availableKeys).toContain('x');
    expect(r.availableKeys).toContain('y');
  });

  it('returns the Map itself when the path stops at it', () => {
    const m = new Map([['k', 'v']]);
    expect(selectPath({ m }, 'm')).toEqual({ found: true, value: m });
  });

  it('only reports string keys in availableKeys for a Map (non-string keys omitted)', () => {
    const m = new Map<unknown, number>([
      ['str', 1],
      [42, 2],
      [Symbol('s'), 3],
    ]);
    const r = selectPath({ m }, 'm.missing');
    expect(r.found).toBe(false);
    expect(r.availableKeys).toEqual(['str']);
  });
});

describe('capDepth — Date/Map/Set handling', () => {
  it('treats Date as a leaf and returns its ISO string at any depth', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(capDepth(d, 0)).toBe('2026-01-01T00:00:00.000Z');
    expect(capDepth({ t: d }, 1)).toEqual({ t: '2026-01-01T00:00:00.000Z' });
  });

  it('degrades an invalid Date to null instead of throwing', () => {
    expect(capDepth(new Date(NaN), 0)).toBeNull();
    expect(capDepth({ t: new Date('invalid') }, 1)).toEqual({ t: null });
  });

  it('converts a Set to an array with depth capping', () => {
    const s = new Set(['a', 'b']);
    expect(capDepth(s, 1)).toEqual(['a', 'b']);
    expect(capDepth(s, 0)).toBe('[Set(2)]');
  });

  it('converts a Map to an object with depth capping', () => {
    const m = new Map<string, unknown>([['x', { nested: 1 }]]);
    expect(capDepth(m, 2)).toEqual({ x: { nested: 1 } });
    expect(capDepth(m, 1)).toEqual({ x: '{…1 keys}' });
    expect(capDepth(m, 0)).toBe('{Map(1)}');
  });

  it('recurses through nested Date/Map/Set correctly', () => {
    const state = {
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      selected: new Set(['a', 'b']),
      byId: new Map([['a', 1]]),
      n: 5,
    };
    const capped = capDepth(state, 3);
    expect(capped).toEqual({
      updatedAt: '2026-01-01T00:00:00.000Z',
      selected: ['a', 'b'],
      byId: { a: 1 },
      n: 5,
    });
  });
});

describe('capDepth', () => {
  it('a negative budget means no cap (value returned unchanged)', () => {
    const deep = { a: { b: { c: 1 } } };
    expect(capDepth(deep, -1)).toEqual(deep);
  });

  it('maxDepth 0 collapses objects and arrays to size markers', () => {
    expect(capDepth({ a: 1, b: 2 }, 0)).toBe('{…2 keys}');
    expect(capDepth([1, 2, 3], 0)).toBe('[Array(3)]');
  });

  it('prunes only past the budget', () => {
    expect(capDepth({ a: { b: 1 } }, 1)).toEqual({ a: '{…1 keys}' });
    expect(capDepth({ a: { b: 1 } }, 2)).toEqual({ a: { b: 1 } });
  });
});
