// @vitest-environment jsdom
/**
 * ChatComposer · Resume-Robustness Block 1 — draft persistence + send-lock.
 *
 * Covers:
 *   • draftKey wiring of useDraftPersistence: restore on mount, debounced
 *     persist while typing, clear ONLY after successful send dispatch,
 *     keep on failed send / beforeSend-abort, flush-on-unmount so the draft
 *     survives in-flow navigation, AuthGate error-swaps and remounts.
 *   • per-key isolation (two threads open → no cross-bleed).
 *   • back-compat: no draftKey → pure in-memory, storage untouched.
 *   • expiry-based send-lock: a send-promise that never settles (iOS WebKit
 *     suspension drop) must NOT brick the composer — after SEND_LOCK_MAX_MS
 *     (20s) the unstick failsafe re-enables input and a new send passes the
 *     re-entry guard. Within the window the double-tap guard still holds.
 *
 * Rendered without JSX (this is a .test.ts — the vitest glob scopes .tsx to
 * the spatial tree). useVoiceRecorder is mocked so the Capacitor voice
 * plugin never loads in jsdom; useToast falls back to its built-in noop.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'

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

vi.mock('../../src/hooks/useVoiceRecorder', () => ({
  useVoiceRecorder: () => ({
    state: 'idle' as const,
    elapsedMs: 0,
    liveBars: [],
    warningVisible: false,
    error: null,
    recording: null,
    start: async () => {},
    updateDrag: () => {},
    release: async () => {},
    sendFromLocked: async () => {},
    discardFromLocked: () => {},
    reset: () => {},
  }),
}))

import { ChatComposer } from '../../src/components/chat/ChatComposer'

const KEY = 'fixup.chat.draft.thread-1'
const SEND_LOCK_MAX_MS = 20_000

type ComposerProps = Partial<Parameters<typeof ChatComposer>[0]>

function renderComposer(overrides: ComposerProps = {}) {
  const onSendText = overrides.onSendText ?? vi.fn().mockResolvedValue(undefined)
  const utils = render(
    createElement(ChatComposer, {
      role: 'customer',
      onSendText,
      onTrigger: vi.fn(),
      draftKey: KEY,
      ...overrides,
    }),
  )
  const textarea = utils.container.querySelector('textarea')
  if (!textarea) throw new Error('textarea not rendered')
  return { ...utils, textarea, onSendText }
}

describe('ChatComposer draft persistence (draftKey)', () => {
  beforeEach(() => {
    memoryStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('restores the persisted draft into the textarea at mount', () => {
    memoryStorage.setItem(KEY, 'Wo bleibt das Angebot?')
    const { textarea } = renderComposer()
    expect(textarea.value).toBe('Wo bleibt das Angebot?')
  })

  it('persists typed text under the draftKey after the debounce', () => {
    const { textarea } = renderComposer()
    fireEvent.change(textarea, { target: { value: 'Halb getippt' } })
    expect(memoryStorage.getItem(KEY)).toBe(null)
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem(KEY)).toBe('Halb getippt')
  })

  it('clears input + storage ONLY after a successful send dispatch', async () => {
    const { textarea, onSendText } = renderComposer()
    fireEvent.change(textarea, { target: { value: 'Hallo' } })
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem(KEY)).toBe('Hallo')
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSendText).toHaveBeenCalledTimes(1)
    expect(onSendText).toHaveBeenCalledWith('Hallo')
    expect(textarea.value).toBe('')
    expect(memoryStorage.getItem(KEY)).toBe(null)
    // A stale debounce timer must not resurrect the cleared draft.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(memoryStorage.getItem(KEY)).toBe(null)
  })

  it('keeps text + persisted draft when the send rejects (retry without re-typing)', async () => {
    const onSendText = vi.fn().mockRejectedValue(new Error('network down'))
    const { textarea } = renderComposer({ onSendText })
    fireEvent.change(textarea, { target: { value: 'Wichtige Nachricht' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSendText).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('Wichtige Nachricht')
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem(KEY)).toBe('Wichtige Nachricht')
  })

  it('keeps the draft when beforeSend denies (gate abort)', async () => {
    const onSendText = vi.fn().mockResolvedValue(undefined)
    const { textarea } = renderComposer({ onSendText, beforeSend: async () => false })
    fireEvent.change(textarea, { target: { value: 'Gate hält mich auf' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSendText).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Gate hält mich auf')
  })

  it('draft survives unmount inside the debounce window and a remount restores it', () => {
    const first = renderComposer()
    fireEvent.change(first.textarea, { target: { value: 'Navigation unterbricht' } })
    // Unmount BEFORE the debounce elapses (in-flow tile navigation /
    // AuthGate error-swap) — flush-on-unmount must persist synchronously.
    first.unmount()
    expect(memoryStorage.getItem(KEY)).toBe('Navigation unterbricht')
    const second = renderComposer()
    expect(second.textarea.value).toBe('Navigation unterbricht')
  })

  it('two composers with different draftKeys do not cross-bleed', () => {
    memoryStorage.setItem('fixup.chat.draft.thread-A', 'Entwurf A')
    memoryStorage.setItem('fixup.chat.draft.thread-B', 'Entwurf B')
    const a = renderComposer({ draftKey: 'fixup.chat.draft.thread-A' })
    const b = renderComposer({ draftKey: 'fixup.chat.draft.thread-B' })
    expect(a.textarea.value).toBe('Entwurf A')
    expect(b.textarea.value).toBe('Entwurf B')
    fireEvent.change(a.textarea, { target: { value: 'Entwurf A neu' } })
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem('fixup.chat.draft.thread-A')).toBe('Entwurf A neu')
    expect(memoryStorage.getItem('fixup.chat.draft.thread-B')).toBe('Entwurf B')
  })

  it('without draftKey the composer stays in-memory only (back-compat)', () => {
    const { textarea } = renderComposer({ draftKey: null })
    fireEvent.change(textarea, { target: { value: 'flüchtig' } })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(memoryStorage.length).toBe(0)
  })
})

describe('ChatComposer send-lock expiry (resume robustness)', () => {
  beforeEach(() => {
    memoryStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('double-tap in the same tick sends exactly once', async () => {
    const { textarea, onSendText } = renderComposer()
    fireEvent.change(textarea, { target: { value: 'einmal' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSendText).toHaveBeenCalledTimes(1)
  })

  it('a never-settling send does not brick the composer — unsticks after SEND_LOCK_MAX_MS', async () => {
    const onSendText = vi.fn(() => new Promise<void>(() => { /* never settles */ }))
    const { textarea } = renderComposer({ onSendText })
    fireEvent.change(textarea, { target: { value: 'hängt fest' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    // In-flight: input disabled, re-entry guard blocks a second send.
    expect(textarea.disabled).toBe(true)
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSendText).toHaveBeenCalledTimes(1)
    // Failsafe fires: composer re-enabled, draft untouched (send never
    // succeeded → no clear).
    act(() => { vi.advanceTimersByTime(SEND_LOCK_MAX_MS + 1) })
    expect(textarea.disabled).toBe(false)
    expect(textarea.value).toBe('hängt fest')
    // The expired lock lets a fresh send through.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSendText).toHaveBeenCalledTimes(2)
  })

  it('a late-settling success after unstick must not clear a freshly typed draft', async () => {
    // Send #1 hangs (iOS suspension), the unstick failsafe frees the
    // composer, the user types a NEW draft — when send #1 settles late its
    // success side-effects must be token-guarded away, otherwise clearDraft
    // would silently destroy the new draft.
    let resolveFirst: (() => void) | undefined
    const onSendText = vi.fn(
      () => new Promise<void>((resolve) => { resolveFirst = resolve }),
    )
    const { textarea } = renderComposer({ onSendText })
    fireEvent.change(textarea, { target: { value: 'hängt' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    act(() => { vi.advanceTimersByTime(SEND_LOCK_MAX_MS + 1) })
    expect(textarea.disabled).toBe(false)
    // Fresh draft, persisted through the debounce.
    fireEvent.change(textarea, { target: { value: 'neuer Entwurf' } })
    act(() => { vi.advanceTimersByTime(400) })
    expect(memoryStorage.getItem(KEY)).toBe('neuer Entwurf')
    // The hung send resolves late — draft and storage must survive.
    await act(async () => { resolveFirst?.() })
    expect((textarea as HTMLTextAreaElement).value).toBe('neuer Entwurf')
    expect(memoryStorage.getItem(KEY)).toBe('neuer Entwurf')
  })

  it('a settling send releases the lock immediately for the next message', async () => {
    const { textarea, onSendText } = renderComposer()
    fireEvent.change(textarea, { target: { value: 'erste' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    fireEvent.change(textarea, { target: { value: 'zweite' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onSendText).toHaveBeenCalledTimes(2)
    expect(onSendText).toHaveBeenNthCalledWith(1, 'erste')
    expect(onSendText).toHaveBeenNthCalledWith(2, 'zweite')
  })
})
