/**
 * AppContext resolver — boundary contract
 *
 * Validates that resolveAppContext() deterministically maps session state to
 * the canonical AppContext for all actor paths.
 *
 * Scenarios:
 *   1.  customer session                → 'customer'
 *   2.  craftsman owner session         → 'owner'
 *   3.  craftsman worker session        → 'employee'
 *   4.  unauthenticated session         → 'unknown'
 *   5.  cached user, not yet validated  → 'unknown'
 *   6.  role null, validated user       → 'unknown'
 *   7.  craftsman, craftsmanRole null   → 'unknown'
 *   8.  operator flag does not change context
 *   9.  isTabRoute: customer tabs correct
 *  10.  isTabRoute: owner tabs correct
 *  11.  isTabRoute: employee gets no tabs
 *  12.  isTabRoute: unknown gets no tabs
 *  13.  reload: stale cached user without sessionValidated stays unknown
 *  14.  mixed-role: all combos resolve without throwing
 */

import { describe, it, expect } from 'vitest'
import { resolveAppContext, type AppContext } from '../../src/lib/access'
import { isTabRoute } from '../../src/lib/navigation/tabRoutes'
import type { SessionState } from '../../src/lib/session'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    user: null,
    role: null,
    craftsmanRole: null,
    isOperator: false,
    loading: false,
    sessionValidated: false,
    error: null,
    errorKind: null,
    ...overrides,
  }
}

// A minimal User object — only the fields SessionState cares about.
const mockUser = { id: 'user-1', email: 'test@example.com' } as SessionState['user']

const customerSession = makeSession({ user: mockUser, sessionValidated: true, role: 'customer' })
const ownerSession = makeSession({ user: mockUser, sessionValidated: true, role: 'craftsman', craftsmanRole: 'owner' })
const workerSession = makeSession({ user: mockUser, sessionValidated: true, role: 'craftsman', craftsmanRole: 'worker' })
const anonSession = makeSession()
const cachedButUnvalidated = makeSession({ user: mockUser, sessionValidated: false })
const validatedNoRole = makeSession({ user: mockUser, sessionValidated: true, role: null })
const craftsmanNoSubrole = makeSession({ user: mockUser, sessionValidated: true, role: 'craftsman', craftsmanRole: null })
const operatorSession = makeSession({ user: mockUser, sessionValidated: true, role: 'craftsman', craftsmanRole: 'owner', isOperator: true })

// ---------------------------------------------------------------------------
// resolveAppContext
// ---------------------------------------------------------------------------

describe('resolveAppContext', () => {
  it('1. customer session → customer', () => {
    expect(resolveAppContext(customerSession)).toBe<AppContext>('customer')
  })

  it('2. craftsman owner session → owner', () => {
    expect(resolveAppContext(ownerSession)).toBe<AppContext>('owner')
  })

  it('3. craftsman worker session → employee', () => {
    expect(resolveAppContext(workerSession)).toBe<AppContext>('employee')
  })

  it('4. unauthenticated session (no user, no validation) → unknown', () => {
    expect(resolveAppContext(anonSession)).toBe<AppContext>('unknown')
  })

  it('5. cached user without sessionValidated → unknown', () => {
    // This is the core session-cache safety contract: a cached user identity
    // must never grant an app context before server validation completes.
    expect(resolveAppContext(cachedButUnvalidated)).toBe<AppContext>('unknown')
  })

  it('6. validated user with null role → unknown', () => {
    expect(resolveAppContext(validatedNoRole)).toBe<AppContext>('unknown')
  })

  it('7. craftsman with null craftsmanRole → unknown', () => {
    expect(resolveAppContext(craftsmanNoSubrole)).toBe<AppContext>('unknown')
  })

  it('8a. operator flag on owner session does not change context', () => {
    expect(resolveAppContext(operatorSession)).toBe<AppContext>('owner')
  })

  it('8b. operator flag on worker session does not elevate to owner', () => {
    const workerOperator = makeSession({ user: mockUser, sessionValidated: true, role: 'craftsman', craftsmanRole: 'worker', isOperator: true })
    expect(resolveAppContext(workerOperator)).toBe<AppContext>('employee')
  })

  it('8c. operator flag on customer session does not change context', () => {
    const customerOperator = makeSession({ user: mockUser, sessionValidated: true, role: 'customer', isOperator: true })
    expect(resolveAppContext(customerOperator)).toBe<AppContext>('customer')
  })

  it('14. all session combos resolve without throwing', () => {
    const sessions = [customerSession, ownerSession, workerSession, anonSession, cachedButUnvalidated, validatedNoRole, craftsmanNoSubrole, operatorSession]
    const validContexts: AppContext[] = ['customer', 'owner', 'employee', 'unknown']
    for (const s of sessions) {
      expect(validContexts).toContain(resolveAppContext(s))
    }
  })
})

