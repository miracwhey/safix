/**
 * Post-signup handoff — Direct entry repair tests
 *
 * Validates that after signUpWithPassword() succeeds with an immediate session
 * (email confirmations OFF), the session bootstrap completes and gates route
 * the user correctly:
 *
 *   1. Signup + session → sessionValidated becomes true (no bounce to login)
 *   2. Signup + missing role → gates route to /onboarding/role
 *   3. Signup + existing role → gates route to correct app entry
 *   4. Session is NOT validated during bootstrap (prevents premature routing)
 *   5. No regression to normal login flow
 *   6. No regression to sessionValidated gate logic
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
// 1. Signup with immediate session → sessionValidated becomes true
// ---------------------------------------------------------------------------

describe('signup with immediate session routes into authenticated flow', () => {
  it('signUp returns session → needsConfirmation=false → bootstrap validates session', async () => {
    const newUser = makeUser('signup-handoff-1', 'handoff@example.com')

    // signUp returns both user AND session (confirmations OFF)
    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'new-tok', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('handoff@example.com', 'secret123')
    expect(result.needsConfirmation).toBe(false)

    // After signup, onAuthStateChange fires SIGNED_IN → forceRefreshSession
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
    // Session must be fully validated — gates can route to post-auth content
    expect(state.user?.id).toBe('signup-handoff-1')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
  })

  it('signup does not set sessionValidated before bootstrap completes', async () => {
    const newUser = makeUser('premature-check', 'premature@example.com')

    // Simulate a slow getSession to observe mid-bootstrap state
    let resolveGetSession: (value: unknown) => void
    mockGetSession.mockReturnValue(new Promise((r) => { resolveGetSession = r }))

    const session = await import('../../src/lib/session')

    // Trigger SIGNED_IN (as signUp would)
    capturedAuthCallback!('SIGNED_IN', { user: newUser })

    // Mid-bootstrap: user is set, but sessionValidated must NOT be true yet
    const midState = session.getSession()
    expect(midState.user?.id).toBe('premature-check')
    expect(midState.sessionValidated).toBe(false)
    expect(midState.loading).toBe(true)

    // Complete the bootstrap
    resolveGetSession!({
      data: { session: { user: newUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: newUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    await session.forceRefreshSession()

    const finalState = session.getSession()
    expect(finalState.sessionValidated).toBe(true)
    expect(finalState.loading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Signup + missing role → routes to /onboarding/role
// ---------------------------------------------------------------------------

describe('signup + missing role → role selection', () => {
  it('signup with role=null results in session state that gates route to /onboarding/role', async () => {
    const newUser = makeUser('needs-role-1', 'needsrole@example.com')

    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'tok', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('needsrole@example.com', 'pass123')
    expect(result.needsConfirmation).toBe(false)

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
    expect(state.sessionValidated).toBe(true)
    expect(state.user?.id).toBe('needs-role-1')
    expect(state.role).toBeNull()
    // HomeGate checks: sessionValidated=true, role=null → Navigate to /onboarding/role
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('needs-role-1')
  })
})

// ---------------------------------------------------------------------------
// 3. Signup + existing role → routes to correct app entry
// ---------------------------------------------------------------------------

describe('signup + existing role → correct app entry', () => {
  it('signup with role=customer results in session ready for CustomerHomeScreen', async () => {
    const newUser = makeUser('has-role-cust', 'cust@example.com')

    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'tok', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('cust@example.com', 'pass123')
    expect(result.needsConfirmation).toBe(false)

    mockGetSession.mockResolvedValue({
      data: { session: { user: newUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: newUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user: newUser })
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    // HomeGate checks: sessionValidated=true, role=customer → CustomerHomeScreen
  })

  it('signup with role=craftsman + craftsmanRole=owner results in session ready for dashboard', async () => {
    const newUser = makeUser('has-role-craft', 'craft@example.com')

    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'tok', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('craft@example.com', 'pass123')
    expect(result.needsConfirmation).toBe(false)

    mockGetSession.mockResolvedValue({
      data: { session: { user: newUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: newUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: true,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user: newUser })
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('owner')
    expect(state.isOperator).toBe(true)
    // HomeGate: sessionValidated=true, role=craftsman, craftsmanRole=owner → /craftsman/dashboard
  })
})

// ---------------------------------------------------------------------------
// 4. Signup does NOT falsely bounce back to login
// ---------------------------------------------------------------------------

describe('signup does not falsely bounce to login', () => {
  it('signup with needsConfirmation=false produces a session that passes gate checks', async () => {
    const newUser = makeUser('no-bounce-1', 'nobounce@example.com')

    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'tok', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('nobounce@example.com', 'pass123')

    // needsConfirmation is false — the signup returned a usable session
    expect(result.needsConfirmation).toBe(false)

    // After bootstrap completes, session must be fully validated
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
    // These are exactly the conditions HomeGate checks — must NOT show HomeScreen/login
    expect(state.user).not.toBeNull()
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    // The user's gates WILL let them through, NOT bounce to login
  })

  it('signUp with session does not show awaiting-confirmation state', async () => {
    const user = makeUser('auto-confirm-user-2', 'autoconf2@example.com')

    mockSignUp.mockResolvedValue({
      data: {
        user,
        session: { access_token: 'session-tok', user },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('autoconf2@example.com', 'password')

    // When session exists, needsConfirmation must be false — the user can
    // proceed immediately. The LoginScreen must NOT show the "please confirm
    // your email" message.
    expect(result.needsConfirmation).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. No regression to normal login flow
// ---------------------------------------------------------------------------

describe('no regression to normal login flow', () => {
  it('signInWithPassword still works and session bootstraps normally', async () => {
    const user = makeUser('login-user-1', 'login@example.com')

    mockSignInWithPassword.mockResolvedValue({
      data: { session: { user }, user },
      error: null,
    })

    const auth = await import('../../src/lib/auth')
    // Login must not throw
    await auth.signInWithPassword('login@example.com', 'pass123')

    // Session bootstrap after login
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
    expect(state.user?.id).toBe('login-user-1')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 6. No regression to sessionValidated gate logic
// ---------------------------------------------------------------------------

describe('no regression to sessionValidated gate logic', () => {
  it('unauthenticated state has sessionValidated=false', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.loading).toBe(false)
    // Gates must show login/HomeScreen, never role selection
  })

  it('SIGNED_OUT event clears sessionValidated', async () => {
    const user = makeUser('signout-test', 'signout@example.com')

    // Start with a valid session
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

    // User signs out
    capturedAuthCallback!('SIGNED_OUT', null)

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.loading).toBe(false)
  })

  it('network error during bootstrap does NOT validate session', async () => {
    const user = makeUser('net-err-user', 'neterr@example.com')

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
  })
})
