export type DiagnosticSource =
  | 'PROJECT_CREATE'
  | 'STRIPE_CONNECT'
  | 'OFFER_ACCEPT'
  | 'JOB_CREATE'
  | 'PAYMENT_INIT'
  | 'SHARED_SUBMIT'
  | 'SUPABASE_INSERT'
  | 'CONNECT_STATUS'

export type RuntimeDiagnostic = {
  source: DiagnosticSource
  step: string
  name?: string
  message: string
  code?: string | number | null
  details?: unknown
  hint?: string | null
  raw: string
}

type ExtractedError = {
  message: string
  code?: string | number | null
  details?: unknown
  hint?: string | null
  raw: string
}

function safeSerialize(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`
  }
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'

  try {
    return JSON.stringify(
      value,
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    )
  } catch {
    return String(value)
  }
}

export function extractError(error: unknown): ExtractedError {
  if (error instanceof Error) {
    const errWithMeta = error as Error & {
      code?: string | number
      details?: unknown
      hint?: string
    }
    return {
      message: error.message || error.name || 'Unbekannter Fehler',
      code: errWithMeta.code ?? null,
      details: errWithMeta.details,
      hint: errWithMeta.hint,
      raw: safeSerialize(error),
    }
  }

  if (typeof error === 'string') {
    return {
      message: error,
      code: null,
      details: undefined,
      hint: null,
      raw: error,
    }
  }

  if (typeof error === 'object' && error !== null) {
    const obj = error as {
      message?: string
      code?: string | number
      details?: unknown
      hint?: string
    }
    const message = obj.message || 'Unbekannter Fehler'
    return {
      message,
      code: obj.code ?? null,
      details: obj.details,
      hint: obj.hint,
      raw: safeSerialize(error),
    }
  }

  return {
    message: 'Unbekannter Fehler',
    code: null,
    details: undefined,
    hint: null,
    raw: safeSerialize(error),
  }
}

export function buildDiagnostic(params: {
  source: DiagnosticSource
  step: string
  name?: string
  error?: unknown
  message?: string
  code?: string | number | null
  details?: unknown
  hint?: string | null
}): RuntimeDiagnostic {
  const extracted = extractError(params.error)
  return {
    source: params.source,
    step: params.step,
    name: params.name,
    message: params.message ?? extracted.message,
    code: params.code ?? extracted.code ?? null,
    details: params.details ?? extracted.details,
    hint: params.hint ?? extracted.hint ?? null,
    raw: extracted.raw,
  }
}

export function emitDiagnostic(diagnostic: RuntimeDiagnostic): void {
  // Structured console output keeps diagnostics easy to scan and filter.
  console.error('[SaFix][diagnostic]', diagnostic)
}

/**
 * Extracts a human-readable error message from any thrown value.
 *
 * Handles:
 *   - Error instances  → error.message
 *   - Strings          → the string itself
 *   - Plain objects with `.message` (e.g. Supabase PostgrestError) → obj.message
 *   - Anything else    → JSON serialization or fallback
 *
 * This prevents `String(err)` from producing `[object Object]` when the
 * thrown value is a plain object (common with Supabase/PostgREST errors).
 */
export function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>
    if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message
    try {
      return JSON.stringify(err)
    } catch {
      return 'Unbekannter Fehler'
    }
  }
  return String(err)
}
