import { createElement, useEffect, type ComponentType } from 'react'

/**
 * Opt-in bottom-tab tap latency instrumentation (Handover 2026-07-01, Step 0).
 *
 * The symptom is "tap a bottom tab → nothing for a beat → then it loads",
 * worst on a memory/thermal-throttled device. #1063 reduced a cold tap to
 * parsing ONE chunk, yet the latency persists — so before touching the
 * load-bearing PersistentTabs render again we MEASURE where the time actually
 * goes: tap → navigate → PersistentTabs render → Suspense fallback painted →
 * chunk parsed → screen content painted.
 *
 * Fully no-op unless enabled, so the probes are safe to leave in place. Enable
 * ON THE DEVICE without a rebuild by appending `?tabperf=on` to any URL (the
 * flag persists in localStorage, mirroring `applyChatCutoverUrlOverride`);
 * `?tabperf=off` / `?tabperf=clear` turns it off again. Read the timeline over
 * Safari Web Inspector (Develop → device → console) filtered on `[tabperf]`.
 *
 * Reading the output — a tap prints one block:
 *   [tabperf] ─── tap → /explore
 *   [tabperf] +2.1ms   PersistentTabs render · active=/explore
 *   [tabperf] +3.4ms   import() eval start · explore
 *   [tabperf] +6.0ms   fallback painted · explore          ← Suspense skeleton visible
 *   [tabperf] +120ms   chunk parsed+resolved · explore     ← parse finished
 *   [tabperf] +140ms   screen content painted · explore    ← real screen visible
 * Diagnosis:
 *   • large `tap → render`            → main-thread contention (boot herd) — Hyp #2/#3
 *   • `fallback painted` ≈ `content`  → the skeleton never paints before the
 *                                       parse (fallback-paint problem) — Hyp #1
 *   • small fallback, large content   → parse/mount is the cost → preload — Hyp #6
 */

const STORAGE_KEY = 'debug_tabperf'

let enabled = false
try {
  enabled = localStorage.getItem(STORAGE_KEY) === 'on'
} catch {
  // localStorage can throw in private mode / SSR — stay disabled.
}

/**
 * `?tabperf=on|off|clear` in any URL flips the flag before any probe reads it,
 * so the harness can be armed on-device without a rebuild. Call once at boot.
 */
export function applyTabPerfUrlOverride(): void {
  try {
    const v = new URLSearchParams(window.location.search).get('tabperf')
    if (v === 'on') {
      localStorage.setItem(STORAGE_KEY, 'on')
      enabled = true
    } else if (v === 'off' || v === 'clear') {
      localStorage.removeItem(STORAGE_KEY)
      enabled = false
    }
  } catch {
    // ignore — probes stay in their current state.
  }
}

export const isTabPerfEnabled = (): boolean => enabled

// Wall-clock origin of the current tap. 0 = no tap recorded yet.
let t0 = 0

/** Reset the clock at the instant a tab is tapped and print the header line. */
export function tabPerfTap(path: string): void {
  if (!enabled) return
  t0 = performance.now()
  console.log(`[tabperf] ─── tap → ${path}`)
}

/** Print `+Δms  label`, delta measured from the last {@link tabPerfTap}. */
export function tabPerfMark(label: string): void {
  if (!enabled || t0 === 0) return
  const dt = (performance.now() - t0).toFixed(1)
  console.log(`[tabperf] +${dt}ms  ${label}`)
}

/**
 * Mark AFTER the browser has actually composited the current commit. A single
 * rAF fires before that frame paints; the second rAF runs at the start of the
 * next frame, by which point the commit is on screen — a good "perceived
 * paint" proxy (its own cadence is throttled on a slow device, which is
 * exactly the perceived latency we care about).
 */
export function tabPerfMarkPaint(label: string): void {
  if (!enabled || t0 === 0) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => tabPerfMark(label))
  })
}

/**
 * Wrap a code-split `import()` so the parse window is timed and the real
 * screen's paint is marked. Pass-through (zero cost, identical module) when the
 * harness is disabled, so it is safe to leave on every lazy tab import.
 *
 * `import() eval start` fires when React first renders the lazy element (i.e.
 * the navigation reached the tab); `chunk parsed+resolved` fires when the
 * dynamic import settles (module fetched + top-level evaluated). The resolved
 * default component is wrapped once so its mount schedules a paint mark.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's heterogeneous screen prop shapes
export function tabPerfWrapImport<T extends ComponentType<any>>(
  label: string,
  factory: () => Promise<{ default: T }>,
): Promise<{ default: T }> {
  if (!enabled) return factory()
  tabPerfMark(`import() eval start · ${label}`)
  return factory().then((mod) => {
    tabPerfMark(`chunk parsed+resolved · ${label}`)
    const Original = mod.default
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- prop shape is the wrapped screen's own
    const Probed = (props: any) => {
      useEffect(() => {
        tabPerfMarkPaint(`screen content painted · ${label}`)
      }, [])
      return createElement(Original, props)
    }
    Probed.displayName = `TabPerf(${label})`
    return { default: Probed as unknown as T }
  })
}
