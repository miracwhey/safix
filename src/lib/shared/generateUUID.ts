/**
 * Central UUID v4 generator.
 *
 * Every entity ID that targets a Postgres UUID column MUST use this helper
 * (or the equivalent DB-default `gen_random_uuid()`).
 *
 * Using it from a single location makes it trivial to audit / grep that
 * no runtime path accidentally introduces string-template IDs like
 * `job-…` or `offer-…`.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  // Fallback for environments without crypto.randomUUID (older runtimes).
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }

  // Per RFC 4122 variant 1, version 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

/**
 * Validates that a string is a well-formed UUID (any version, RFC 4122).
 */
export function isValidUUID(value: string): boolean {
  return UUID_RE.test(value.trim())
}
