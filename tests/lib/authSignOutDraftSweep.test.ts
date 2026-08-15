// @vitest-environment jsdom
/**
 * auth.ts sign-out → draft sweep wiring · Resume-Robustness Block 3.
 *
 * User-initiated sign-out runs exclusively through `lib/auth.ts#signOut()`
 * (all screens/gates import from there); `deleteAccount()` ends in its own
 * `supabase.auth.signOut()`. Both must sweep the persisted composer drafts
 * so they never reach the next account on this device — but ONLY after the
 * sign-out actually succeeded (a failed sign-out keeps the session and the
 * user's drafts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory storage stubs (jsdom localStorage is non-functional in this repo —
// same pattern as tests/hooks/useDraftPersistence.test.ts).
function makeMemoryStorage() {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => { store[k] = v },
    removeItem: (k: string): void => { delete store[k] },
    clear: (): void => { store = {} },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number { return Object.keys(store).length },
  }
}
const memoryLocal = makeMemoryStorage()
const memorySession = makeMemoryStorage()
vi.stubGlobal('localStorage', memoryLocal)
vi.stubGlobal('sessionStorage', memorySession)
Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryLocal })
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memorySession })

// Mock the supabase client module — auth.ts only touches supabase.auth.
// Shapes mirror supabase-js v2: signOut → { error: AuthError | null },
// getSession → { data: { session }, error }.
const signOutMock = vi.fn()
const getSessionMock = vi.fn()
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signOut: (...args: unknown[]) => signOutMock(...args),
      getSession: (...args: unknown[]) => getSessionMock(...args),
    },
  },
}))

import { signOut, deleteAccount } from '../../src/lib/auth'

const DRAFT_KEY = 'fixup.chat.draft.thread-1'

describe('signOut → sweepAllDraftKeys wiring', () => {
  beforeEach(() => {
    memoryLocal.clear()
    memorySession.clear()
    signOutMock.mockReset()
    getSessionMock.mockReset()
    memoryLocal.setItem(DRAFT_KEY, 'privater Entwurf')
    memorySession.setItem('fixup.chat.draft.thread-2', 'auch privat')
    memoryLocal.setItem('fixup.pending_mutations.v1', '[]')
  })

  it('sweeps drafts from both storages after a successful sign-out', async () => {
    signOutMock.mockResolvedValue({ error: null })
    await signOut()
    expect(memoryLocal.getItem(DRAFT_KEY)).toBe(null)
    expect(memorySession.getItem('fixup.chat.draft.thread-2')).toBe(null)
    // The mutation queue is deliberately preserved across sign-out (session.ts
    // replays the same user's mutations on re-login) — must stay untouched.
    expect(memoryLocal.getItem('fixup.pending_mutations.v1')).toBe('[]')
  })

  it('keeps the drafts when the sign-out fails (session still active)', async () => {
    const authError = Object.assign(new Error('network down'), { name: 'AuthError' })
    signOutMock.mockResolvedValue({ error: authError })
    await expect(signOut()).rejects.toThrow('network down')
    expect(memoryLocal.getItem(DRAFT_KEY)).toBe('privater Entwurf')
    expect(memorySession.getItem('fixup.chat.draft.thread-2')).toBe('auch privat')
  })

  it('deleteAccount sweeps the drafts after its final sign-out', async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'tok-1' } },
      error: null,
    })
    signOutMock.mockResolvedValue({ error: null })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    )
    await deleteAccount()
    expect(signOutMock).toHaveBeenCalledTimes(1)
    expect(memoryLocal.getItem(DRAFT_KEY)).toBe(null)
    expect(memorySession.getItem('fixup.chat.draft.thread-2')).toBe(null)
    vi.unstubAllGlobals()
    // Re-stub the storages dropped by unstubAllGlobals for any later test.
    vi.stubGlobal('localStorage', memoryLocal)
    vi.stubGlobal('sessionStorage', memorySession)
  })
})
