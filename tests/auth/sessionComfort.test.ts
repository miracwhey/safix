import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { User } from '@supabase/supabase-js'

const mockGetSession = vi.fn()
const mockGetUser = vi.fn()
const mockSignOut = vi.fn().mockResolvedValue({ error: null })
const mockOnAuthStateChange = vi.fn()
const mockGetMyProfile = vi.fn()
type DocumentStub = {
  addEventListener?: (type: string, listener: () => void) => void
  visibilityState?: string
}

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

vi.mock('../../src/lib/profile', () => ({
  getMyProfile: mockGetMyProfile,
  ensureProfileExists: vi.fn().mockResolvedValue(undefined),
  acceptTos: vi.fn().mockResolvedValue(undefined),
}))

function makeUser(): User {
  return {
    id: 'user-123',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'user@example.com',
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
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
  vi.stubGlobal('localStorage', storage)
  return storage
}

async function loadSessionModule() {
  const sessionModule = await import('../../src/lib/session')
  return sessionModule
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  setupLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Clean up any manual globals (e.g., document stubs).
  const globalWithDocument = globalThis as { document?: DocumentStub }
  delete globalWithDocument.document
})

describe('session comfort', () => {
  it('stores a successful session refresh for reuse across reloads', async () => {
    const user = makeUser()
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockOnAuthStateChange.mockImplementation((_callback) => {
      // No immediate events for this test
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
    })

    const session = await loadSessionModule()

    await session.refreshSession()

    const current = session.getSession()
    expect(current.user?.id).toBe(user.id)
    expect(current.role).toBe('customer')
    expect(current.sessionValidated).toBe(true)

    const cachedRaw = localStorage.getItem('fixup.session.cache.v1')
    expect(cachedRaw).toBeTruthy()
    const cached = JSON.parse(cachedRaw || '{}')
    expect(cached.user.id).toBe(user.id)
    expect(cached.role).toBe('customer')
  })

  it('hydrates from cached session while Supabase restores in background', async () => {
    const cachedUser = makeUser()
    const cachedPayload = {
      user: cachedUser,
      role: 'customer',
      craftsmanRole: null,
      isOperator: false,
    }
    localStorage.setItem('fixup.session.cache.v1', JSON.stringify(cachedPayload))

    let resolveSession!: (value: unknown) => void
    const sessionPromise = new Promise((resolve) => {
      resolveSession = resolve
    })

    mockGetSession.mockReturnValue(sessionPromise)
    mockOnAuthStateChange.mockImplementation((_callback) => {
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'craftsman',
      craftsman_role: 'owner',
      is_operator: true,
    })

    const session = await loadSessionModule()

    const interim = session.getSession()
    expect(interim.user?.id).toBe(cachedUser.id)
    expect(interim.loading).toBe(true)
    // Cache warms the UI but session is not yet validated
    expect(interim.sessionValidated).toBe(false)

    const nextUser = makeUser()
    nextUser.id = 'user-999'

    mockGetUser.mockResolvedValue({
      data: { user: nextUser },
      error: null,
    })

    resolveSession({
      data: { session: { user: nextUser } },
      error: null,
    })

    await session.refreshSession()

    const final = session.getSession()
    expect(final.user?.id).toBe('user-999')
    expect(final.role).toBe('craftsman')
    expect(final.craftsmanRole).toBe('owner')
    expect(final.isOperator).toBe(true)
    expect(final.sessionValidated).toBe(true)
  })

  it('clears cache and state on sign-out auth event', async () => {
    const user = makeUser()
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })

    let authCallback: ((event: string, session: { user: User } | null) => void) | null =
      null
    mockOnAuthStateChange.mockImplementation((callback) => {
      authCallback = callback
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    })

    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
    })

    const session = await loadSessionModule()
    await session.refreshSession()

    expect(session.getSession().user).not.toBeNull()

    authCallback?.('SIGNED_OUT', null)

    expect(session.getSession().user).toBeNull()
    expect(localStorage.getItem('fixup.session.cache.v1')).toBeNull()
  })

  it('re-checks the session when returning to the foreground', async () => {
    const user = makeUser()
    mockGetSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    })
    mockGetUser.mockResolvedValue({
      data: { user },
      error: null,
    })
    mockOnAuthStateChange.mockImplementation((_callback) => {
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    })
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
    })

    const addEventListener = vi.fn()
    const documentStub: DocumentStub = {
      addEventListener,
      visibilityState: 'hidden',
    }
    ;(globalThis as { document?: DocumentStub }).document = documentStub

    const session = await loadSessionModule()
    await session.refreshSession()
    mockGetSession.mockClear()

    expect(addEventListener).toHaveBeenCalled()
    const handler = addEventListener.mock.calls[0]?.[1] as () => void
    const globalDocument = (globalThis as { document?: DocumentStub }).document
    if (globalDocument) {
      globalDocument.visibilityState = 'visible'
    }
    handler()

    await session.refreshSession()

    expect(mockGetSession).toHaveBeenCalledTimes(1)
  })
})
