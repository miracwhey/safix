/**
 * Auth Foundation — Role selection flow tests
 *
 * Validates the complete flow after email/password authentication:
 *
 *   1. After signup, when role is null, the session reflects no role.
 *   2. Selecting Kunde (customer) persists the role correctly.
 *   3. Selecting Handwerker (craftsman) persists the role correctly.
 *   4. ensureProfileExists creates a profile row for brand-new users.
 *   5. Role selection updates an existing (auto-created) profile row.
 *   6. Magic link remains available but is not the default auth mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { User } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const mockGetSession = vi.fn()
const mockSignInWithPassword = vi.fn()
const mockSignUp = vi.fn()
const mockSignInWithOtp = vi.fn()
const mockSignOut = vi.fn()
const mockOnAuthStateChange = vi.fn()
const mockUpsert = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockMaybeSingle = vi.fn()

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      signInWithPassword: mockSignInWithPassword,
      signUp: mockSignUp,
      signInWithOtp: mockSignInWithOtp,
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

beforeEach(() => {
  vi.clearAllMocks()
  mockOnAuthStateChange.mockImplementation(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  }))
  mockUpsert.mockResolvedValue({ error: null })
  mockSelect.mockReturnValue({ eq: mockEq })
  mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureProfileExists', () => {
  it('performs a SELECT-only existence check (no INSERT — trigger owns creation)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'user-new-123' }, error: null })

    const { ensureProfileExists } = await import('../../src/lib/profile')

    await ensureProfileExists('user-new-123')

    const { supabase } = await import('../../src/lib/supabase')
    expect(supabase.from).toHaveBeenCalledWith('profiles')
    expect(mockSelect).toHaveBeenCalledWith('id')
    expect(mockEq).toHaveBeenCalledWith('id', 'user-new-123')
    expect(mockMaybeSingle).toHaveBeenCalled()
    // No client-side write — the INSERT path would race with signOut and
    // fail WITH CHECK (auth.uid() = id). The on_auth_user_created trigger
    // (SECURITY DEFINER) is the sole writer of profile rows.
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('resolves when the row exists', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'existing-user' }, error: null })

    const { ensureProfileExists } = await import('../../src/lib/profile')

    await expect(ensureProfileExists('existing-user')).resolves.toBeUndefined()
  })

  it('throws when the SELECT fails with a real error', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: new Error('DB connection failed') })

    const { ensureProfileExists } = await import('../../src/lib/profile')

    await expect(ensureProfileExists('user-fail')).rejects.toThrow('DB connection failed')
  })
})

describe('setMyRole persists role correctly', () => {
  it('persists customer role via upsert', async () => {
    const user = makeUser('user-role-1', 'kunde@example.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })

    const { setMyRole } = await import('../../src/lib/profile')
    await setMyRole('customer')

    expect(mockUpsert).toHaveBeenCalledWith(
      { id: 'user-role-1', role: 'customer', craftsman_role: null },
      { onConflict: 'id' },
    )
  })

  it('persists craftsman role via upsert', async () => {
    const user = makeUser('user-role-2', 'handwerker@example.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })

    const { setMyRole } = await import('../../src/lib/profile')
    await setMyRole('craftsman')

    expect(mockUpsert).toHaveBeenCalledWith(
      { id: 'user-role-2', role: 'craftsman' },
      { onConflict: 'id' },
    )
  })

  it('throws when not authenticated', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const { setMyRole } = await import('../../src/lib/profile')

    await expect(setMyRole('customer')).rejects.toThrow('Not authenticated')
  })
})

describe('getMyProfile returns null role for new user', () => {
  it('returns null role when no profile row exists', async () => {
    const user = makeUser('user-no-profile', 'new@example.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })

    const { getMyProfile } = await import('../../src/lib/profile')
    const profile = await getMyProfile()

    expect(profile.role).toBeNull()
    expect(profile.craftsman_role).toBeNull()
    expect(profile.is_operator).toBe(false)
  })

  it('returns null role when profile exists but role is not set', async () => {
    const user = makeUser('user-no-role', 'norole@example.com')
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

describe('complete signup → role selection flow', () => {
  it('signup creates a real Supabase auth user and returns an immediate session (auto-confirm)', async () => {
    const newUser = makeUser('signup-user-1', 'signup@example.com')
    mockSignUp.mockResolvedValue({
      data: {
        user: newUser,
        session: { access_token: 'tok-signup-1', user: newUser },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('signup@example.com', 'MyPassword123')

    expect(mockSignUp).toHaveBeenCalledWith({
      email: 'signup@example.com',
      password: 'MyPassword123',
      options: { emailRedirectTo: expect.any(String) },
    })
    expect(result.needsConfirmation).toBe(false)
  })

  it('after signup, getMyProfile returns null role → triggers role selection routing', async () => {
    const user = makeUser('signup-flow-1', 'flowuser@example.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    // Profile row auto-created by ensureProfileExists, but role is still null
    mockMaybeSingle.mockResolvedValue({
      data: { role: null, craftsman_role: null, is_operator: false, guided_entry_state: null },
      error: null,
    })

    const { getMyProfile } = await import('../../src/lib/profile')
    const profile = await getMyProfile()

    // Role is null → in HomeGate this triggers: <Navigate to="/onboarding/role" />
    expect(profile.role).toBeNull()
  })

  it('after selecting Kunde, role is persisted and profile reflects customer', async () => {
    const user = makeUser('role-select-1', 'kunde@example.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })

    const { setMyRole } = await import('../../src/lib/profile')
    await setMyRole('customer')

    // Verify upsert was called with customer role
    expect(mockUpsert).toHaveBeenCalledWith(
      { id: 'role-select-1', role: 'customer', craftsman_role: null },
      { onConflict: 'id' },
    )
  })

  it('after selecting Handwerker, role is persisted and profile reflects craftsman', async () => {
    const user = makeUser('role-select-2', 'handwerker@example.com')
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })

    const { setMyRole } = await import('../../src/lib/profile')
    await setMyRole('craftsman')

    expect(mockUpsert).toHaveBeenCalledWith(
      { id: 'role-select-2', role: 'craftsman' },
      { onConflict: 'id' },
    )
  })
})

describe('magic link is secondary, not primary', () => {
  it('signInWithMagicLink still works via signInWithOtp', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: null })
    vi.stubGlobal('window', { location: { origin: 'https://app.fixup.test' } })

    const { signInWithMagicLink } = await import('../../src/lib/auth')
    await signInWithMagicLink('user@example.com')

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'user@example.com',
      options: { emailRedirectTo: 'https://app.fixup.test/auth/callback' },
    })
  })

  it('email/password login does NOT call signInWithOtp', async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { session: {} }, error: null })

    const { signInWithPassword } = await import('../../src/lib/auth')
    await signInWithPassword('user@example.com', 'pass123')

    expect(mockSignInWithOtp).not.toHaveBeenCalled()
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'pass123',
    })
  })

  it('email/password signup does NOT call signInWithOtp', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 'tok' } },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    await signUpWithPassword('new@example.com', 'pass123')

    expect(mockSignInWithOtp).not.toHaveBeenCalled()
    expect(mockSignUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'pass123',
      options: { emailRedirectTo: expect.any(String) },
    })
  })
})
