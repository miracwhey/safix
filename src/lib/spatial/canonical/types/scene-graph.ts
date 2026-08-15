/**
 * Spatial · Canonical · Scene-Graph
 *
 * Hierarchical scene-graph definitions per Master-Spec §1.
 *
 *   Project
 *   └── Building
 *       └── RoomScene  (V1: 1 per Building · V1.x: N per Building)
 *           ├── walls[]
 *           ├── floor
 *           ├── ceiling
 *           ├── free_objects[]
 *           ├── pins[]
 *           ├── photos[]
 *           ├── notes[]
 *           └── variants[]
 *
 * Each node has exactly ONE parent (tree, not graph). Cross-references such as
 * "door connects rooms A and B" are modelled as separate edges on the
 * connectivity-graph, not as additional parents (§3.5).
 */

import type { Transform } from './primitives.ts'

/**
 * ISO-8601 timestamp string (e.g. "2026-05-20T14:32:11.123Z").
 *
 * Canonical scene-graph timestamps use ISO-8601 strings because they survive
 * gzipped-JSON round-trips unambiguously and remain human-readable in storage.
 * Block-A's `scans`/`scan_events` tables use unix-ms internally; the bridge
 * (`scanToParametric`, Day 8 B13) converts at the boundary.
 */
export type ISO8601 = string

/**
 * Discriminator tag for every node in the canonical scene-graph.
 *
 * Mirrors DB CHECK constraint that will be added in Phase 0b
 * (`supabase/migrations/20260527000001_spatial_canonical_scenes.sql`).
 */
export type NodeType =
  | 'project'
  | 'building'
  | 'room'
  | 'wall'
  | 'floor'
  | 'ceiling'
  | 'door'
  | 'window'
  | 'opening'
  | 'object'
  | 'pin'
  | 'photo'
  | 'note'

/**
 * Provenance of a node's data.
 *
 *   - 'roomplan'    : produced by Apple RoomPlan capture (immutable in base layer)
 *   - 'manual'      : authored by a user in the editor (Phase 2)
 *   - 'edited'      : derived from a roomplan-source node via override / correction
 *
 * Stored alongside `confidence` to drive UI badges and validator severity.
 */
export type NodeSource = 'roomplan' | 'manual' | 'edited'

/**
 * Variant identifier — see `./variants.ts` for the full lifecycle. The
 * canonical "no override" / "scan-truth" layer is always `'base_roomplan'`.
 */
export type VariantId = string

/**
 * Base interface implemented by every node in the scene-graph.
 *
 * Per Master-Spec §1.2. Children are stored on the concrete node types (Wall,
 * Floor, ...) rather than on Node itself so each node can typed-narrow its
 * allowed children — e.g. a Wall holds `openings` and `wall_mounted`, not
 * arbitrary `Node[]`.
 */
export interface Node {
  /** UUID. Stable across re-scans (matched by RoomPlan element-uuid where possible). */
  id: string
  /** Optional human-readable label, e.g. "Wall_01", "Door_Eingang". */
  name?: string
  /** Discriminator tag — used by adapters/validator to match concrete subtypes. */
  type: NodeType

  /** Parent-id in the scene-graph; `null` only for the top-level Project. */
  parent_id: string | null
  /** Children-ids (computed cache · not authoritative · do not edit directly). */
  children_ids: string[]

  /** Local transform (position parent-relative · Master-Spec §2.3). */
  transform: Transform

  /** Where the data came from (audit + UI-badge driver). */
  source: NodeSource
  /** 0..1 confidence from RoomPlan classification (low=0.3, med=0.6, high=0.9). */
  confidence: number
  /** Original RoomPlan element-UUID when `source === 'roomplan'`; preserved for re-scan diffing. */
  roomplan_uuid?: string

  /** Which variant layer this node belongs to (see `./variants.ts`). */
  variant_id: VariantId

  created_at: ISO8601
  updated_at: ISO8601
  /** auth.users.id of the last editor — null when system-generated. */
  edited_by_user_id?: string
}

