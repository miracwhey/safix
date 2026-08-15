/**
 * Phase 5 Spatial V1.6 — Perf-KPI Instrumentation.
 *
 * Free-tier-aware (Sentry 100 spans/transaction cap). Only the 3 KPI spans
 * defined in `PerfSpanName` are intended to be emitted — anything beyond
 * that is a budget regression.
 *
 * Memory-Probe is NOT included here: `performance.memory` is Chromium-only
 * and unavailable inside WKWebView (iOS Capacitor shell). The TestFlight
 * Perf-Guide documents the Xcode → Instruments workflow for heap snapshots
 * instead.
 *
 * Design notes:
 *   - SSR-safe (`typeof performance === 'undefined'` short-circuits).
 *   - Capacitor / WKWebView-safe (every `performance.*` call is in a
 *     try/catch so a missing API path is a silent no-op, never a crash).
 *   - All silent failures route through `logWarning` so a regression is
 *     observable in Sentry without throwing in the render path.
 *   - Sentry spans are post-hoc — we own the timing via `performance.mark`
 *     + `performance.measure` and report the resulting duration via
 *     `startInactiveSpan().end()` (the only shape that lets us emit a span
 *     at the moment we already know the duration without re-running the
 *     work inside the callback form of `startSpan`).
 */

import * as Sentry from '@sentry/react'
import { logWarning } from './index'

// ---------------------------------------------------------------------------
// Public KPI name unions
// ---------------------------------------------------------------------------

/**
 * Performance marks for the customer spatial pipeline. Mirrors the binding
 * Phase-5 KPIs:
 *   - hub.mount-start → hub.gltf-ready   ⇒ hub-load-total < 3s
 *   - pin.raycast-start                  ⇒ raycast tick attribute < 100ms
 *   - pin.detail-save → pin.persisted    ⇒ pin-save-roundtrip < 1s
 *   - lidar.capture-start → lidar.scene-created ⇒ scene-create < (governed by GLB-cached < 1.5s budget)
 */
export type PerfMarkName =
  | 'spatial.hub.mount-start'
  | 'spatial.hub.gltf-ready'
  | 'spatial.pin.raycast-start'
  | 'spatial.pin.detail-save'
  | 'spatial.pin.persisted'
  | 'spatial.lidar.capture-start'
  | 'spatial.lidar.scene-created'

/**
 * Free-tier-mindful set of Sentry-Performance spans. Adding a new entry
 * here is a deliberate budget bump — review against the 100 spans/
 * transaction cap before extending.
 */
export type PerfSpanName =
  | 'spatial.hub.load'
  | 'spatial.pin.save-roundtrip'
  | 'spatial.lidar.scene'

type SpanAttrs = Record<string, string | number | boolean | undefined | null>

// ---------------------------------------------------------------------------
// Internal helpers — performance API guards
// ---------------------------------------------------------------------------

function hasPerformanceApi(): boolean {
  return typeof performance !== 'undefined' && typeof performance.mark === 'function'
}

// ---------------------------------------------------------------------------
// performance.mark / measure wrappers
// ---------------------------------------------------------------------------

/**
 * Drop a `performance.mark` for the given KPI name. No-ops silently when
 * the platform has no User-Timing API (older WKWebView edge case).
 */
export function mark(name: PerfMarkName): void {
  if (!hasPerformanceApi()) return
  try {
    performance.mark(name)
  } catch (err) {
    logWarning('observability.perf.mark_failed', { name, error: String(err) })
  }
}

/**
 * Compute the duration between two marks via `performance.measure`. Returns
 * the resulting `PerformanceMeasure.duration` in milliseconds, or `undefined`
 * when the marks are missing, the API is unavailable, or the measure call
 * itself throws (Safari throws SyntaxError when a start-mark name is unknown).
 *
 * The measure is named `<name>` so the same name can be reused for the
 * Sentry span emitted by `reportMeasureAsSpan`.
 */
