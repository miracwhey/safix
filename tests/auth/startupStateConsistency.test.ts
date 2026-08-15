/**
 * Startup State Consistency + Post-Signup Session Bootstrap Repair
 *
 * Validates:
 *   1. Cold open with stale cached session does NOT render wrong home/app
 *      state as final truth — loading indicator shown until validation
 *   2. Successful signup with usable session bootstraps into authenticated flow
 *   3. Signup creates user but session bootstrap failure is handled
 *      deterministically with a user-friendly message
 *   4. Startup no longer flashes stale pseudo-home state — onAuthStateChange
 *      INITIAL_SESSION with no user does not prematurely clear state while
 *      refreshSession() is in-flight
 *   5. Valid session + profile still routes correctly
 *   6. No regression to login / logout / account switching
 *   7. Non-Error objects (PostgrestError) produce real error messages
 *   8. SIGNED_IN resets sessionValidated to prevent stale routing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { User } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const mockGetSession = vi.fn()
const mockGetUser = vi.fn()
const mockSignOut = vi.fn().mockResolvedValue({ error: null })
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
// 1. Cold open with stale cached session does not render wrong state
// ---------------------------------------------------------------------------

describe('cold open with stale cached session', () => {
  it('stale cached craftsman/owner state shows loading, NOT craftsman dashboard', async () => {
    const staleUser = makeUser('stale-craft-1', 'stale@example.com')

    // Previous session was a craftsman/owner with full roles
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: staleUser,
      role: 'craftsman',
      craftsmanRole: 'owner',
      isOperator: true,
    }))

    // Server says session is invalid
    let resolveGetSession!: (value: unknown) => void
    mockGetSession.mockReturnValue(new Promise(resolve => {
      resolveGetSession = resolve
    }))

    const session = await import('../../src/lib/session')

    // During bootstrap: cached user is visible for the loading indicator
    // but role / craftsmanRole are intentionally NOT restored from cache
    // to prevent stale role data from leaking into the session state.
    const bootState = session.getSession()
    expect(bootState.user?.id).toBe('stale-craft-1')
    expect(bootState.role).toBeNull()
    expect(bootState.craftsmanRole).toBeNull()
    expect(bootState.loading).toBe(true)
    expect(bootState.sessionValidated).toBe(false)

    // KEY INVARIANT: role is null during bootstrap — no stale role data
    // can influence any component before the server validates the session
    // and the canonical profile is loaded.

    // Resolve with invalid session
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'Invalid JWT', status: 401 },
    })

    resolveGetSession({
      data: { session: { user: staleUser } },
      error: null,
    })

    await session.refreshSession()

    const finalState = session.getSession()
    expect(finalState.user).toBeNull()
    expect(finalState.role).toBeNull()
    expect(finalState.craftsmanRole).toBeNull()
    expect(finalState.sessionValidated).toBe(false)
    expect(finalState.loading).toBe(false)

    // Cache cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
  })

  it('stale cached customer state does not flash CustomerHomeScreen before validation', async () => {
    const staleUser = makeUser('stale-cust-1', 'stalecust@example.com')

    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: staleUser,
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

    // Before refresh completes: cached user is visible for the loading
    // indicator but role is intentionally NOT restored from cache to
    // prevent stale role data from leaking into the session state.
    const bootState = session.getSession()
    expect(bootState.user?.id).toBe('stale-cust-1')
    expect(bootState.role).toBeNull()
    expect(bootState.loading).toBe(true)
    expect(bootState.sessionValidated).toBe(false)
    // Role is null — no stale 'customer' role can influence any component

    // Resolve with no session
    resolveGetSession({ data: { session: null }, error: null })
    await session.refreshSession()

    const finalState = session.getSession()
    // No valid session → cleared
    expect(finalState.user).toBeNull()
    expect(finalState.role).toBeNull()
    expect(finalState.sessionValidated).toBe(false)
    expect(finalState.loading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Successful signup with usable session bootstraps correctly
// ---------------------------------------------------------------------------

describe('successful signup with usable session', () => {
  it('signup → SIGNED_IN → forceRefreshSession → sessionValidated=true', async () => {
    const newUser = makeUser('signup-ok-1', 'signup@example.com')

    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'new-tok', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('signup@example.com', 'secret123')
    expect(result.needsConfirmation).toBe(false)

    // After signup, simulate SIGNED_IN event + forceRefreshSession
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
    expect(state.user?.id).toBe('signup-ok-1')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    // New user → role is null → gates route to /onboarding/role
    expect(state.role).toBeNull()
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('signup-ok-1')
  })
})

// ---------------------------------------------------------------------------
// 3. Signup creates user but bootstrap fails deterministically
// ---------------------------------------------------------------------------

describe('signup creates user but session bootstrap fails', () => {
  it('profile creation failure after signup produces user-readable error, not generic fallback', async () => {
    const newUser = makeUser('signup-fail-1', 'failsignup@example.com')

    // getSession/getUser succeed but ensureProfileExists fails
    // with a PostgREST-style error (plain object, not Error instance)
    mockGetSession.mockResolvedValue({
      data: { session: { user: newUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: newUser },
      error: null,
    })
    mockEnsureProfileExists.mockRejectedValue({
      message: 'new row violates row-level security policy',
      code: '42501',
      details: null,
      hint: null,
    })

    const session = await import('../../src/lib/session')
    capturedAuthCallback!('SIGNED_IN', { user: newUser })
    await session.forceRefreshSession()

    const state = session.getSession()
    // Must NOT be the generic fallback — real message is extracted
    expect(state.error).toBe('new row violates row-level security policy')
    expect(state.error).not.toBe('Session-Laden fehlgeschlagen')
    expect(state.errorKind).toBe('profile_create_failed')
    // Auth succeeded — user stays authenticated so gates can show retry
    // screen instead of bouncing to login.
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.user?.id).toBe('signup-fail-1')
  })

  it('getUser failure with non-Error object shows real message', async () => {
    const user = makeUser('getuser-fail-1', 'getuserfail@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    // Supabase returns an error object that is NOT an Error instance
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: 'AuthRetryableFetchError',
        message: 'request to auth server failed',
        status: 0,
      },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.error).toBe('request to auth server failed')
    expect(state.error).not.toBe('Session-Laden fehlgeschlagen')
    expect(state.errorKind).toBe('network_error')
  })
})

// ---------------------------------------------------------------------------
// 4. INITIAL_SESSION with no user during in-flight refresh does not flash
// ---------------------------------------------------------------------------

describe('startup does not flash stale pseudo-home state', () => {
  it('INITIAL_SESSION with no user during in-flight refresh is ignored', async () => {
    const cachedUser = makeUser('flash-guard-1', 'flash@example.com')

    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: cachedUser,
      role: 'customer',
      craftsmanRole: null,
      isOperator: false,
    }))

    // Delay getSession so refreshSession is in-flight
    let resolveGetSession!: (value: unknown) => void
    mockGetSession.mockReturnValue(new Promise(resolve => {
      resolveGetSession = resolve
    }))

    const session = await import('../../src/lib/session')

    // refreshSession is in-flight → loading is true
    expect(session.getSession().loading).toBe(true)
    expect(session.getSession().user?.id).toBe('flash-guard-1')

    // Simulate Supabase firing INITIAL_SESSION with no user while refresh
    // is in-flight. This must NOT clear state to EMPTY_SESSION.
    capturedAuthCallback!('INITIAL_SESSION', null)

    const afterInitial = session.getSession()
    // State must still have cached user + loading: true — NOT EMPTY_SESSION
    // with loading: false (which would flash HomeScreen)
    expect(afterInitial.loading).toBe(true)
    expect(afterInitial.user?.id).toBe('flash-guard-1')

    // Now let refreshSession complete — session turns out to be valid
    mockGetUser.mockResolvedValue({
      data: { user: cachedUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    resolveGetSession({
      data: { session: { user: cachedUser } },
      error: null,
    })
    await session.refreshSession()

    const finalState = session.getSession()
    expect(finalState.user?.id).toBe('flash-guard-1')
    expect(finalState.sessionValidated).toBe(true)
    expect(finalState.loading).toBe(false)
    expect(finalState.role).toBe('customer')
  })

  it('SIGNED_OUT with no user always clears state even during in-flight refresh', async () => {
    const user = makeUser('signout-clear-1', 'signoutclear@example.com')

    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user,
      role: 'customer',
      craftsmanRole: null,
      isOperator: false,
    }))

    // Delay getSession so refreshSession is in-flight
    mockGetSession.mockReturnValue(new Promise(() => { /* never resolves */ }))

    const session = await import('../../src/lib/session')

    // refreshSession is in-flight
    expect(session.getSession().loading).toBe(true)

    // SIGNED_OUT must always clear, even with refresh in-flight
    capturedAuthCallback!('SIGNED_OUT', null)

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(false)
    expect(state.role).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. SIGNED_IN resets sessionValidated to prevent stale routing