/**
 * Top-level container linking the canonical scene-graph to a SaFix project.
 *
 * Note (binding): unlike Master-Spec §16.1, the SQL `spatial_scenes` table
 * does NOT store `fixup_project_id` directly (Risk R4). Project association
 * is resolved via `source_scan_id → scans.project_id` because Block-A scans
 * may be linked to a job OR a project, not always both.
 */
export interface Project extends Node {
  type: 'project'
  /** SaFix `projects.id` (TEXT FK · nullable for job-only-scans). */
  fixup_project_id: string | null
  /** SaFix `jobs.id` (TEXT FK · nullable for project-only-scans). */
  fixup_job_id: string | null
  buildings: Building[]
  /** Always `'meters'` in V1 (see `./primitives.ts#Unit`). */
  default_unit: 'meters'
  /** Always `'right-handed-y-up'` in V1 (see `./primitives.ts#CoordinateSystem`). */
  coordinate_system: 'right-handed-y-up'
  /** Variants available within this project — see `./variants.ts`. */
  variant_ids: VariantId[]
}

/**
 * Container for one or more RoomScenes that physically belong together.
 *
 * V1 has exactly 1 Building per Project containing 1 RoomScene. V1.x lifts
 * the single-room restriction via RoomPlan's `CapturedStructure` API; the
 * type already carries the multi-room shape so callers stay stable.
 */
export interface Building extends Node {
  type: 'building'
  rooms: RoomScene[]
  /** Adjacency between rooms via doors / openings — see `./walkable.ts`. */
  connectivity_graph_ref: string // → RoomConnectivityGraph.id
}

/**
 * Functional category of a room. Drives default lighting preset, default
 * camera focus point, validator clearance thresholds, and asset-picker
 * filtering.
 */
export type RoomCategory =
  | 'bathroom'
  | 'kitchen'
  | 'living'
  | 'bedroom'
  | 'hallway'
  | 'office'
  | 'storage'
  | 'other'

/**
 * A single room — the unit of capture in V1.
 *
 * Forward-declares its concrete child types so importers can pull
 * `RoomScene` without dragging the entire types/ surface; each child type is
 * defined in its own file (`./geometry.ts`, `./objects.ts`, ...) and merged
 * here via interface-import. This keeps file-level cohesion tight.
 */
export interface RoomScene extends Node {
  type: 'room'
  category: RoomCategory

  /** Bounding walls (≥3 in any legal room; validator enforces). */
  walls: Wall[]
  floor: Floor
  ceiling: Ceiling

  /** Free-standing or floor-mounted-but-not-wall-hosted objects. */
  free_objects: SpatialObject[]

  /** Pins anchored to wall/floor/ceiling/object surfaces — see `./annotations.ts`. */
  pins: Pin[]
  /** Photos optionally anchored to surfaces — see `./annotations.ts`. */
  photos: Photo[]
  /** Free-text notes optionally anchored — see `./annotations.ts`. */
  notes: Note[]

  /** Cached bounding box in world coordinates · computed from walls. */
  bounds_min: import('./primitives.ts').Vector3
  bounds_max: import('./primitives.ts').Vector3
  /** Cached floor-area in m² · derived from `floor.polygon`. */
  computed_area_m2: number
  /** Cached interior volume in m³ · derived from area × ceiling.height_m. */
  computed_volume_m3: number
}

// ── Forward type-imports (defined in sibling files) ──────────────────────────
// These re-imports let consumers do `import type { RoomScene } from
// '@/lib/spatial/canonical/types'` without separately importing each
// concrete child type. The full definitions live in their respective files
// (geometry.ts, objects.ts, annotations.ts) and are merged into the public
// barrel via `./index.ts`.

import type { Wall, Floor, Ceiling } from './geometry.ts'
import type { SpatialObject } from './objects.ts'
import type { Pin, Photo, Note } from './annotations.ts'

// Re-export so callers can use `RoomScene` and its members from a single
// import root.
export type { Wall, Floor, Ceiling } from './geometry.ts'
export type { SpatialObject, ObjectCategory, ObjectHost } from './objects.ts'
export type { Pin, Photo, Note } from './annotations.ts'
