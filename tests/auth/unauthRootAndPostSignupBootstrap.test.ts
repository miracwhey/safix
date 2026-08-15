/**
 * Unauthenticated Root Cleanup + Post-Signup Bootstrap Fix
 *
 * Validates:
 *   1. Cold app open with no validated session → auth entry (login), not legacy/home app content
 *   2. No stale/mock app state appears for unauthenticated startup
 *   3. Signup success with usable session → full bootstrap into role/app
 *   4. Signup creates user but failing bootstrap step is correctly classified
 *   5. Profile creation/load after signup works
 *   6. Role-missing after signup routes to role selection
 *   7. Valid login still works
 *   8. No regression to logout/account switching/sessionValidated logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { User } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const mockGetSession = vi.fn()
const mockGetUser = vi.fn()
const mockSignOut = vi.fn().mockResolvedValue({ error: null })
const mockSignInWithPassword = vi.fn()
const mockSignUp = vi.fn()

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
      signInWithPassword: mockSignInWithPassword,
      signUp: mockSignUp,
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

vi.mock('../../src/lib/bootstrap', () => ({
  resyncRepositories: () => new Promise<void>(() => {}),
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
// 1. Cold app open with no validated session → auth entry, not legacy/home
// ---------------------------------------------------------------------------

describe('cold app open with no validated session → auth entry', () => {
  it('no session produces state that gates route to /login, never to HomeScreen', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // State that HomeGate checks: !user || !sessionValidated → Navigate to /login
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    // No cache → no risk of stale data flash
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
  })

  it('stale cache does not let unauthenticated users see app content', async () => {
    const staleUser = makeUser('stale-root-1', 'stale@example.com')

    // Simulate stale cache with customer role
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: staleUser,
      role: 'customer',
      craftsmanRole: null,
      isOperator: false,
    }))

    // Server rejects the session
    mockGetSession.mockResolvedValue({
      data: { session: { user: staleUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'Invalid JWT', status: 401 },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // HomeGate: !user → Navigate to /login (not HomeScreen with demo cards)
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.role).toBeNull()
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. No stale/mock app state for unauthenticated startup
// ---------------------------------------------------------------------------

describe('no stale/mock app state for unauthenticated startup', () => {
  it('during bootstrap with stale cache, loading=true prevents showing any app content', async () => {
    const staleUser = makeUser('boot-check-1', 'boot@example.com')

    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: staleUser,
      role: 'craftsman',
      craftsmanRole: 'owner',
      isOperator: true,
    }))

    let resolveGetSession!: (value: unknown) => void
    mockGetSession.mockReturnValue(new Promise(resolve => {
      resolveGetSession = resolve
    }))

    const session = await import('../../src/lib/session')

    // During bootstrap: loading=true → HomeGate shows "Lade...", never app content
    const bootState = session.getSession()
    expect(bootState.loading).toBe(true)
    expect(bootState.sessionValidated).toBe(false)
    // Even though cache has user/role, gates check loading first

    // Resolve with no session
    resolveGetSession({ data: { session: null }, error: null })
    await session.refreshSession()

    const finalState = session.getSession()
    expect(finalState.user).toBeNull()
    expect(finalState.sessionValidated).toBe(false)
    expect(finalState.loading).toBe(false)
    // HomeGate: !user → Navigate to /login
  })
})

// ---------------------------------------------------------------------------
// 3. Signup success with usable session → full bootstrap into role/app
// ---------------------------------------------------------------------------

describe('signup success → full authenticated bootstrap', () => {
  it('signup + immediate session → sessionValidated=true with profile loaded', async () => {
    const newUser = makeUser('signup-full-1', 'signup-full@example.com')

    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'new-tok', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('signup-full@example.com', 'secret123')
    expect(result.needsConfirmation).toBe(false)

    // Bootstrap chain mocks
    mockGetSession.mockResolvedValue({
      data: { session: { user: newUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: newUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user: newUser })
    await session.forceRefreshSession()

    const state = session.getSession()
    // Full bootstrap completed
    expect(state.user?.id).toBe('signup-full-1')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    // ensureProfileExists was called
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('signup-full-1')
    // getMyProfile was called
    expect(mockGetMyProfile).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. Signup creates user but failing bootstrap step is correctly classified
// ---------------------------------------------------------------------------

describe('post-signup bootstrap failure classification', () => {
  it('profile_create_failed when ensureProfileExists fails persistently', async () => {
    const user = makeUser('create-fail-1', 'createfail@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    // Both attempts fail with RLS error
    mockEnsureProfileExists.mockRejectedValue({
      message: 'new row violates row-level security policy',
      code: '42501',
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.errorKind).toBe('profile_create_failed')
    expect(state.error).toBe('new row violates row-level security policy')
    // Auth succeeded — user stays authenticated so gates can show retry
    // screen instead of bouncing to login.
    expect(state.sessionValidated).toBe(true)
    expect(state.user?.id).toBe('create-fail-1')
  })

  it('profile_load_failed when getMyProfile fails persistently', async () => {
    const user = makeUser('load-fail-1', 'loadfail@example.com')

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
    expect(state.errorKind).toBe('profile_load_failed')
    expect(state.error).toBe('Could not load profile')
    // Auth succeeded — user stays authenticated so gates can show retry
    // screen instead of bouncing to login.
    expect(state.sessionValidated).toBe(true)
    expect(state.user?.id).toBe('load-fail-1')
  })

  it('auth error during profile create still triggers recovery (not profile_create_failed)', async () => {
    const user = makeUser('auth-create-fail', 'authcreatefail@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    // Auth error — should trigger performInvalidSessionRecovery, not profile_create_failed
    mockEnsureProfileExists.mockRejectedValue({
      name: 'AuthApiError',
      message: 'JWT expired',
      status: 401,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Auth errors are rethrown to the outer catch which calls recovery
    expect(state.user).toBeNull()
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('transient profile creation failure recovers on retry', async () => {
    const user = makeUser('transient-1', 'transient@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })

    // First call fails, second succeeds
    let callCount = 0
    mockEnsureProfileExists.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.reject(new Error('temporary failure'))
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
    // Transient failure recovered on retry — bootstrap completed
    expect(state.sessionValidated).toBe(true)
    expect(state.user?.id).toBe('transient-1')
    expect(state.error).toBeNull()
    expect(mockEnsureProfileExists).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// 5. Profile creation/load after signup works
// ---------------------------------------------------------------------------

describe('profile creation/load after signup works', () => {
  it('ensureProfileExists is called for new signup user', async () => {
    const newUser = makeUser('profile-new-1', 'profilenew@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user: newUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: newUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user: newUser })
    await session.forceRefreshSession()

    expect(mockEnsureProfileExists).toHaveBeenCalledWith('profile-new-1')
    expect(mockGetMyProfile).toHaveBeenCalled()

    const state = session.getSession()
    expect(state.sessionValidated).toBe(true)
    expect(state.user?.id).toBe('profile-new-1')
  })
})

// ---------------------------------------------------------------------------
// 6. Role-missing after signup routes to role selection
// ---------------------------------------------------------------------------

describe('role-missing after signup → role selection', () => {
  it('signup with null role produces state that gates route to /onboarding/role', async () => {
    const newUser = makeUser('no-role-signup', 'norole@example.com')

    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'tok', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    await signUpWithPassword('norole@example.com', 'pass123')

    mockGetSession.mockResolvedValue({
      data: { session: { user: newUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: newUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user: newUser })
    await session.forceRefreshSession()

    const state = session.getSession()
    // HomeGate: sessionValidated=true, role=null → Navigate to /onboarding/role
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    expect(state.user?.id).toBe('no-role-signup')
  })
})

// ---------------------------------------------------------------------------
// 7. Valid login still works
// ---------------------------------------------------------------------------

describe('valid login still works', () => {
  it('signInWithPassword + bootstrap produces validated session', async () => {
    const user = makeUser('login-ok-1', 'login@example.com')

    mockSignInWithPassword.mockResolvedValue({
      data: { session: { user }, user },
      error: null,
    })

    const auth = await import('../../src/lib/auth')
    await auth.signInWithPassword('login@example.com', 'pass123')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
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
    expect(state.user?.id).toBe('login-ok-1')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 8. No regression to logout / account switching / sessionValidated logic
// ---------------------------------------------------------------------------

describe('no regression to logout/account switching/sessionValidated', () => {
  it('SIGNED_OUT clears session completely', async () => {
    const user = makeUser('signout-reg-1', 'signout@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    expect(session.getSession().sessionValidated).toBe(true)
    expect(session.getSession().user?.id).toBe('signout-reg-1')

    // Sign out
    capturedAuthCallback!('SIGNED_OUT', null)

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.loading).toBe(false)
    expect(state.role).toBeNull()
  })

  it('SIGNED_IN resets sessionValidated to prevent stale routing from previous session', async () => {
    const oldUser = makeUser('old-user-switch', 'old@example.com')

    // Start with a fully validated session
    mockGetSession.mockResolvedValue({
      data: { session: { user: oldUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: oldUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: true,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    expect(session.getSession().sessionValidated).toBe(true)
    expect(session.getSession().role).toBe('craftsman')

    // New sign-in with different user
    const newUser = makeUser('new-user-switch', 'new@example.com')
    capturedAuthCallback!('SIGNED_IN', { user: newUser })

    // Immediately after SIGNED_IN: sessionValidated must be false
    const midState = session.getSession()
    expect(midState.sessionValidated).toBe(false)
    expect(midState.loading).toBe(true)
    expect(midState.role).toBeNull()
    // Old role data must NOT leak through
    expect(midState.craftsmanRole).toBeNull()
  })

  it('network error during bootstrap does not validate session', async () => {
    const user = makeUser('net-err-reg', 'neterr@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.sessionValidated).toBe(false)
    expect(state.errorKind).toBe('network_error')
    expect(state.loading).toBe(false)
    // signOut must NOT be called — session may be valid once network returns
    expect(mockSignOut).not.toHaveBeenCalled()
  })
})
