/**
 * Redaction for the diagnostics export.
 *
 * A diagnostics file is the one artifact a user is expected to send to somebody else, so it must not
 * carry what the vault carries. This is deliberately a text scrub rather than a structural one: logs
 * and error messages are free-form and the patterns below are the shapes credentials actually take.
 */
export function redact(text) {
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[=:]\s*)\S+/gi, '$1[redacted]');
}
