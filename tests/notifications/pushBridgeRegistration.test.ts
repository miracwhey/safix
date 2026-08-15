import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Push-Registrierung + Auth-Re-Arm (Fix 2026-07-05).
 *
 * Sichert die Kausalkette der Token-Persistenz ab:
 *   - non-iOS → No-op (register() darf keine nativen Calls machen)
 *   - Token MIT Session → Upsert nach notification_device_tokens
 *   - Token OHNE Session → kein Upsert (no_user_id), aber gecacht
 *   - danach SIGNED_IN → gecachter Token wird nachgeschrieben (Re-Arm)
 *
 * Mocks spiegeln die realen Producer-Shapes: @capacitor/push-notifications
 * `addListener(event, cb)` / `register()`, supabase-js `onAuthStateChange(cb)`
 * und die `from().upsert()`-Kette. Modul-State ist modul-scoped → jeder Test
 * importiert die Bridge nach `resetModules()` frisch.
 */

// ── Capturable mock state ────────────────────────────────────────────────────
let platform = 'ios'
let permissionStatus = 'granted'
const pushListeners = new Map<string, (arg: unknown) => unknown>()
let authCallback: ((event: string) => void) | null = null
const registerSpy = vi.fn(async () => {})
const upsertSpy = vi.fn(async () => ({ error: null }))
const getSession = vi.fn(async () => ({ data: { session: null as unknown } }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => platform },
}))

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    requestPermissions: vi.fn(async () => ({ receive: permissionStatus })),
    addListener: vi.fn((event: string, cb: (arg: unknown) => unknown) => {
      pushListeners.set(event, cb)
      return { remove: vi.fn() }
    }),
    register: registerSpy,
    removeAllListeners: vi.fn(async () => {}),
  },
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession,
      onAuthStateChange: vi.fn((cb: (event: string) => void) => {
        authCallback = cb
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      }),
    },
    from: vi.fn(() => ({ upsert: upsertSpy })),
  },
}))

vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarning: vi.fn(),
}))

async function loadBridge() {
  vi.resetModules()
  return await import('../../src/lib/notifications/pushNotificationBridge')
}

/** Feuert den captured 'registration'-Listener mit einem Token und wartet ihn ab. */
async function fireRegistration(token: string): Promise<void> {
  const cb = pushListeners.get('registration')
  expect(cb).toBeTypeOf('function')
  await cb!({ value: token })
}

beforeEach(() => {
  platform = 'ios'
  permissionStatus = 'granted'
  pushListeners.clear()
  authCallback = null
  registerSpy.mockClear()
  upsertSpy.mockClear()
  getSession.mockReset()
  getSession.mockResolvedValue({ data: { session: null } })
})

describe('registerForPushNotifications', () => {
  it('is a no-op on non-iOS platforms', async () => {
    platform = 'web'
    const { registerForPushNotifications } = await loadBridge()
    await registerForPushNotifications()
    expect(registerSpy).not.toHaveBeenCalled()
    expect(pushListeners.size).toBe(0)
  })

  it('writes the token when a session already exists', async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } })
    const { registerForPushNotifications } = await loadBridge()
    await registerForPushNotifications()
    expect(registerSpy).toHaveBeenCalledOnce()

    await fireRegistration('tok-abc')

    expect(upsertSpy).toHaveBeenCalledOnce()
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', token: 'tok-abc', platform: 'ios' }),
      { onConflict: 'user_id,token' },
    )
  })

  it('does NOT write without a session, then recovers the token on SIGNED_IN', async () => {
    // Boot without session: token arrives, gets cached but not written.
    getSession.mockResolvedValue({ data: { session: null } })
    const { registerForPushNotifications } = await loadBridge()
    await registerForPushNotifications()
    await fireRegistration('tok-late')
    expect(upsertSpy).not.toHaveBeenCalled()

    // User logs in → session now available → Re-Arm writes the cached token.
    getSession.mockResolvedValue({ data: { session: { user: { id: 'user-2' } } } })
    expect(authCallback).toBeTypeOf('function')
    await authCallback!('SIGNED_IN')
    // let the async persist settle
    await Promise.resolve()
    await Promise.resolve()

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-2', token: 'tok-late' }),
      { onConflict: 'user_id,token' },
    )
  })

  it('does not attach native listeners twice on repeat calls', async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } })
    const { registerForPushNotifications } = await loadBridge()
    await registerForPushNotifications()
    await registerForPushNotifications()
    expect(registerSpy).toHaveBeenCalledOnce()
  })
})
