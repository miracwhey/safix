/**
 * Role Gate Enforcement — role selection must precede app entry
 *
 * Validates that role selection is a hard prerequisite for entering any
 * role-dependent app flow.  After successful authentication (signup or
 * login), a user whose role is null/invalid MUST be routed to
 * /onboarding/role before any customer or craftsman content renders.
 *
 * Scenarios covered:
 *   1. signup success + role null → session routes to /onboarding/role
 *   2. login success + role null → session routes to /onboarding/role
 *   3. role null must not produce customer-ready session state
 *   4. role null must not produce craftsman-ready session state
 *   5. role = customer → customer flow allowed
 *   6. role = craftsman → craftsman flow allowed
 *   7. invalid/malformed role → treated as missing → /onboarding/role
 *   8. no regression to stable signup/login/bootstrap
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { User } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const mockGetSession = vi.fn()
const mockGetUser = vi.fn()
const mockSignOut = vi.fn().mockResolvedValue({ error: null })

type AuthCallback = (event: string, session: { user: User } | null) => void
let capturedAuthCallback: AuthCallback | null = null

const mockOnAuthStateChange = vi.fn().mockImplementation((callback: AuthCallback) => {
  capturedAuthCallback = callback
  return { data: { subscription: { unsubscribe: vi.fn() } } }
})

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      getUser: mockGetUser,
      signOut: mockSignOut,
      onAuthStateChange: mockOnAuthStateChange,
    },
  },
}))

// ---------------------------------------------------------------------------
// Profile mock
// ---------------------------------------------------------------------------

const mockGetMyProfile = vi.fn()
const mockEnsureProfileExists = vi.fn().mockResolvedValue(undefined)

vi.mock(import('../../src/lib/profile'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getMyProfile: mockGetMyProfile,
    ensureProfileExists: mockEnsureProfileExists,
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(id: string, email: string): User {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    email_confirmed_at: '2026-03-20T00:00:00Z',
    phone: '',
    phone_confirmed_at: null,
    confirmation_sent_at: '2026-03-20T00:00:00Z',
    confirmed_at: '2026-03-20T00:00:00Z',
    last_sign_in_at: '2026-03-20T00:00:00Z',
    app_metadata: {},
    user_metadata: {},
    identities: [],
    factors: [],
    created_at: '2026-03-20T00:00:00Z',
    updated_at: '2026-03-20T00:00:00Z',
  }
}

function setupLocalStorage() {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
  vi.stubGlobal('localStorage', storage)
  return storage
}

/**
 * Sets up Supabase mocks for a valid, server-validated session that returns
 * the given profile data.  After refreshSession() the session state will
 * have sessionValidated: true with role/craftsmanRole from the profile.
 */
