/**
 * Tests for the B-4 walk-camera input derivation + the sceneStore camera slice.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { deriveWalkInputs } from '../../../../../src/components/spatial/three/canonical/cameras/walkInputs.ts'
import { useCanonicalSceneStore } from '../../../../../src/lib/spatial/canonical/store/sceneStore.ts'
import { makeObject, makeRoom } from '../../../../lib/spatial/canonical/__helpers__/sceneFactory.ts'

describe('cameras · deriveWalkInputs', () => {
  it('produces one oriented obstacle per wall', () => {
    const scene = makeRoom()
    const { obstacles } = deriveWalkInputs(scene)
    const wallObstacles = obstacles.filter((o) => scene.walls.some((w) => w.id === o.id))
    expect(wallObstacles).toHaveLength(scene.walls.length)
    for (const o of wallObstacles) {
      expect(typeof o.rotationY).toBe('number')
      expect(Number.isFinite(o.rotationY as number)).toBe(true)
    }
  })

  it('includes a walkable polygon with an outer ring', () => {
    const { walkable } = deriveWalkInputs(makeRoom())
    expect(Array.isArray(walkable.outer)).toBe(true)
    expect(walkable.outer.length).toBeGreaterThanOrEqual(3)
  })

  it('adds a rotated obstacle for a floor-mounted object', () => {
    const couch = makeObject({
      id: 'couch',
      category: 'generic_cuboid',
      host: 'free',
      host_id: 'room',
      rotation_around_y_deg: 90,
    })
    const scene = makeRoom({ free_objects: [couch] })
    const obstacle = deriveWalkInputs(scene).obstacles.find((o) => o.id === 'couch')
    expect(obstacle).toBeDefined()
    expect(obstacle?.rotationY).toBeCloseTo(Math.PI / 2, 6)
  })
})

describe('sceneStore · camera slice (B-4)', () => {
  beforeEach(() => {
    useCanonicalSceneStore.getState().setCameraMode('dollhouse')
  })

  it('defaults to dollhouse mode', () => {
    expect(useCanonicalSceneStore.getState().cameraMode).toBe('dollhouse')
  })

  it('setCameraMode switches the active mode', () => {
    useCanonicalSceneStore.getState().setCameraMode('walk')
    expect(useCanonicalSceneStore.getState().cameraMode).toBe('walk')
    useCanonicalSceneStore.getState().setCameraMode('floorplan')
    expect(useCanonicalSceneStore.getState().cameraMode).toBe('floorplan')
  })

  it('changing the camera mode does not touch the resolved scene', () => {
    const before = useCanonicalSceneStore.getState().resolved
    useCanonicalSceneStore.getState().setCameraMode('walk')
    expect(useCanonicalSceneStore.getState().resolved).toBe(before)
  })
})

describe('sceneStore · section slice (B-5)', () => {
  beforeEach(() => {
    const s = useCanonicalSceneStore.getState()
    s.setCutawaySetting('none')
    s.setSectionSliderY(null)
    for (const id of [...s.hiddenWallIds]) s.toggleHiddenWall(id)
  })

  it('defaults to no cutaway, no slice, no hidden walls', () => {
    const s = useCanonicalSceneStore.getState()
    expect(s.cutawaySetting).toBe('none')
    expect(s.sectionSliderY).toBeNull()
    expect(s.hiddenWallIds).toEqual([])
  })

  it('setCutawaySetting + setSectionSliderY update view state', () => {
    useCanonicalSceneStore.getState().setCutawaySetting('remove_ceiling')
    expect(useCanonicalSceneStore.getState().cutawaySetting).toBe('remove_ceiling')
    useCanonicalSceneStore.getState().setSectionSliderY(1.2)
    expect(useCanonicalSceneStore.getState().sectionSliderY).toBe(1.2)
  })

  it('toggleHiddenWall adds then removes a wall id', () => {
    useCanonicalSceneStore.getState().toggleHiddenWall('w_n')
    expect(useCanonicalSceneStore.getState().hiddenWallIds).toContain('w_n')
    useCanonicalSceneStore.getState().toggleHiddenWall('w_n')
    expect(useCanonicalSceneStore.getState().hiddenWallIds).not.toContain('w_n')
  })
})
