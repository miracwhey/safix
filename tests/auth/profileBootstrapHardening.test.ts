/**
 * Profile Bootstrap Hardening + Canonical Role Normalization
 *
 * Tests that the profile bootstrap is resilient to:
 *   - malformed role values (quoted, whitespace-padded, unknown)
 *   - missing optional schema columns (guided_entry_state)
 *   - invalid role values that should route to role selection, not cause loops
 *
 * Also validates that role writes always use canonical values only.
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

vi.mock('../../src/lib/profile', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/profile')>('../../src/lib/profile')
  return {
    ...actual,
    getMyProfile: (...args: unknown[]) => mockGetMyProfile(...args),
    ensureProfileExists: (...args: unknown[]) => mockEnsureProfileExists(...args),
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

function setupValidSession(userId: string, email: string) {
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  setupLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// PART A — Canonical role normalization (unit tests)
// ---------------------------------------------------------------------------

describe('normalizeRole', () => {
  it('returns "customer" for canonical value', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole('customer')).toBe('customer')
  })

  it('returns "craftsman" for canonical value', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole('craftsman')).toBe('craftsman')
  })

  it('normalizes single-quoted customer: "\'customer\'"', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole("'customer'")).toBe('customer')
  })

  it('normalizes double-quoted craftsman: \'"craftsman"\'', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole('"craftsman"')).toBe('craftsman')
  })

  it('normalizes whitespace-padded values', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole('  customer  ')).toBe('customer')
    expect(normalizeRole(' craftsman ')).toBe('craftsman')
  })

  it('normalizes mixed case', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole('Customer')).toBe('customer')
    expect(normalizeRole('CRAFTSMAN')).toBe('craftsman')
  })

  it('normalizes nested quotes', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole("\"'customer'\"")).toBe('customer')
  })

  it('returns null for unknown role string', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole('admin')).toBeNull()
    expect(normalizeRole('superuser')).toBeNull()
    expect(normalizeRole('random_garbage')).toBeNull()
  })

  it('returns null for empty string', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole('')).toBeNull()
    expect(normalizeRole('   ')).toBeNull()
  })

  it('returns null for null/undefined', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole(null)).toBeNull()
    expect(normalizeRole(undefined)).toBeNull()
  })

  it('returns null for non-string types', async () => {
    const { normalizeRole } = await import('../../src/lib/profile')
    expect(normalizeRole(42)).toBeNull()
    expect(normalizeRole(true)).toBeNull()
    expect(normalizeRole({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PART B — Session bootstrap with various role states
// ---------------------------------------------------------------------------

describe('bootstrap with canonical roles', () => {
  it('role = customer works normally', async () => {
    setupValidSession('user-cust', 'cust@test.com')
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('user-cust')
    expect(state.role).toBe('customer')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('role = craftsman works normally', async () => {
    setupValidSession('user-craft', 'craft@test.com')
    mockGetMyProfile.mockResolvedValue({
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('user-craft')
    expect(state.role).toBe('craftsman')
    expect(state.craftsmanRole).toBe('owner')
    expect(state.sessionValidated).toBe(true)
  })
})

describe('bootstrap with malformed roles', () => {
  it('malformed role from DB is rejected by strict matching — getMyProfile returns null', async () => {
    // When getMyProfile uses strictCanonicalRole, "'customer'" is NOT normalized
    // to "customer" — it is treated as invalid and returns null.  This ensures
    // the user is routed to role selection instead of getting silent app access.
    setupValidSession('user-malformed-1', 'malformed1@test.com')
    // getMyProfile now returns null for malformed values (strict canonical check)
    mockGetMyProfile.mockResolvedValue({
      role: null, // strictCanonicalRole("'customer'") → null
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Role is null — malformed value was NOT silently upgraded to 'customer'
    expect(state.role).toBeNull()
    expect(state.sessionValidated).toBe(true)
    expect(state.error).toBeNull()
    // Gates will route to /onboarding/role
  })

  it('completely invalid role normalizes to null → routes to role selection, no login loop', async () => {
    setupValidSession('user-invalid-role', 'invalid@test.com')
    // Simulate getMyProfile returning null for an invalid role (normalizeRole returns null)
    mockGetMyProfile.mockResolvedValue({
      role: null, // normalizeRole("garbage_role") → null
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('user-invalid-role')
    expect(state.role).toBeNull()
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    // Gates will route to /onboarding/role since role is null + sessionValidated
  })
})

describe('signup success + missing role → role selection', () => {
  it('new signup with null role results in validated session + null role', async () => {
    setupValidSession('signup-user', 'signup@test.com')
    mockGetMyProfile.mockResolvedValue({
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('signup-user')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    // HomeGate/RoleGate: sessionValidated=true + role=null → Navigate to /onboarding/role
  })
})

describe('login success + malformed role → no login bounce', () => {
  it('does not cause error or login loop when role normalizes to valid value', async () => {
    setupValidSession('login-malformed', 'login-malformed@test.com')
    // getMyProfile returns a normalized value
    mockGetMyProfile.mockResolvedValue({
      role: 'craftsman', // was malformed in DB, normalized by getMyProfile
      craftsman_role: 'worker',
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('login-malformed')
    expect(state.role).toBe('craftsman')
    expect(state.sessionValidated).toBe(true)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    // No bounce back to login
  })

  it('does not cause error when role normalizes to null — routes to role selection instead of login loop', async () => {
    setupValidSession('login-bad-role', 'badrole@test.com')
    mockGetMyProfile.mockResolvedValue({
      role: null, // was "some_garbage" in DB, normalized to null
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    // Session is VALID — user is authenticated. Just role is missing.
    expect(state.user?.id).toBe('login-bad-role')
    expect(state.sessionValidated).toBe(true)
    expect(state.role).toBeNull()
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
    // Gates route to /onboarding/role, NOT back to /login
  })
})

// ---------------------------------------------------------------------------
// PART C — Profile bootstrap hardening (optional field / schema issues)
// ---------------------------------------------------------------------------

describe('profile bootstrap with optional field issues', () => {
  it('profile with missing guided_entry_state still bootstraps successfully', async () => {
    setupValidSession('user-no-ges', 'noges@test.com')
    // Simulate profile that doesn't have guided_entry_state column
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('user-no-ges')
    expect(state.role).toBe('customer')
    expect(state.sessionValidated).toBe(true)
    expect(state.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PART D — Schema failure classification
// ---------------------------------------------------------------------------

describe('schema failure classification', () => {
  it('profile_schema_mismatch error is classified when column does not exist', async () => {
    setupValidSession('user-schema', 'schema@test.com')
    mockGetMyProfile.mockRejectedValue({
      message: 'column profiles.guided_entry_state does not exist',
      code: '42703',
      status: 400,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.errorKind).toBe('profile_schema_mismatch')
    expect(state.error).toBeTruthy()
    expect(state.sessionValidated).toBe(false)
    expect(state.user).toBeNull()
  })

  it('BootstrapErrorKind includes all required error types', async () => {
    const session = await import('../../src/lib/session')
    // Verify the error classification function exists and works with various types
    expect(session.classifyError({ name: 'AuthApiError', message: 'test', status: 401 })).toBe('invalid_session')
    expect(session.classifyError({ name: 'AuthRetryableFetchError', message: 'test', status: 0 })).toBe('network_error')
    expect(session.classifyError(new Error('random'))).toBe('unknown_error')
  })
})

// ---------------------------------------------------------------------------
// Regression guards
// ---------------------------------------------------------------------------

describe('no regression to valid profile bootstrap', () => {
  it('normal valid session bootstrap still works correctly', async () => {
    setupValidSession('valid-reg', 'valid-reg@test.com')
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: { step: 'initial', path: null, selectedProviderId: null, projectId: null },
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const state = session.getSession()
    expect(state.user?.id).toBe('valid-reg')
    expect(state.role).toBe('customer')
    expect(state.sessionValidated).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.errorKind).toBeNull()
  })
})

describe('no regression to sessionValidated auth gating', () => {
  it('cached session is not validated — gates redirect to login, not role selection', async () => {
    const cachedUser = makeUser('cached-gate', 'cached@test.com')
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify({
      user: cachedUser,
      role: null,
      craftsmanRole: null,
      isOperator: false,
    }))

    let resolveGetSession!: (value: unknown) => void
    mockGetSession.mockReturnValue(new Promise(resolve => {
      resolveGetSession = resolve
    }))

    const session = await import('../../src/lib/session')

    const interimState = session.getSession()
    expect(interimState.user).not.toBeNull()
    expect(interimState.loading).toBe(true)
    expect(interimState.sessionValidated).toBe(false)

    // Resolve with no session (cache was stale)
    resolveGetSession({ data: { session: null }, error: null })
    await session.refreshSession()

    const finalState = session.getSession()
    expect(finalState.user).toBeNull()
    expect(finalState.sessionValidated).toBe(false)
  })
})
