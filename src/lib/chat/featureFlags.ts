/**
 * Block D Slice 1 Phase 1b — Per-Persona Feature Flags for Chat-UI Cutover.
 *
 * Each persona toggles independently. Build-time via Vite env-var, runtime
 * override via localStorage (for QA on real devices without rebuild).
 *
 * Env-vars (Vercel):
 *   VITE_CHAT_UI_CUTOVER_CUSTOMER  ('true' | unset)
 *   VITE_CHAT_UI_CUTOVER_CRAFTSMAN ('true' | unset)
 *   VITE_CHAT_UI_CUTOVER_WORKER    ('true' | unset)
 *
 * localStorage keys (one per persona):
 *   fixup.chat_ui_cutover.customer  ('on' | 'off' | unset)
 *   fixup.chat_ui_cutover.craftsman ('on' | 'off' | unset)
 *   fixup.chat_ui_cutover.worker    ('on' | 'off' | unset)
 *
 * Runtime override wins over env-var. Set via:
 *   localStorage.setItem('fixup.chat_ui_cutover.customer', 'on')
 *   localStorage.removeItem('fixup.chat_ui_cutover.customer')  // clear override
 */

import { getFlag } from '../flags/evaluateFlag'

export type ChatUiPersona = 'customer' | 'craftsman' | 'worker'

/** Remote feature-flag key per persona (public.feature_flags). */
const FLAG_KEYS: Record<ChatUiPersona, string> = {
  customer: 'chat_ui_cutover_customer',
  craftsman: 'chat_ui_cutover_craftsman',
  worker: 'chat_ui_cutover_worker',
}

const LS_KEY_PREFIX = 'fixup.chat_ui_cutover.'

function readLocalStorage(persona: ChatUiPersona): 'on' | 'off' | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${LS_KEY_PREFIX}${persona}`)
    if (raw === 'on' || raw === 'off') return raw
    return null
  } catch {
    return null
  }
}

function readEnv(persona: ChatUiPersona): boolean {
  // Keep these as direct Vite env accesses. Computed access via
  // `(import.meta as any).env[key]` bypasses Vitest's build-time definitions
  // and can accidentally load a developer's production .env.local flags.
  if (persona === 'customer') {
    return import.meta.env.VITE_CHAT_UI_CUTOVER_CUSTOMER === 'true'
  }
  if (persona === 'craftsman') {
    return import.meta.env.VITE_CHAT_UI_CUTOVER_CRAFTSMAN === 'true'
  }
  return import.meta.env.VITE_CHAT_UI_CUTOVER_WORKER === 'true'
}

/**
 * Returns true when the per-persona Chat-UI Cutover is active.
 *
 * Resolution order (first match wins):
 *   1. localStorage override ('on' → true, 'off' → false) — QA, beats remote.
 *   2. Remote feature flag, WHEN a row exists — its `enabled` master toggle is
 *      the source of truth, so ops can enable a cutover or KILL a broken one
 *      live without a release.
 *   3. Vite env-var default (no remote row yet → pre-flags behavior preserved).
 *   4. default false
 *
 * A missing flag row deliberately falls through to env rather than fail-closing
 * to false, so introducing the flags table never silently disables a cutover
 * that env currently enables. Create the row to take remote control.
 *
 * Only the `enabled` master toggle is consulted here (not rollout_pct/targeting)
 * — a cutover is per-persona binary, and reading the full session-based resolver
 * would pull session.ts into this module-load-sensitive file. Staged % rollout
 * of a cutover, if ever needed, belongs in a session-aware caller.
 */
export function isChatCutoverEnabled(persona: ChatUiPersona): boolean {
  const ls = readLocalStorage(persona)
  if (ls === 'on') return true
  if (ls === 'off') return false
  const flag = getFlag(FLAG_KEYS[persona])
  if (flag) return flag.enabled
  return readEnv(persona)
}

/**
 * Test/QA helper: set localStorage override.
 * In production code, prefer the env-var.
 */
export function setChatCutoverOverride(
  persona: ChatUiPersona,
  value: 'on' | 'off' | null,
): void {
  if (typeof localStorage === 'undefined') return
  const key = `${LS_KEY_PREFIX}${persona}`
  if (value === null) localStorage.removeItem(key)
  else localStorage.setItem(key, value)
}

const URL_PARAM_PREFIX = 'chat_cutover_'
const PERSONAS: readonly ChatUiPersona[] = ['customer', 'craftsman', 'worker']

/**
 * Recovery-Path (P2-6): Apply URL-param overrides into localStorage and clean
 * the URL. Useful when the cutover causes a UI crash and the user has no
 * DevTools — opening any SaFix URL with `?chat_cutover_customer=off` (or
 * `=on` / `=clear`) flips the flag immediately on next reload without a
 * rebuild.
 *
 * Accepted values per param: `on` | `off` | `clear` (empty also clears).
 * Params are removed from the URL after application so they do not persist in
 * browser history or share-links.
 */
export function applyChatCutoverUrlOverride(): void {
  if (typeof window === 'undefined') return
  const search = window.location?.search
  if (!search) return
  try {
    const params = new URLSearchParams(search)
    let mutated = false
    for (const persona of PERSONAS) {
      const key = `${URL_PARAM_PREFIX}${persona}`
      if (!params.has(key)) continue
      const raw = params.get(key)
      if (raw === 'on' || raw === 'off') {
        setChatCutoverOverride(persona, raw)
      } else {
        setChatCutoverOverride(persona, null)
      }
      params.delete(key)
      mutated = true
    }
    if (mutated && window.history?.replaceState) {
      const next = params.toString()
      const url =
        window.location.pathname +
        (next ? `?${next}` : '') +
        (window.location.hash ?? '')
      window.history.replaceState(null, '', url)
    }
  } catch {
    // ignore — defaults remain in effect
  }
}
