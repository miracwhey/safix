/**
 * Test helper: builds `SessionState` snapshots for the rbacGuards in
 * `src/lib/auth/rbacGuards.ts`. Pass the result as the optional `session`
 * argument to any workflow that takes one — the real `getSession()` store
 * does not need to be mutated for tests.
 */

import type { SessionState } from '../../src/lib/session'
import { __testOnly_setSession, __testOnly_resetSession } from '../../src/lib/session'
import type { User } from '@supabase/supabase-js'

function makeUser(userId: string): User {
  return {
    id: userId,
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  } as unknown as User
}

const BASE: Omit<SessionState, 'user' | 'role' | 'craftsmanRole'> = {
  isOperator: false,
  tosAcceptedAt: null,
  loading: false,
  sessionValidated: true,
  error: null,
  errorKind: null,
}

export function mockCustomerSession(userId: string): SessionState {
  return {
    ...BASE,
    user: makeUser(userId),
    role: 'customer',
    craftsmanRole: null,
  }
}

export function mockOwnerSession(userId: string, opts: { isOperator?: boolean } = {}): SessionState {
  return {
    ...BASE,
    user: makeUser(userId),
    role: 'craftsman',
    craftsmanRole: 'owner',
    isOperator: opts.isOperator ?? false,
  }
}

export function mockWorkerSession(userId: string): SessionState {
  return {
    ...BASE,
    user: makeUser(userId),
    role: 'craftsman',
    craftsmanRole: 'worker',
  }
}

export function installMockSession(state: SessionState): void {
  __testOnly_setSession(state)
}

export function resetMockSession(): void {
  __testOnly_resetSession()
}

/**
 * Install a session whose user.id matches the job's owner. Use before
 * Workflows that require `assertJobProviderOwner` (requestFunding, …)
 * or `assertJobWorkerOrOwner` (markWorkComplete) when the test exercises
 * the owner happy path.
 */
export function installSessionForJobOwner(job: { craftsmanUserId?: string }): void {
  if (!job.craftsmanUserId) {
    throw new Error('installSessionForJobOwner: job.craftsmanUserId is required')
  }
  installMockSession(mockOwnerSession(job.craftsmanUserId))
}

/**
 * Install a session whose user.id matches the job's customer. Use before
 * Workflows that require `assertJobCustomer` (customerRelease,
 * confirmFunding) or `assertCustomerRole` + funding_request match
 * (customerFundingEntry).
 */
export function installSessionForJobCustomer(job: { customerUserId?: string }): void {
  if (!job.customerUserId) {
    throw new Error('installSessionForJobCustomer: job.customerUserId is required')
  }
  installMockSession(mockCustomerSession(job.customerUserId))
}