// ---------------------------------------------------------------------------

describe('SIGNED_IN resets stale session data', () => {
  it('SIGNED_IN clears old role/craftsmanRole/sessionValidated from previous session', async () => {
    const oldUser = makeUser('old-user-1', 'old@example.com')

    // Establish an old validated session
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

    // Verify old session is fully validated
    expect(session.getSession().sessionValidated).toBe(true)
    expect(session.getSession().role).toBe('craftsman')
    expect(session.getSession().craftsmanRole).toBe('owner')

    // Now a new user signs in
    const newUser = makeUser('new-user-1', 'new@example.com')
    capturedAuthCallback!('SIGNED_IN', { user: newUser })

    // Immediately after SIGNED_IN: old session data must be cleared
    const midState = session.getSession()
    expect(midState.user?.id).toBe('new-user-1')
    expect(midState.sessionValidated).toBe(false) // MUST be reset
    expect(midState.role).toBeNull()               // MUST be reset
    expect(midState.craftsmanRole).toBeNull()       // MUST be reset
    expect(midState.isOperator).toBe(false)         // MUST be reset
    expect(midState.loading).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Valid session + profile still routes correctly
// ---------------------------------------------------------------------------

describe('valid session + profile routes correctly', () => {
  it('valid session with customer role → correct session state', async () => {
    const user = makeUser('valid-cust-1', 'valid@example.com')

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
    expect(state.user?.id).toBe('valid-cust-1')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('valid session with craftsman/owner role → correct session state', async () => {
    const user = makeUser('valid-craft-1', 'validcraft@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
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

    const state = session.getSession()
    expect(state.user?.id).toBe('valid-craft-1')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('owner')
    expect(state.isOperator).toBe(true)
    expect(state.loading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. No regression to login / logout / account switching
// ---------------------------------------------------------------------------

describe('no regression to login/logout/account switching', () => {
  it('SIGNED_OUT always clears full session state', async () => {
    const user = makeUser('logout-reg-1', 'logout@example.com')

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

    capturedAuthCallback!('SIGNED_OUT', null)

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(state.loading).toBe(false)
    expect(state.role).toBeNull()
    expect(state.error).toBeNull()
  })

  it('TOKEN_REFRESHED preserves existing role data while refreshing', async () => {
    const user = makeUser('refresh-tok-1', 'refreshtok@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'craftsman',
      craftsman_role: 'worker',
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    expect(session.getSession().role).toBe('craftsman')
    expect(session.getSession().craftsmanRole).toBe('worker')

    // TOKEN_REFRESHED should keep existing role data visible
    capturedAuthCallback!('TOKEN_REFRESHED', { user })

    const midState = session.getSession()
    expect(midState.role).toBe('craftsman')      // preserved
    expect(midState.craftsmanRole).toBe('worker') // preserved
    // A TOKEN_REFRESHED on an already-validated session is a warm re-validate:
    // loading must STAY false so loading-gated consumers (PersistentTabs, route
    // gates) keep their mounted tree instead of unmounting/flashing on every
    // token refresh / resume. Only a cold start (sessionValidated still false)
    // sets loading:true.
    expect(midState.loading).toBe(false)
  })

  it('same-user SIGNED_IN re-fire keeps the warm session (no teardown, no reload)', async () => {
    // supabase-js re-emits SIGNED_IN for the already-signed-in user on every
    // iOS foreground / tab refocus. The handler must NOT reset sessionValidated
    // or loading for the same already-validated user — doing so unmounts the
    // whole tab tree (PersistentTabs) and triggers a full repository resync,
    // i.e. the "app reloads and hangs on a quick background→foreground" bug.
    const user = makeUser('resume-refire-1', 'resume@example.com')

    mockGetSession.mockResolvedValue({ data: { session: { user } }, error: null })
    mockGetUser.mockResolvedValue({ data: { user }, error: null })
    mockGetMyProfile.mockResolvedValue({
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: true,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()
    expect(session.getSession().sessionValidated).toBe(true)

    // Same user signs in again (resume re-fire) — must stay warm.
    capturedAuthCallback!('SIGNED_IN', { user })

    const after = session.getSession()
    expect(after.sessionValidated).toBe(true)  // NOT torn down → tabs stay mounted
    expect(after.loading).toBe(false)          // no skeleton / reload flash
    expect(after.role).toBe('craftsman')       // preserved
    expect(after.craftsmanRole).toBe('owner')  // preserved
    expect(after.isOperator).toBe(true)        // preserved
    expect(after.user?.id).toBe('resume-refire-1')
  })
})
