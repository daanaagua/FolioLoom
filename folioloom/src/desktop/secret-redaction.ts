const SECRET_FIELD = [
  "authorization",
  "proxy[-_ ]?authorization",
  "x[-_ ]?api[-_ ]?key",
  "api[-_ ]?key",
  "access[-_ ]?token",
  "refresh[-_ ]?token",
  "x[-_ ]?amz[-_ ]?security[-_ ]?token",
  "token",
  "client[-_ ]?secret",
  "secret",
  "password",
].join("|");

/**
 * Matches plain headers as well as JSON and escaped-JSON fields, for example:
 * `x-api-key: abc`, `{"apiKey":"abc"}`, and `{\"Authorization\":\"Bearer abc\"}`.
 */
const SECRET_ASSIGNMENT = new RegExp(
  `((?:\\\\?["'])?\\b(?:${SECRET_FIELD})(?:\\\\?["'])?\\s*[:=]\\s*)`
    + `(?:(\\\\?["'])(?:(?!\\2)[\\s\\S])*?\\2|(?:bearer\\s+)?[^\\s,;}\\]]+)`,
  "giu",
);

const BEARER_VALUE = /\b(Bearer\s+)[^\s,;}\]"']+/giu;
const QUERY_SECRET = /([?&](?:api[-_]?key|access[-_]?token|token|key|secret)=)[^&#\s]+/giu;
const COMMON_KEY_PREFIX = /\b(?:sk|ak)-[A-Za-z0-9_-]{4,}\b/gu;

export function redactSecrets(value: string, marker = "[REDACTED]"): string {
  return value
    .replace(SECRET_ASSIGNMENT, (_match, prefix: string, quote: string | undefined) => (
      quote === undefined ? `${prefix}${marker}` : `${prefix}${quote}${marker}${quote}`
    ))
    .replace(BEARER_VALUE, `$1${marker}`)
    .replace(QUERY_SECRET, `$1${marker}`)
    .replace(COMMON_KEY_PREFIX, marker);
}
