/**
 * Spatial · Shared config + math for the manual-room wall measure inputs.
 *
 * Pure (no components) so both {@link DimensionInputSheet} and the non-modal
 * {@link DimensionMeasureBar} can reuse the same field ranges, dark-glass token,
 * and stepping math without tripping `react-refresh/only-export-components`.
 */
import type { CSSProperties } from 'react'

export const LENGTH_MIN_M = 0.5
export const LENGTH_MAX_M = 20
export const HEIGHT_MIN_M = 1.8
export const HEIGHT_MAX_M = 4.0
export const THICKNESS_MIN_CM = 5
export const THICKNESS_MAX_CM = 40

/**
 * Translucentes dunkles Liquid-Glass (an `.liquid-glass-dark` in index.css angelehnt).
 * Dunkel getoent, weil der Balken ueber dem HELLEN Grundriss schwebt und der
 * weisse Text Kontrast braucht — daher dunkler Tint statt des weissen Kanon-Tints.
 */
export const SHEET_GLASS: CSSProperties = {
  background:
    'linear-gradient(180deg, rgba(14,19,32,0.50) 0%, rgba(10,14,26,0.62) 100%)',
  // The backdrop here is a BRIGHT floorplan (#FAF7F0→#EDE6D6, lum ~0.85). The
  // tint alpha + a backdrop brightness < 1 must keep the composite dark enough
  // for white text: composite ≈ (1−alpha)·brightness·backdrop + alpha·tint. With
  // brightness 0.80 + alpha 0.50/0.62 the composite stays at/below the previously
  // shipped legibility (lowering brightness compensates for the more-transparent
  // tint). The wide blur frosts the busy plan into an even field; textShadow on
  // the card (DimensionMeasureBar) adds the final white-text safety halo.
  backdropFilter: 'blur(40px) saturate(1.7) brightness(0.80)',
  WebkitBackdropFilter: 'blur(40px) saturate(1.7) brightness(0.80)',
  border: '1px solid rgba(255,255,255,0.14)',
  boxShadow: '0 0.5px 0 0 rgba(255,255,255,0.16) inset, 0 6px 24px -6px rgba(0,0,0,0.45)',
}

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

export function distance(
  a: { x: number; y?: number; z: number },
  b: { x: number; y?: number; z: number },
): number {
  return Math.hypot(b.x - a.x, b.z - a.z)
}

/** Step `value` by `delta`, round to `decimals`, clamp to [min,max] → string. */
export function stepped(
  value: number,
  delta: number,
  min: number,
  max: number,
  decimals: number,
): string {
  const base = Number.isFinite(value) ? value : min
  const next = clamp(Number((base + delta).toFixed(decimals)), min, max)
  return next.toFixed(decimals)
}