// ---------------------------------------------------------------------------
// isTabRoute
// ---------------------------------------------------------------------------

describe('isTabRoute', () => {
  it('9a. customer tab paths are tab routes', () => {
    expect(isTabRoute('/', 'customer')).toBe(true)
    expect(isTabRoute('/explore', 'customer')).toBe(true)
    expect(isTabRoute('/messages', 'customer')).toBe(true)
    expect(isTabRoute('/profile', 'customer')).toBe(true)
  })

  it('9b. customer does not match owner tab paths', () => {
    expect(isTabRoute('/craftsman/dashboard', 'customer')).toBe(false)
    expect(isTabRoute('/craftsman/backoffice', 'customer')).toBe(false)
  })

  it('10a. owner tab paths are tab routes', () => {
    expect(isTabRoute('/craftsman/dashboard', 'owner')).toBe(true)
    expect(isTabRoute('/explore', 'owner')).toBe(true)
    expect(isTabRoute('/craftsman/backoffice', 'owner')).toBe(true)
    expect(isTabRoute('/craftsman/messages', 'owner')).toBe(true)
    expect(isTabRoute('/profile', 'owner')).toBe(true)
  })

  it('10b. owner does not match customer-only tab paths', () => {
    expect(isTabRoute('/', 'owner')).toBe(false)
    expect(isTabRoute('/messages', 'owner')).toBe(false)
  })

  it('11. employee context gets no tab routes', () => {
    expect(isTabRoute('/worker', 'employee')).toBe(false)
    expect(isTabRoute('/', 'employee')).toBe(false)
    expect(isTabRoute('/craftsman/dashboard', 'employee')).toBe(false)
  })

  it('12. unknown context gets no tab routes', () => {
    expect(isTabRoute('/', 'unknown')).toBe(false)
    expect(isTabRoute('/craftsman/dashboard', 'unknown')).toBe(false)
    expect(isTabRoute('/worker', 'unknown')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Session restore / reload hardening
// ---------------------------------------------------------------------------

describe('session restore and reload', () => {
  it('13. stale cached user without server validation resolves to unknown', () => {
    // Simulates the state during app reload before getUser() completes.
    // Role data is intentionally withheld (session.ts cache contract).
    const restoringSession = makeSession({
      user: mockUser,
      sessionValidated: false,
      loading: true,
      role: null,
      craftsmanRole: null,
    })
    expect(resolveAppContext(restoringSession)).toBe<AppContext>('unknown')
  })

  it('after reload completes: customer context is restored deterministically', () => {
    const afterReload = makeSession({ user: mockUser, sessionValidated: true, role: 'customer' })
    expect(resolveAppContext(afterReload)).toBe<AppContext>('customer')
  })

  it('after reload completes: owner context is restored deterministically', () => {
    const afterReload = makeSession({ user: mockUser, sessionValidated: true, role: 'craftsman', craftsmanRole: 'owner' })
    expect(resolveAppContext(afterReload)).toBe<AppContext>('owner')
  })

  it('after reload completes: employee context is restored deterministically', () => {
    const afterReload = makeSession({ user: mockUser, sessionValidated: true, role: 'craftsman', craftsmanRole: 'worker' })
    expect(resolveAppContext(afterReload)).toBe<AppContext>('employee')
  })
})

// ---------------------------------------------------------------------------
// No cross-context leakage
// ---------------------------------------------------------------------------

describe('cross-context isolation', () => {
  it('customer context does not resolve to owner', () => {
    expect(resolveAppContext(customerSession)).not.toBe('owner')
    expect(resolveAppContext(customerSession)).not.toBe('employee')
  })

  it('owner context does not resolve to employee or customer', () => {
    expect(resolveAppContext(ownerSession)).not.toBe('employee')
    expect(resolveAppContext(ownerSession)).not.toBe('customer')
  })

  it('employee context does not resolve to owner or customer', () => {
    expect(resolveAppContext(workerSession)).not.toBe('owner')
    expect(resolveAppContext(workerSession)).not.toBe('customer')
  })

  it('owner tab paths are not accessible under employee context', () => {
    const ownerPaths = ['/craftsman/dashboard', '/craftsman/backoffice', '/craftsman/messages']
    for (const path of ownerPaths) {
      expect(isTabRoute(path, 'employee')).toBe(false)
    }
  })

  it('employee tab paths are not accessible under owner context (worker non-tab route)', () => {
    expect(isTabRoute('/worker', 'owner')).toBe(false)
  })
})
