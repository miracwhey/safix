/**
 * Tests for the Material-Picker switch-logic (writeMaterialOverride) — the
 * variant-write + undo extracted from useMaterialResolution so it is testable
 * without a React renderer.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { writeMaterialOverride } from '../../../../src/lib/spatial/hooks/useMaterialResolution.ts'
import { useCanonicalSceneStore } from '../../../../src/lib/spatial/canonical/store/sceneStore.ts'

const VARIANT = 'customer_corrections'

beforeEach(() => {
  const store = useCanonicalSceneStore.getState()
  store.setScene(null)
  store.setOverrides([])
  store.setVariants([])
})

describe('writeMaterialOverride', () => {
  it('writes a material_id override onto the surface node', () => {
    writeMaterialOverride('wall-2', 'wall-tile-white', VARIANT)
    const overrides = useCanonicalSceneStore.getState().overrides
    expect(overrides).toHaveLength(1)
    expect(overrides[0]).toMatchObject({
      base_node_id: 'wall-2',
      variant_id: VARIANT,
      override_fields: { material_id: 'wall-tile-white' },
    })
  })

  it('reports no previous material on a first write', () => {
    const handle = writeMaterialOverride('wall-2', 'wall-tile-white', VARIANT)
    expect(handle.previousMaterialSlug).toBeNull()
  })

  it('undo removes an override that did not exist before', () => {
    const handle = writeMaterialOverride('wall-2', 'wall-tile-white', VARIANT)
    handle.undo()
    expect(useCanonicalSceneStore.getState().overrides).toHaveLength(0)
  })

  it('undo restores the prior material when one was applied before', () => {
    writeMaterialOverride('wall-2', 'wall-tile-white', VARIANT)
    const second = writeMaterialOverride('wall-2', 'wall-marble', VARIANT)
    expect(second.previousMaterialSlug).toBe('wall-tile-white')

    second.undo()
    const overrides = useCanonicalSceneStore.getState().overrides
    expect(overrides).toHaveLength(1)
    expect(overrides[0].override_fields.material_id).toBe('wall-tile-white')
  })

  it('preserves unrelated override fields on the same node', () => {
    useCanonicalSceneStore.getState().upsertOverride({
      base_node_id: 'wall-2',
      variant_id: VARIANT,
      override_fields: { renovation_intent: 'replace' },
    })
    writeMaterialOverride('wall-2', 'wall-oak', VARIANT)
    const fields = useCanonicalSceneStore.getState().overrides[0].override_fields
    expect(fields.renovation_intent).toBe('replace')
    expect(fields.material_id).toBe('wall-oak')
  })

  it('keeps overrides on different surfaces independent', () => {
    writeMaterialOverride('wall-1', 'wall-paint-white', VARIANT)
    writeMaterialOverride('floor-1', 'floor-oak', VARIANT)
    expect(useCanonicalSceneStore.getState().overrides).toHaveLength(2)
  })
})
