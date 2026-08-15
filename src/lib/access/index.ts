/**
 * Centralized access-control helpers.
 *
 * These thin, pure helpers consolidate every operator/admin access decision
 * into a single module so they can be reasoned about, tested, and hardened
 * independently of individual screens or route guards.
 *
 * Role model:
 *   - customer          – normal product user
 *   - craftsman/worker  – team member, view-only operational access
 *   - craftsman/owner   – business operator; accesses dashboard, finance,
 *                         schedule, disputes, and operator tools
 *
 * Elevated dispute-resolution actions (release / refund / split) require:
 *   1. Craftsman owner role (operational access baseline), AND
 *   2. The per-user is_operator flag (profiles.is_operator in the DB).
 *
 * Granting a user operator access:
 *   UPDATE profiles SET is_operator = true WHERE id = '<user-uuid>';
 */

import type { SessionState } from '../session'

// ---------------------------------------------------------------------------
// App context — canonical actor / path resolution
// ---------------------------------------------------------------------------

/**
 * Canonical actor / app-context type.
 *
 * Three first-class paths:
 *   'customer'  – role=customer
 *   'owner'     – role=craftsman, craftsmanRole=owner
 *   'employee'  – role=craftsman, craftsmanRole=worker
 *   'unknown'   – unauthenticated, unvalidated, or role data not yet complete
 *
 * 'unknown' is the only safe default.  No gate may silently fall through to
 * any app path on 'unknown' — it must redirect to /login or /onboarding/role.
 */
export type AppContext = 'customer' | 'owner' | 'employee' | 'unknown'

/**
 * Resolve the canonical app context from a validated session snapshot.
 *
 * Rules:
 *   - Requires both `user` AND `sessionValidated` to return a non-unknown
 *     context.  A cached user without server validation must never grant any
 *     context — this mirrors the session cache safety contract in session.ts.
 *   - Incomplete craftsman state (craftsmanRole === null) resolves to 'unknown'
 *     so onboarding gates handle it.
 *   - Mixed or unexpected role combinations resolve to 'unknown'.
 *   - This is the single place that maps (role, craftsmanRole) → AppContext.
 *     All entry points and routing gates consume this resolver instead of
 *     performing their own raw role comparisons.
 */
export function resolveAppContext(session: SessionState): AppContext {
  if (!session.user || !session.sessionValidated) return 'unknown'
  if (session.role === 'customer') return 'customer'
  if (session.role === 'craftsman') {
    if (session.craftsmanRole === 'owner') return 'owner'
    if (session.craftsmanRole === 'worker') return 'employee'
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Owner-level helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the session belongs to a craftsman owner.
 * This is the baseline for all operational surfaces (dashboard, schedule,
 * finance, disputes, operator).
 */
export function isOwnerCraftsman(session: SessionState): boolean {
  return session.role === 'craftsman' && session.craftsmanRole === 'owner'
}

/**
 * Whether the current user may access operator tools such as the
 * OperatorDashboardScreen, the moderation report queue, and the priority-case
 * view.
 *
 * Requires BOTH the craftsman-owner operational baseline AND the per-user
 * operator grant (profiles.is_operator === true). The moderation queue exposes
 * cross-tenant report data (Apple 1.2 takedown surface), so a normal owner must
 * never reach it — this mirrors the DB policy `operators_read_all_reports`
 * (is_operator=true) and keeps the client gate as defense-in-depth, not a
 * weaker layer than RLS.
 */
export function canAccessOperatorTools(session: SessionState): boolean {
  return isOwnerCraftsman(session) && session.isOperator === true
}

/**
 * Whether the current user may access finance operations such as the
 * CraftsmanFinanceScreen and ledger/payment overviews.
 */
export function canAccessFinanceOps(session: SessionState): boolean {
  return isOwnerCraftsman(session)
}

// ---------------------------------------------------------------------------
// Elevated / admin-level helpers
// ---------------------------------------------------------------------------

/**
 * Whether the current session may perform privileged dispute-resolution
 * actions (release payment, issue refund, split funds).
 *
 * Requires all of:
 *   1. Craftsman owner role (operational baseline).
 *   2. Per-user operator grant: session.isOperator === true
 *      (set via profiles.is_operator in the database).
 */
export function canAccessDisputeResolution(session: SessionState): boolean {
  return isOwnerCraftsman(session) && session.isOperator === true
}