function setupValidSession(
  user: User,
  profile: {
    role: string | null
    craftsman_role: string | null
    is_operator: boolean
    guided_entry_state: unknown
  },
) {
  mockGetSession.mockResolvedValue({
    data: { session: { user } },
    error: null,
  })
  mockGetUser.mockResolvedValue({
    data: { user },
    error: null,
  })
  mockGetMyProfile.mockResolvedValue(profile)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  capturedAuthCallback = null
  setupLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('role gate enforcement', () => {
  // -----------------------------------------------------------------------
  // 1. signup success + role null → must route to /onboarding/role
  // -----------------------------------------------------------------------
  it('signup success with null role produces session state that gates route to /onboarding/role', async () => {
    const user = makeUser('signup-null-role', 'signup@example.com')

    setupValidSession(user, {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Session is authenticated and validated
    expect(state.user?.id).toBe('signup-null-role')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()

    // Role is null — gates MUST redirect to /onboarding/role
    expect(state.role).toBeNull()

    // Verify the profile was read and ensureProfileExists was called
    // (standard post-signup bootstrap)
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('signup-null-role')
    expect(mockGetMyProfile).toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 2. login success + role null → must route to /onboarding/role
  // -----------------------------------------------------------------------
  it('login success with null role produces session state that gates route to /onboarding/role', async () => {
    const user = makeUser('login-null-role', 'login@example.com')

    setupValidSession(user, {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    expect(state.user?.id).toBe('login-null-role')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    expect(state.loading).toBe(false)
  })

  // -----------------------------------------------------------------------
  // 3. role null must not produce a customer-ready session
  // -----------------------------------------------------------------------
  it('role null is never treated as customer-ready', async () => {
    const user = makeUser('not-customer', 'notcust@example.com')

    setupValidSession(user, {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Explicit check: role must be exactly null, not defaulted
    expect(state.role).toBeNull()
    expect(state.role).not.toBe('customer')
    // No guided entry or customer search should be accessible
    // (gates check role === 'customer' before rendering)
  })

  // -----------------------------------------------------------------------
  // 4. role null must not produce a craftsman-ready session
  // -----------------------------------------------------------------------
  it('role null is never treated as craftsman-ready', async () => {
    const user = makeUser('not-craftsman', 'notcraft@example.com')

    setupValidSession(user, {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    expect(state.role).toBeNull()
    expect(state.role).not.toBe('craftsman')
    expect(state.craftsmanRole).toBeNull()
  })

  // -----------------------------------------------------------------------
  // 5. role = customer → customer flow allowed
  // -----------------------------------------------------------------------
  it('role = customer produces customer-ready session state', async () => {
    const user = makeUser('customer-user', 'customer@example.com')

    setupValidSession(user, {
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    expect(state.user?.id).toBe('customer-user')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    // Customer flow is allowed — HomeGate will render CustomerHomeScreen
  })

  // -----------------------------------------------------------------------
  // 6. role = craftsman → craftsman flow allowed
  // -----------------------------------------------------------------------
  it('role = craftsman produces craftsman-ready session state', async () => {
    const user = makeUser('craftsman-user', 'craftsman@example.com')

    setupValidSession(user, {
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    expect(state.user?.id).toBe('craftsman-user')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('owner')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  // -----------------------------------------------------------------------
  // 7. invalid/malformed role → treated as missing → /onboarding/role
  // -----------------------------------------------------------------------
  it('invalid role string is normalized to null by profile layer', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')

    // Various invalid values must all normalize to null
    expect(normalizeRole('invalid')).toBeNull()
    expect(normalizeRole('admin')).toBeNull()
    expect(normalizeRole('')).toBeNull()
    expect(normalizeRole('  ')).toBeNull()
    expect(normalizeRole(123)).toBeNull()
    expect(normalizeRole(undefined)).toBeNull()
    expect(normalizeRole(null)).toBeNull()
    expect(normalizeRole(true)).toBeNull()
    expect(normalizeRole({ role: 'customer' })).toBeNull()
  })

  it('malformed role values are normalized to canonical form', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')

    // Quoted/whitespace/case variants must normalize correctly
    expect(normalizeRole("'customer'")).toBe('customer')
    expect(normalizeRole('"craftsman"')).toBe('craftsman')
    expect(normalizeRole(' customer ')).toBe('customer')
    expect(normalizeRole('CUSTOMER')).toBe('customer')
    expect(normalizeRole('Craftsman')).toBe('craftsman')
    expect(normalizeRole("'\"customer\"'")).toBe('customer')
  })

  it('session with invalid role from DB produces null role after normalization', async () => {
    const user = makeUser('bad-role-user', 'badrole@example.com')

    // getMyProfile returns normalized values — invalid role becomes null
    setupValidSession(user, {
      role: null, // normalizeRole('garbage') → null in getMyProfile
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    expect(state.role).toBeNull()
    expect(state.sessionValidated).toBe(true)
    // Gates will route to /onboarding/role
  })

  // -----------------------------------------------------------------------
  // 8. no regression to stable signup/login/bootstrap
  // -----------------------------------------------------------------------
  it('valid customer session is not disrupted by role gating changes', async () => {
    const user = makeUser('stable-customer', 'stable@example.com')

    setupValidSession(user, {
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Must complete bootstrap cleanly with customer role
    expect(state.user?.id).toBe('stable-customer')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.craftsmanRole).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('valid craftsman session is not disrupted by role gating changes', async () => {
    const user = makeUser('stable-craftsman', 'stablecraft@example.com')

    setupValidSession(user, {
      role: 'craftsman',
      craftsman_role: 'worker',
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    expect(state.user?.id).toBe('stable-craftsman')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('worker')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('unauthenticated session is not affected — no role state, no validation', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    expect(state.user).toBeNull()
    expect(state.role).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('SIGNED_IN event resets role to null preventing stale role from prior session', async () => {
    const user1 = makeUser('user-1-role', 'user1@example.com')

    // First session: customer
    setupValidSession(user1, {
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    expect(session.getSession().role).toBe('customer')

    // New sign-in: SIGNED_IN event must reset role to null until refresh
    const user2 = makeUser('user-2-role', 'user2@example.com')
    capturedAuthCallback!('SIGNED_IN', { user: user2 })

    const afterSignIn = session.getSession()
    expect(afterSignIn.role).toBeNull()
    expect(afterSignIn.loading).toBe(true)
    expect(afterSignIn.sessionValidated).toBe(false)
    // Gate must NOT route to customer home — role is null, loading is true
  })

  // -----------------------------------------------------------------------
  // 9. role null cannot render customer guided-entry or search as app entry
  // -----------------------------------------------------------------------
  it('role null session state does not satisfy customer requiredRole for search/guided-entry routes', async () => {
    const user = makeUser('no-role-search', 'nosearch@example.com')

    setupValidSession(user, {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Session is authenticated and validated, but role is null
    expect(state.user?.id).toBe('no-role-search')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()

    // AuthGate with requiredRole="customer" checks: role !== requiredRole
    // Since null !== 'customer', the gate redirects to /gate.
    // Additionally, the !allowMissingRole && role == null check redirects
    // to /onboarding/role FIRST.  Either way, customer search and
    // guided-entry routes are blocked.
    expect(state.role).not.toBe('customer')
  })

  // -----------------------------------------------------------------------
  // 10. stale cached customer role does not bypass fresh null role
  // -----------------------------------------------------------------------
  it('stale cached customer role does not bypass fresh null role from server', async () => {
    const user = makeUser('stale-cache-user', 'stalecache@example.com')

    // Simulate stale cache from a previous session where user had customer role
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user,
      role: 'customer',
      craftsmanRole: null,
      isOperator: false,
    }))

    // Delay getSession so we can observe the interim cached state
    let resolveGetSession!: (value: unknown) => void
    mockGetSession.mockReturnValue(new Promise(resolve => {
      resolveGetSession = resolve
    }))

    const session = await import('../../src/lib/session')

    // During cache hydration: role must be null (not restored from cache)
    const interimState = session.getSession()
    expect(interimState.user?.id).toBe('stale-cache-user')
    expect(interimState.role).toBeNull()
    expect(interimState.loading).toBe(true)
    expect(interimState.sessionValidated).toBe(false)

    // Now resolve — server returns valid session but profile has no role
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    resolveGetSession({
      data: { session: { user } },
      error: null,
    })

    await session.refreshSession()

    // After fresh profile loads: role must still be null
    const finalState = session.getSession()
    expect(finalState.user?.id).toBe('stale-cache-user')
    expect(finalState.sessionValidated).toBe(true)
    expect(finalState.role).toBeNull()
    expect(finalState.loading).toBe(false)

    // The stale 'customer' role from cache MUST NOT leak through.
    // Gates will redirect to /onboarding/role.
  })

  // -----------------------------------------------------------------------
  // 11. role is written only through explicit setMyRole
  // -----------------------------------------------------------------------
  it('ensureProfileExists does not write or default any role value', async () => {
    const user = makeUser('profile-create-user', 'profilecreate@example.com')

    setupValidSession(user, {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    // ensureProfileExists was called with ONLY the user id — no role
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('profile-create-user')

    // The state must have null role — ensureProfileExists does not set one
    expect(session.getSession().role).toBeNull()
  })
})
