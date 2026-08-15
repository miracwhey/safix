/**
 * Tests for overrides/variant-resolve.ts
 */
import { describe, it, expect } from 'vitest'

import {
  resolveNode,
  resolveScene,
  variantChain,
} from '../../../../../src/lib/spatial/canonical/overrides/variant-resolve.ts'
import type {
  NodeOverride,
  Variant,
} from '../../../../../src/lib/spatial/canonical/types/variants.ts'
import { DELETION_MARKER_KEY } from '../../../../../src/lib/spatial/canonical/overrides/layer-merge.ts'
import { makeObject, makeOpening, makePin, makeRoom, makeWall } from '../__helpers__/sceneFactory.ts'

const variants: Variant[] = [
  { id: 'base_roomplan', display_name: 'Scan', is_default: true },
  { id: 'customer_corrections', display_name: 'Customer', is_default: false, parent_variant_id: 'base_roomplan' },
  { id: 'provider_x_annotations', display_name: 'Provider X', is_default: false, parent_variant_id: 'customer_corrections' },
]

describe('variant-resolve · variantChain', () => {
  it('returns the inheritance chain in apply-order', () => {
    const chain = variantChain('provider_x_annotations', variants)
    expect(chain).toEqual(['base_roomplan', 'customer_corrections', 'provider_x_annotations'])
  })

  it('handles a single-layer chain', () => {
    expect(variantChain('base_roomplan', variants)).toEqual(['base_roomplan'])
  })

  it('survives cycles without infinite-looping', () => {
    const looped: Variant[] = [
      { id: 'a', display_name: 'A', is_default: true, parent_variant_id: 'b' },
      { id: 'b', display_name: 'B', is_default: false, parent_variant_id: 'a' },
    ]
    const chain = variantChain('a', looped)
    expect(chain.length).toBeLessThanOrEqual(2)
  })
})

describe('variant-resolve · resolveNode', () => {
  it('returns the base node when no overrides exist', () => {
    const w = makeWall({ id: 'w_s', material_id: 'plaster_white' })
    expect(resolveNode(w, [], ['base_roomplan'])?.material_id).toBe('plaster_white')
  })

  it('applies a single-variant override', () => {
    const w = makeWall({ id: 'w_s', material_id: 'plaster_white' })
    const overrides: NodeOverride[] = [
      { base_node_id: 'w_s', variant_id: 'customer_corrections', override_fields: { material_id: 'tile_anthrazit' } },
    ]
    const resolved = resolveNode(w, overrides, ['base_roomplan', 'customer_corrections'])
    expect(resolved?.material_id).toBe('tile_anthrazit')
  })

  it('returns null when the override marks the node as deleted', () => {
    const w = makeWall({ id: 'w_s' })
    const overrides: NodeOverride[] = [
      { base_node_id: 'w_s', variant_id: 'customer_corrections', override_fields: { [DELETION_MARKER_KEY]: true } },
    ]
    const resolved = resolveNode(w, overrides, ['base_roomplan', 'customer_corrections'])
    expect(resolved).toBeNull()
  })
})

