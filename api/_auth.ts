/**
 * Server-side API authentication helper.
 *
 * Validates the Supabase JWT carried in the Authorization header so that all
 * critical API routes can require authenticated callers.
 *
 * Preferred usage — `requireAuth` sends the error response automatically:
 *
 *   const auth = await requireAuth(req, res)
 *   if (!auth) return
 *   // auth.userId and auth.user are available
 *
 * Lower-level alternative — `authenticateRequest` returns a discriminated union:
 *
 *   const auth = await authenticateRequest(req)
 *   if (auth.ok === false) {
 *     res.status(auth.statusCode).json({ error: auth.error })
 *     return
 *   }
 *   // auth.userId and auth.user are now available
 *
 * Emitted observability events:
 *   api.auth.missing_token     — Authorization header absent or not Bearer
 *   api.auth.invalid_token     — Token present but JWT validation failed
 *   api.auth.verified          — Token valid, user resolved
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { User } from '@supabase/supabase-js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logInfo, logWarning, setSentryRequestUser } from './_observability.js'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type AuthResult =
  | { ok: true; userId: string; user: User }
  | { ok: false; statusCode: 401 | 503; error: string }

/** Successful authentication data returned by {@link requireAuth}. */
export interface AuthSuccess {
  userId: string
  user: User
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the raw Bearer token from the Authorization header.
 * Returns null when the header is absent or not in "Bearer <token>" form.
 *
 * Node.js (and Vercel) normalizes all incoming HTTP header names to lowercase,
 * so 'authorization' is the correct key regardless of how the client sends it.
 */
export function extractBearerToken(req: VercelRequest): string | null {
  // Node.js http.IncomingMessage lowercases all header names automatically.
  const header = req.headers['authorization']
  if (!header || typeof header !== 'string') return null
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token.length > 0 ? token : null
}

// ---------------------------------------------------------------------------
// Main authentication function
// ---------------------------------------------------------------------------

/**
 * Authenticates the incoming request by validating the Supabase JWT in the
 * Authorization header.
 *
 * - Returns { ok: true, userId, user } on success.
 * - Returns { ok: false, statusCode: 401, error } on any failure.
 *
 * Requires the Supabase admin client (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 * When the admin client is unavailable (e.g. missing env vars in local dev)
 * authentication fails with a 401 rather than proceeding unauthenticated.
 */
export async function authenticateRequest(req: VercelRequest): Promise<AuthResult> {
  const token = extractBearerToken(req)

  if (!token) {
    logWarning('api.auth.missing_token', { path: req.url })
    return {
      ok: false,
      statusCode: 401,
      error: 'Unauthorized: missing or malformed Authorization header.',
    }
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    // Admin client unavailable — fail closed: cannot verify the token.
    const message = formatAdminUnavailable(adminResult.missing)
    logWarning('api.auth.invalid_token', {
      path: req.url,
      reason: 'supabase_admin_unavailable',
      missing: adminResult.missing,
    })
    return {
      ok: false,
      statusCode: 503,
      error: `Authentication unavailable: ${message}`,
    }
  }

  const { data, error } = await adminResult.client.auth.getUser(token)

  if (error || !data?.user) {
    logWarning('api.auth.invalid_token', {
      path: req.url,
      reason: error?.message ?? 'no_user_returned',
    })
    return {
      ok: false,
      statusCode: 401,
      error: 'Unauthorized: invalid or expired token.',
    }
  }

  logInfo('api.auth.verified', { path: req.url, userId: data.user.id })
  setSentryRequestUser(data.user.id)
  return { ok: true, userId: data.user.id, user: data.user }
}

// ---------------------------------------------------------------------------
// Convenience — authenticate-or-reject
// ---------------------------------------------------------------------------

/**
 * Authenticates the request and sends an error response when authentication
 * fails.  Returns the authenticated user data on success, or `null` when the
 * error response has already been sent (caller should `return` immediately).
 *
 * This eliminates the discriminated-union boilerplate at call sites:
 *
 *   const auth = await requireAuth(req, res)
 *   if (!auth) return
 *   // auth.userId / auth.user are available — no union narrowing needed
 */
export async function requireAuth(
  req: VercelRequest,
  res: VercelResponse,
): Promise<AuthSuccess | null> {
  const result = await authenticateRequest(req)
  if (result.ok === false) {
    res.status(result.statusCode).json({ error: result.error })
    return null
  }
  return { userId: result.userId, user: result.user }
}
