/**
 * Spatial · CAD Lane V1.5.1 · Customer Self-Scan presets
 *
 * Ready-made `RoomScene` templates for the Customer-Self-Scan flow
 * (Mockup 05 `05-new-room-sheet.html`). The Customer picks one preset to
 * skip the dimension-research step; the editor exposes per-axis steppers
 * for fine-tuning before the scene lands.
 *
 * Defaults mirror typical German interior dimensions and round to the
 * nearest 10 cm so the ±10 cm width/length stepper + ±5 cm height stepper
 * (see Mockup 05) keep producing tidy values:
 *
 *   - **Bad** (`bathroom`)        — 2.20 × 3.20 × 2.60 m → ~7 m²
 *   - **Küche** (`kitchen`)       — 3.40 × 3.80 × 2.60 m → ~13 m²
 *   - **Wohnzimmer** (`living`)   — 3.80 × 4.50 × 2.60 m → ~17 m²
 *   - **Schlafzimmer** (`bedroom`)— 3.10 × 3.20 × 2.60 m → ~10 m²
 *   - **Leerer Raum** (`custom`)  — 2.50 × 2.50 × 2.50 m → ~6 m² (Phase 3)
 *
 * Each preset is just default geometry — no pre-placed pins. The Customer
 * adds doors, windows, heating, and electrical pins in the hub after the
 * scene exists. The "Leerer Raum"-tile (Phase 3) starts from a neutral
 * 2.5 × 2.5 × 2.5 m closed rectangle and demands a stepper adjustment
 * before the Save-button releases — see {@link isCustomCanvasDirty}.
 */

import { buildEmptyRoom2x2Preset } from './presetEmptyRoom'
import type { RoomCategory, RoomScene } from '../types/scene-graph'

export interface CustomerRoomPresetDef {
  /** Display label used in the picker card + as the default scene name. */
  label: string
  /** RoomScene.category — drives lighting preset + validator clearance thresholds. */
  category: RoomCategory
  /** Default footprint width (X), in metres. */
  defaultWidthM: number
  /** Default footprint length (Z), in metres. */
  defaultLengthM: number
  /** Default ceiling height (Y), in metres. */
  defaultHeightM: number
  /** Rounded preview area for the picker badge (m²). */
  approxAreaM2: number
}

export const CUSTOMER_ROOM_PRESETS = {
  bath: {
    label: 'Bad',
    category: 'bathroom',
    defaultWidthM: 2.2,
    defaultLengthM: 3.2,
    defaultHeightM: 2.6,
    approxAreaM2: 7,
  },
  kitchen: {
    label: 'Küche',
    category: 'kitchen',
    defaultWidthM: 3.4,
    defaultLengthM: 3.8,
    defaultHeightM: 2.6,
    approxAreaM2: 13,
  },
  living: {
    label: 'Wohnzimmer',
    category: 'living',
    defaultWidthM: 3.8,
    defaultLengthM: 4.5,
    defaultHeightM: 2.6,
    approxAreaM2: 17,
  },
  bedroom: {
    label: 'Schlafzimmer',
    category: 'bedroom',
    defaultWidthM: 3.1,
    defaultLengthM: 3.2,
    defaultHeightM: 2.6,
    approxAreaM2: 10,
  },
  custom: {
    label: 'Leerer Raum',
    category: 'other',
    defaultWidthM: 2.5,
    defaultLengthM: 2.5,
    defaultHeightM: 2.5,
    approxAreaM2: 6,
  },
} satisfies Record<string, CustomerRoomPresetDef>

export type CustomerRoomPresetKind = keyof typeof CUSTOMER_ROOM_PRESETS

/**
 * Preset-kinds rendered as the 2×2 picker grid in `CustomerNewRoomSheet`.
 * `custom` is intentionally NOT in this list — the "Leerer Raum"-tile lives
 * outside the preset grid and routes to {@link CustomerCustomCanvasSheet}.
 */
export const CUSTOMER_ROOM_PRESET_KINDS: readonly CustomerRoomPresetKind[] = [
  'bath',
  'kitchen',
  'living',
  'bedroom',
] as const

/** Stable key for the Custom-Canvas path (Phase 3 · B4-D3). */
export const CUSTOM_CANVAS_PRESET_KIND = 'custom' as const satisfies CustomerRoomPresetKind

/**
 * Default starting dimensions for the Custom-Canvas sheet (Mockup 11 + TBD #2).
 * The Save-button stays disabled until at least one axis differs from these
 * values — see {@link isCustomCanvasDirty}. Numbers are in centimetres so the
 * sheet's stepper logic doesn't need a metre↔cm conversion at the render layer.
 */
export const CUSTOM_CANVAS_DEFAULT_DIMS = {
  widthCm: 250,
  lengthCm: 250,
  heightCm: 250,
} as const

/**
 * `true` if at least one of the three axes has been adjusted from the
 * 250 cm starting value. The Custom-Canvas sheet uses this as its
 * dirty-guard before enabling Save (P3-TBD #2 binding).
 */
export function isCustomCanvasDirty(
  widthCm: number,
  lengthCm: number,
  heightCm: number,
): boolean {
  return (
    widthCm !== CUSTOM_CANVAS_DEFAULT_DIMS.widthCm ||
    lengthCm !== CUSTOM_CANVAS_DEFAULT_DIMS.lengthCm ||
    heightCm !== CUSTOM_CANVAS_DEFAULT_DIMS.heightCm
  )
}

export interface BuildCustomerRoomFromPresetInput {
  /** Server-assigned scene id — used as the room's node id so referers stay stable. */
  sceneId: string
  /** Which preset to start from. */
  presetKind: CustomerRoomPresetKind
  /**
   * Optional per-axis overrides (metres). Any axis the editor's stepper has
   * touched flows in here; unspecified axes fall back to the preset default.
   */
  overrideDims?: {
    widthM?: number
    lengthM?: number
    heightM?: number
  }
  /** ISO-8601 timestamp stamped onto every node. Defaults to `new Date().toISOString()`. */
  createdAt?: string
}

/**
 * Build a Customer-Self-Scan `RoomScene` from one of the four named presets.
 *
 * Delegates to {@link buildEmptyRoom2x2Preset} for the closed-rectangle
 * geometry and then patches `category` so the room reads as a bathroom /
 * kitchen / etc. instead of `other`. The category drives lighting + camera
 * defaults downstream; without it every preset would render with the
 * generic "other" preset and the Customer would see the wrong scene tone.
 */
export function buildCustomerRoomFromPreset(
  input: BuildCustomerRoomFromPresetInput,
): RoomScene {
  const preset = CUSTOMER_ROOM_PRESETS[input.presetKind]
  const widthM = input.overrideDims?.widthM ?? preset.defaultWidthM
  const lengthM = input.overrideDims?.lengthM ?? preset.defaultLengthM
  const heightM = input.overrideDims?.heightM ?? preset.defaultHeightM

  const base = buildEmptyRoom2x2Preset({
    roomNodeId: input.sceneId,
    footprintMeters: { widthM, depthM: lengthM },
    ceilingHeightM: heightM,
    createdAt: input.createdAt,
  })

  return {
    ...base,
    category: preset.category,
  }
}
