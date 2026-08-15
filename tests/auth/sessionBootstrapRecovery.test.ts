/**
 * Auth Bootstrap Recovery — deterministic startup recovery paths
 *
 * Tests the recovery flow added to refreshSession() in session.ts:
 *
 *   PATH 1 — invalid / deleted session → clear all local state → /login
 *   PATH 2 — valid session, missing profile → ensureProfileExists → continue
 *   PATH 3 — valid session, missing role → role is null → gates route to /onboarding/role
 *   PATH 4 — real network failure → retry-able error state
 *
 * Each scenario validates that:
 *   • The correct BootstrapErrorKind is (or is not) set
 *   • Local caches are cleared when appropriate
 *   • No stale user data survives recovery
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

describe('bootstrap recovery', () => {
  it('PATH 1a — deleted user with stale local session → reset + no error', async () => {
    // Simulate a stale cached session from a user that was deleted on the server
    const staleUser = makeUser('deleted-user-1', 'deleted@example.com')

    // Pre-populate caches to simulate stale state
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: staleUser,
      role: 'customer',
      craftsmanRole: null,
      isOperator: false,
    }))
    localStorage.setItem('fixup.guided-entry.v1', JSON.stringify({
      step: 'invited',
      path: 'invited',
      selectedProviderId: null,
      projectId: null,
    }))

    // getSession returns the stale local session
    mockGetSession.mockResolvedValue({
      data: { session: { user: staleUser } },
      error: null,
    })

    // getUser validates against the server and finds the user was deleted
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'User not found', status: 404 },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // User must be null — recovery cleared the stale session
    expect(state.user).toBeNull()
    expect(state.role).toBeNull()
    expect(state.craftsmanRole).toBeNull()
    expect(state.isOperator).toBe(false)
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(false)

    // No error should be set — the app routes to /login via gates
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // All caches must be cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
    expect(localStorage.getItem('fixup.guided-entry.v1')).toBeNull()

    // signOut must have been called to clear Supabase auth storage
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('PATH 1b — invalid session (expired/revoked JWT) → reset + no error', async () => {
    const staleUser = makeUser('expired-user-1', 'expired@example.com')

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

    // Server rejects the token
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'Invalid JWT: token expired', status: 401 },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(false)

    // Cache must be cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('PATH 1c — auth error during profile load → recovery', async () => {
    const user = makeUser('user-auth-fail', 'authfail@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })

    // ensureProfileExists fails with auth error (session became invalid mid-request)
    mockEnsureProfileExists.mockRejectedValue({
      name: 'AuthApiError',
      message: 'JWT expired',
      status: 401,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(state.sessionValidated).toBe(false)
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('PATH 2 — valid session + missing profile → ensureProfileExists creates it, continue normally', async () => {
    const user = makeUser('new-user-1', 'newuser@example.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockEnsureProfileExists.mockResolvedValue(undefined)

    // Profile returns with null role (freshly created row)
    mockGetMyProfile.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Session is valid — user is set
    expect(state.user?.id).toBe('new-user-1')
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(true)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // Role is null — gates will redirect to /onboarding/role
    expect(state.role).toBeNull()

    // ensureProfileExists was called to create the profile row
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('new-user-1')
  })

  it('PATH 3 — valid session + profile exists + role missing → role is null for gate routing', async () => {
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
    expect(state.role).toBeNull()
    expect(state.sessionValidated).toBe(true)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    // Gates will see role === null + sessionValidated === true and redirect to /onboarding/role
  })

  it('PATH 4 — real network failure → retry-able error with network_error kind', async () => {
    const staleUser = makeUser('net-fail-user', 'netfail@example.com')

    // Pre-populate cache so we have a user in state
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: staleUser,
      role: 'customer',
      craftsmanRole: null,
      isOperator: false,
    }))

    mockGetSession.mockResolvedValue({
      data: { session: { user: staleUser } },
      error: null,
    })

    // getUser fails with a network error
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Error must be set with network_error kind — gates show retry screen
    expect(state.error).toBeTruthy()
    expect(state.errorKind).toBe('network_error')
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(false)

    // signOut must NOT have been called — session might still be valid
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('normal valid session bootstrap still works correctly', async () => {
    const user = makeUser('valid-user-1', 'valid@example.com')

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
      guided_entry_state: { step: 'initial', path: null, selectedProviderId: null, projectId: null },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('valid-user-1')
    expect(state.role).toBe('customer')
    expect(state.craftsmanRole).toBeNull()
    expect(state.isOperator).toBe(false)
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(true)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // Session cache must be populated
    const cached = localStorage.getItem('fixup.session.cache.v1')
    expect(cached).toBeTruthy()
    const parsed = JSON.parse(cached!)
    expect(parsed.user.id).toBe('valid-user-1')
    expect(parsed.role).toBe('customer')
  })

  it('no cross-account stale state after recovery from deleted user', async () => {
    // Phase 1: User A is logged in
    const userA = makeUser('user-a-stale', 'a@stale.test')

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
      guided_entry_state: { step: 'invited', path: 'invited', selectedProviderId: 'prov-1', projectId: null },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    expect(session.getSession().user?.id).toBe('user-a-stale')
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeTruthy()

    // Phase 2: Simulate app reload where user A's session was deleted server-side
    mockGetSession.mockResolvedValue({
      data: { session: { user: userA } }, // Still in local storage
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'User not found', status: 404 },
    })

    await session.refreshSession()

    // State must be fully cleared — no leakage of user A
    const stateAfterRecovery = session.getSession()
    expect(stateAfterRecovery.user).toBeNull()
    expect(stateAfterRecovery.role).toBeNull()
    expect(stateAfterRecovery.craftsmanRole).toBeNull()
    expect(stateAfterRecovery.isOperator).toBe(false)
    expect(stateAfterRecovery.sessionValidated).toBe(false)
    expect(stateAfterRecovery.error).toBeNull()
    expect(stateAfterRecovery.errorKind).toBeNull()

    // All caches must be cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
    expect(localStorage.getItem('fixup.guided-entry.v1')).toBeNull()

    // Phase 3: User B signs in — no leakage of user A data
    const userB = makeUser('user-b-fresh', 'b@fresh.test')

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
    await session.refreshSession()

    const stateB = session.getSession()
    expect(stateB.user?.id).toBe('user-b-fresh')
    expect(stateB.user?.id).not.toBe('user-a-stale')
    expect(stateB.role).toBe('craftsman')
    expect(stateB.craftsmanRole).toBe('owner')
    expect(stateB.isOperator).toBe(true)
    expect(stateB.loading).toBe(false)
    expect(stateB.sessionValidated).toBe(true)
  })
})

describe('error classification', () => {
  it('classifies AuthApiError with 401 as invalid_session', async () => {
    const session = await import('../../src/lib/session')
    expect(session.classifyError({ name: 'AuthApiError', message: 'Unauthorized', status: 401 })).toBe('invalid_session')
  })

  it('classifies AuthApiError with 404 and "User not found" as deleted_user', async () => {
    const session = await import('../../src/lib/session')
    expect(session.classifyError({ name: 'AuthApiError', message: 'User not found', status: 404 })).toBe('deleted_user')
  })

  it('classifies AuthRetryableFetchError as network_error', async () => {
    const session = await import('../../src/lib/session')
    expect(session.classifyError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 })).toBe('network_error')
  })

  it('classifies TypeError with "fetch" as network_error', async () => {
    const session = await import('../../src/lib/session')
    expect(session.classifyError(new TypeError('Failed to fetch'))).toBe('network_error')
  })

  it('classifies JWT-related messages as invalid_session', async () => {
    const session = await import('../../src/lib/session')
    expect(session.classifyError({ message: 'JWT expired', status: 401 })).toBe('invalid_session')
    expect(session.classifyError({ message: 'Invalid Refresh Token', status: 400 })).toBe('invalid_session')
  })

  it('classifies unknown errors as unknown_error', async () => {
    const session = await import('../../src/lib/session')
    expect(session.classifyError(new Error('Something weird happened'))).toBe('unknown_error')
    expect(session.classifyError('string error')).toBe('unknown_error')
  })
})
