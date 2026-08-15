/**
 * Spatial · V1.6 Phase 1d · Customer Pin-Type System (Domain layer)
 *
 * Single source of truth for the four customer-facing pin types — colour,
 * label, default-dimensions, icon paths. All UI consumers (toolbar, picker,
 * detail-sheet, pin-list) pull from this module so a rename or palette
 * tweak lands in one place.
 *
 * Decision binding:
 *   - B.2-D3 (Master-Plan §1): 4 Typen mit Farbcode — Tür #7c3aed ·
 *     Fenster #0891b2 · Heizung #dc2626 · Elektro #f59e0b (Mockup 02 v9).
 *   - PRIV-D2: customer pin metadata cascades on scan-delete via the
 *     same `scan_annotations` FK — no extra cleanup needed here.
 *
 * Defaults (Master-Plan §3 — pinTypeSystem default-Maße):
 *   - door:        80×210 cm  (DIN-Standard Wohn-Innentür)
 *   - window:     120×140 cm  (DIN-Standard 2-flügeliges Fenster)
 *   - heating:     60×60 cm   (Standard-Heizkörper-Höhe Mehrfamilienhaus)
 *   - electrical:   8×8 cm    (Standard-Schalter-Doppeldose)
 *
 * Pure module — no React, no Supabase imports. Importable from any layer.
 */

import type { CustomerPinType } from '../../types'

export interface CustomerPinTypeSpec {
  key: CustomerPinType
  /** German UI label (locked, no translations until i18n block in V1.7). */
  label: string
  /** Aria-label used by buttons / sheets so screen-readers stay on-spec. */
  ariaLabel: string
  /** Hex colour used for badge background, pin dot, list-row swatch. */
  color: string
  /** Companion glow colour for badge pulses (rgba with alpha). */
  colorGlow: string
  /** SVG path data — single `<path d="...">` strokes. */
  iconPath: string
  /** Default dimensions written into the pin metadata on first save.
   *  All values in metres. */
  defaultDims: {
    widthM: number
    heightM: number
    /** Depth/protrusion (optional) — heizung uses this for radiator depth. */
    depthM?: number
  }
}

const SPECS: Readonly<Record<CustomerPinType, CustomerPinTypeSpec>> = {
  door: {
    key: 'door',
    label: 'Tür',
    ariaLabel: 'Tür markieren',
    color: '#7c3aed',
    colorGlow: 'rgba(124,58,237,0.55)',
    iconPath: 'M6 3h12v18H6z M14 12h.5 M6 21h12',
    defaultDims: { widthM: 0.8, heightM: 2.1 },
  },
  window: {
    key: 'window',
    label: 'Fenster',
    ariaLabel: 'Fenster markieren',
    color: '#0891b2',
    colorGlow: 'rgba(8,145,178,0.55)',
    iconPath: 'M4 4h16v16H4z M4 12h16 M12 4v16',
    defaultDims: { widthM: 1.2, heightM: 1.4 },
  },
  heating: {
    key: 'heating',
    label: 'Heizung',
    ariaLabel: 'Heizung markieren',
    color: '#dc2626',
    colorGlow: 'rgba(220,38,38,0.55)',
    iconPath:
      'M4 6h16v12H4z M8 6v12 M12 6v12 M16 6v12 M3 8h1 M3 16h1 M20 8h1 M20 16h1',
    defaultDims: { widthM: 0.6, heightM: 0.6, depthM: 0.12 },
  },
  electrical: {
    key: 'electrical',
    label: 'Elektro',
    ariaLabel: 'Elektro markieren',
    color: '#f59e0b',
    colorGlow: 'rgba(245,158,11,0.55)',
    iconPath: 'M4 4h16v16H4z M9 9v3 M15 9v3 M9 16h6',
    defaultDims: { widthM: 0.08, heightM: 0.08 },
  },
}

/** Stable iteration order for UIs that list all four types (toolbar, picker). */
export const CUSTOMER_PIN_TYPES: ReadonlyArray<CustomerPinType> = [
  'door',
  'window',
  'heating',
  'electrical',
]

export function getCustomerPinTypeSpec(
  type: CustomerPinType,
): CustomerPinTypeSpec {
  return SPECS[type]
}

export function getCustomerPinTypeColor(type: CustomerPinType): string {
  return SPECS[type].color
}

export function getCustomerPinTypeLabel(type: CustomerPinType): string {
  return SPECS[type].label
}

/** Type-guard for string → CustomerPinType narrowing. Use when reading
 *  back from localStorage or query params before persistence. */
export function isCustomerPinType(value: unknown): value is CustomerPinType {
  return (
    typeof value === 'string' &&
    (value === 'door' ||
      value === 'window' ||
      value === 'heating' ||
      value === 'electrical')
  )
}
