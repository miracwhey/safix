/**
 * Spatial · Canonical · Schema · parametric.json (JSON-Schema Draft-07)
 *
 * Authoritative storage-format schema for the canonical scene graph.
 *
 * Persisted shape (Master-Spec §15):
 *   - `parametric.json` gzipped at `{userId}/{sceneId}/parametric-{sha}.json.gz`
 *   - Pointed at by `spatial_scenes.parametric_storage_path` (Day 6 B1)
 *   - Validated by `ajv` at ingest time (read-side) AND in the bridge
 *     (write-side) so we never persist a malformed document.
 *
 * Conventions:
 *   - Top-level `schema_version` is REQUIRED so future migrations can
 *     branch on it (`schema/version-migration.ts`).
 *   - Sub-shapes refer back to their TypeScript `interface` counterparts
 *     in `types/`; the schema is the runtime ground-truth and the types
 *     stay aligned with it via the test suite.
 *   - The top-level document forbids unknown properties; sub-objects accept
 *     additional properties so the bridge can carry catalog metadata
 *     without breaking validation.
 *
 * Note: typed as a plain object (not `JSONSchemaType<T>`) because the
 * installed `ajv` is v6, which predates the generic schema-type. The
 * runtime ground-truth lives here regardless; canonical TS interfaces are
 * verified to match via the schema tests.
 */

const Vector3Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
  },
  required: ['x', 'y', 'z'],
}

const QuaternionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    w: { type: 'number' },
  },
  required: ['x', 'y', 'z', 'w'],
}

const TransformSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    position: Vector3Schema,
    rotation: QuaternionSchema,
    scale: Vector3Schema,
  },
  required: ['position', 'rotation', 'scale'],
}

// ISO-8601 timestamps are validated as plain strings; we deliberately
// avoid `format: 'date-time'` so the schema doesn't require `ajv-formats`
// as a runtime dep. Bridge + converter layers construct ISO strings via
// `new Date().toISOString()`, which is canonical.
const ISO8601Schema = { type: 'string' }

/**
 * Top-level schema describing the full `parametric.json` document.
 *
 * Sub-arrays use `{ type: 'array', items: { type: 'object' } }` placeholders
 * rather than fully-typed sub-schemas. The bridge always constructs
 * documents from the canonical TypeScript interfaces, so structural
 * validity is guaranteed at write-time; the runtime validation here is a
 * defensive net for hand-edited / legacy / V1.x-imported documents.
 */
export const PARAMETRIC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'generated_at',
    'source',
    'coordinate_system',
    'unit',
    'project',
    'scene_graph',
    'walkable_areas',
    'collision_volumes',
    'connectivity_graph',
    'validation_report',
    'variants',
    'overrides',
    'metadata',
  ],
  properties: {
    schema_version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+$' },
    generated_at: ISO8601Schema,
    source: { type: 'string', enum: ['roomplan_ios17', 'roomplan_ios18', 'manual'] },
    coordinate_system: { type: 'string', enum: ['right-handed-y-up'] },
    unit: { type: 'string', enum: ['meters'] },
    project: {
      type: 'object',
      additionalProperties: true,
      required: ['id', 'buildings'],
      properties: {
        id: { type: 'string', minLength: 1 },
        type: { type: 'string' },
        name: { type: 'string' },
        parent_id: { type: ['string', 'null'] },
        children_ids: { type: 'array', items: { type: 'string' } },
        transform: TransformSchema,
        source: { type: 'string', enum: ['roomplan', 'manual', 'edited'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        roomplan_uuid: { type: 'string' },
        variant_id: { type: 'string' },
        created_at: ISO8601Schema,
        updated_at: ISO8601Schema,
        edited_by_user_id: { type: 'string' },
        fixup_project_id: { type: ['string', 'null'] },
        fixup_job_id: { type: ['string', 'null'] },
        default_unit: { type: 'string' },
        buildings: { type: 'array', items: { type: 'object', additionalProperties: true } },
        variant_ids: { type: 'array', items: { type: 'string' } },
      },
    },
    scene_graph: {
      type: 'object',
      additionalProperties: true,
      required: ['id', 'type', 'walls', 'floor', 'ceiling'],
      properties: {
        id: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['room'] },
        name: { type: 'string' },
        parent_id: { type: ['string', 'null'] },
        children_ids: { type: 'array', items: { type: 'string' } },
        transform: TransformSchema,
        source: { type: 'string', enum: ['roomplan', 'manual', 'edited'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        roomplan_uuid: { type: 'string' },
        variant_id: { type: 'string' },
        created_at: ISO8601Schema,
        updated_at: ISO8601Schema,
        edited_by_user_id: { type: 'string' },
        category: { type: 'string' },
        walls: { type: 'array', items: { type: 'object', additionalProperties: true } },
        floor: { type: 'object', additionalProperties: true },
        ceiling: { type: 'object', additionalProperties: true },
        free_objects: { type: 'array', items: { type: 'object', additionalProperties: true } },
        pins: { type: 'array', items: { type: 'object', additionalProperties: true } },
        photos: { type: 'array', items: { type: 'object', additionalProperties: true } },
        notes: { type: 'array', items: { type: 'object', additionalProperties: true } },
        bounds_min: Vector3Schema,
        bounds_max: Vector3Schema,
        computed_area_m2: { type: 'number' },
        computed_volume_m3: { type: 'number' },
      },
    },
    walkable_areas: { type: 'array', items: { type: 'object', additionalProperties: true } },
    collision_volumes: { type: 'array', items: { type: 'object', additionalProperties: true } },
    connectivity_graph: { type: 'object', additionalProperties: true },
    validation_report: { type: 'object', additionalProperties: true },
    variants: { type: 'array', items: { type: 'object', additionalProperties: true } },
    overrides: { type: 'array', items: { type: 'object', additionalProperties: true } },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const