describe('variant-resolve · resolveScene', () => {
  it('drops deleted walls from the resolved scene', () => {
    const room = makeRoom()
    const overrides: NodeOverride[] = [
      { base_node_id: 'w_s', variant_id: 'customer_corrections', override_fields: { [DELETION_MARKER_KEY]: true } },
    ]
    const resolved = resolveScene({
      scene: room,
      overrides,
      variants,
      activeVariantId: 'customer_corrections',
    })
    expect(resolved.walls.find(w => w.id === 'w_s')).toBeUndefined()
    expect(resolved.walls).toHaveLength(room.walls.length - 1)
  })

  it('passes through the scene unchanged when no overrides target the active variant', () => {
    const room = makeRoom()
    const resolved = resolveScene({
      scene: room,
      overrides: [],
      variants,
      activeVariantId: 'customer_corrections',
    })
    expect(resolved.walls).toHaveLength(room.walls.length)
  })

  it('drops pins anchored to a deleted wall and reports a warning (H22 audit-fix)', () => {
    const orphanPin = makePin({
      id: 'pin_orphan',
      anchor_surface_id: 'w_s',
      anchor_surface_type: 'wall',
      pin_type: 'damage',
    })
    const survivorPin = makePin({
      id: 'pin_keep',
      anchor_surface_id: 'w_e',
      anchor_surface_type: 'wall',
      pin_type: 'note',
    })
    const room = makeRoom({ pins: [orphanPin, survivorPin] })
    const warnings: string[] = []
    const resolved = resolveScene({
      scene: room,
      overrides: [
        {
          base_node_id: 'w_s',
          variant_id: 'customer_corrections',
          override_fields: { [DELETION_MARKER_KEY]: true },
        },
      ],
      variants,
      activeVariantId: 'customer_corrections',
      onWarning: (msg) => warnings.push(msg),
    })
    expect(resolved.pins.find(p => p.id === 'pin_orphan')).toBeUndefined()
    expect(resolved.pins.find(p => p.id === 'pin_keep')).toBeDefined()
    expect(warnings.some(w => w.includes('pin_orphan') && w.includes('w_s'))).toBe(true)
  })

  it('H22 · drops wall-mounted objects orphaned by a deleted wall + reports each drop', () => {
    const sink = makeObject({
      id: 'sink_orphan', category: 'sink', host: 'wall', host_id: 'w_s',
    })
    const door = makeOpening({ id: 'door_orphan', host_wall_id: 'w_s', type: 'door' })
    const wallWithChildren = makeWall({
      id: 'w_s',
      start_point: { x: 0, y: 0, z: 0 },
      end_point: { x: 4, y: 0, z: 0 },
      wall_mounted: [sink],
      openings: [door],
    })
    const room = makeRoom({
      walls: [
        wallWithChildren,
        makeWall({ id: 'w_e', start_point: { x: 4, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 3 } }),
        makeWall({ id: 'w_n', start_point: { x: 4, y: 0, z: 3 }, end_point: { x: 0, y: 0, z: 3 } }),
        makeWall({ id: 'w_w', start_point: { x: 0, y: 0, z: 3 }, end_point: { x: 0, y: 0, z: 0 } }),
      ],
    })
    const warnings: string[] = []
    const resolved = resolveScene({
      scene: room,
      overrides: [
        {
          base_node_id: 'w_s',
          variant_id: 'customer_corrections',
          override_fields: { [DELETION_MARKER_KEY]: true },
        },
      ],
      variants,
      activeVariantId: 'customer_corrections',
      onWarning: (msg) => warnings.push(msg),
    })
    // The wall is gone — and so are its wall-mounted object + opening.
    expect(resolved.walls.find(w => w.id === 'w_s')).toBeUndefined()
    const allObjs = resolved.walls.flatMap(w => w.wall_mounted)
    expect(allObjs.find(o => o.id === 'sink_orphan')).toBeUndefined()
    // Each orphan drop is reported so the deletion is observable, not silent.
    expect(warnings.some(w => w.includes('sink_orphan') && w.includes('w_s'))).toBe(true)
    expect(warnings.some(w => w.includes('door_orphan') && w.includes('w_s'))).toBe(true)
  })

  it('H22 · drops a pin anchored to a wall-mounted object whose host wall is deleted', () => {
    const sink = makeObject({
      id: 'sink_orphan', category: 'sink', host: 'wall', host_id: 'w_s',
    })
    const pinOnSink = makePin({
      id: 'pin_on_sink', anchor_surface_id: 'sink_orphan', anchor_surface_type: 'object', pin_type: 'damage',
    })
    const room = makeRoom({
      walls: [
        makeWall({ id: 'w_s', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 }, wall_mounted: [sink] }),
        makeWall({ id: 'w_e', start_point: { x: 4, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 3 } }),
        makeWall({ id: 'w_n', start_point: { x: 4, y: 0, z: 3 }, end_point: { x: 0, y: 0, z: 3 } }),
        makeWall({ id: 'w_w', start_point: { x: 0, y: 0, z: 3 }, end_point: { x: 0, y: 0, z: 0 } }),
      ],
      pins: [pinOnSink],
    })
    const resolved = resolveScene({
      scene: room,
      overrides: [
        { base_node_id: 'w_s', variant_id: 'customer_corrections', override_fields: { [DELETION_MARKER_KEY]: true } },
      ],
      variants,
      activeVariantId: 'customer_corrections',
    })
    // The sink vanished with its wall → the pin anchored to the sink is orphaned too.
    expect(resolved.pins.find(p => p.id === 'pin_on_sink')).toBeUndefined()
  })
})
