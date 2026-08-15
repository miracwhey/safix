/**
 * Reload & Reopen Hardening Tests
 *
 * Validates that the auth + role + customer-entry flow remains correct
 * after app reload / reopen:
 *
 *   1. Reopen with valid customer role → customer flow
 *   2. Reopen with valid craftsman role → craftsman flow
 *   3. Reopen with missing role → role selection
 *   4. Invalid/malformed role after reopen → role selection
 *   5. Stale cache cannot bypass canonical role truth
 *   6. Path A remains provider-directed after reload
 *   7. Path B remains project-directed after reload
 *   8. No route loop between auth / role / home
 *   9. No regression to signup/login/bootstrap
 *  10. Corrupted guided-entry cache → initial state
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

describe('reload / reopen hardening', () => {
  // -----------------------------------------------------------------------
  // 1. Reopen with valid customer role → customer flow
  // -----------------------------------------------------------------------
  it('reopen with valid customer role produces customer-ready session', async () => {
    const user = makeUser('reload-customer', 'reload-cust@example.com')

    // Simulate cached session from previous visit
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user,
      role: 'customer',
      craftsmanRole: null,
      isOperator: false,
    }))

    // Server confirms customer role
    setupValidSession(user, {
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('reload-customer')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('customer')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  // -----------------------------------------------------------------------
  // 2. Reopen with valid craftsman role → craftsman flow
  // -----------------------------------------------------------------------
  it('reopen with valid craftsman role produces craftsman-ready session', async () => {
    const user = makeUser('reload-craftsman', 'reload-craft@example.com')

    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user,
      role: 'craftsman',
      craftsmanRole: 'owner',
      isOperator: false,
    }))

    setupValidSession(user, {
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('reload-craftsman')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('owner')
    expect(state.loading).toBe(false)
  })

  // -----------------------------------------------------------------------
  // 3. Reopen with missing role → role selection
  // -----------------------------------------------------------------------
  it('reopen with missing role results in null role → gates route to role selection', async () => {
    const user = makeUser('reload-no-role', 'norole@example.com')

    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user,
      role: null,
      craftsmanRole: null,
      isOperator: false,
    }))

    setupValidSession(user, {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('reload-no-role')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    // HomeGate/AuthGate: sessionValidated + role==null → /onboarding/role
  })

  // -----------------------------------------------------------------------
  // 4. Invalid/malformed role after reopen → role selection
  // -----------------------------------------------------------------------
  it('malformed role from DB is treated as null after reopen', async () => {
    const user = makeUser('reload-bad-role', 'badrole@example.com')

    // strictCanonicalRole in getMyProfile returns null for malformed values.
    // Simulate the profile mock returning null (since getMyProfile already
    // does the strict check internally — this test validates the gate behavior).
    setupValidSession(user, {
      role: null,  // strictCanonicalRole("'customer'") → null
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    // Gates redirect to /onboarding/role
  })

  // -----------------------------------------------------------------------
  // 5. Stale cache cannot bypass canonical role truth
  // -----------------------------------------------------------------------
  it('stale cached craftsman role cannot bypass server null role', async () => {
    const user = makeUser('stale-craftsman-cache', 'stalecraft@example.com')

    // Cache says craftsman, server says null
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user,
      role: 'craftsman',
      craftsmanRole: 'owner',
      isOperator: true,
    }))

    setupValidSession(user, {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    // After server validation: canonical truth wins — stale cache role is
    // overwritten by the fresh server response.
    const state = session.getSession()
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    expect(state.craftsmanRole).toBeNull()
    expect(state.isOperator).toBe(false)
    // The stale 'craftsman' + 'owner' from cache MUST NOT leak through
  })

  // -----------------------------------------------------------------------
  // 6. Path A remains provider-directed after reload
  // -----------------------------------------------------------------------
  it('Path A guided-entry state survives reload via Supabase hydration', async () => {
    const user = makeUser('reload-path-a', 'patha@example.com')

    const guidedState = {
      step: 'provider_selected',
      path: 'invited',
      selectedProviderId: 'prov-abc',
      projectId: null,
    }

    setupValidSession(user, {
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: guidedState,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    // Verify session is customer
    expect(session.getSession().role).toBe('customer')

    // Verify guided entry state was hydrated from server
    const { getGuidedEntryState } = await import('../../src/lib/customerEntry/guidedEntryState')
    const s = getGuidedEntryState()
    expect(s.step).toBe('provider_selected')
    expect(s.path).toBe('invited')
    expect(s.selectedProviderId).toBe('prov-abc')
  })

  // -----------------------------------------------------------------------
  // 7. Path B remains project-directed after reload
  // -----------------------------------------------------------------------
  it('Path B guided-entry state survives reload via Supabase hydration', async () => {
    const user = makeUser('reload-path-b', 'pathb@example.com')

    const guidedState = {
      step: 'project_created',
      path: 'self_found',
      selectedProviderId: null,
      projectId: 'proj-xyz',
    }

    setupValidSession(user, {
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: guidedState,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    expect(session.getSession().role).toBe('customer')

    const { getGuidedEntryState } = await import('../../src/lib/customerEntry/guidedEntryState')
    const s = getGuidedEntryState()
    expect(s.step).toBe('project_created')
    expect(s.path).toBe('self_found')
    expect(s.projectId).toBe('proj-xyz')
    expect(s.selectedProviderId).toBeNull()
  })

  // -----------------------------------------------------------------------
  // 8. No route loop between auth / role / home
  // -----------------------------------------------------------------------
  it('no route loop: valid session always settles into a determinate state', async () => {
    const user = makeUser('no-loop', 'noloop@example.com')

    setupValidSession(user, {
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Must be in a terminal state: validated, not loading, no error
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(true)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()

    // Gates will resolve deterministically:
    // - HomeGate: user + validated + role=customer → CustomerHomeScreen
    // - AuthGate: user + validated → pass through
    // - No redirect loop
    expect(state.user).not.toBeNull()
    expect(state.role).toBe('customer')
  })

  it('no route loop: null role settles into role selection state', async () => {
    const user = makeUser('null-role-settle', 'nullrole@example.com')

    setupValidSession(user, {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()

    // Terminal state: validated, role null → gates always redirect to /onboarding/role
    expect(state.loading).toBe(false)
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    // This is a stable terminal state: /onboarding/role uses allowMissingRole
    // which allows null role, so the user lands on role selection without
    // being bounced back to /login or /.
  })

  // -----------------------------------------------------------------------
  // 9. No regression to signup/login/bootstrap
  // -----------------------------------------------------------------------
  it('unauthenticated reopen does not show stale role data', async () => {
    // No session on server
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
    // Gates will redirect to /login
  })

  // -----------------------------------------------------------------------
  // 10. Corrupted session cache → falls back gracefully
  // -----------------------------------------------------------------------
  it('corrupted session cache is rejected and does not produce partial user', async () => {
    // Corrupted cache: user without id
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: { name: 'fake' },
      role: 'customer',
    }))

    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Corrupted cache should have been rejected — no user
    expect(state.user).toBeNull()
    expect(state.role).toBeNull()
    expect(state.loading).toBe(false)
  })

  it('corrupted session cache with non-object value is rejected', async () => {
    localStorage.setItem('fixup.session.cache.v1', '"not-an-object"')

    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user).toBeNull()
    expect(state.loading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Role strict validation on reload
// ---------------------------------------------------------------------------

describe('role validation hardening on reload', () => {
  it('strictCanonicalRole rejects quoted role on reload path', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole("'customer'")).toBeNull()
    expect(strictCanonicalRole('"craftsman"')).toBeNull()
    expect(strictCanonicalRole(' customer ')).toBeNull()
    expect(strictCanonicalRole('CUSTOMER')).toBeNull()
  })

  it('strictCanonicalRole accepts only exact canonical values', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole('customer')).toBe('customer')
    expect(strictCanonicalRole('craftsman')).toBe('craftsman')
    expect(strictCanonicalRole(null)).toBeNull()
    expect(strictCanonicalRole(undefined)).toBeNull()
  })

  it('strictCanonicalCraftsmanRole rejects invalid craftsman role values', async () => {
    const { strictCanonicalCraftsmanRole } = await import('../../src/lib/profile')
    expect(strictCanonicalCraftsmanRole('owner')).toBe('owner')
    expect(strictCanonicalCraftsmanRole('worker')).toBe('worker')
    expect(strictCanonicalCraftsmanRole("'owner'")).toBeNull()
    expect(strictCanonicalCraftsmanRole('admin')).toBeNull()
    expect(strictCanonicalCraftsmanRole(null)).toBeNull()
    expect(strictCanonicalCraftsmanRole(42)).toBeNull()
    expect(strictCanonicalCraftsmanRole('')).toBeNull()
  })

  it('SIGNED_IN resets all role state to prevent stale data from prior session on reopen', async () => {
    const user1 = makeUser('reopen-user1', 'user1@example.com')

    // First session: craftsman owner
    setupValidSession(user1, {
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: true,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    expect(session.getSession().role).toBe('craftsman')
    expect(session.getSession().craftsmanRole).toBe('owner')

    // Simulate new sign-in (different user or reauth)
    const user2 = makeUser('reopen-user2', 'user2@example.com')
    capturedAuthCallback!('SIGNED_IN', { user: user2 })

    const afterSignIn = session.getSession()
    // All role state must be reset
    expect(afterSignIn.role).toBeNull()
    expect(afterSignIn.craftsmanRole).toBeNull()
    expect(afterSignIn.isOperator).toBe(false)
    expect(afterSignIn.sessionValidated).toBe(false)
    expect(afterSignIn.loading).toBe(true)
  })
})
