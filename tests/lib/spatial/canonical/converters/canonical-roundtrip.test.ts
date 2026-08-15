/**
 * Tests for src/lib/spatial/canonical/converters/canonical-roundtrip.ts
 */
import { describe, it, expect } from 'vitest'

import { deserialize, serialize } from '../../../../../src/lib/spatial/canonical/converters/canonical-roundtrip.ts'
import { runValidator } from '../../../../../src/lib/spatial/canonical/validator/run-validator.ts'
import { CURRENT_SCHEMA_VERSION } from '../../../../../src/lib/spatial/canonical/schema/version-migration.ts'
import { makeRoom } from '../__helpers__/sceneFactory.ts'

describe('canonical-roundtrip · serialize + deserialize', () => {
  it('stamps the current schema version on serialise', () => {
    const scene = makeRoom()
    const report = runValidator(scene)
    const json = serialize({ scene, validation_report: report, source: 'roomplan_ios18' })
    expect(json.schema_version).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('round-trips a scene through serialize + deserialize without loss', () => {
    const scene = makeRoom()
    const report = runValidator(scene)
    const json = serialize({ scene, validation_report: report, source: 'roomplan_ios18' })
    const restored = deserialize(json)
    expect(restored.scene.id).toBe(scene.id)
    expect(restored.scene.walls.length).toBe(scene.walls.length)
    expect(restored.validation_report.scene_id).toBe(scene.id)
  })

  it('preserves variants + overrides through round-trip', () => {
    const scene = makeRoom()
    const report = runValidator(scene)
    const json = serialize({
      scene,
      validation_report: report,
      source: 'roomplan_ios18',
      variants: [
        { id: 'base_roomplan', display_name: 'Scan', is_default: true },
        { id: 'customer_corrections', display_name: 'Customer', is_default: false, parent_variant_id: 'base_roomplan' },
      ],
      overrides: [
        { base_node_id: 'w_s', variant_id: 'customer_corrections', override_fields: { material_id: 'tile_anthrazit' } },
      ],
    })
    const restored = deserialize(json)
    expect(restored.variants).toHaveLength(2)
    expect(restored.overrides).toHaveLength(1)
    expect(restored.overrides[0].variant_id).toBe('customer_corrections')
  })
})
