import type { VercelRequest, VercelResponse } from '@vercel/node'
import { checkProductionGate, type GateScope } from './_env.js'
import { logWarning } from './_observability.js'

/**
 * Applies CORS headers to the response and handles OPTIONS preflight requests.
 *
 * Returns true when the response has already been sent — the caller must
 * return immediately (covers OPTIONS preflight AND production gate failures).
 *
 * Production gate (VERCEL_ENV=production):
 *   Validates env vars on first invocation per cold start.  The `gateScope`
 *   parameter controls which variables are required:
 *     - 'full' (default): all payment-critical secrets
 *     - 'core': only base infrastructure (Stripe key, Supabase, CORS origin)
 *
 * The allowed origin is read from the ALLOWED_ORIGIN environment variable.
 * It defaults to '*' in development so local dev servers work without extra
 * configuration.  In production, ALLOWED_ORIGIN is enforced by the gate and
 * must be set to the exact frontend origin (e.g. https://app.safix.digital).
 */
export function applyCors(req: VercelRequest, res: VercelResponse, gateScope?: GateScope): boolean {
  // ── Production gate ─────────────────────────────────────────────────────
  const gate = checkProductionGate(gateScope)
  // See the matching guard in account/team-code-email: Vercel compiles API
  // entrypoints without strict null checks, so narrow the result explicitly.
  if (gate.ok === false) {
    res.status(500).json({
      error: 'Production environment misconfiguration — request blocked.',
      missing: gate.missing,
    })
    return true
  }

  // ── CORS headers ────────────────────────────────────────────────────────
  // ALLOWED_ORIGIN may be a comma-separated list (e.g. web origin + capacitor://localhost).
  // Reflect the requesting origin ONLY when it is on the allow-list. Never
  // reflect a non-matching origin: an earlier version fell back to list[0],
  // which spoofed a WRONG Access-Control-Allow-Origin and turned an allow-list
  // drift (e.g. a domain migration that forgot to add the new web origin) into
  // an opaque browser "Load failed" instead of a loud, debuggable mismatch.
  // On a miss we emit NO ACAO header and log a warning so the drift surfaces.
  const rawAllowed = process.env.ALLOWED_ORIGIN ?? '*'
  const requestOrigin = (req.headers.origin as string | undefined) ?? ''

  if (rawAllowed === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*')
  } else {
    const list = rawAllowed.split(',').map((o) => o.trim()).filter(Boolean)
    if (requestOrigin && list.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin)
    } else if (requestOrigin) {
      // Origin present but not allow-listed — do NOT reflect it. The preflight
      // fails in the browser (correct), but visibly, and we record why.
      logWarning('api.cors.origin_not_allowed', {
        requestOrigin,
        allowed: list,
        path: req.url,
      })
    }
    // No Origin header (server-to-server / same-origin) needs no ACAO.
    // Vary: Origin so caches don't serve a per-origin response to another caller.
    res.setHeader('Vary', 'Origin')
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }

  return false
}
