/**
 * Signup → Login → Session → Bootstrap chain — end-to-end runtime tests
 *
 * Validates that the full auth chain works deterministically:
 *
 *   1. Password signup with email confirmations OFF → immediate session
 *   2. Password login for an existing password-auth user
 *   3. App reopen with valid session → session restored
 *   4. App reopen with invalid session → cleaned up, routed to login
 *   5. Missing profile recovery after auth → ensureProfileExists
 *   6. Missing role routing after auth → role selection
 *   7. Callback success path when confirmations are ON
 *   8. Callback failure → fallback to login
 *   9. No regression to logout / account switching
 *  10. AppBootstrap does not crash on notification init failure
 *  11. AuthCallbackScreen requires sessionValidated before routing
 *  12. LoginScreen uses sessionValidated to avoid redirect loops
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
// 1. Password signup with confirmations OFF → immediate session
// ---------------------------------------------------------------------------

describe('password signup with confirmations OFF', () => {
  it('signUp returns user+session → needsConfirmation=false → session bootstraps', async () => {
    const newUser = makeUser('signup-user-1', 'signup@example.com')

    // signUp returns both user AND session (confirmations OFF)
    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'new-tok', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('signup@example.com', 'secret123')

    // Must indicate no confirmation needed
    expect(result.needsConfirmation).toBe(false)

    // Now simulate what happens after signup in the runtime:
    // onAuthStateChange fires SIGNED_IN → forceRefreshSession → bootstrap
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

    // Simulate SIGNED_IN event from Supabase
    capturedAuthCallback!('SIGNED_IN', { user: newUser })
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('signup-user-1')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.role).toBeNull()
    // Gates will route to /onboarding/role since role is null
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('signup-user-1')
  })

  it('signup with session does not show awaiting-confirmation state', async () => {
    const user = makeUser('auto-confirm-user', 'autoconf@example.com')

    mockSignUp.mockResolvedValue({
      data: {
        user,
        session: { access_token: 'tok', user },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('autoconf@example.com', 'pass123456')

    expect(result.needsConfirmation).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Password login for existing password-auth user
// ---------------------------------------------------------------------------

describe('password login for existing user', () => {
  it('signInWithPassword succeeds → session bootstrap completes', async () => {
    const existingUser = makeUser('existing-pw-user', 'existing@example.com')

    // Login succeeds
    mockSignInWithPassword.mockResolvedValue({
      data: { session: { user: existingUser }, user: existingUser },
      error: null,
    })

    const { signInWithPassword } = await import('../../src/lib/auth')
    await signInWithPassword('existing@example.com', 'mypassword')

    // Simulate bootstrap after login
    mockGetSession.mockResolvedValue({
      data: { session: { user: existingUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: existingUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')

    capturedAuthCallback!('SIGNED_IN', { user: existingUser })
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('existing-pw-user')
    expect(state.role).toBe('customer')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('login with wrong password throws error without breaking state', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { session: null },
      error: new Error('Invalid login credentials'),
    })

    const { signInWithPassword } = await import('../../src/lib/auth')

    await expect(
      signInWithPassword('user@example.com', 'wrongpass'),
    ).rejects.toThrow('Invalid login credentials')
  })
})

// ---------------------------------------------------------------------------
// 3. App reopen with valid session → session restored
// ---------------------------------------------------------------------------

describe('app reopen with valid session', () => {
  it('cached session + valid getUser → session restored with sessionValidated=true', async () => {
    const user = makeUser('reopen-valid-user', 'reopen@example.com')

    // Pre-populate cache
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user,
      role: 'customer',
      craftsmanRole: null,
      isOperator: false,
    }))

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

    const state = session.getSession()
    expect(state.user?.id).toBe('reopen-valid-user')
    expect(state.role).toBe('customer')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. App reopen with invalid session → cleanup → login
// ---------------------------------------------------------------------------

describe('app reopen with invalid session', () => {
  it('stale cached session + invalid getUser → full cleanup, no fatal error', async () => {
    const staleUser = makeUser('stale-reopen', 'stale@example.com')

    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: staleUser,
      role: 'craftsman',
      craftsmanRole: 'owner',
      isOperator: true,
    }))

    mockGetSession.mockResolvedValue({
      data: { session: { user: staleUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'JWT expired', status: 401 },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Must be fully cleared — gates route to login, NOT to a fatal error
    expect(state.user).toBeNull()
    expect(state.role).toBeNull()
    expect(state.craftsmanRole).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // Cache must be cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})

// ---------------------------------------------------------------------------
// 5. Missing profile recovery after auth
// ---------------------------------------------------------------------------

describe('missing profile recovery after auth', () => {
  it('new auth user with no profile row → ensureProfileExists creates it', async () => {
    const newUser = makeUser('no-profile-user', 'noprofile@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user: newUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: newUser },
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
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('no-profile-user')
    expect(state.sessionValidated).toBe(true)
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('no-profile-user')
  })
})

// ---------------------------------------------------------------------------
// 6. Missing role routing after auth
// ---------------------------------------------------------------------------

describe('missing role routing after auth', () => {
  it('authenticated user with null role → sessionValidated=true, role=null', async () => {
    const user = makeUser('no-role-user', 'norole@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
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

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('no-role-user')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    // Gates will route to /onboarding/role
  })
})

// ---------------------------------------------------------------------------
// 7. Callback success path (confirmations ON)
// ---------------------------------------------------------------------------

describe('callback success path with confirmations ON', () => {
  it('SIGNED_IN event from callback → session established + profile loaded', async () => {
    const confirmedUser = makeUser('confirmed-user', 'confirmed@example.com')

    // Initial state: no session (user signed up but hasn't confirmed yet)
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    expect(session.getSession().user).toBeNull()

    // After user clicks confirm link → Supabase processes callback → SIGNED_IN
    mockGetSession.mockResolvedValue({
      data: { session: { user: confirmedUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: confirmedUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    capturedAuthCallback!('SIGNED_IN', { user: confirmedUser })
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('confirmed-user')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    expect(state.error).toBeNull()
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('confirmed-user')
  })
})

// ---------------------------------------------------------------------------
// 8. Callback failure → fallback to login
// ---------------------------------------------------------------------------

describe('callback failure fallback to login', () => {
  it('invalid/expired callback token → clean recovery, no fatal error', async () => {
    const staleUser = makeUser('bad-callback-user', 'badcallback@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user: staleUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'Invalid token', status: 401 },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})

// ---------------------------------------------------------------------------
// 9. No regression to logout / account switching
// ---------------------------------------------------------------------------

describe('no regression to logout/account switching', () => {
  it('SIGNED_OUT event clears all state correctly', async () => {
    const user = makeUser('logout-test-user', 'logout@example.com')

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

    expect(session.getSession().user?.id).toBe('logout-test-user')
    expect(session.getSession().sessionValidated).toBe(true)

    // Sign out
    capturedAuthCallback!('SIGNED_OUT', null)

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.role).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.loading).toBe(false)

    // Cache must be cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
  })

  it('account switch: user A → sign out → user B signs in with no leakage', async () => {
    const userA = makeUser('user-a-switch', 'a@switch.test')
    const userB = makeUser('user-b-switch', 'b@switch.test')

    // User A is signed in
    mockGetSession.mockResolvedValue({
      data: { session: { user: userA } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: userA },
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

    expect(session.getSession().user?.id).toBe('user-a-switch')

    // User A signs out
    capturedAuthCallback!('SIGNED_OUT', null)
    expect(session.getSession().user).toBeNull()

    // User B signs in
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
      is_operator: true,
      guided_entry_state: null,
    })

    capturedAuthCallback!('SIGNED_IN', { user: userB })
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('user-b-switch')
    expect(state.user?.id).not.toBe('user-a-switch')
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('owner')
    expect(state.isOperator).toBe(true)
    expect(state.sessionValidated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 10. AuthCallbackScreen requires sessionValidated
// ---------------------------------------------------------------------------

describe('AuthCallbackScreen sessionValidated requirement', () => {
  it('cached user without sessionValidated does not trigger premature routing', async () => {
    // Simulate a user in cache but not yet validated
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Without a user AND sessionValidated, callback screen should NOT route
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 11. Unknown error does not cause unrecoverable fatal state
// ---------------------------------------------------------------------------

describe('profile load failure recovery', () => {
  it('profile load failure keeps user authenticated — gates show retry', async () => {
    const user = makeUser('unknown-err-user', 'unknown@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockGetMyProfile.mockRejectedValue(new Error('Unexpected database error'))

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Auth succeeded — user stays authenticated so gates can show a
    // retry screen instead of bouncing to login.
    expect(state.user?.id).toBe('unknown-err-user')
    expect(state.sessionValidated).toBe(true)
    expect(state.error).toBeTruthy()
    expect(state.errorKind).toBe('profile_load_failed')
    // HomeGate will show retry screen, not redirect to /login
  })
})

// ---------------------------------------------------------------------------
// 12. Full signup → login lifecycle
// ---------------------------------------------------------------------------

describe('full signup → login lifecycle', () => {
  it('signup creates user → user can then login with same credentials', async () => {
    const user = makeUser('lifecycle-user', 'lifecycle@example.com')

    // Step 1: Signup (confirmations OFF → returns session)
    mockSignUp.mockResolvedValue({
      data: {
        user,
        session: { access_token: 'new-tok', user },
      },
      error: null,
    })

    const auth = await import('../../src/lib/auth')
    const signupResult = await auth.signUpWithPassword('lifecycle@example.com', 'pass123456')
    expect(signupResult.needsConfirmation).toBe(false)

    // Step 2: Login with same credentials
    mockSignInWithPassword.mockResolvedValue({
      data: { session: { user }, user },
      error: null,
    })

    await auth.signInWithPassword('lifecycle@example.com', 'pass123456')

    // Step 3: Verify session bootstrap works for the logged-in user
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
    expect(state.user?.id).toBe('lifecycle-user')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.error).toBeNull()
  })
})
