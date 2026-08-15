/**
 * Profile Bootstrap Recovery — post-auth profile bootstrap repair
 *
 * Validates the critical invariant: when auth succeeds but profile bootstrap
 * fails, the user must NOT be bounced back to login.
 *
 * Previously, profile_create_failed / profile_load_failed set EMPTY_SESSION
 * (user: null) which caused gates to redirect to /login even though auth had
 * succeeded.  This created the reported login loop.
 *
 * After the fix:
 *   - Auth success + profile bootstrap failure → user stays authenticated
 *   - sessionValidated is true (auth IS valid)
 *   - Gates show a retry screen (not redirect to /login)
 *   - Retry via refreshSession() can recover
 *   - Real auth failures still trigger full recovery to /login
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

vi.mock('../../src/lib/profile', () => ({
  getMyProfile: mockGetMyProfile,
  ensureProfileExists: mockEnsureProfileExists,
  acceptTos: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(id: string, email: string): User {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    email_confirmed_at: '2026-03-22T00:00:00Z',
    phone: '',
    phone_confirmed_at: null,
    confirmation_sent_at: '2026-03-22T00:00:00Z',
    confirmed_at: '2026-03-22T00:00:00Z',
    last_sign_in_at: '2026-03-22T00:00:00Z',
    app_metadata: {},
    user_metadata: {},
    identities: [],
    factors: [],
    created_at: '2026-03-22T00:00:00Z',
    updated_at: '2026-03-22T00:00:00Z',
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mockSignOut.mockResolvedValue({ error: null })
  mockEnsureProfileExists.mockResolvedValue(undefined)
  mockOnAuthStateChange.mockImplementation((callback: AuthCallback) => {
    capturedAuthCallback = callback
    return { data: { subscription: { unsubscribe: vi.fn() } } }
  })
  capturedAuthCallback = null
  setupLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 1. Signup success + profile bootstrap fail → user stays authenticated
// ---------------------------------------------------------------------------

describe('signup success + profile bootstrap failure', () => {
  it('profile_create_failed keeps user authenticated with classified error', async () => {
    const user = makeUser('signup-pf-fail', 'signuppf@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockEnsureProfileExists.mockRejectedValue({
      message: 'new row violates row-level security policy',
      code: '42501',
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    const state = session.getSession()
    // Auth succeeded — user stays authenticated
    expect(state.user?.id).toBe('signup-pf-fail')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    // Error is classified, not generic
    expect(state.errorKind).toBe('profile_create_failed')
    expect(state.error).toBe('new row violates row-level security policy')
    // signOut must NOT be called — auth is valid
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('profile_load_failed keeps user authenticated with classified error', async () => {
    const user = makeUser('signup-pl-fail', 'signuppl@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockGetMyProfile.mockRejectedValue(new Error('Could not load profile'))

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    const state = session.getSession()
    // Auth succeeded — user stays authenticated
    expect(state.user?.id).toBe('signup-pl-fail')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    // Error is classified
    expect(state.errorKind).toBe('profile_load_failed')
    expect(state.error).toBe('Could not load profile')
    // signOut must NOT be called — auth is valid
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('profile bootstrap failure preserves session cache for page reloads', async () => {
    const user = makeUser('cache-preserved', 'cache@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockGetMyProfile.mockRejectedValue(new Error('DB timeout'))

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    // Session cache must preserve the user so page reloads don't lose auth
    const cached = localStorage.getItem('fixup.session.cache.v1')
    expect(cached).toBeTruthy()
    expect(JSON.parse(cached!).user.id).toBe('cache-preserved')
  })
})

// ---------------------------------------------------------------------------
// 2. Login success + profile bootstrap fail → no login bounce
// ---------------------------------------------------------------------------

describe('login success + profile bootstrap failure → no login bounce', () => {
  it('profile_load_failed after login keeps user authenticated (no login loop)', async () => {
    const user = makeUser('login-pf-fail', 'loginpf@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockGetMyProfile.mockRejectedValue(new Error('Profile query timed out'))

    const session = await import('../../src/lib/session')
    // Simulate login → SIGNED_IN → forceRefreshSession
    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    const state = session.getSession()
    // User stays authenticated — gates will NOT redirect to /login
    expect(state.user?.id).toBe('login-pf-fail')
    expect(state.sessionValidated).toBe(true)
    // Gates will show retry screen based on this error
    expect(state.errorKind).toBe('profile_load_failed')
    // signOut must NOT be called
    expect(mockSignOut).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3. Transient profile bootstrap delay → retry succeeds → no login bounce
// ---------------------------------------------------------------------------

describe('transient profile bootstrap delay → no login bounce', () => {
  it('transient ensureProfileExists failure recovers on retry', async () => {
    const user = makeUser('transient-create', 'transient@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })

    let createCallCount = 0
    mockEnsureProfileExists.mockImplementation(() => {
      createCallCount++
      if (createCallCount === 1) {
        return Promise.reject(new Error('temporary RLS delay'))
      }
      return Promise.resolve(undefined)
    })

    mockGetMyProfile.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Transient failure recovered — bootstrap completed successfully
    expect(state.user?.id).toBe('transient-create')
    expect(state.sessionValidated).toBe(true)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(state.role).toBeNull()
    expect(mockEnsureProfileExists).toHaveBeenCalledTimes(2)
  })

  it('transient getMyProfile failure recovers on retry', async () => {
    const user = makeUser('transient-load', 'transient-load@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })

    let loadCallCount = 0
    mockGetMyProfile.mockImplementation(() => {
      loadCallCount++
      if (loadCallCount === 1) {
        return Promise.reject(new Error('temporary connection reset'))
      }
      return Promise.resolve({
        role: 'customer',
        craftsman_role: null,
        is_operator: false,
        guided_entry_state: null,
      })
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Transient failure recovered — profile loaded on retry
    expect(state.user?.id).toBe('transient-load')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(mockGetMyProfile).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// 4. Profile bootstrap fail → retry via refreshSession() recovers
// ---------------------------------------------------------------------------

describe('profile bootstrap fail → retry recovers', () => {
  it('profile_load_failed then successful retry clears error and loads profile', async () => {
    const user = makeUser('retry-recover', 'retry@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })

    // Both initial and retry calls fail
    mockGetMyProfile.mockRejectedValue(new Error('Database temporarily unavailable'))

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    // First: profile load failed, user stays authenticated
    let state = session.getSession()
    expect(state.user?.id).toBe('retry-recover')
    expect(state.sessionValidated).toBe(true)
    expect(state.errorKind).toBe('profile_load_failed')

    // Now fix the profile load
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    // Retry via refreshSession (as user would click retry button in gate)
    await session.forceRefreshSession()

    state = session.getSession()
    // Error cleared, profile loaded, full bootstrap complete
    expect(state.user?.id).toBe('retry-recover')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(state.loading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Real auth failure still triggers full recovery (not profile error)
// ---------------------------------------------------------------------------

describe('real auth failure still routes to login', () => {
  it('auth error during ensureProfileExists triggers invalid session recovery', async () => {
    const user = makeUser('auth-fail-create', 'authfailcreate@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockEnsureProfileExists.mockRejectedValue({
      name: 'AuthApiError',
      message: 'JWT expired',
      status: 401,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Auth errors are NOT treated as profile errors — full recovery triggered
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('auth error during getMyProfile triggers invalid session recovery', async () => {
    const user = makeUser('auth-fail-load', 'authfailload@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockEnsureProfileExists.mockResolvedValue(undefined)
    mockGetMyProfile.mockRejectedValue({
      name: 'AuthApiError',
      message: 'Invalid token',
      status: 401,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Auth error → full recovery (not profile error)
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})

// ---------------------------------------------------------------------------
// 6. No regression: logout/account switching still works
// ---------------------------------------------------------------------------

describe('no regression: logout and account switching', () => {
  it('SIGNED_OUT after profile error clears state correctly', async () => {
    const user = makeUser('logout-after-err', 'logouterr@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockGetMyProfile.mockRejectedValue(new Error('Profile load failed'))

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    // User is authenticated with profile error
    expect(session.getSession().user?.id).toBe('logout-after-err')
    expect(session.getSession().errorKind).toBe('profile_load_failed')

    // Sign out
    capturedAuthCallback!('SIGNED_OUT', null)

    const state = session.getSession()
    // Fully cleared
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(state.loading).toBe(false)
  })

  it('account switch after profile error: new user gets clean state', async () => {
    const userA = makeUser('user-a-err', 'a-err@example.com')
    const userB = makeUser('user-b-ok', 'b-ok@example.com')

    // User A has profile error
    mockGetSession.mockResolvedValue({
      data: { session: { user: userA } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: userA },
      error: null,
    })
    mockGetMyProfile.mockRejectedValue(new Error('Profile load failed'))

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    expect(session.getSession().user?.id).toBe('user-a-err')
    expect(session.getSession().errorKind).toBe('profile_load_failed')

    // Sign out user A
    capturedAuthCallback!('SIGNED_OUT', null)

    // Sign in user B — profile works fine
    mockGetSession.mockResolvedValue({
      data: { session: { user: userB } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: userB },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: false,
      guided_entry_state: null,
    })

    capturedAuthCallback!('SIGNED_IN', { user: userB })
    await session.forceRefreshSession()

    const state = session.getSession()
    // User B has clean state — no leakage from user A's error
    expect(state.user?.id).toBe('user-b-ok')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('owner')
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. Signup → profile exists → role selection
// ---------------------------------------------------------------------------

describe('signup → profile exists → role selection routing', () => {
  it('signup + profile created with null role → gates route to role selection', async () => {
    const user = makeUser('signup-role-select', 'roleselect@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockEnsureProfileExists.mockResolvedValue(undefined)
    mockGetMyProfile.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    const state = session.getSession()
    // Fully validated, role null → HomeGate routes to /onboarding/role
    expect(state.user?.id).toBe('signup-role-select')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    expect(state.error).toBeNull()
  })

  it('signup + profile with existing role → gates route to app', async () => {
    const user = makeUser('signup-has-role', 'hasrole@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockEnsureProfileExists.mockResolvedValue(undefined)
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    const state = session.getSession()
    // Fully validated, role = customer → HomeGate shows CustomerHomeScreen
    expect(state.user?.id).toBe('signup-has-role')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.error).toBeNull()
  })
})
