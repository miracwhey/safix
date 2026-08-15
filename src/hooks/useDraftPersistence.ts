/**
 * useDraftPersistence — localStorage-backed draft-text persistence.
 *
 * Resume-robustness Block 1: composer drafts must survive unmount/remount
 * cycles (in-flow navigation to Nachtrag/Artifact surfaces, AuthGate
 * error-swaps on transient resume network failures) and WebView memory
 * kills. Follows the ProjectBuilderScreen draft pattern (`fixup_pb_draft`):
 * lazy useState initializer reads the key, every change persists, explicit
 * clear on success — with one chat-specific addition: writes are debounced
 * (~300ms) because a composer persists per keystroke, not per form field.
 *
 * Contract:
 *   • `key === null` → pure in-memory state (no storage reads/writes).
 *     Used while the chat-thread id is still resolving; the composer input
 *     is disabled in that window, so no keystrokes can be lost.
 *   • Key transition (null → id, or thread switch without remount) flushes
 *     any pending write under the OLD key, then adopts the value stored
 *     under the NEW key. Separate threads = separate keys — no cross-bleed
 *     between two open threads (multi-tab / double-mount: last writer wins
 *     per key).
 *   • Unmount flushes the pending debounced write — it NEVER clears.
 *     Clearing is an explicit caller decision (`clear()` after a successful
 *     send dispatch or an explicit discard).
 *   • All storage access is try/catch-guarded (SSR, Safari private mode,
 *     quota) — persistence is best-effort, the in-memory state always works.
 *
 * Key convention for chat composers: `fixup.chat.draft.<chatThreadId>`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_DEBOUNCE_MS = 300

export interface UseDraftPersistenceApi {
  /** Current draft text (in-memory source of truth). */
  value: string
  /** Update the draft; schedules a debounced storage write. */
  setValue: (next: string) => void
  /**
   * Clear the draft: empties state, removes the storage entry and cancels
   * any pending debounced write. Call ONLY after a successful send dispatch
   * or an explicit user discard — never on unmount.
   */
  clear: () => void
}

function readDraft(key: string | null): string {
  if (key === null || typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    // Safari private mode / sandboxed storage throws on access — treat as
    // "no draft" so the composer still renders.
    return ''
  }
}

function writeDraft(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    if (value.length === 0) {
      // Empty draft → remove the entry instead of storing '' so abandoned
      // threads do not accumulate empty keys.
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, value)
    }
  } catch {
    // Quota exceeded / private mode — silently skip, in-memory state wins.
  }
}

function removeDraft(key: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore — best-effort
  }
}

export function useDraftPersistence(
  key: string | null,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
  opts?: { trackValue?: boolean },
): UseDraftPersistenceApi {
  // When `trackValue` is false the consumer never reads `value` (the multi-field
  // form-draft path). Suppressing the setValueState calls then avoids forcing a
  // second render of the consuming component on every persist — the localStorage
  // truth is unaffected because it flows through valueRef + writeDraft, not React
  // state. ChatComposer reads `value`, so it keeps the default (true).
  const trackValue = opts?.trackValue ?? true
  // Lazy init: restore the persisted draft synchronously at mount so the
  // composer never flashes empty before an effect runs.
  const [value, setValueState] = useState<string>(() => readDraft(key))
  const keyRef = useRef<string | null>(key)
  const valueRef = useRef<string>(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)

  // Write any pending debounced change immediately under the current key.
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (dirtyRef.current && keyRef.current !== null) {
      writeDraft(keyRef.current, valueRef.current)
    }
    dirtyRef.current = false
  }, [])

  // Key transition (thread resolution null → id, or thread switch without
  // remount): persist the outgoing draft under the OLD key first, then adopt
  // whatever is stored under the NEW key. Guarded by the prev-key comparison
  // so it runs exactly once per transition; the flush is idempotent, so a
  // StrictMode re-run cannot double-apply.
  useEffect(() => {
    if (keyRef.current === key) return
    flush()
    keyRef.current = key
    const stored = readDraft(key)
    valueRef.current = stored
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt the stored draft of the newly resolved thread; render-time adoption is blocked by react-hooks/refs (ref access + storage write are render-impure)
    if (trackValue) setValueState(stored)
  }, [key, flush, trackValue])

  // Unmount: flush so the last keystrokes inside the debounce window survive
  // navigation/AuthGate-swaps. Deliberately NOT a clear — see contract.
  useEffect(() => {
    return () => {
      flush()
    }
  }, [flush])

  const setValue = useCallback(
    (next: string) => {
      valueRef.current = next
      if (trackValue) setValueState(next)
      if (keyRef.current === null) return
      dirtyRef.current = true
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (dirtyRef.current && keyRef.current !== null) {
          writeDraft(keyRef.current, valueRef.current)
        }
        dirtyRef.current = false
      }, debounceMs)
    },
    [debounceMs, trackValue],
  )

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    dirtyRef.current = false
    valueRef.current = ''
    if (trackValue) setValueState('')
    if (keyRef.current !== null) removeDraft(keyRef.current)
  }, [trackValue])

  return { value, setValue, clear }
}

