// Shared secret-redaction utility for logs, notifications and error summaries.
// It removes credential material while preserving the surrounding message so
// operational meaning (and stack traces) stay readable.

export const REDACTED = '[REDACTED]';

const PATTERNS = [
  // PEM private keys (must run before the generic key=value rule).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
  // Authorization: Bearer <token> and bare "Bearer <token>".
  [/\b(authorization\s*[:=]\s*bearer)\s+[^\s,;]+/gi, `$1 ${REDACTED}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, `bearer ${REDACTED}`],
  // JSON Web Tokens (three base64url segments).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED],
  // key=value / key: value secret assignments.
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|smtp[_-]?password|private[_-]?key|auth[_-]?token|agent[_-]?key|encryption[_-]?key|webhook[_-]?secret)\b(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}\]]+)/gi,
    `$1$2${REDACTED}`,
  ],
  // Credentials embedded in database/connection URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@/\s]+(@)/gi, `$1${REDACTED}$2`],
  // Access tokens passed as query parameters.
  [/([?&](?:access_token|refresh_token|token|api_key|apikey|key|secret|password|signature|sig)=)[^&\s]+/gi, `$1${REDACTED}`],
];

/**
 * Redact secrets from a single string. Non-string input is returned unchanged
 * so callers can pass optional values safely.
 */
export function redactSecrets(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let output = value;
  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Redact a list of messages (deployment logs, notifications, etc.).
 */
export function redactMessages(messages) {
  return (messages || []).map((message) => redactSecrets(message));
}

/**
 * Line-buffered redaction for streaming output. Secrets can be split across
 * chunks, so only complete lines are redacted; the trailing partial line is
 * held back until the next chunk (or `flush`).
 */
export function createLineRedactor() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline === -1) return '';
      const complete = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      return redactSecrets(complete);
    },
    flush() {
      if (!buffer) return '';
      const remaining = redactSecrets(buffer);
      buffer = '';
      return remaining;
    },
  };
}
