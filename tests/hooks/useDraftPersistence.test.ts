// @vitest-environment jsdom
/**
 * useDraftPersistence · Resume-Robustness Block 1.
 *
 * localStorage-backed composer-draft persistence (ProjectBuilder pattern +
 * 300ms debounce). Tests cover: lazy restore on mount · debounced write ·
 * keystroke coalescing · clear() removes + cancels pending write · empty
 * value removes the key · unmount flushes (but never clears) · key
 * transitions (null→key, keyA→keyB) · null-key in-memory mode · quota-throw
 * safety · per-key isolation (multi-tab/double-mount proxy).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// In-memory localStorage stub — the vitest-jsdom localStorage in this repo
// has no functional methods (Node `--localstorage-file` warning); same
// pattern as tests/hooks/useSpatialFirstRunFlag.test.ts.
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

import { useDraftPersistence } from '../../src/hooks/useDraftPersistence'

const KEY_A = 'fixup.chat.draft.thread-a'
const KEY_B = 'fixup.chat.draft.thread-b'

describe('useDraftPersistence', () => {
  beforeEach(() => {
    memoryStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('restores the persisted draft synchronously at mount', () => {
    memoryStorage.setItem(KEY_A, 'Hallo aus dem Storage')
    const { result } = renderHook(() => useDraftPersistence(KEY_A))
    expect(result.current.value).toBe('Hallo aus dem Storage')
  })

  it('starts empty when nothing is stored', () => {
    const { result } = renderHook(() => useDraftPersistence(KEY_A))
    expect(result.current.value).toBe('')
  })

  it('persists a change only after the debounce window (~300ms)', () => {
    const { result } = renderHook(() => useDraftPersistence(KEY_A))
    act(() => { result.current.setValue('Entwurf') })
    expect(result.current.value).toBe('Entwurf')
    // Not yet written — still inside the debounce window.
    act(() => { vi.advanceTimersByTime(250) })
    expect(memoryStorage.getItem(KEY_A)).toBe(null)
    act(() => { vi.advanceTimersByTime(100) })
    expect(memoryStorage.getItem(KEY_A)).toBe('Entwurf')
  })

  it('coalesces rapid keystrokes — only the final value is written', () => {
    const { result } = renderHook(() => useDraftPersistence(KEY_A))
    act(() => { result.current.setValue('H') })
    act(() => { vi.advanceTimersByTime(100) })
    act(() => { result.current.setValue('Ha') })
    act(() => { vi.advanceTimersByTime(100) })
    act(() => { result.current.setValue('Hal') })
    // 200ms since last keystroke — debounce not elapsed, nothing written.
    act(() => { vi.advanceTimersByTime(200) })
    expect(memoryStorage.getItem(KEY_A)).toBe(null)
    act(() => { vi.advanceTimersByTime(150) })
    expect(memoryStorage.getItem(KEY_A)).toBe('Hal')
  })

  it('clear() empties state, removes the entry and cancels the pending write', () => {
    memoryStorage.setItem(KEY_A, 'alt')
    const { result } = renderHook(() => useDraftPersistence(KEY_A))
    act(() => { result.current.setValue('neu getippt') })
    act(() => { result.current.clear() })
    expect(result.current.value).toBe('')
    expect(memoryStorage.getItem(KEY_A)).toBe(null)
    // The debounced write from before clear() must NOT resurrect the draft.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(memoryStorage.getItem(KEY_A)).toBe(null)
  })

  it('writing an empty value removes the key instead of storing ""', () => {
    const { result } = renderHook(() => useDraftPersistence(KEY_A))
    act(() => { result.current.setValue('etwas') })
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem(KEY_A)).toBe('etwas')
    act(() => { result.current.setValue('') })
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem(KEY_A)).toBe(null)
  })

  it('unmount flushes the pending debounced write (no keystroke loss on navigation)', () => {
    const { result, unmount } = renderHook(() => useDraftPersistence(KEY_A))
    act(() => { result.current.setValue('halb getippt') })
    // Unmount BEFORE the debounce elapses — flush must write synchronously.
    unmount()
    expect(memoryStorage.getItem(KEY_A)).toBe('halb getippt')
  })

  it('unmount never clears an already-persisted draft', () => {
    memoryStorage.setItem(KEY_A, 'bleibt')
    const { unmount } = renderHook(() => useDraftPersistence(KEY_A))
    unmount()
    expect(memoryStorage.getItem(KEY_A)).toBe('bleibt')
  })

  it('key transition null→key adopts the stored draft (thread resolution)', () => {
    memoryStorage.setItem(KEY_A, 'wiederhergestellt')
    const { result, rerender } = renderHook(
      ({ k }: { k: string | null }) => useDraftPersistence(k),
      { initialProps: { k: null as string | null } },
    )
    expect(result.current.value).toBe('')
    rerender({ k: KEY_A })
    expect(result.current.value).toBe('wiederhergestellt')
  })

  it('key transition keyA→keyB flushes A and loads B — no cross-bleed', () => {
    memoryStorage.setItem(KEY_B, 'draft-b')
    const { result, rerender } = renderHook(
      ({ k }: { k: string | null }) => useDraftPersistence(k),
      { initialProps: { k: KEY_A as string | null } },
    )
    act(() => { result.current.setValue('draft-a') })
    // Switch threads inside the debounce window — A must be flushed first.
    rerender({ k: KEY_B })
    expect(memoryStorage.getItem(KEY_A)).toBe('draft-a')
    expect(result.current.value).toBe('draft-b')
    // The stale debounce timer must not write 'draft-a' under KEY_B.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(memoryStorage.getItem(KEY_B)).toBe('draft-b')
  })

  it('null key works as pure in-memory state without touching storage', () => {
    const { result, unmount } = renderHook(() => useDraftPersistence(null))
    act(() => { result.current.setValue('nur im Speicher') })
    expect(result.current.value).toBe('nur im Speicher')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(memoryStorage.length).toBe(0)
    unmount()
    expect(memoryStorage.length).toBe(0)
  })

  it('survives a throwing setItem (quota / private mode) — state still updates', () => {
    vi.spyOn(memoryStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    const { result } = renderHook(() => useDraftPersistence(KEY_A))
    expect(() => {
      act(() => { result.current.setValue('trotzdem da') })
      act(() => { vi.advanceTimersByTime(350) })
    }).not.toThrow()
    expect(result.current.value).toBe('trotzdem da')
  })

  it('survives a throwing getItem at mount — starts empty', () => {
    vi.spyOn(memoryStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError')
    })
    const { result } = renderHook(() => useDraftPersistence(KEY_A))
    expect(result.current.value).toBe('')
  })

  it('two hooks with different keys stay isolated (two open threads)', () => {
    const a = renderHook(() => useDraftPersistence(KEY_A))
    const b = renderHook(() => useDraftPersistence(KEY_B))
    act(() => { a.result.current.setValue('für Thread A') })
    act(() => { b.result.current.setValue('für Thread B') })
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem(KEY_A)).toBe('für Thread A')
    expect(memoryStorage.getItem(KEY_B)).toBe('für Thread B')
    expect(a.result.current.value).toBe('für Thread A')
    expect(b.result.current.value).toBe('für Thread B')
  })
})
