/**
 * Converts an unknown thrown/rejected value into a human-readable string so
 * the bootstrap error screen always displays the real failure reason instead
 * of the unhelpful "[object Object]" that String() produces for plain objects.
 *
 * Priority order:
 *  1. Error instance          → use .message
 *  2. Object with .message    → use .message
 *  3. Object with .error      → use .error (string or recursive)
 *  4. Object with structured  → format code / details / hint / status fields
 *  5. Other plain object      → safe JSON serialization
 *  6. Anything else           → String() coercion (handles primitives)
 */
export function formatBootstrapError(e: unknown): string {
  if (e instanceof Error) {
    return e.message
  }

  if (e !== null && typeof e === 'object') {
    const obj = e as Record<string, unknown>

    if (typeof obj['message'] === 'string' && obj['message']) {
      return obj['message']
    }

    if (obj['error'] !== undefined) {
      return formatBootstrapError(obj['error'])
    }

    const parts: string[] = []
    if (obj['code'] !== undefined) parts.push(`code: ${String(obj['code'])}`)
    if (obj['status'] !== undefined) parts.push(`status: ${String(obj['status'])}`)
    if (obj['details'] !== undefined) parts.push(`details: ${String(obj['details'])}`)
    if (obj['hint'] !== undefined) parts.push(`hint: ${String(obj['hint'])}`)
    if (parts.length > 0) {
      return parts.join(', ')
    }

    try {
      return JSON.stringify(e)
    } catch {
      return String(e)
    }
  }

  return String(e)
}
