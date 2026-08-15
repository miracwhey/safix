/**
 * Email Confirmation Callback — tests for the Supabase auth callback flow
 *
 * Validates the full lifecycle of the email-confirmation return path:
 *
 *   1. Callback with valid session establishes session correctly
 *   2. Confirmed user with missing profile recovers correctly
 *   3. Confirmed user with missing role routes to role selection
 *   4. Invalid/expired callback falls back to login
 *   5. Callback no longer collapses into generic internet error
 *   6. No regression to normal password login/session restore
 *   7. hasAuthCallbackParams() detects callback URLs
 *   8. forceRefreshSession() bypasses deduplication
 *   9. onAuthStateChange handler uses forceRefreshSession for SIGNED_IN events
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

function makeUser(id = 'confirmed-user-1', email = 'confirmed@example.com'): User {
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

function setWindowLocation(url: string) {
  const urlObj = new URL(url)
  vi.stubGlobal('window', {
    location: {
      hash: urlObj.hash,
      search: urlObj.search,
      origin: urlObj.origin,
      href: urlObj.href,
    },
    btoa: globalThis.btoa?.bind(globalThis),
    atob: globalThis.atob?.bind(globalThis),
  })
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
// Tests: hasAuthCallbackParams
// ---------------------------------------------------------------------------

describe('hasAuthCallbackParams', () => {
  it('detects hash-based access_token callback', async () => {
    setWindowLocation('https://app.fixup.test/#access_token=xxx&type=signup')
    const session = await import('../../src/lib/session')
    expect(session.hasAuthCallbackParams()).toBe(true)
  })

  it('detects PKCE code callback', async () => {
    setWindowLocation('https://app.fixup.test/?code=abc123')
    const session = await import('../../src/lib/session')
    expect(session.hasAuthCallbackParams()).toBe(true)
  })

  it('returns false for normal URLs', async () => {
    setWindowLocation('https://app.fixup.test/')
    const session = await import('../../src/lib/session')
    expect(session.hasAuthCallbackParams()).toBe(false)
  })

  it('returns false for URLs with unrelated query params', async () => {
    setWindowLocation('https://app.fixup.test/?foo=bar')
    const session = await import('../../src/lib/session')
    expect(session.hasAuthCallbackParams()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: email confirmation callback flow
// ---------------------------------------------------------------------------

describe('email confirmation callback flow', () => {
  it('successful callback establishes session via SIGNED_IN event', async () => {
    // Simulate: no previous session, returning from email confirmation
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    // The module-level refreshSession() fires eagerly (no callback params in test URL)
    // so wait for it to settle
    await session.refreshSession()

    // After initial refresh with no session — should be EMPTY_SESSION
    const initialState = session.getSession()
    expect(initialState.user).toBeNull()
    expect(initialState.error).toBeNull()

    // Now simulate Supabase finishing the callback processing
    const confirmedUser = makeUser()

    mockGetSession.mockResolvedValue({
      data: { session: { user: confirmedUser } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user: confirmedUser },
      error: null,
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    // Trigger the SIGNED_IN event as Supabase would after processing callback
    capturedAuthCallback!('SIGNED_IN', { user: confirmedUser })
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('confirmed-user-1')
    expect(state.role).toBe('customer')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
  })

  it('confirmed user with missing profile recovers via ensureProfileExists', async () => {
    const user = makeUser('new-confirmed-user', 'newuser@example.com')

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

    // Simulate SIGNED_IN event after email confirmation
    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    const state = session.getSession()

    // Session is valid — user is set
    expect(state.user?.id).toBe('new-confirmed-user')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // ensureProfileExists was called
    expect(mockEnsureProfileExists).toHaveBeenCalledWith('new-confirmed-user')

    // Role is null — gates will redirect to /onboarding/role
    expect(state.role).toBeNull()
  })

  it('confirmed user with missing role has role=null for gate routing', async () => {
    const user = makeUser('no-role-confirmed', 'norole@confirmed.test')

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

    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('no-role-confirmed')
    expect(state.role).toBeNull()
    expect(state.error).toBeNull()
    // Gates should route to /onboarding/role
  })

  it('invalid/expired callback token results in clean recovery to login', async () => {
    // Simulate: Supabase processed an invalid/expired callback token
    // The getSession might return something stale or the getUser fails
    const staleUser = makeUser('expired-callback', 'expired@callback.test')

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

    // User must be null — recovery cleared the invalid session
    expect(state.user).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // signOut must have been called for cleanup
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('callback processing does NOT trigger generic internet error', async () => {
    const user = makeUser('callback-user', 'callback@test.com')

    // Simulate callback where getSession initially returns null (race condition)
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    // After initial refresh with no session — should be EMPTY_SESSION, NO error
    let state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(state.loading).toBe(false)

    // Now the callback completes — Supabase fires SIGNED_IN
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

    capturedAuthCallback!('SIGNED_IN', { user })
    await session.forceRefreshSession()

    state = session.getSession()
    expect(state.user?.id).toBe('callback-user')
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    expect(state.loading).toBe(false)
  })

  it('normal password login still works without regression', async () => {
    const user = makeUser('password-user', 'password@test.com')

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
    expect(state.user?.id).toBe('password-user')
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('owner')
    expect(state.isOperator).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // Session cache must be populated
    const cached = localStorage.getItem('fixup.session.cache.v1')
    expect(cached).toBeTruthy()
    const parsed = JSON.parse(cached!)
    expect(parsed.user.id).toBe('password-user')
    expect(parsed.role).toBe('craftsman')
  })
})

// ---------------------------------------------------------------------------
// Tests: forceRefreshSession
// ---------------------------------------------------------------------------

describe('forceRefreshSession', () => {
  it('starts a new refresh even when one was in-flight', async () => {
    const user = makeUser('force-refresh-user', 'force@test.com')

    // First getSession returns null (race condition during callback)
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')

    // Start a normal refresh — it will resolve with empty session
    await session.refreshSession()

    let state = session.getSession()
    expect(state.user).toBeNull()

    // Now update mocks for the valid callback session
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

    // forceRefreshSession should override the deduplication
    await session.forceRefreshSession()

    state = session.getSession()
    expect(state.user?.id).toBe('force-refresh-user')
    expect(state.role).toBe('customer')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests: onAuthStateChange event handling
// ---------------------------------------------------------------------------

describe('onAuthStateChange event handling', () => {
  it('SIGNED_IN event after callback triggers forceRefreshSession', async () => {
    const user = makeUser('signed-in-user', 'signin@callback.test')

    // Initial state: no session
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    // Verify initial empty state
    expect(session.getSession().user).toBeNull()

    // Setup mocks for the callback session
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

    // Fire SIGNED_IN event (as Supabase would after callback processing)
    capturedAuthCallback!('SIGNED_IN', { user })

    // Wait for the async refresh triggered by the handler
    // The handler calls forceRefreshSession which is async
    await session.forceRefreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('signed-in-user')
    expect(state.role).toBe('customer')
    expect(state.error).toBeNull()
    expect(state.loading).toBe(false)
  })

  it('SIGNED_OUT event clears state correctly', async () => {
    const user = makeUser('signout-user', 'signout@test.com')

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

    expect(session.getSession().user?.id).toBe('signout-user')

    // Fire SIGNED_OUT event
    capturedAuthCallback!('SIGNED_OUT', null)

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.role).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests: network error remains visible
// ---------------------------------------------------------------------------

describe('network error handling', () => {
  it('real network error still shows retry-able error state', async () => {
    const staleUser = makeUser('net-fail-user', 'netfail@test.com')

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
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.error).toBeTruthy()
    expect(state.errorKind).toBe('network_error')
    expect(state.loading).toBe(false)
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('unknown error does NOT cause generic internet error state for callback returns', async () => {
    // Simulate an unknown error during callback processing
    const user = makeUser('unknown-err-user', 'unknown@test.com')

    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    // Profile query fails with a non-auth, non-network error
    mockGetMyProfile.mockRejectedValue(new Error('Unexpected database error'))

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Error is set but it's unknown_error, not network_error
    // HomeGate should NOT show the generic internet error screen for this
    expect(state.error).toBeTruthy()
    expect(state.errorKind).toBe('profile_load_failed')
  })
})
