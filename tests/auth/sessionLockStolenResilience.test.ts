/**
 * Residual double-steal resilience (resume-robustness Block 2, repair pass).
 *
 * The single-flight seam retries a lock-stolen auth read exactly once. When
 * that retry is ALSO stolen (plausible: ~25 repository initialize() paths
 * plus PostgREST token reads remain raw lock contenders), the rejection
 * propagates into the refreshSession catch. Before the fix, classifyError
 * mapped the DOMException ('Lock was stolen by another request' — no 'abort'
 * substring in the MESSAGE, only the name is AbortError) to 'unknown_error',
 * which wiped the warm session via EMPTY_SESSION — the original P0 symptom
 * (visible logout flash). A lock steal is transient contention and must be
 * classified as retryable: 'network_error' keeps the cached user.
 *
 * Error shapes mirror the real producers (see authSingleFlight.test.ts):
 *  - WebKit DOMException { name: 'AbortError', message: 'Lock was stolen by another request' }
 *  - postgrest-wrapped result error { message: 'AbortError: Lock was stolen by another request' }
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { User } from '@supabase/supabase-js'

const mockGetSession = vi.fn()
const mockGetUser = vi.fn()
const mockSignOut = vi.fn()
const mockOnAuthStateChange = vi.fn()
const mockGetMyProfile = vi.fn()

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

/** Producer shape: WebKit rejects the lock victim with this DOMException. */
function lockStolenDomException(): DOMException {
  return new DOMException('Lock was stolen by another request', 'AbortError')
}

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

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  setupLocalStorage()
  mockSignOut.mockResolvedValue({ error: null })
  mockOnAuthStateChange.mockImplementation(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('double lock-steal during refreshSession', () => {
  it('keeps the warm cached user and surfaces errorKind network_error (no logout flash)', async () => {
    const user = makeUser()

    // ── Warm-up: a fully validated session ────────────────────────────────
    mockGetSession.mockResolvedValue({ data: { session: { user } }, error: null })
    mockGetUser.mockResolvedValue({ data: { user }, error: null })
    mockGetMyProfile.mockResolvedValue({
      role: 'customer',
      craftsman_role: null,
      is_operator: false,
    })

    const session = await import('../../src/lib/session')
    await session.refreshSession()

    const warm = session.getSession()
    expect(warm.user?.id).toBe(user.id)
    expect(warm.sessionValidated).toBe(true)

    // ── Double steal: the read AND its single retry are both stolen ───────
    mockGetSession.mockReset().mockRejectedValue(lockStolenDomException())

    await session.refreshSession()

    const after = session.getSession()
    // The warm user must survive — a transient lock steal is retryable,
    // not grounds to destroy the session (EMPTY_SESSION → login flash).
    expect(after.user?.id).toBe(user.id)
    expect(after.errorKind).toBe('network_error')
    expect(after.error).toBeTruthy()
    expect(after.loading).toBe(false)
    // Both single-flight attempts actually ran (initial + one retry).
    expect(mockGetSession).toHaveBeenCalledTimes(2)
  })
})

describe('classifyError — lock-stolen producer shapes', () => {
  it('maps both real-world lock-steal shapes to network_error', async () => {
    const session = await import('../../src/lib/session')

    // WebKit DOMException thrown by supabase.auth reads.
    expect(session.classifyError(lockStolenDomException())).toBe('network_error')
    // postgrest-js wraps fetch rejections into `${name}: ${message}`.
    expect(
      session.classifyError({
        message: 'AbortError: Lock was stolen by another request',
        details: '',
        hint: '',
        code: '',
      }),
    ).toBe('network_error')
    // A genuine manual abort must NOT be reclassified by this rule alone —
    // it still classifies via the generic patterns (name-only AbortError
    // with the WebKit cancellation message is not a lock steal).
    expect(session.classifyError({ message: 'JWT expired', status: 401 })).toBe('invalid_session')
  })
})
