/**
 * Spatial · Canonical · Converters · Canonical Roundtrip
 *
 * `serialize` packages a {@link RoomScene} (plus optional auxiliary state)
 * into a {@link ParametricJson} document ready for gzip + storage upload.
 * `deserialize` reverses the operation.
 *
 * The roundtrip is lossless for the structural fields the schema covers.
 * Phase-0a (this file) implements the structural roundtrip; Phase-0b's
 * bridge (`scanToParametric.ts`) attaches the Block-A capture metadata.
 */

import { CURRENT_SCHEMA_VERSION, migrateParametricJson } from '../schema/version-migration.ts'
import type { RoomScene } from '../types/scene-graph.ts'
import type {
  NodeOverride,
  Variant,
} from '../types/variants.ts'
import type { ValidationReport } from '../types/validation.ts'
import type {
  RoomConnectivityGraph,
  WalkableArea,
  CollisionVolume,
} from '../types/walkable.ts'

/**
 * Top-level `parametric.json` document shape. Anything persisted to
 * Supabase Storage must conform to this. Sub-fields are pulled in from
 * their canonical type modules so the same TS interfaces drive both the
 * in-memory model and the on-disk format.
 */
export interface ParametricJson {
  schema_version: string
  generated_at: string
  source: 'roomplan_ios17' | 'roomplan_ios18' | 'manual'
  coordinate_system: 'right-handed-y-up'
  unit: 'meters'
  project: {
    id: string
    type: 'project'
    fixup_project_id: string | null
    fixup_job_id: string | null
    buildings: Array<{
      id: string
      type: 'building'
      rooms: RoomScene[]
      connectivity_graph_ref: string
    }>
    default_unit: 'meters'
    coordinate_system: 'right-handed-y-up'
    variant_ids: string[]
    parent_id: string | null
    children_ids: string[]
    transform: RoomScene['transform']
    source: 'roomplan' | 'manual' | 'edited'
    confidence: number
    variant_id: string
    created_at: string
    updated_at: string
  }
  scene_graph: RoomScene
  walkable_areas: WalkableArea[]
  collision_volumes: CollisionVolume[]
  connectivity_graph: RoomConnectivityGraph
  validation_report: ValidationReport
  variants: Variant[]
  overrides: NodeOverride[]
  metadata: {
    roomplan_version?: string
    device_model?: string
    scan_duration_s?: number
    raw_capture_url?: string
    [k: string]: unknown
  }
}

export interface SerializeInput {
  scene: RoomScene
  walkable_areas?: WalkableArea[]
  collision_volumes?: CollisionVolume[]
  connectivity_graph?: RoomConnectivityGraph
  validation_report: ValidationReport
  variants?: Variant[]
  overrides?: NodeOverride[]
  source: ParametricJson['source']
  fixup_project_id?: string | null
  fixup_job_id?: string | null
  building_id?: string
  metadata?: ParametricJson['metadata']
}

/**
 * Build a complete {@link ParametricJson} document around a canonical
 * scene. Sets `schema_version` to {@link CURRENT_SCHEMA_VERSION} and
 * fills in sensible defaults for omitted fields.
 *
 * Pure-function: no Date.now / Math.random escape hatches except when the
 * caller did not provide a value (in which case we fall back to system
 * timestamps).
 */
export function serialize(input: SerializeInput): ParametricJson {
  const generated_at = new Date().toISOString()
  const buildingId = input.building_id ?? `building_${input.scene.id}`
  const variants = input.variants ?? [
    { id: 'base_roomplan', display_name: 'Scan', is_default: true },
  ]

  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    generated_at,
    source: input.source,
    coordinate_system: 'right-handed-y-up',
    unit: 'meters',
    project: {
      id: `project_${input.scene.id}`,
      type: 'project',
      fixup_project_id: input.fixup_project_id ?? null,
      fixup_job_id: input.fixup_job_id ?? null,
      buildings: [
        {
          id: buildingId,
          type: 'building',
          rooms: [input.scene],
          connectivity_graph_ref: `cg_${buildingId}`,
        },
      ],
      default_unit: 'meters',
      coordinate_system: 'right-handed-y-up',
      variant_ids: variants.map(v => v.id),
      parent_id: null,
      children_ids: [buildingId],
      transform: input.scene.transform,
      source: input.scene.source,
      confidence: 1,
      variant_id: 'base_roomplan',
      created_at: input.scene.created_at,
      updated_at: generated_at,
    },
    scene_graph: input.scene,
    walkable_areas: input.walkable_areas ?? [],
    collision_volumes: input.collision_volumes ?? [],
    connectivity_graph: input.connectivity_graph ?? {
      id: `cg_${buildingId}`,
      nodes: [{ id: `n_${input.scene.id}`, room_id: input.scene.id }],
      edges: [],
    },
    validation_report: input.validation_report,
    variants,
    overrides: input.overrides ?? [],
    metadata: input.metadata ?? {},
  }
}

/**
 * Reverse of {@link serialize}: pull the canonical scene + auxiliary state
 * back out of a stored document. Applies the version-migration pipeline
 * first so older documents are upgraded transparently.
 */
export function deserialize(raw: unknown): {
  scene: RoomScene
  walkable_areas: WalkableArea[]
  collision_volumes: CollisionVolume[]
  connectivity_graph: RoomConnectivityGraph
  validation_report: ValidationReport
  variants: Variant[]
  overrides: NodeOverride[]
  source: ParametricJson['source']
  metadata: ParametricJson['metadata']
} {
  const migrated = migrateParametricJson(raw) as unknown as ParametricJson
  return {
    scene: migrated.scene_graph,
    walkable_areas: migrated.walkable_areas,
    collision_volumes: migrated.collision_volumes,
    connectivity_graph: migrated.connectivity_graph,
    validation_report: migrated.validation_report,
    variants: migrated.variants,
    overrides: migrated.overrides,
    source: migrated.source,
    metadata: migrated.metadata,
  }
}