// ---------------------------------------------------------------------------
// Sign-out sweep (Resume-Robustness Block 3)
// ---------------------------------------------------------------------------

/**
 * Key-prefixes of every persisted draft namespace written through
 * {@link useDraftPersistence}. Drafts are user-private: a draft typed by one
 * account must never surface in the next account's composer on a shared
 * device, so {@link sweepAllDraftKeys} removes every matching key at sign-out.
 *
 * Every NEW draft surface MUST register its key prefix here — an unregistered
 * prefix silently leaks its drafts across sign-out.
 */
export const DRAFT_KEY_PREFIXES: readonly string[] = [
  // Chat composers (Block 1): `fixup.chat.draft.<chatThreadId>`
  'fixup.chat.draft.',
  // Block 3/4 form-draft surfaces (useFormDraftPersistence). These carry the
  // most sensitive content (quote prices/scope, change-order, dispute
  // statements) — they MUST be swept at sign-out on a shared device.
  'fixup.quote.draft.', // QuoteCreationSheet: fixup.quote.draft.<conversationId>.<documentType>
  'fixup.changeorder.draft.', // ChangeOrderComposerScreen: fixup.changeorder.draft.<jobId>
  'fixup.dispute.response.', // DisputeResponseComposer: fixup.dispute.response.<jobId>
  'fixup.dispute.open.', // CustomerOpenDisputeCard: fixup.dispute.open.<jobId>
  // ProjectBuilderScreen — own legacy underscore key (NOT a `fixup.<x>.draft.`
  // family; managed directly, not via this hook). One global key with no user
  // suffix, carrying private request content (category, location, budget, trade
  // answers, room scan) → on a shared device it surfaces in the next account's
  // builder unless swept. Exact key — `startsWith` matches it.
  'fixup_pb_draft', // ProjectBuilderScreen DRAFT_KEY
]

function sweepStorage(storage: Storage): void {
  // Collect first, remove second — removing while iterating shifts the
  // index→key mapping and would silently skip every other matching key.
  const doomed: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key !== null && DRAFT_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      doomed.push(key)
    }
  }
  for (const key of doomed) storage.removeItem(key)
}

/**
 * Remove every persisted draft (all {@link DRAFT_KEY_PREFIXES} matches) from
 * BOTH web storages. Wired into the user-initiated sign-out path
 * (`lib/auth.ts#signOut` / `deleteAccount`); server-initiated sign-outs land
 * in the session SIGNED_OUT handler. Best-effort like every other storage
 * access in this module: a throwing storage (Safari private mode, SSR) never
 * blocks the sign-out itself.
 */
export function sweepAllDraftKeys(): void {
  if (typeof window === 'undefined') return
  try {
    sweepStorage(window.localStorage)
  } catch {
    // best-effort — sign-out must never fail on a storage error
  }
  try {
    sweepStorage(window.sessionStorage)
  } catch {
    // best-effort
  }
}
