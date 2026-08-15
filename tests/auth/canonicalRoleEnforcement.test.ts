/**
 * Canonical Role Source-of-Truth Enforcement Tests
 *
 * Validates that:
 *   1. strictCanonicalRole rejects all non-exact values (quotes, whitespace, case)
 *   2. getMyProfile returns null for malformed DB role values (no silent normalization)
 *   3. Fresh signup → profile role remains null
 *   4. Malformed role like "'customer'" is treated as invalid for gating
 *   5. Only explicit role selection via setMyRole writes canonical values
 *   6. No regression to valid customer/craftsman routing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { User } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const mockGetSession = vi.fn()
const mockGetUser = vi.fn()
const mockSignOut = vi.fn().mockResolvedValue({ error: null })

const mockOnAuthStateChange = vi.fn().mockImplementation(() => {
  return { data: { subscription: { unsubscribe: vi.fn() } } }
})

const mockUpsert = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockMaybeSingle = vi.fn()

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      getUser: mockGetUser,
      signOut: mockSignOut,
      onAuthStateChange: mockOnAuthStateChange,
    },
    from: vi.fn().mockReturnValue({
      upsert: mockUpsert,
      select: mockSelect,
    }),
  },
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
    email_confirmed_at: '2026-03-23T00:00:00Z',
    phone: '',
    phone_confirmed_at: null,
    confirmation_sent_at: '2026-03-23T00:00:00Z',
    confirmed_at: '2026-03-23T00:00:00Z',
    last_sign_in_at: '2026-03-23T00:00:00Z',
    app_metadata: {},
    user_metadata: {},
    identities: [],
    factors: [],
    created_at: '2026-03-23T00:00:00Z',
    updated_at: '2026-03-23T00:00:00Z',
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
  setupLocalStorage()
  mockUpsert.mockResolvedValue({ error: null })
  mockSelect.mockReturnValue({ eq: mockEq })
  mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// PART 1 — strictCanonicalRole: strict exact-match validation
// ---------------------------------------------------------------------------

describe('strictCanonicalRole', () => {
  it('accepts exact "customer"', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole('customer')).toBe('customer')
  })

  it('accepts exact "craftsman"', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole('craftsman')).toBe('craftsman')
  })

  it('rejects single-quoted customer: "\'customer\'"', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole("'customer'")).toBeNull()
  })

  it('rejects double-quoted craftsman: \'"craftsman"\'', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole('"craftsman"')).toBeNull()
  })

  it('rejects whitespace-padded values', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole('  customer  ')).toBeNull()
    expect(strictCanonicalRole(' craftsman ')).toBeNull()
  })

  it('rejects mixed case values', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole('Customer')).toBeNull()
    expect(strictCanonicalRole('CRAFTSMAN')).toBeNull()
  })

  it('rejects nested quotes', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole("\"'customer'\"")).toBeNull()
  })

  it('returns null for unknown role string', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole('admin')).toBeNull()
    expect(strictCanonicalRole('superuser')).toBeNull()
  })

  it('returns null for empty/whitespace string', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole('')).toBeNull()
    expect(strictCanonicalRole('   ')).toBeNull()
  })

  it('returns null for null/undefined', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole(null)).toBeNull()
    expect(strictCanonicalRole(undefined)).toBeNull()
  })

  it('returns null for non-string types', async () => {
    const { strictCanonicalRole } = await import('../../src/lib/profile')
    expect(strictCanonicalRole(42)).toBeNull()
    expect(strictCanonicalRole(true)).toBeNull()
    expect(strictCanonicalRole({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PART 2 — getMyProfile: malformed DB values are NOT normalized for gating
// ---------------------------------------------------------------------------

describe('getMyProfile strict role matching', () => {
  it('returns null role when DB contains malformed value "\'customer\'"', async () => {
    const user = makeUser('malformed-user-1', 'malformed1@test.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({
      data: { role: "'customer'", craftsman_role: null, is_operator: false, guided_entry_state: null },
      error: null,
    })

    const { getMyProfile } = await import('../../src/lib/profile')
    const profile = await getMyProfile()

    // Malformed role must NOT be silently normalized to 'customer'
    expect(profile.role).toBeNull()
  })

  it('returns null role when DB contains quoted "craftsman"', async () => {
    const user = makeUser('malformed-user-2', 'malformed2@test.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({
      data: { role: '"craftsman"', craftsman_role: null, is_operator: false, guided_entry_state: null },
      error: null,
    })

    const { getMyProfile } = await import('../../src/lib/profile')
    const profile = await getMyProfile()

    expect(profile.role).toBeNull()
  })

  it('returns null role when DB contains whitespace-padded value', async () => {
    const user = makeUser('malformed-user-3', 'malformed3@test.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({
      data: { role: '  customer  ', craftsman_role: null, is_operator: false, guided_entry_state: null },
      error: null,
    })

    const { getMyProfile } = await import('../../src/lib/profile')
    const profile = await getMyProfile()

    expect(profile.role).toBeNull()
  })

  it('returns canonical role when DB contains exact "customer"', async () => {
    const user = makeUser('canonical-user-1', 'canonical1@test.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({
      data: { role: 'customer', craftsman_role: null, is_operator: false, guided_entry_state: null },
      error: null,
    })

    const { getMyProfile } = await import('../../src/lib/profile')
    const profile = await getMyProfile()

    expect(profile.role).toBe('customer')
  })

  it('returns canonical role when DB contains exact "craftsman"', async () => {
    const user = makeUser('canonical-user-2', 'canonical2@test.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({
      data: { role: 'craftsman', craftsman_role: 'owner', is_operator: false, guided_entry_state: null },
      error: null,
    })

    const { getMyProfile } = await import('../../src/lib/profile')
    const profile = await getMyProfile()

    expect(profile.role).toBe('craftsman')
  })

  it('returns null role for fresh signup profile (role is null in DB)', async () => {
    const user = makeUser('fresh-signup', 'fresh@test.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({
      data: { role: null, craftsman_role: null, is_operator: false, guided_entry_state: null },
      error: null,
    })

    const { getMyProfile } = await import('../../src/lib/profile')
    const profile = await getMyProfile()

    expect(profile.role).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PART 3 — Session bootstrap: malformed role → null → role selection
// ---------------------------------------------------------------------------

describe('session bootstrap with malformed DB role', () => {
  // We need to mock profile functions for session bootstrap tests
  const mockGetMyProfileSession = vi.fn()
  const mockEnsureProfileExists = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.doMock('../../src/lib/profile', async () => {
      const actual = await vi.importActual<typeof import('../../src/lib/profile')>('../../src/lib/profile')
      return {
        ...actual,
        getMyProfile: (...args: unknown[]) => mockGetMyProfileSession(...args),
        ensureProfileExists: (...args: unknown[]) => mockEnsureProfileExists(...args),
      }
    })
  })

  function setupValidSessionMocks(userId: string, email: string) {
    const user = makeUser(userId, email)
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockEnsureProfileExists.mockResolvedValue(undefined)
    return user
  }

  it('malformed role "\'customer\'" in profile → session role is null → routes to role selection', async () => {
    setupValidSessionMocks('malformed-session-1', 'malformed@test.com')
    // getMyProfile (with strict matching) returns null for malformed role
    mockGetMyProfileSession.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('malformed-session-1')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    // Gates will redirect to /onboarding/role
  })

  it('fresh signup → null role → user must visit role selection', async () => {
    setupValidSessionMocks('fresh-signup', 'fresh@test.com')
    mockGetMyProfileSession.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('fresh-signup')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    // null role means HomeGate, AuthGate, RoleGate all redirect to /onboarding/role
  })

  it('explicit customer selection → canonical role in session', async () => {
    setupValidSessionMocks('explicit-customer', 'customer@test.com')
    mockGetMyProfileSession.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.role).toBe('customer')
    expect(state.sessionValidated).toBe(true)
  })

  it('explicit craftsman selection → canonical role in session', async () => {
    setupValidSessionMocks('explicit-craftsman', 'craftsman@test.com')
    mockGetMyProfileSession.mockResolvedValue({
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('owner')
    expect(state.sessionValidated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PART 4 — setMyRole: write-path only accepts canonical values
// ---------------------------------------------------------------------------

describe('setMyRole canonical write enforcement', () => {
  it('writes exact canonical "customer" value', async () => {
    const user = makeUser('write-customer', 'writecust@test.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })

    const { setMyRole } = await import('../../src/lib/profile')
    await setMyRole('customer')

    expect(mockUpsert).toHaveBeenCalledWith(
      { id: 'write-customer', role: 'customer', craftsman_role: null },
      { onConflict: 'id' },
    )
  })

  it('writes exact canonical "craftsman" value', async () => {
    const user = makeUser('write-craftsman', 'writecraft@test.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })

    const { setMyRole } = await import('../../src/lib/profile')
    await setMyRole('craftsman')

    expect(mockUpsert).toHaveBeenCalledWith(
      { id: 'write-craftsman', role: 'craftsman' },
      { onConflict: 'id' },
    )
  })
})

// ---------------------------------------------------------------------------
// PART 5 — normalizeRole still works for data-repair purposes
// ---------------------------------------------------------------------------

describe('normalizeRole (data-repair utility, not used for gating)', () => {
  it('normalizes malformed values for data repair', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole("'customer'")).toBe('customer')
    expect(normalizeRole('"craftsman"')).toBe('craftsman')
    expect(normalizeRole('  customer  ')).toBe('customer')
  })

  it('is NOT used by getMyProfile for role gating', async () => {
    // This is a documentation test: getMyProfile uses strictCanonicalRole,
    // which rejects malformed values. normalizeRole would accept them.
    const { normalizeRole, strictCanonicalRole } = await import('../../src/lib/profile')

    const malformedRole = "'customer'"
    expect(normalizeRole(malformedRole)).toBe('customer')  // normalizeRole accepts
    expect(strictCanonicalRole(malformedRole)).toBeNull()   // strictCanonicalRole rejects
  })
})
