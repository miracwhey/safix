// @vitest-environment jsdom
/**
 * sweepAllDraftKeys · Resume-Robustness Block 3 — sign-out draft sweep.
 *
 * Drafts persisted via useDraftPersistence are user-private: at sign-out
 * EVERY key under the registered DRAFT_KEY_PREFIXES must be removed from
 * BOTH web storages so a draft typed by one account never surfaces in the
 * next account's composer on a shared device. Covers: prefix-scan removal
 * (localStorage + sessionStorage) · non-draft keys untouched · interleaved
 * multi-key removal (index-shift safety) · every registered prefix swept ·
 * throwing storage never throws out of the sweep.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory storage stubs — the vitest-jsdom localStorage in this repo has
// no functional methods (Node `--localstorage-file` warning); same pattern
// as tests/hooks/useDraftPersistence.test.ts.
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

import {
  sweepAllDraftKeys,
  DRAFT_KEY_PREFIXES,
} from '../../src/hooks/useDraftPersistence'

describe('sweepAllDraftKeys', () => {
  beforeEach(() => {
    memoryLocal.clear()
    memorySession.clear()
    // Restore the stubbed storages in case a test replaced them.
    Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryLocal })
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memorySession })
    vi.restoreAllMocks()
  })

  it('removes every chat-draft key from localStorage', () => {
    memoryLocal.setItem('fixup.chat.draft.thread-1', 'Hallo')
    memoryLocal.setItem('fixup.chat.draft.thread-2', 'noch ein Entwurf')
    sweepAllDraftKeys()
    expect(memoryLocal.getItem('fixup.chat.draft.thread-1')).toBe(null)
    expect(memoryLocal.getItem('fixup.chat.draft.thread-2')).toBe(null)
    expect(memoryLocal.length).toBe(0)
  })

  it('sweeps sessionStorage too', () => {
    memorySession.setItem('fixup.chat.draft.thread-9', 'session-draft')
    sweepAllDraftKeys()
    expect(memorySession.getItem('fixup.chat.draft.thread-9')).toBe(null)
  })

  it('leaves non-draft keys untouched (session cache, auth, mutation queue)', () => {
    memoryLocal.setItem('fixup.session.cache.v1', '{"user":null}')
    memoryLocal.setItem('fixup.pending_mutations.v1', '[]')
    memoryLocal.setItem('fixup.auth', 'token-blob')
    memorySession.setItem('fixup.auth.recovery_hash', '#access_token=x')
    memoryLocal.setItem('fixup.chat.draft.thread-1', 'weg damit')
    sweepAllDraftKeys()
    expect(memoryLocal.getItem('fixup.session.cache.v1')).toBe('{"user":null}')
    expect(memoryLocal.getItem('fixup.pending_mutations.v1')).toBe('[]')
    expect(memoryLocal.getItem('fixup.auth')).toBe('token-blob')
    expect(memorySession.getItem('fixup.auth.recovery_hash')).toBe('#access_token=x')
    expect(memoryLocal.getItem('fixup.chat.draft.thread-1')).toBe(null)
  })

  it('removes ALL matching keys even when interleaved with others (index-shift safety)', () => {
    // Removing while iterating storage.key(i) shifts indices — five
    // interleaved draft keys catch the every-other-key skip bug.
    for (let n = 0; n < 5; n++) {
      memoryLocal.setItem(`fixup.chat.draft.t${n}`, `d${n}`)
      memoryLocal.setItem(`fixup.other.${n}`, `o${n}`)
    }
    sweepAllDraftKeys()
    for (let n = 0; n < 5; n++) {
      expect(memoryLocal.getItem(`fixup.chat.draft.t${n}`)).toBe(null)
      expect(memoryLocal.getItem(`fixup.other.${n}`)).toBe(`o${n}`)
    }
  })

  it('sweeps every registered prefix (future Block-4 surfaces included)', () => {
    for (const prefix of DRAFT_KEY_PREFIXES) {
      memoryLocal.setItem(`${prefix}some-id`, 'local')
      memorySession.setItem(`${prefix}other-id`, 'session')
    }
    sweepAllDraftKeys()
    for (const prefix of DRAFT_KEY_PREFIXES) {
      expect(memoryLocal.getItem(`${prefix}some-id`)).toBe(null)
      expect(memorySession.getItem(`${prefix}other-id`)).toBe(null)
    }
  })

  it('sweeps the literal Block-4 form-draft surfaces (quote/change-order/dispute)', () => {
    // Exact key shapes produced by the live surfaces — a LITERAL guard, not a
    // DRAFT_KEY_PREFIXES iteration (which can never catch an unregistered
    // prefix). If any of these prefixes is dropped from the registry this test
    // fails, surfacing the cross-account leak the sweep exists to prevent.
    memoryLocal.setItem('fixup.quote.draft.conv-1.diagnosis', 'Preis 250 EUR') // QuoteCreationSheet
    memoryLocal.setItem('fixup.changeorder.draft.job-7', 'Mehraufwand Fliesen') // ChangeOrderComposerScreen
    memoryLocal.setItem('fixup.dispute.response.job-7', 'Meine Stellungnahme') // DisputeResponseComposer
    memorySession.setItem('fixup.dispute.open.job-7', 'Streitgrund') // CustomerOpenDisputeCard
    memoryLocal.setItem('fixup_pb_draft', 'Bad sanieren in Hannover, Budget 8000') // ProjectBuilderScreen
    memoryLocal.setItem('fixup.chat.draft.thread-1', 'Hallo')
    sweepAllDraftKeys()
    expect(memoryLocal.getItem('fixup.quote.draft.conv-1.diagnosis')).toBe(null)
    expect(memoryLocal.getItem('fixup.changeorder.draft.job-7')).toBe(null)
    expect(memoryLocal.getItem('fixup.dispute.response.job-7')).toBe(null)
    expect(memorySession.getItem('fixup.dispute.open.job-7')).toBe(null)
    expect(memoryLocal.getItem('fixup_pb_draft')).toBe(null)
    expect(memoryLocal.getItem('fixup.chat.draft.thread-1')).toBe(null)
  })

  it('a throwing storage accessor never throws out of the sweep (other storage still swept)', () => {
    memoryLocal.setItem('fixup.chat.draft.thread-1', 'weg damit')
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('SecurityError')
      },
    })
    expect(() => sweepAllDraftKeys()).not.toThrow()
    // localStorage is swept first and independently of the throwing session store.
    expect(memoryLocal.getItem('fixup.chat.draft.thread-1')).toBe(null)
  })

  it('a throwing removeItem never throws out of the sweep', () => {
    memoryLocal.setItem('fixup.chat.draft.thread-1', 'x')
    vi.spyOn(memoryLocal, 'removeItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    expect(() => sweepAllDraftKeys()).not.toThrow()
  })
})
