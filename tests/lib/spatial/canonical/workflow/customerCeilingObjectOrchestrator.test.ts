/**
 * V1.6.1 Ceiling Re-Edit — customerCeilingObjectOrchestrator.
 *
 * Locks the move/delete contract for ceiling-mounted objects: an absolute-XZ
 * move that leaves Y untouched (renderer derives `ceilingY − h/2`) and clamps
 * the footprint into the ceiling polygon (clamp-to-fit, same policy as the
 * floor layer), plus the delete path.
 */
import { describe, expect, it } from 'vitest'

import {
  deleteCeilingObject,
  moveCeilingObject,
} from '../../../../../src/lib/spatial/canonical/workflow/customerCeilingObjectOrchestrator.ts'
import { makeObject, makeRoom } from '../__helpers__/sceneFactory.ts'
import type { RoomScene } from '../../../../../src/lib/spatial/canonical/types/scene-graph.ts'

/** A 4×3 room with one ceiling lamp at (2, ·, 1.5). */
function roomWithLamp(id = 'lamp'): RoomScene {
  const room = makeRoom()
  const lamp = makeObject({
    id,
    category: 'lamp',
    host: 'ceiling',
    host_id: room.ceiling.id,
    dimensions: { width_m: 0.4, depth_m: 0.4, height_m: 0.3 },
    transform: {
      position: { x: 2, y: 0, z: 1.5 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
  })
  return { ...room, ceiling: { ...room.ceiling, ceiling_mounted: [lamp] } }
}

describe('moveCeilingObject', () => {
  it('repositions an in-room XZ target and leaves Y untouched', () => {
    const result = moveCeilingObject({ scene: roomWithLamp(), objectId: 'lamp', x: 1, z: 1 })
    expect(result.kind).toBe('updated')
    if (result.kind !== 'updated') return
    const moved = result.scene.ceiling.ceiling_mounted.find((o) => o.id === 'lamp')
    expect(moved?.transform.position.x).toBeCloseTo(1)
    expect(moved?.transform.position.z).toBeCloseTo(1)
    // Y stays 0 — the renderer derives the world-Y from ceilingY − h/2.
    expect(moved?.transform.position.y).toBe(0)
  })

  it('clamps an out-of-room tap flush into the ceiling polygon instead of rejecting', () => {
    const result = moveCeilingObject({ scene: roomWithLamp(), objectId: 'lamp', x: 10, z: 10 })
    expect(result.kind).toBe('updated')
    if (result.kind !== 'updated') return
    const moved = result.scene.ceiling.ceiling_mounted.find((o) => o.id === 'lamp')
    // lamp 0.4×0.4 → half 0.2 → centre clamped to (3.8, 2.8) in the 4×3 room.
    expect(moved?.transform.position.x).toBeCloseTo(3.8)
    expect(moved?.transform.position.z).toBeCloseTo(2.8)
  })

  it('returns missing when the object is gone (idempotent no-op for the caller)', () => {
    const result = moveCeilingObject({ scene: roomWithLamp(), objectId: 'nope', x: 1, z: 1 })
    expect(result.kind).toBe('missing')
  })

  it('rejects an object genuinely larger than the room', () => {
    const room = makeRoom()
    const huge = makeObject({
      id: 'huge',
      category: 'lamp',
      host: 'ceiling',
      host_id: room.ceiling.id,
      dimensions: { width_m: 8, depth_m: 8, height_m: 0.3 },
      transform: {
        position: { x: 2, y: 0, z: 1.5 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    })
    const scene: RoomScene = { ...room, ceiling: { ...room.ceiling, ceiling_mounted: [huge] } }
    const result = moveCeilingObject({ scene, objectId: 'huge', x: 0, z: 0 })
    expect(result.kind).toBe('rejected')
  })

  it('does not mutate the input scene (immutable)', () => {
    const scene = roomWithLamp()
    const before = scene.ceiling.ceiling_mounted[0].transform.position.x
    moveCeilingObject({ scene, objectId: 'lamp', x: 1, z: 1 })
    expect(scene.ceiling.ceiling_mounted[0].transform.position.x).toBe(before)
  })
})

describe('deleteCeilingObject', () => {
  it('removes the ceiling object', () => {
    const next = deleteCeilingObject({ scene: roomWithLamp(), objectId: 'lamp' })
    expect(next.ceiling.ceiling_mounted).toHaveLength(0)
  })

  it('is a no-op for an unknown id', () => {
    const scene = roomWithLamp()
    const next = deleteCeilingObject({ scene, objectId: 'nope' })
    expect(next.ceiling.ceiling_mounted).toHaveLength(1)
  })
})
