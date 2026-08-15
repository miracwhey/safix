/**
 * Tests for overrides/diff-variants.ts
 */
import { describe, it, expect } from 'vitest'

import { diffVariants } from '../../../../../src/lib/spatial/canonical/overrides/diff-variants.ts'
import { makePin, makeRoom, makeWall } from '../__helpers__/sceneFactory.ts'

describe('diff-variants · added / removed / modified', () => {
  it('detects identical scenes as empty diff', () => {
    const a = makeRoom()
    const b = makeRoom()
    const diff = diffVariants(a, b)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.modified).toEqual([])
  })

  it('detects added pins in b but not a', () => {
    const a = makeRoom()
    const newPin = makePin({
      id: 'p_new',
      anchor_surface_id: 'w_s',
      anchor_surface_type: 'wall',
      pin_type: 'damage',
    })
    const b = { ...a, pins: [newPin] }
    const diff = diffVariants(a, b)
    expect(diff.added.map(e => e.node_id)).toContain('p_new')
  })

  it('detects removed walls in b vs a', () => {
    const a = makeRoom()
    const b = { ...a, walls: a.walls.slice(1) }
    const diff = diffVariants(a, b)
    expect(diff.removed.map(e => e.node_id)).toContain(a.walls[0].id)
  })

  it('detects modified wall material', () => {
    const a = makeRoom({
      walls: [makeWall({ id: 'w_s', material_id: 'plaster_white' })],
    })
    const b = makeRoom({
      walls: [makeWall({ id: 'w_s', material_id: 'tile_anthrazit' })],
    })
    const diff = diffVariants(a, b)
    expect(diff.modified.some(e => e.node_id === 'w_s' && e.changed_fields?.includes('material_id'))).toBe(true)
  })
})