export function measure(
  name: string,
  startMark: string,
  endMark?: string,
): number | undefined {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') {
    return undefined
  }
  try {
    const result = endMark
      ? performance.measure(name, startMark, endMark)
      : performance.measure(name, startMark)
    // `performance.measure` returns a PerformanceMeasure in modern engines;
    // some legacy paths return void. Fall back to the entries lookup.
    const entry =
      result && typeof (result as PerformanceMeasure).duration === 'number'
        ? (result as PerformanceMeasure)
        : performance.getEntriesByName(name, 'measure').slice(-1)[0]
    if (!entry || typeof entry.duration !== 'number') return undefined
    return entry.duration
  } catch (err) {
    logWarning('observability.perf.measure_failed', {
      name,
      startMark,
      endMark: endMark ?? null,
      error: String(err),
    })
    return undefined
  }
}

/**
 * Clears `performance.mark` / `performance.measure` entries that match the
 * optional prefix. Without a prefix it tears down all spatial.* marks the
 * Hub owns — call on Hub-unmount so cross-session marks never bleed.
 */
export function clearPerfMarks(prefix?: string): void {
  if (typeof performance === 'undefined') return
  try {
    if (!prefix) {
      performance.clearMarks?.()
      performance.clearMeasures?.()
      return
    }
    const marks = performance.getEntriesByType?.('mark') ?? []
    for (const entry of marks) {
      if (entry.name.startsWith(prefix)) {
        performance.clearMarks?.(entry.name)
      }
    }
    const measures = performance.getEntriesByType?.('measure') ?? []
    for (const entry of measures) {
      if (entry.name.startsWith(prefix)) {
        performance.clearMeasures?.(entry.name)
      }
    }
  } catch (err) {
    logWarning('observability.perf.clear_failed', { prefix: prefix ?? null, error: String(err) })
  }
}

// ---------------------------------------------------------------------------
// Sentry span helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an async function in `Sentry.startSpan`. The span auto-ends when the
 * promise settles. Errors propagate untouched — the caller still owns the
 * try/catch policy.
 */
export async function startSpan<T>(
  name: PerfSpanName,
  op: string,
  fn: () => Promise<T>,
  attrs?: SpanAttrs,
): Promise<T> {
  return Sentry.startSpan({ name, op, attributes: sanitizeAttrs(attrs) }, () => fn())
}

/**
 * Synchronous variant of {@link startSpan} — wraps a sync function. Use for
 * tight render-path measurements (raycast hit-test etc.) where the work is
 * already on the main thread.
 */
export function startSpanSync<T>(
  name: PerfSpanName,
  op: string,
  fn: () => T,
  attrs?: SpanAttrs,
): T {
  return Sentry.startSpan({ name, op, attributes: sanitizeAttrs(attrs) }, () => fn())
}

/**
 * Post-hoc span report. Used when the duration is already known from a
 * `performance.measure` (the user-timing API ran first, the Sentry span is
 * the projection of that measurement into the Sentry Performance dashboard).
 *
 * Skipped silently when the duration is non-positive or non-finite — those
 * are diagnostic bugs (start-mark after end-mark, NaN measure), not signal.
 */
export function reportMeasureAsSpan(
  name: PerfSpanName,
  op: string,
  durationMs: number,
  attrs?: SpanAttrs,
): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return
  try {
    const now = Date.now()
    const startTimeMs = now - durationMs
    const span = Sentry.startInactiveSpan({
      name,
      op,
      attributes: sanitizeAttrs(attrs),
      startTime: startTimeMs / 1000,
    })
    // `Sentry.startInactiveSpan` returns a Span (or a no-op span when the
    // SDK is uninitialised). `.end()` accepts a unix-seconds timestamp.
    span.end(now / 1000)
  } catch (err) {
    logWarning('observability.perf.report_span_failed', {
      name,
      op,
      durationMs,
      error: String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sanitizeAttrs(attrs: SpanAttrs | undefined): Record<string, string | number | boolean> | undefined {
  if (!attrs) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}
