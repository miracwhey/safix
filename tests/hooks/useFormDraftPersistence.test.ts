// @vitest-environment jsdom
/**
 * useFormDraftPersistence · Resume-Robustness Block 4.
 *
 * Object-draft layer on top of useDraftPersistence (Block 1): one JSON
 * object per surface under a single key. Tests cover: lazy restore on
 * mount · schema-tolerant parse (missing fields → defaults, type-mismatch
 * → defaults, unknown fields dropped, corrupt JSON → defaults) · debounced
 * persist of the full field object · persist(null) removes the entry ·
 * clear() removes + cancels pending write · flush-on-unmount · null-key
 * in-memory mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// In-memory localStorage stub — the vitest-jsdom localStorage in this repo
// has no functional methods (Node `--localstorage-file` warning); same
// pattern as tests/hooks/useDraftPersistence.test.ts.
const memoryStorage = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => { store[k] = v },
    removeItem: (k: string): void => { delete store[k] },
    clear: (): void => { store = {} },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number { return Object.keys(store).length },
  }
})()
vi.stubGlobal('localStorage', memoryStorage)
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: memoryStorage,
})

import {
  useFormDraftPersistence,
  parseFormDraft,
} from '../../src/hooks/useFormDraftPersistence'

const KEY = 'fixup.quote.draft.thread-1.binding_offer'

type TestDraft = {
  price: string
  notes: string
  vatIncluded: boolean
}

const DEFAULTS: TestDraft = { price: '', notes: '', vatIncluded: true }

describe('parseFormDraft (schema-tolerant restore)', () => {
  it('returns defaults for empty input', () => {
    expect(parseFormDraft('', DEFAULTS)).toEqual(DEFAULTS)
  })

  it('returns defaults for corrupt JSON', () => {
    expect(parseFormDraft('{not json', DEFAULTS)).toEqual(DEFAULTS)
  })

  it('returns defaults for non-object payloads (string/array)', () => {
    expect(parseFormDraft('"nur text"', DEFAULTS)).toEqual(DEFAULTS)
    expect(parseFormDraft('[1,2]', DEFAULTS)).toEqual(DEFAULTS)
  })

  it('fills missing fields with defaults (older draft, newer schema)', () => {
    const parsed = parseFormDraft(JSON.stringify({ price: '450 €' }), DEFAULTS)
    expect(parsed).toEqual({ price: '450 €', notes: '', vatIncluded: true })
  })

  it('rejects type-mismatched fields and drops unknown fields', () => {
    const parsed = parseFormDraft(
      JSON.stringify({ price: 450, vatIncluded: false, legacyField: 'x' }),
      DEFAULTS,
    )
    expect(parsed).toEqual({ price: '', notes: '', vatIncluded: false })
    expect('legacyField' in parsed).toBe(false)
  })
})

describe('useFormDraftPersistence', () => {
  beforeEach(() => {
    memoryStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('restores the stored object synchronously at mount', () => {
    memoryStorage.setItem(KEY, JSON.stringify({ price: '1.200 €', vatIncluded: false }))
    const { result } = renderHook(() => useFormDraftPersistence(KEY, DEFAULTS))
    expect(result.current.restored).toEqual({
      price: '1.200 €',
      notes: '',
      vatIncluded: false,
    })
  })

  it('restores defaults when nothing is stored', () => {
    const { result } = renderHook(() => useFormDraftPersistence(KEY, DEFAULTS))
    expect(result.current.restored).toEqual(DEFAULTS)
  })

  it('persists the full field object as JSON after the debounce', () => {
    const { result } = renderHook(() => useFormDraftPersistence(KEY, DEFAULTS))
    act(() => {
      result.current.persist({ price: '99 €', notes: 'Hinweis', vatIncluded: false })
    })
    expect(memoryStorage.getItem(KEY)).toBe(null)
    act(() => { vi.advanceTimersByTime(350) })
    expect(JSON.parse(memoryStorage.getItem(KEY)!)).toEqual({
      price: '99 €',
      notes: 'Hinweis',
      vatIncluded: false,
    })
  })

  it('persist(null) removes the entry (empty form leaves no junk key)', () => {
    memoryStorage.setItem(KEY, JSON.stringify({ price: 'alt' }))
    const { result } = renderHook(() => useFormDraftPersistence(KEY, DEFAULTS))
    act(() => { result.current.persist(null) })
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem(KEY)).toBe(null)
  })

  it('clear() removes the entry and cancels a pending debounced write', () => {
    memoryStorage.setItem(KEY, JSON.stringify({ price: 'alt' }))
    const { result } = renderHook(() => useFormDraftPersistence(KEY, DEFAULTS))
    act(() => {
      result.current.persist({ price: 'neu', notes: '', vatIncluded: true })
    })
    act(() => { result.current.clear() })
    expect(memoryStorage.getItem(KEY)).toBe(null)
    // The cancelled debounce must not resurrect the draft.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(memoryStorage.getItem(KEY)).toBe(null)
  })

  it('flushes the pending write on unmount (never clears)', () => {
    const { result, unmount } = renderHook(() => useFormDraftPersistence(KEY, DEFAULTS))
    act(() => {
      result.current.persist({ price: '450 €', notes: '', vatIncluded: true })
    })
    // Unmount inside the debounce window — navigation/AuthGate-swap.
    unmount()
    expect(JSON.parse(memoryStorage.getItem(KEY)!)).toEqual({
      price: '450 €',
      notes: '',
      vatIncluded: true,
    })
  })

  it('key === null stays in-memory only, storage untouched', () => {
    const { result } = renderHook(() => useFormDraftPersistence(null, DEFAULTS))
    expect(result.current.restored).toEqual(DEFAULTS)
    act(() => {
      result.current.persist({ price: 'flüchtig', notes: '', vatIncluded: true })
    })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(memoryStorage.length).toBe(0)
  })
})
