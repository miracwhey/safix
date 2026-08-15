import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isOwnerCraftsman,
  canAccessOperatorTools,
  canAccessFinanceOps,
  canAccessDisputeResolution,
} from '../../src/lib/access'
import type { SessionState } from '../../src/lib/session'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SessionState for test purposes.
 * canAccessDisputeResolution requires session.isOperator === true;
 * VITE_ADMIN_MODE no longer grants elevated access.
 */
function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    user: null,
    role: null,
    craftsmanRole: null,
    isOperator: false,
    loading: false,
    error: null,
    errorKind: null,
    ...overrides,
  }
}

const ownerSession = makeSession({ role: 'craftsman', craftsmanRole: 'owner' })
const workerSession = makeSession({ role: 'craftsman', craftsmanRole: 'worker' })
const customerSession = makeSession({ role: 'customer' })
const anonSession = makeSession()
const operatorSession = makeSession({ role: 'craftsman', craftsmanRole: 'owner', isOperator: true })

// ---------------------------------------------------------------------------
// isOwnerCraftsman
// ---------------------------------------------------------------------------

describe('isOwnerCraftsman', () => {
  it('returns true for craftsman owner', () => {
    expect(isOwnerCraftsman(ownerSession)).toBe(true)
  })

  it('returns false for craftsman worker', () => {
    expect(isOwnerCraftsman(workerSession)).toBe(false)
  })

  it('returns false for customer', () => {
    expect(isOwnerCraftsman(customerSession)).toBe(false)
  })

  it('returns false for unauthenticated session', () => {
    expect(isOwnerCraftsman(anonSession)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canAccessOperatorTools
// ---------------------------------------------------------------------------

describe('canAccessOperatorTools', () => {
  it('allows craftsman owner with operator grant', () => {
    expect(canAccessOperatorTools(operatorSession)).toBe(true)
  })

  it('denies craftsman owner WITHOUT operator grant (Apple 1.2 moderation queue is operator-only)', () => {
    expect(canAccessOperatorTools(ownerSession)).toBe(false)
  })

  it('denies craftsman worker', () => {
    expect(canAccessOperatorTools(workerSession)).toBe(false)
  })

  it('denies customer', () => {
    expect(canAccessOperatorTools(customerSession)).toBe(false)
  })

  it('denies unauthenticated session', () => {
    expect(canAccessOperatorTools(anonSession)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canAccessFinanceOps
// ---------------------------------------------------------------------------

describe('canAccessFinanceOps', () => {
  it('allows craftsman owner', () => {
    expect(canAccessFinanceOps(ownerSession)).toBe(true)
  })

  it('denies craftsman worker', () => {
    expect(canAccessFinanceOps(workerSession)).toBe(false)
  })

  it('denies customer', () => {
    expect(canAccessFinanceOps(customerSession)).toBe(false)
  })

  it('denies unauthenticated session', () => {
    expect(canAccessFinanceOps(anonSession)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canAccessDisputeResolution
// ---------------------------------------------------------------------------

describe('canAccessDisputeResolution', () => {
  it('allows craftsman owner with is_operator = true', () => {
    expect(canAccessDisputeResolution(operatorSession)).toBe(true)
  })

  it('denies craftsman owner without is_operator', () => {
    expect(canAccessDisputeResolution(ownerSession)).toBe(false)
  })

  it('denies craftsman worker even with is_operator = true', () => {
    const workerOperator = makeSession({ role: 'craftsman', craftsmanRole: 'worker', isOperator: true })
    expect(canAccessDisputeResolution(workerOperator)).toBe(false)
  })

  it('denies customer even with is_operator = true', () => {
    const customerOperator = makeSession({ role: 'customer', isOperator: true })
    expect(canAccessDisputeResolution(customerOperator)).toBe(false)
  })

  it('denies unauthenticated session even with is_operator = true', () => {
    const anonOperator = makeSession({ isOperator: true })
    expect(canAccessDisputeResolution(anonOperator)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canAccessDisputeResolution – VITE_ADMIN_MODE bypass removed
// ---------------------------------------------------------------------------

describe('canAccessDisputeResolution – env flag bypass removed', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('denies craftsman owner even when isAdminMode() returns true — env bypass is removed', async () => {
    // VITE_ADMIN_MODE must no longer grant elevated dispute access.
    // The only valid grant is session.isOperator === true (profiles.is_operator).
    vi.doMock('../../src/lib/admin', () => ({ isAdminMode: () => true }))
    const { canAccessDisputeResolution: check } = await import('../../src/lib/access/index.ts?test=owner')
    expect(check(ownerSession)).toBe(false)
  })

  it('denies craftsman worker regardless of isAdminMode()', async () => {
    vi.doMock('../../src/lib/admin', () => ({ isAdminMode: () => true }))
    const { canAccessDisputeResolution: check } = await import('../../src/lib/access/index.ts?test=worker')
    expect(check(workerSession)).toBe(false)
  })

  it('denies customer regardless of isAdminMode()', async () => {
    vi.doMock('../../src/lib/admin', () => ({ isAdminMode: () => true }))
    const { canAccessDisputeResolution: check } = await import('../../src/lib/access/index.ts?test=customer')
    expect(check(customerSession)).toBe(false)
  })
})
