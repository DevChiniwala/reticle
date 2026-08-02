/**
 * reticle_state path selection + depth capping — pure, shared by the browser SDK (which applies them
 * BEFORE the transport so a scoped read of a huge store isn't truncated) and the server (back-compat
 * fallback when an older browser returns the whole store). `selectPath` walks a dot-path (with numeric
 * array indices) and, on a miss, returns the keys that WERE available at the last good level so a wrong
 * path is diagnosable rather than a bare null. `capDepth` prunes deeply-nested values to a budget.
 */

/** Result of walking a dot-path: the value, or a near-miss with the keys available where it stopped. */
export interface PathSelection {
  found: boolean;
  value: unknown;
  /** On a miss: the keys present at the deepest level reached (so the agent can correct the path). */
  availableKeys?: string[];
}

/** Cap on how many near-miss keys travel in a failed selection — a 10k-key store must not return a
 *  10k-entry array in the error payload (that was the token blowup the near-miss exists to avoid). */
const MAX_AVAILABLE_KEYS = 50;

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.slice(0, MAX_AVAILABLE_KEYS).map((_, i) => String(i));
  if (value instanceof Map) {
    const out: string[] = [];
    for (const k of value.keys()) {
      if (typeof k === 'string') out.push(k);
      if (out.length >= MAX_AVAILABLE_KEYS) break;
    }
    return out;
  }
  if (typeof value === 'object' && value !== null)
    return Object.keys(value).slice(0, MAX_AVAILABLE_KEYS);
  return [];
}

/** Walk `path` (e.g. "captionCache.v3.0.text") into `root`. Empty path returns root unchanged. */
export function selectPath(root: unknown, path: string): PathSelection {
  const segments = path.split('.').filter((s) => s.length > 0);
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      // Require a CANONICAL index string. `Number('01')`/`Number('1e0')`/`Number(' 1')` all coerce to 1,
      // so `items.01` silently read index 1 — an assertion on a path that doesn't exist quietly passed.
      // `String(index) === segment` accepts only "0","1","2",… and rejects the coercion aliases.
      const index = Number(segment);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        String(index) !== segment ||
        index >= current.length
      ) {
        return { found: false, value: null, availableKeys: keysOf(current) };
      }
      current = current[index];
      continue;
    }
    if (current instanceof Map) {
      if (current.has(segment)) {
        current = current.get(segment);
        continue;
      }
      return { found: false, value: null, availableKeys: keysOf(current) };
    }
    // `Object.hasOwn`, not `in`: `in` walks the prototype, so a path segment of `constructor`,
    // `__proto__`, or `toString` reported found:true and returned a function from Object.prototype —
    // a state assertion on a typo'd path silently passed against a builtin instead of failing with
    // availableKeys. Only an OWN key is a real state path.
    if (typeof current === 'object' && current !== null && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return { found: false, value: null, availableKeys: keysOf(current) };
  }
  return { found: true, value: current };
}

/**
 * Prune `value` to `maxDepth` levels: objects/arrays deeper than the budget collapse to a compact
 * placeholder string recording their size, so a huge store can be skimmed shape-first. A negative
 * budget means "no cap".
 */
export function capDepth(value: unknown, maxDepth: number): unknown {
  if (maxDepth < 0) return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Set) {
    if (maxDepth === 0) return `[Set(${String(value.size)})]`;
    return [...value].map((v) => capDepth(v, maxDepth - 1));
  }
  if (value instanceof Map) {
    if (maxDepth === 0) return `{Map(${String(value.size)})}`;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of value) out[String(k)] = capDepth(v, maxDepth - 1);
    return out;
  }
  if (Array.isArray(value)) {
    if (maxDepth === 0) return `[Array(${String(value.length)})]`;
    return value.map((v) => capDepth(v, maxDepth - 1));
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (maxDepth === 0) return `{…${String(keys.length)} keys}`;
    // Null-proto target: a wire object can carry an own `__proto__` key (via JSON.parse), and
    // `out['__proto__'] = …` on a normal object writes the prototype slot instead of a key, losing
    // that key from the projection. A prototype-less target makes every key an ordinary assignment.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys)
      out[key] = capDepth((value as Record<string, unknown>)[key], maxDepth - 1);
    return out;
  }
  return value;
}
