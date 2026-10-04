/**
 * Parse or refuse a value that should be a `Record<string, unknown>` at a tool-surface boundary.
 *
 * Some MCP clients stringify tool arguments (#1117), so `{ confirmDangerous: true }` arrives as
 * `"{\"confirmDangerous\":true}"`. `asRecord` in core silently returns `{}` for that, which is
 * correct for internal callers but destructive at the tool surface — the agent's input is thrown
 * away. This helper sits at the three boundaries where that happens (act-tools, act-sequence-tool,
 * dynamic-tools) and either parses the string or refuses it with a clear message.
 */
export function coerceRecord(value: unknown, label: string): Record<string, unknown> {
  if ('object' === typeof value && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if ('string' === typeof value) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(
        `${label} is a string, not an object — if the value was meant as JSON, it is not valid: ${value}`,
      );
    }
    if ('object' === typeof parsed && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(
      `${label} parsed as JSON but is ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object`,
    );
  }
  if (undefined === value || null === value) return {};
  throw new Error(`${label} must be an object, got ${typeof value}`);
}
