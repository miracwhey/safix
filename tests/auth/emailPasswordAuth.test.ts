import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSignInWithPassword = vi.fn()
const mockSignUp = vi.fn()
const mockSignInWithOtp = vi.fn()
const mockGetSession = vi.fn()
const mockSignOut = vi.fn()
const mockOnAuthStateChange = vi.fn()

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: mockSignInWithPassword,
      signUp: mockSignUp,
      signInWithOtp: mockSignInWithOtp,
      getSession: mockGetSession,
      signOut: mockSignOut,
      onAuthStateChange: mockOnAuthStateChange,
    },
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signInWithPassword', () => {
  it('calls supabase.auth.signInWithPassword with email and password', async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { session: {} }, error: null })

    const { signInWithPassword } = await import('../../src/lib/auth')
    await signInWithPassword('user@example.com', 'secret123')

    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'secret123',
    })
  })

  it('throws on invalid credentials', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { session: null },
      error: new Error('Invalid login credentials'),
    })

    const { signInWithPassword } = await import('../../src/lib/auth')

    await expect(
      signInWithPassword('user@example.com', 'wrong'),
    ).rejects.toThrow('Invalid login credentials')
  })

  it('throws on rate limit', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { session: null },
      error: new Error('Rate limit exceeded'),
    })

    const { signInWithPassword } = await import('../../src/lib/auth')

    await expect(
      signInWithPassword('user@example.com', 'secret'),
    ).rejects.toThrow('Rate limit exceeded')
  })
})

describe('signUpWithPassword', () => {
  it('calls supabase.auth.signUp with email and password', async () => {
    mockSignUp.mockResolvedValue({
      data: {
        user: { id: 'new-user' },
        session: { access_token: 'tok' },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('new@example.com', 'newpass123')

    expect(mockSignUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'newpass123',
      options: { emailRedirectTo: expect.any(String) },
    })
    expect(result.needsConfirmation).toBe(false)
  })

  it('returns needsConfirmation=true when session is null (email confirmation enabled)', async () => {
    mockSignUp.mockResolvedValue({
      data: {
        user: { id: 'new-user' },
        session: null,
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('new@example.com', 'newpass123')

    expect(result.needsConfirmation).toBe(true)
  })

  it('returns needsConfirmation=false when session is present (auto-confirm)', async () => {
    mockSignUp.mockResolvedValue({
      data: {
        user: { id: 'new-user' },
        session: { access_token: 'tok' },
      },
      error: null,
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')
    const result = await signUpWithPassword('new@example.com', 'newpass123')

    expect(result.needsConfirmation).toBe(false)
  })

  it('throws when user is already registered', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new Error('User already registered'),
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')

    await expect(
      signUpWithPassword('existing@example.com', 'pass123'),
    ).rejects.toThrow('User already registered')
  })

  it('throws when password is too short', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new Error('Password should be at least 6 characters'),
    })

    const { signUpWithPassword } = await import('../../src/lib/auth')

    await expect(
      signUpWithPassword('new@example.com', 'ab'),
    ).rejects.toThrow('Password should be at least 6 characters')
  })
})

describe('signInWithMagicLink (preserved)', () => {
  it('still works via signInWithOtp', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: null })

    vi.stubGlobal('window', { location: { origin: 'https://app.fixup.test' } })

    const { signInWithMagicLink } = await import('../../src/lib/auth')
    await signInWithMagicLink('user@example.com')

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'user@example.com',
      options: {
        emailRedirectTo: 'https://app.fixup.test/auth/callback',
      },
    })
  })
})

describe('session persistence after password login', () => {
  it('getCurrentUser returns user from active session', async () => {
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: 'pw-user', email: 'pw@example.com' },
        },
      },
      error: null,
    })

    const { getCurrentUser } = await import('../../src/lib/auth')
    const user = await getCurrentUser()

    expect(user).not.toBeNull()
    expect(user!.id).toBe('pw-user')
  })

  it('getCurrentUser returns null when no session', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    const { getCurrentUser } = await import('../../src/lib/auth')
    const user = await getCurrentUser()

    expect(user).toBeNull()
  })
})

describe('logout clears auth state', () => {
  it('signOut calls supabase.auth.signOut', async () => {
    mockSignOut.mockResolvedValue({ error: null })

    const { signOut } = await import('../../src/lib/auth')
    await signOut()

    expect(mockSignOut).toHaveBeenCalled()
  })

  it('signOut throws on error', async () => {
    mockSignOut.mockResolvedValue({ error: new Error('Signout failed') })

    const { signOut } = await import('../../src/lib/auth')

    await expect(signOut()).rejects.toThrow('Signout failed')
  })
})
