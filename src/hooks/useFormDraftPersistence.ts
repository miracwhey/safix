/**
 * useFormDraftPersistence — multi-field form draft persistence.
 *
 * Resume-robustness Block 4: form composers (Quote, Nachtrag, Dispute) must
 * survive unmount/remount cycles and WebView memory kills the same way chat
 * composers do (Block 1). Builds ON TOP of useDraftPersistence — debounce,
 * flush-on-unmount, key transitions and storage try/catch guards are fully
 * reused — and adds object support: ONE JSON object per surface under a
 * single storage key (never one key per field).
 *
 * Contract:
 *   • `restored` is parsed once, synchronously at mount (lazy restore).
 *     Schema-tolerant: missing fields and type-mismatched fields fall back
 *     to the provided defaults; unknown stored fields are dropped; corrupt
 *     JSON yields the defaults. Consumers seed their per-field useState
 *     initializers from it.
 *   • `persist(fields)` schedules a debounced write of the full field
 *     object; `persist(null)` marks the form as empty (removes the entry
 *     instead of storing an empty object).
 *   • Restoring NEVER triggers a submit — it only refills field state.
 *   • `clear()` removes the entry and cancels pending writes. Call ONLY
 *     after a successful submit dispatch or an explicit user discard.
 *   • The key is expected to be fixed for the component lifetime (all
 *     consumers key on a route/prop id that cannot change without a
 *     remount); `key === null` → pure in-memory, storage untouched.
 */

import { useCallback, useState } from 'react'
import { useDraftPersistence } from './useDraftPersistence'

export interface UseFormDraftPersistenceApi<T> {
  /** Draft parsed at mount — missing/mismatched fields fall back to defaults. */
  restored: T
  /** Debounced write-through of the full field object; `null` = form empty. */
  persist: (fields: T | null) => void
  /** Remove the draft + cancel pending writes (after submit success/discard). */
  clear: () => void
  /**
   * True when a stored draft entry existed at mount (even one whose fields are
   * all empty). Lets a consumer distinguish "a draft was restored" from "no
   * draft" — needed so an explicitly-cleared field is not re-seeded from a
   * prop default on reopen. Frozen at mount, like {@link restored}.
   */
  hasDraft: boolean
}

function readStoredDraft(key: string | null): string {
  if (key === null || typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    // Safari private mode / sandboxed storage — treat as "no draft".
    return ''
  }
}

/**
 * Schema-tolerant parse: only keys present in `defaults` are adopted, and
 * only when the stored value's type matches the default's type. Everything
 * else (missing fields, renamed fields, corrupt payloads) falls back to the
 * default — old drafts can never crash a newer form.
 */
export function parseFormDraft<T extends Record<string, unknown>>(
  raw: string,
  defaults: T,
): T {
  if (!raw) return { ...defaults }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...defaults }
    }
    const result = { ...defaults }
    for (const field of Object.keys(defaults) as (keyof T)[]) {
      const stored = (parsed as Record<string, unknown>)[field as string]
      if (stored !== undefined && typeof stored === typeof defaults[field]) {
        result[field] = stored as T[keyof T]
      }
    }
    return result
  } catch {
    return { ...defaults }
  }
}

export function useFormDraftPersistence<T extends Record<string, unknown>>(
  key: string | null,
  defaults: T,
): UseFormDraftPersistenceApi<T> {
  // trackValue:false — this hook never reads useDraftPersistence's `value` (the
  // restored draft is parsed independently below), so suppressing its internal
  // state update removes a redundant re-render of the form on every keystroke.
  const { setValue, clear } = useDraftPersistence(key, undefined, { trackValue: false })

  // Lazy restore: read storage ONCE at mount and derive both the parsed draft
  // and whether an entry existed. Both are frozen for the component lifetime
  // (the key cannot change without a remount), so a single read is correct and
  // avoids a per-render localStorage hit.
  const [{ restored, hasDraft }] = useState<{ restored: T; hasDraft: boolean }>(() => {
    const raw = readStoredDraft(key)
    return { restored: parseFormDraft(raw, defaults), hasDraft: raw !== '' }
  })

  const persist = useCallback(
    (fields: T | null) => {
      // Empty form → '' which the underlying hook turns into removeItem,
      // so abandoned forms do not accumulate junk keys.
      setValue(fields === null ? '' : JSON.stringify(fields))
    },
    [setValue],
  )

  return { restored, persist, clear, hasDraft }
}
