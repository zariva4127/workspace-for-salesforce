/**
 * Redaction helpers applied to anything that leaves the extension (exports,
 * copied reports) and to anything that might be logged.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Salesforce session IDs / access tokens: 00D<orgid>!<opaque>
  [/\b00D[a-zA-Z0-9]{12,15}![A-Za-z0-9._-]{20,}/g, '[REDACTED_SESSION]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=!-]{16,}/gi, 'Bearer [REDACTED]'],
  [/("?(?:access_token|refresh_token|id_token|client_secret|sid|password|code_verifier)"?\s*[:=]\s*"?)([^"&\s,}]+)/gi, '$1[REDACTED]'],
  // Salesforce refresh tokens (5Aep...) are long opaque strings starting with 5Aep.
  [/\b5Aep[A-Za-z0-9._]{40,}/g, '[REDACTED_TOKEN]'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]'],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface RedactOptions {
  emails?: boolean;
}

export function redact(text: string, options: RedactOptions = {}): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  if (options.emails) out = out.replace(EMAIL, '[REDACTED_EMAIL]');
  return out;
}

/** Query parameters that are safe and useful to keep in exported URLs. */
const SAFE_PARAMS = new Set(['flowId', 'id', 'tab', 'filterName']);

/**
 * Removes query parameters (except an allowlist) and fragments that could carry
 * tokens (e.g. `#access_token=`), keeping the path so reports stay useful.
 */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const kept = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (SAFE_PARAMS.has(k)) kept.set(k, v);
    const qs = kept.toString();
    return `${u.origin}${u.pathname}${qs ? `?${qs}` : ''}`;
  } catch {
    return redact(url);
  }
}
