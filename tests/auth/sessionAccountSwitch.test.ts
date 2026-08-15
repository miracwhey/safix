/**
 * Auth Foundation — Session-driven account switch test
 *
 * Validates the complete flow when the session module's auth state listener
 * processes a SIGNED_OUT → SIGNED_IN transition (account switch):
 *
 *   1. User A signs in → session has user A data
 *   2. SIGNED_OUT fires → session clears user, role, cache, guided entry
 *   3. SIGNED_IN fires for user B → session loads user B profile
 *   4. No leakage of user A state
 *
 * This exercises the real onAuthStateChange callback in session.ts, not just
 * the store-reset helper used in accountIsolation.test.ts.
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

vi.mock('../../src/lib/profile', () => ({
  getMyProfile: mockGetMyProfile,
  ensureProfileExists: vi.fn().mockResolvedValue(undefined),
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

describe('session-driven account switch', () => {
  it('SIGNED_OUT clears user A, then SIGNED_IN loads user B correctly', async () => {
    // ── Phase 1: User A is signed in ──────────────────────────────
    const userA = makeUser('user-a-111', 'alice@example.com')

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
      guided_entry_state: { step: 'invited', path: 'invited', selectedProviderId: null, projectId: null },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    // Verify user A is active
    const stateA = session.getSession()
    expect(stateA.user?.id).toBe('user-a-111')
    expect(stateA.role).toBe('customer')
    expect(stateA.loading).toBe(false)

    // Session cache should contain user A
    const cachedA = localStorage.getItem('fixup.session.cache.v1')
    expect(cachedA).toBeTruthy()
    expect(JSON.parse(cachedA!).user.id).toBe('user-a-111')

    // ── Phase 2: User A signs out ─────────────────────────────────
    expect(capturedAuthCallback).not.toBeNull()
    capturedAuthCallback!('SIGNED_OUT', null)

    // Session must be fully cleared
    const stateCleared = session.getSession()
    expect(stateCleared.user).toBeNull()
    expect(stateCleared.role).toBeNull()
    expect(stateCleared.craftsmanRole).toBeNull()
    expect(stateCleared.isOperator).toBe(false)
    expect(stateCleared.loading).toBe(false)

    // Cache must be cleared
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()

    // Guided entry cache must be cleared
    expect(localStorage.getItem('fixup.guided-entry.v1')).toBeNull()

    // ── Phase 3: User B signs in ──────────────────────────────────
    const userB = makeUser('user-b-222', 'bob@example.com')

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

    // User B is set immediately (before profile load completes)
    const stateInterim = session.getSession()
    expect(stateInterim.user?.id).toBe('user-b-222')
    expect(stateInterim.loading).toBe(true)

    // Wait for profile load to complete
    await session.refreshSession()

    // Verify user B is fully loaded
    const stateB = session.getSession()
    expect(stateB.user?.id).toBe('user-b-222')
    expect(stateB.user?.email).toBe('bob@example.com')
    expect(stateB.role).toBe('craftsman')
    expect(stateB.craftsmanRole).toBe('owner')
    expect(stateB.isOperator).toBe(true)
    expect(stateB.loading).toBe(false)

    // No leakage of user A data
    expect(stateB.user?.id).not.toBe('user-a-111')

    // Cache now contains user B
    const cachedB = localStorage.getItem('fixup.session.cache.v1')
    expect(cachedB).toBeTruthy()
    const parsedB = JSON.parse(cachedB!)
    expect(parsedB.user.id).toBe('user-b-222')
    expect(parsedB.role).toBe('craftsman')
    expect(parsedB.craftsmanRole).toBe('owner')
  })

  it('rapid account switch does not race between two users', async () => {
    const userA = makeUser('user-rapid-a', 'a@rapid.test')
    const userB = makeUser('user-rapid-b', 'b@rapid.test')

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
    expect(session.getSession().user?.id).toBe('user-rapid-a')

    // Rapid switch: sign out A + sign in B almost simultaneously
    capturedAuthCallback!('SIGNED_OUT', null)
    expect(session.getSession().user).toBeNull()

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
      craftsman_role: 'worker',
      is_operator: false,
      guided_entry_state: null,
    })

    capturedAuthCallback!('SIGNED_IN', { user: userB })
    await session.refreshSession()

    // Final state must be user B, not user A
    const final = session.getSession()
    expect(final.user?.id).toBe('user-rapid-b')
    expect(final.role).toBe('craftsman')
    expect(final.craftsmanRole).toBe('worker')
    expect(final.loading).toBe(false)
  })

  it('subscribers are notified on every state change during account switch', async () => {
    const userA = makeUser('user-sub-a', 'a@sub.test')

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

    const listener = vi.fn()
    const unsub = session.subscribeSession(listener)
    listener.mockClear()

    // Sign out fires notify
    capturedAuthCallback!('SIGNED_OUT', null)
    expect(listener).toHaveBeenCalled()
    expect(session.getSession().user).toBeNull()

    unsub()
  })
})
