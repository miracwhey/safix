/**
 * Spatial · Canonical · Annotations
 *
 * Pins, photos, and notes anchored into the scene. Master-Spec §1.10, §1.12, §13.
 *
 * The defining feature is 3D-native anchoring: every annotation lives on a
 * surface (wall / floor / ceiling / object) via a UV coordinate in [0,1]²,
 * NOT as a UI-overlay with screen coordinates. This makes annotations survive
 * re-scans, camera-mode switches, and variant overrides without drifting.
 *
 * The Block-A `scan_annotations` table already implements an equivalent
 * "D2 hybrid anchor" (see `src/lib/spatial/types.ts:103-133`). The bridge
 * (Day 8 B13 · `scanToParametric.ts`) maps Block-A's `AnchorUv` →
 * canonical `CanonicalSurfaceAnchorUv` (Pin/Photo/Note `anchor_uv` field).
 *
 * Name-collision-note (CRIT-1 audit-fix): Block-A exports `AnchorUv`
 * `{surfaceExternalId, uv: [n,n]}` from `src/lib/spatial/types.ts`. To keep
 * both surfaces co-exportable from `lib/spatial`, the canonical interface is
 * named `CanonicalSurfaceAnchorUv` and never aliased to plain `AnchorUv`.
 */

import type { ISO8601, Node } from './scene-graph.ts'

/**
 * Pin category. Mirrors the user-visible filter chips and drives:
 *   - icon selection in the renderer,
 *   - severity defaults,
 *   - BoM relevance (only `material` and `task` pins feed quotes/BoM).
 *
 * The four customer-authored kinds (`damage` / `wish` / `note` / `photo`) are
 * the set the Verify-Flow Stage-4 Pin-Picker offers (Implementation-Spec
 * §Stage-4). `wish` ("hier soll etwas Neues hin") is customer-only — it is the
 * V1 stand-in for the deferred Material-Vorschau (VF-3 · "neue Fliesen hier").
 * The remaining kinds (`measurement` / `material` / `task`) are produced by the
 * scan-bridge / provider-annotation paths.
 */
export type PinType =
  | 'damage'
  | 'wish'
  | 'note'
  | 'measurement'
  | 'material'
  | 'task'
  | 'photo'

/** Severity for damage / task pins. */
export type PinSeverity = 'low' | 'medium' | 'high'

/**
 * Categorical tag for the surface a pin / photo / note is anchored to.
 *
 * Drives the UV resolver in `PinAdapter` (Day 11 C9):
 *   - 'wall' / 'floor' / 'ceiling' : look up `anchor_surface_id` in the room's
 *     geometry children and project U/V onto the surface plane.
 *   - 'object' : look up `anchor_surface_id` in the room's object list and use
 *     the asset's UV map.
 *
 * Risk R15 mitigation: when the resolver detects a wall with
 * `polygon_override`, it falls back to nearest-vertex world-XYZ projection.
 */
export type AnchorSurfaceType = 'wall' | 'floor' | 'ceiling' | 'object'

/**
 * UV anchor in [0, 1]² of the surface it is bound to.
 *
 * Conventions per Master-Spec §13.2:
 *   - Wall   : U along (start → end), V from bottom → top.
 *   - Floor  : U along room-bounds X, V along room-bounds Z.
 *   - Ceiling: same as Floor (V along Z).
 *   - Object : asset-specific UV map.
 */
export interface CanonicalSurfaceAnchorUv {
  u: number
  v: number
}

/**
 * A 3D-native marker pinned to a surface in the scene.
 *
 * Renderers display pins as billboards or 3D meshes attached to the resolved
 * world position; they are NOT 2D HUD elements. This is critical for the
 * walk-mode + AR-compare modes that did not have stable HUD coordinates.
 */
export interface Pin extends Node {
  type: 'pin'

  /** Categorical pin kind (drives icon + filter + BoM relevance). */
  pin_type: PinType

  /** ID of the wall / floor / ceiling / object the pin is anchored to. */
  anchor_surface_id: string
  /** Category of the anchored surface (resolver discriminator). */
  anchor_surface_type: AnchorSurfaceType
  /** UV coordinate in [0,1]² · canonical anchor truth. */
  anchor_uv: CanonicalSurfaceAnchorUv
  /** Small offset along the surface normal (default 0.01 m · prevents z-fighting). */
  anchor_offset_normal_m: number

  /** Optional title for the pin tooltip. */
  title?: string
  /** Severity for damage / task pins (drives badge colour). */
  severity?: PinSeverity

  // ── Cross-domain links (Phase 5 wires the rest of the system) ───────────
  linked_photo_ids: string[]
  linked_note_ids: string[]
  linked_task_ids: string[]
  linked_material_id?: string
}

/**
 * A captured photo, optionally anchored to a surface.
 *
 * When `anchor_surface_id` is `undefined`, the photo is "free-floating" and is
 * rendered as a thumbnail icon at the photo's capture position (extracted from
 * EXIF if available). Anchored photos drive the dispute-evidence + chat-pin
 * features in Phase 5.
 */
export interface Photo extends Node {
  type: 'photo'
  /** Public or signed URL to the full-resolution image. */
  url: string
  /** Public or signed URL to the thumbnail variant. */
  thumb_url: string
  /** Capture timestamp · ISO-8601. */
  captured_at: ISO8601
  /** Optional EXIF metadata (lens, ISO, exposure). */
  exif?: ExifData

  // ── Optional anchor (when `anchor_surface_id` is set, all anchor fields are set) ──
  anchor_surface_id?: string
  anchor_surface_type?: AnchorSurfaceType
  anchor_uv?: CanonicalSurfaceAnchorUv
}

/**
 * Minimal EXIF subset captured for photo annotations. Extended via index
 * signature to allow forward-compatibility without breaking JSON-Schema
 * validation.
 */
export interface ExifData {
  camera_model?: string
  lens?: string
  iso?: number
  exposure_time?: number
  aperture?: number
  focal_length_mm?: number
  taken_at?: ISO8601
  [k: string]: unknown
}

/**
 * Free-text note, optionally anchored to a surface. Renderers may show notes
 * inline as floating callouts or aggregate them into a side-panel.
 */
export interface Note extends Node {
  type: 'note'
  body: string

  // ── Optional anchor ───────────────────────────────────────────────────
  anchor_surface_id?: string
  anchor_surface_type?: AnchorSurfaceType
  anchor_uv?: CanonicalSurfaceAnchorUv
}
