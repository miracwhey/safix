/**
 * Server-side API role authorization helper (Layer 4 — HTTP gate).
 *
 * Layered alongside `requireAuth` (JWT validation, Layer 1) and the
 * workflow-layer `rbacGuards` (Layer 3). This module closes the HTTP-level
 * role gap: a valid JWT alone is not enough — the caller's `profiles.role`
 * (and optionally `profiles.craftsman_role`) must match the endpoint's
 * expectation, otherwise the request is rejected with a 403 before any
 * business logic runs.
 *
 * Usage:
 *
 *   const auth = await requireOwner(req, res)
 *   if (!auth) return
 *   // auth.userId / auth.role === 'craftsman' / auth.craftsmanRole === 'owner'
 *
 * On role mismatch the response body is:
 *   { error: '...', code: 'forbidden_role' }
 *
 * Emitted observability events:
 *   api.auth_role.verified                   — role passed
 *   api.auth_role.role_denied                — profiles.role mismatch
 *   api.auth_role.craftsman_role_denied      — profiles.craftsman_role mismatch
 *   api.auth_role.profile_missing            — no profiles row for caller
 *   api.auth_role.profile_lookup_failed      — DB error during profile fetch
 *   api.auth_role.admin_unavailable          — Supabase admin client unavailable
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth, type AuthSuccess } from './_auth.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logInfo, logWarning } from './_observability.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CallerRole = 'customer' | 'craftsman'
export type CallerCraftsmanRole = 'owner' | 'worker' | null

export interface RoleAuthSuccess extends AuthSuccess {
  role: CallerRole
  craftsmanRole: CallerCraftsmanRole
  isOperator: boolean
}

export interface RolePredicate {
  /** Allowed values for `profiles.role`. */
  roles: CallerRole[]
  /**
   * Optional sub-restriction. Only enforced when the caller's resolved
   * `role` is `'craftsman'`. Use `['owner']` for owner-only endpoints,
   * `['owner', 'worker']` for any-craftsman endpoints.
   */
  craftsmanRoles?: CallerCraftsmanRole[]
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

const PREDICATE_OWNER: RolePredicate = { roles: ['craftsman'], craftsmanRoles: ['owner'] }
const PREDICATE_CUSTOMER: RolePredicate = { roles: ['customer'] }
const PREDICATE_OWNER_OR_WORKER: RolePredicate = {
  roles: ['craftsman'],
  craftsmanRoles: ['owner', 'worker'],
}

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Validates the caller's JWT (via {@link requireAuth}) and then enforces a
 * role predicate against the caller's `profiles` row.
 *
 * Returns `null` when authentication or authorization fails — the response
 * has already been sent, the caller should `return` immediately.
 */
export async function requireRole(
  req: VercelRequest,
  res: VercelResponse,
  predicate: RolePredicate,
): Promise<RoleAuthSuccess | null> {
  const auth = await requireAuth(req, res)
  if (!auth) return null

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logWarning('api.auth_role.admin_unavailable', {
      path: req.url,
      missing: adminResult.missing,
    })
    res.status(503).json({
      error: `Authorization unavailable: ${formatAdminUnavailable(adminResult.missing)}`,
    })
    return null
  }

  const { data, error } = await adminResult.client
    .from('profiles')
    .select('role, craftsman_role, is_operator')
    .eq('id', auth.userId)
    .maybeSingle()

  if (error) {
    logWarning('api.auth_role.profile_lookup_failed', {
      path: req.url,
      userId: auth.userId,
      reason: error.message,
    })
    res.status(500).json({ error: 'Failed to resolve caller profile.' })
    return null
  }

  if (!data) {
    logWarning('api.auth_role.profile_missing', {
      path: req.url,
      userId: auth.userId,
    })
    res.status(403).json({
      error: 'Forbidden: caller has no profile.',
      code: 'forbidden_role',
    })
    return null
  }

  const role = (data.role ?? null) as CallerRole | null
  const craftsmanRole = (data.craftsman_role ?? null) as CallerCraftsmanRole

  if (!role || !predicate.roles.includes(role)) {
    logWarning('api.auth_role.role_denied', {
      path: req.url,
      userId: auth.userId,
      role,
      expected: predicate.roles,
    })
    res.status(403).json({
      error: 'Forbidden: caller role does not match endpoint expectation.',
      code: 'forbidden_role',
    })
    return null
  }

  if (
    role === 'craftsman' &&
    predicate.craftsmanRoles &&
    !predicate.craftsmanRoles.includes(craftsmanRole)
  ) {
    logWarning('api.auth_role.craftsman_role_denied', {
      path: req.url,
      userId: auth.userId,
      craftsmanRole,
      expected: predicate.craftsmanRoles,
    })
    res.status(403).json({
      error: 'Forbidden: caller craftsman_role does not match endpoint expectation.',
      code: 'forbidden_role',
    })
    return null
  }

  logInfo('api.auth_role.verified', {
    path: req.url,
    userId: auth.userId,
    role,
    craftsmanRole,
  })

  return {
    userId: auth.userId,
    user: auth.user,
    role,
    craftsmanRole,
    isOperator: data.is_operator === true,
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/** Caller must be a craftsman with `craftsman_role = 'owner'`. */
export function requireOwner(
  req: VercelRequest,
  res: VercelResponse,
): Promise<RoleAuthSuccess | null> {
  return requireRole(req, res, PREDICATE_OWNER)
}

/** Caller must have `role = 'customer'`. */
export function requireCustomer(
  req: VercelRequest,
  res: VercelResponse,
): Promise<RoleAuthSuccess | null> {
  return requireRole(req, res, PREDICATE_CUSTOMER)
}

/** Caller must be a craftsman (owner or worker). */
export function requireOwnerOrWorker(
  req: VercelRequest,
  res: VercelResponse,
): Promise<RoleAuthSuccess | null> {
  return requireRole(req, res, PREDICATE_OWNER_OR_WORKER)
}
