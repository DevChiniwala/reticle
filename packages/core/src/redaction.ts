import { REDACTED_VALUE } from './constants.js';

/**
 * Wire redaction rules — which field names carry credentials, and which VALUE shapes are secrets
 * regardless of the field they sit in.
 *
 * These live in core because they are a property of the wire, not of one side of it. They were
 * implemented in the browser SDK, which was the only consumer until the driven path began capturing
 * request bodies straight from the network stack — those are raw and unscrubbed, and duplicating a
 * security regex to redact them would be the worst possible place to have two copies drift.
 */
// `token` must match auth CREDENTIALS, not compound design fields. Bare/separated `token(s)` and
// auth-prefixed tokens (accessToken, auth_token, sessionToken, …) are redacted; `colorToken`,
// `backgroundToken`, `tokenCount`, `designToken` are NOT — they were false-positives that redacted
// legitimate reticle_inspect/reticle_state output.
// `token` must match auth CREDENTIALS, not compound design fields (see note above). `cookie` is
// boundary-anchored the same way: it targets the `Cookie` / `Set-Cookie` HTTP HEADER names (which
// bundle the session credential and were the one wire payload reaching the journal + the agent
// unredacted), NOT any key that merely contains the substring — `scopecookie`, `cookieConsent`,
// `cookiePolicy` are legitimate app values an agent may need to read, and stay visible.
const SENSITIVE_KEY =
  /password|passwd|passcode|secret|(?:(?:access|refresh|auth|bearer|api|id|session|csrf|client)[-_]?tokens?|(?:^|[-_])tokens?(?=$|[-_]))|session[-_]?id|(?:^|[-_])(?:sid|pwd|jwt)(?=$|[-_])|authorization|(?:^|[-_])(?:set[-_])?cookie(?=$|[-_])|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credit[-_]?card|card[-_]?number|cvv|cvc|ssn|(?:^|[-_])(?:signature|sig)$|(?:^|[-_])credential$|x-(?:amz|goog)-(?:signature|credential|security-token)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

// High-confidence credential SHAPES, redacted regardless of key name — for scanning body/value text where
// a secret can sit under a benign key (`{"note":"<jwt>"}`, `<meta content="sk_live_…">`). Deliberately
// narrow (JWT, known provider prefixes) so it never corrupts legitimate prose the way a broad
// entropy/length heuristic would.
const KNOWN_SECRET =
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9._-]{20,}/g;

/** Redact high-confidence secret shapes anywhere in a text/value, independent of any surrounding key. */
export function scrubKnownSecrets(text: string): string {
  return text.replace(KNOWN_SECRET, REDACTED_VALUE);
}
