/**
 * setWallMaterial — customer wall-finish mutator (V1.6.1).
 *
 * A finish pick writes `Wall.material_id` immutably, preserves every other wall
 * (and the rest of the scene), and `null` resets to the room default. The slug
 * rides the persistence blob generically — these tests lock the pure mutation.
 */
import { describe, expect, it } from 'vitest'

import { setWallMaterial } from '../../../../../src/lib/spatial/canonical/mutations/customerObjectMutator.ts'
import { makeRoom } from '../__helpers__/sceneFactory.ts'

describe('setWallMaterial', () => {
  it('sets the finish slug on the target wall only', () => {
    const scene = makeRoom()
    const next = setWallMaterial(scene, { wallId: 'w_s', materialId: 'wall-tile-grey' })
    expect(next.walls.find((w) => w.id === 'w_s')?.material_id).toBe('wall-tile-grey')
    // other walls keep their default finish untouched
    expect(next.walls.find((w) => w.id === 'w_e')?.material_id).toBe('plaster_white')
  })

  it('does not mutate the input scene (immutable)', () => {
    const scene = makeRoom()
    setWallMaterial(scene, { wallId: 'w_s', materialId: 'wall-marble' })
    expect(scene.walls.find((w) => w.id === 'w_s')?.material_id).toBe('plaster_white')
  })

  it('resets to the room default when materialId is null', () => {
    const scene = makeRoom()
    const next = setWallMaterial(scene, { wallId: 'w_s', materialId: null })
    expect(next.walls.find((w) => w.id === 'w_s')?.material_id).toBeUndefined()
  })

  it('preserves the wall reference when the value is unchanged (idempotent)', () => {
    const scene = setWallMaterial(makeRoom(), { wallId: 'w_s', materialId: 'wall-oak' })
    const again = setWallMaterial(scene, { wallId: 'w_s', materialId: 'wall-oak' })
    // the guard returns the same wall object → no needless re-render churn
    expect(again.walls.find((w) => w.id === 'w_s')).toBe(
      scene.walls.find((w) => w.id === 'w_s'),
    )
  })

  it('returns the scene unchanged for an unknown wall id', () => {
    const scene = makeRoom()
    expect(setWallMaterial(scene, { wallId: 'ghost', materialId: 'wall-marble' })).toBe(scene)
  })
})
