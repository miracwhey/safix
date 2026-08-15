/**
 * Auth-read single-flight + lock-stolen retry (src/lib/auth/authSingleFlight.ts).
 *
 * Sentry P0 FIXUP-WEB-56/A/B/9/C: parallel boot/resume readers each acquire
 * the auth-js navigator.locks lock; one steals it, the victims reject with
 * `AbortError: Lock was stolen by another request`.
 *
 * Error shapes mirror the real producers:
 *  - `supabase.auth.getSession()` rejects with a DOMException
 *    { name: 'AbortError', message: 'Lock was stolen by another request' }.
 *  - postgrest-js wraps the same rejection into a result error object
 *    `{ message: 'AbortError: Lock was stolen by another request', ... }`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: h.getSession,
    },
  },
}))

import {
  getAuthSession,
  retryOnAuthLockStolen,
  isAuthLockStolenError,
  invalidateAuthSessionSingleFlight,
} from '../../src/lib/auth/authSingleFlight'

/** Producer shape: WebKit rejects the lock victim with this DOMException. */
function lockStolenDomException(): DOMException {
  return new DOMException('Lock was stolen by another request', 'AbortError')
}

const SESSION_OK = {
  data: { session: { user: { id: 'user-1' }, access_token: 'token-1' } },
  error: null,
}

beforeEach(() => {
  h.getSession.mockReset()
  invalidateAuthSessionSingleFlight()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isAuthLockStolenError', () => {
  it('matches the WebKit DOMException thrown by supabase.auth reads', () => {
    expect(isAuthLockStolenError(lockStolenDomException())).toBe(true)
  })

  it('matches the Chromium wording', () => {
    expect(
      isAuthLockStolenError(
        new DOMException('Lock broken by another request with the "steal" option.', 'AbortError'),
      ),
    ).toBe(true)
  })

  it('matches the postgrest-wrapped result error object', () => {
    // postgrest-js converts fetch rejections into `${name}: ${message}`.
    expect(
      isAuthLockStolenError({
        message: 'AbortError: Lock was stolen by another request',
        details: '',
        hint: '',
        code: '',
      }),
    ).toBe(true)
  })

  it('matches a plain string carrying the signature', () => {
    expect(isAuthLockStolenError('AbortError: Lock was stolen by another request')).toBe(true)
  })

  it('does NOT match a genuine manual abort (AbortError name alone is not enough)', () => {
    expect(
      isAuthLockStolenError(new DOMException('The operation was aborted.', 'AbortError')),
    ).toBe(false)
  })

  it('does NOT match unrelated errors / non-errors', () => {
    expect(isAuthLockStolenError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isAuthLockStolenError({ message: 'JWT expired' })).toBe(false)
    expect(isAuthLockStolenError(null)).toBe(false)
    expect(isAuthLockStolenError(undefined)).toBe(false)
    expect(isAuthLockStolenError({})).toBe(false)
  })
})

describe('getAuthSession single-flight', () => {
  it('collapses N parallel callers into ONE underlying getSession call', async () => {
    let resolveRead: (v: unknown) => void = () => {}
    h.getSession.mockReturnValue(new Promise((resolve) => { resolveRead = resolve }))

    const p1 = getAuthSession()
    const p2 = getAuthSession()
    const p3 = getAuthSession()
    expect(h.getSession).toHaveBeenCalledTimes(1)

    resolveRead(SESSION_OK)
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toBe(SESSION_OK)
    expect(r2).toBe(SESSION_OK)
    expect(r3).toBe(SESSION_OK)
  })

  it('clears the in-flight slot after resolve — the next call reads fresh', async () => {
    h.getSession.mockResolvedValue(SESSION_OK)
    await getAuthSession()
    await getAuthSession()
    expect(h.getSession).toHaveBeenCalledTimes(2)
  })

  it('retries exactly once when the lock was stolen and returns the retry result', async () => {
    h.getSession
      .mockRejectedValueOnce(lockStolenDomException())
      .mockResolvedValueOnce(SESSION_OK)

    const result = await getAuthSession()
    expect(result).toBe(SESSION_OK)
    expect(h.getSession).toHaveBeenCalledTimes(2)
  })

  it('gives up after the single retry — a second lock steal propagates', async () => {
    h.getSession
      .mockRejectedValueOnce(lockStolenDomException())
      .mockRejectedValueOnce(lockStolenDomException())
      .mockResolvedValue(SESSION_OK)

    await expect(getAuthSession()).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Lock was stolen by another request',
    })
    expect(h.getSession).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a non-lock AbortError (manual cancellation)', async () => {
    h.getSession.mockRejectedValueOnce(
      new DOMException('The operation was aborted.', 'AbortError'),
    )

    await expect(getAuthSession()).rejects.toMatchObject({
      message: 'The operation was aborted.',
    })
    expect(h.getSession).toHaveBeenCalledTimes(1)
  })

  it('a rejection clears the slot — subsequent calls are not poisoned', async () => {
    h.getSession
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(SESSION_OK)

    await expect(getAuthSession()).rejects.toThrow('Failed to fetch')

    const result = await getAuthSession()
    expect(result).toBe(SESSION_OK)
    expect(h.getSession).toHaveBeenCalledTimes(2)
  })

  it('invalidateAuthSessionSingleFlight forces the next caller onto a fresh read', async () => {
    // Fake timers: the hung read's 20s safety timer must never fire for real.
    vi.useFakeTimers()
    h.getSession.mockReturnValueOnce(new Promise(() => { /* never settles */ }))

    const hung = getAuthSession()
    hung.catch(() => { /* intentionally dangling */ })
    expect(h.getSession).toHaveBeenCalledTimes(1)

    // forceRefreshSession / SIGNED_OUT path: drop the in-flight slot.
    invalidateAuthSessionSingleFlight()

    h.getSession.mockResolvedValueOnce(SESSION_OK)
    const result = await getAuthSession()
    expect(result).toBe(SESSION_OK)
    expect(h.getSession).toHaveBeenCalledTimes(2)
  })

  it('a permanently hung read times out, rejects with auth_read_timeout and frees the slot', async () => {
    vi.useFakeTimers()
    h.getSession.mockReturnValueOnce(new Promise(() => { /* suspension hang */ }))

    const hung = getAuthSession()
    const rejection = expect(hung).rejects.toThrow('auth_read_timeout')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejection

    // Slot must be free again — post-resume recovery starts a fresh read.
    h.getSession.mockResolvedValueOnce(SESSION_OK)
    const result = await getAuthSession()
    expect(result).toBe(SESSION_OK)
    expect(h.getSession).toHaveBeenCalledTimes(2)
  })
})

describe('retryOnAuthLockStolen', () => {
  it('retries exactly once on the lock-stolen signature', async () => {
    const read = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(lockStolenDomException())
      .mockResolvedValueOnce('ok')

    await expect(retryOnAuthLockStolen(read)).resolves.toBe('ok')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('propagates other errors without retrying', async () => {
    const read = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce('ok')

    await expect(retryOnAuthLockStolen(read)).rejects.toThrow('Failed to fetch')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('propagates the second failure when the retry is also lock-stolen', async () => {
    const read = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(lockStolenDomException())
      .mockRejectedValueOnce(lockStolenDomException())
      .mockResolvedValue('ok')

    await expect(retryOnAuthLockStolen(read)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).toHaveBeenCalledTimes(2)
  })
})
