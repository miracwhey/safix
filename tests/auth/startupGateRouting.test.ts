/**
 * Startup Gate Routing — unauthenticated startup gate repair
 *
 * Validates that the session bootstrap + gate logic enforces a strict
 * startup order:
 *
 *   STATE 1 — BOOTSTRAPPING  → loading indicator
 *   STATE 2 — UNAUTHENTICATED → login screen (never role selection)
 *   STATE 3 — AUTHENTICATED, PROFILE MISSING → recovery path
 *   STATE 4 — AUTHENTICATED, ROLE MISSING → role selection
 *   STATE 5 — AUTHENTICATED, ROLE READY → normal routing
 *
 * Key invariant: role selection must NEVER appear before a valid,
 * server-validated session exists.
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

describe('startup gate routing', () => {
  it('cold open with no session → unauthenticated state, not role selection', async () => {
    // No cached session, no Supabase session
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Must be unauthenticated — gates route to login
    expect(state.user).toBeNull()
    expect(state.role).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(false)
    expect(state.error).toBeNull()

    // No cache should exist
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
  })

  it('stale local cache but no valid session → login, not role selection', async () => {
    const staleUser = makeUser('stale-1', 'stale@example.com')

    // Stale cache from a previous session with role: null (the dangerous case)
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: staleUser,
      role: null,
      craftsmanRole: null,
      isOperator: false,
    }))

    // Delay getSession so we can observe the interim cached state
    let resolveGetSession!: (value: unknown) => void
    mockGetSession.mockReturnValue(new Promise(resolve => {
      resolveGetSession = resolve
    }))

    const session = await import('../../src/lib/session')

    // Before refresh completes, cached data is available but not validated
    const interimState = session.getSession()
    expect(interimState.user).not.toBeNull()
    expect(interimState.loading).toBe(true)
    expect(interimState.sessionValidated).toBe(false)

    // Now resolve — Supabase returns the stale JWT
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'Invalid JWT', status: 401 },
    })

    resolveGetSession({
      data: { session: { user: staleUser } },
      error: null,
    })

    await session.refreshSession()

    const state = session.getSession()

    // Must be fully cleared — gates route to login
    expect(state.user).toBeNull()
    expect(state.role).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // Cache must be cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
  })

  it('valid session + missing profile → recovery path (ensureProfileExists)', async () => {
    const user = makeUser('new-user-gate', 'newgate@example.com')

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
    await session.refreshSession()

    const state = session.getSession()

    // Session is validated — profile was created
    expect(state.user?.id).toBe('new-user-gate')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.role).toBeNull()

    // ensureProfileExists was called
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('new-user-gate')
  })

  it('valid session + missing role → role selection (only with validated session)', async () => {
    const user = makeUser('no-role-gate', 'norole@example.com')

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

    // Only now should role selection be shown: validated session + null role
    expect(state.user?.id).toBe('no-role-gate')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('valid session + role → normal routing', async () => {
    const user = makeUser('ready-user', 'ready@example.com')

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

    expect(state.user?.id).toBe('ready-user')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('bootstrap/loading does not flash role selection — sessionValidated stays false during load', async () => {
    const cachedUser = makeUser('cached-flash', 'flash@example.com')

    // Simulate a cached session with role: null (the scenario that
    // previously caused the bug)
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: cachedUser,
      role: null,
      craftsmanRole: null,
      isOperator: false,
    }))

    // Delay resolution to simulate slow network
    let resolveGetSession!: (value: unknown) => void
    mockGetSession.mockReturnValue(new Promise(resolve => {
      resolveGetSession = resolve
    }))

    const session = await import('../../src/lib/session')

    // During bootstrap: cached user is visible but NOT validated
    const bootState = session.getSession()
    expect(bootState.user?.id).toBe('cached-flash')
    expect(bootState.role).toBeNull()
    expect(bootState.loading).toBe(true)
    expect(bootState.sessionValidated).toBe(false)

    // Gates MUST NOT route to role selection here because:
    // 1. loading === true → gates show loading indicator
    // 2. sessionValidated === false → even if loading were false, gates
    //    would redirect to login, not role selection

    // Now resolve with no session (cache was stale)
    resolveGetSession({ data: { session: null }, error: null })
    await session.refreshSession()

    const finalState = session.getSession()
    expect(finalState.user).toBeNull()
    expect(finalState.sessionValidated).toBe(false)
    expect(finalState.loading).toBe(false)
    // Cache must be cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
  })

  it('deleted/invalid session with stale cache falls back to login cleanly', async () => {
    const deletedUser = makeUser('deleted-gate', 'deleted@example.com')

    // Stale cache with a role (full cached session)
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: deletedUser,
      role: 'craftsman',
      craftsmanRole: 'owner',
      isOperator: true,
    }))

    mockGetSession.mockResolvedValue({
      data: { session: { user: deletedUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'User not found', status: 404 },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Must be fully cleared
    expect(state.user).toBeNull()
    expect(state.role).toBeNull()
    expect(state.craftsmanRole).toBeNull()
    expect(state.isOperator).toBe(false)
    expect(state.sessionValidated).toBe(false)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // All caches cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('profile load failure keeps user authenticated — gates show retry screen', async () => {
    const user = makeUser('unknown-err-user', 'unknown@example.com')

    // Cache with role: null — the dangerous case
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user,
      role: null,
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

    // Profile load fails with a non-auth, non-network error
    mockGetMyProfile.mockRejectedValue(new Error('Unexpected database error'))

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Auth succeeded — user stays authenticated so gates can show retry
    // screen instead of bouncing to login.  Profile errors must not be
    // confused with auth failures.
    expect(state.user?.id).toBe('unknown-err-user')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeTruthy()
    expect(state.errorKind).toBe('profile_load_failed')
    // Session cache preserves the user for page reloads
    const cached = localStorage.getItem('fixup.session.cache.v1')
    expect(cached).toBeTruthy()
    expect(JSON.parse(cached!).user.id).toBe('unknown-err-user')
  })

  it('network error during validation shows retry, does not validate session', async () => {
    const user = makeUser('net-gate-user', 'netgate@example.com')

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

    // Network error: session is NOT validated
    expect(state.sessionValidated).toBe(false)
    expect(state.errorKind).toBe('network_error')
    expect(state.loading).toBe(false)

    // signOut must NOT be called — session may be valid once network returns
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('onAuthStateChange SIGNED_OUT clears sessionValidated', async () => {
    const user = makeUser('signout-gate', 'signout@example.com')

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

    // Verified: session is validated
    expect(session.getSession().sessionValidated).toBe(true)
    expect(session.getSession().user?.id).toBe('signout-gate')

    // Simulate sign-out
    capturedAuthCallback!('SIGNED_OUT', null)

    const afterSignOut = session.getSession()
    expect(afterSignOut.user).toBeNull()
    expect(afterSignOut.sessionValidated).toBe(false)
    expect(afterSignOut.loading).toBe(false)
  })
})
