/**
 * Workflow-layer RBAC guards.
 *
 * UI route gates (OwnerRouteGate, EmployeeRouteGate, RoleGate) protect screens.
 * RLS protects raw database rows. But workflows run in the client, orchestrate
 * across multiple domains, and frequently mutate tables that the caller cannot
 * touch directly via Supabase. A worker (or another customer) can construct
 * jobIds and call workflows via the JS console even if the UI never offers
 * the action.
 *
 * These guards are the third defense layer: every workflow that mutates money,
 * acceptance state, or job-funding lifecycle must `assert*` the caller's
 * identity matches the job actor expected for that workflow.
 *
 * Design:
 *   - Throw `RbacError` with a stable `code` so callers/tests can branch.
 *   - Read identity from `getSession()` by default — workflows accept an
 *     optional `session` param mainly for tests.
 *   - Worker-or-owner check resolves the team-member row from the in-memory
 *     teamStore (no async DB lookup). Falls back to owner-only when the
 *     teamStore is not hydrated, which is the safer default.
 */

import type { SessionState } from '../session'
import { getSession } from '../session'
import { getTeamMembers, isTeamMembersHydrated } from '../team'
import type { Job } from '../jobs/types'

export type RbacErrorCode =
  | 'rbac_role'
  | 'rbac_owner'
  | 'rbac_customer'
  | 'rbac_worker_or_owner'
  | 'rbac_worker_or_owner_for_member'
  | 'rbac_worker_provider_mismatch'
  | 'rbac_job_assignment'

export class RbacError extends Error {
  readonly code: RbacErrorCode
  constructor(code: RbacErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'RbacError'
    this.code = code
  }
}

export function resolveSession(session?: SessionState): SessionState {
  return session ?? getSession()
}

/** Returns the validated user id of the caller, or undefined when no user. */
export function getCallerUserId(session?: SessionState): string | undefined {
  return resolveSession(session).user?.id
}

export function assertCustomerRole(session?: SessionState): asserts session is SessionState {
  const s = resolveSession(session)
  if (s.role !== 'customer' || !s.user) {
    throw new RbacError('rbac_customer', 'Caller is not a customer')
  }
}

export function assertOwnerRole(session?: SessionState): asserts session is SessionState {
  const s = resolveSession(session)
  if (s.role !== 'craftsman' || s.craftsmanRole !== 'owner' || !s.user) {
    throw new RbacError('rbac_owner', 'Caller is not a craftsman owner')
  }
}

export function assertJobCustomer(job: Job, session?: SessionState): void {
  const s = resolveSession(session)
  if (s.role !== 'customer' || !s.user) {
    throw new RbacError('rbac_customer', 'Caller is not a customer')
  }
  if (!job.customerUserId || job.customerUserId !== s.user.id) {
    throw new RbacError('rbac_customer', 'Caller is not the customer of this job')
  }
}

export function assertJobProviderOwner(job: Job, session?: SessionState): void {
  const s = resolveSession(session)
  if (s.role !== 'craftsman' || s.craftsmanRole !== 'owner' || !s.user) {
    throw new RbacError('rbac_owner', 'Caller is not a craftsman owner')
  }
  if (!job.craftsmanUserId || job.craftsmanUserId !== s.user.id) {
    throw new RbacError('rbac_owner', 'Caller is not the owner of this job')
  }
}

/**
 * Allow the caller through if they are the job's owner OR a worker that is
 * assigned to the job (or works for the job's provider when the job has no
 * explicit assignment yet).
 *
 * Worker resolution reads from the in-memory teamStore. When the store is
 * not hydrated we fall back to owner-only: refusing instead of silently
 * letting an unverified worker through.
 */
export function assertJobWorkerOrOwner(job: Job, session?: SessionState): void {
  const s = resolveSession(session)
  if (!s.user) {
    throw new RbacError('rbac_role', 'Caller has no validated user')
  }

  // Owner branch.
  if (
    s.role === 'craftsman' &&
    s.craftsmanRole === 'owner' &&
    job.craftsmanUserId &&
    job.craftsmanUserId === s.user.id
  ) {
    return
  }

  // Worker branch — only when the team store is hydrated; otherwise
  // fall through to the throw below to stay safe.
  if (
    s.role === 'craftsman' &&
    s.craftsmanRole === 'worker' &&
    isTeamMembersHydrated()
  ) {
    const member = getTeamMembers().find(
      (m) => m.userId === s.user!.id && (!job.providerId || m.providerId === job.providerId),
    )
    if (member) {
      const isAssigned = job.assignedMemberIds.length === 0 || job.assignedMemberIds.includes(member.id)
      if (isAssigned) return
    }
  }

  throw new RbacError(
    'rbac_worker_or_owner',
    'Caller is neither owner nor an assigned worker of this job',
  )
}

/**
 * Allow the caller through if they are either:
 *   - an owner (provider-scope verification deferred to RLS), or
 *   - the worker whose `team_members.id === memberId` (and `userId === auth.uid`).
 *
 * Used by the time-entry workflows (Block 2) where the action is scoped to a
 * specific member, not a job. Owner cross-provider isolation relies on the
 * RLS-side `time_entries_*_select/update` policies — this guard is the
 * workflow layer's third defense and intentionally optimistic for owners.
 *
 * Worker resolution reads from the in-memory teamStore. When the store is
 * not hydrated we fall through to the throw so we never silently let an
 * unverifiable worker write.
 */
export function assertWorkerOrOwnerForMember(
  memberId: string,
  session?: SessionState,
  expectedProviderId?: string,
): void {
  const s = resolveSession(session)
  if (!s.user) {
    throw new RbacError('rbac_role', 'Caller has no validated user')
  }

  // Owner branch — provider-scope cross-check is enforced by RLS.
  if (s.role === 'craftsman' && s.craftsmanRole === 'owner') {
    return
  }

  // Worker branch — must match the team member's userId exactly. If the caller
  // also provided an expectedProviderId (i.e. the workflow knows the row's
  // provider scope), refuse when the member's providerId disagrees. This
  // catches a malicious workflow caller that pairs a victim memberId with the
  // attacker's own providerId — RLS now (post-C1) blocks the write, but the
  // workflow guard should fail-fast with a clean error.
  if (
    s.role === 'craftsman' &&
    s.craftsmanRole === 'worker' &&
    isTeamMembersHydrated()
  ) {
    const member = getTeamMembers().find((m) => m.id === memberId)
    if (member && member.userId === s.user.id) {
      if (expectedProviderId && member.providerId && member.providerId !== expectedProviderId) {
        throw new RbacError(
          'rbac_worker_provider_mismatch',
          'Worker member belongs to a different provider than the workflow target',
        )
      }
      return
    }
  }

  throw new RbacError(
    'rbac_worker_or_owner_for_member',
    'Caller is neither owner nor the worker for this member',
  )
}
