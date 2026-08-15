/**
 * Tests for `AddPinCommand` (Phase 3 · Block 3.6) — driven through the real
 * `editHistoryStore.apply()` pipeline so the `add_pin` constraint gate runs.
 *
 * Covers: a pin-drop appends a base-scene pin node, undo removes it,
 * redo re-adds it, the `add_pin` validator hard-rejects a missing anchor
 * surface / out-of-range UV, and the pin is anchored 3D-native (surface +
 * UV) at creation.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { useCanonicalSceneStore } from '../../../../../src/lib/spatial/canonical/store/sceneStore.ts'
import { useEditHistoryStore } from '../../../../../src/lib/spatial/canonical/store/editHistoryStore.ts'
import { AddPinCommand } from '../../../../../src/lib/spatial/canonical/commands/AddPinCommand.ts'
import { validateComponentMove } from '../../../../../src/lib/spatial/canonical/validator/validate-component-move.ts'
import type { Pin } from '../../../../../src/lib/spatial/canonical/types/annotations.ts'
import { IDENTITY_TRANSFORM } from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import type { SpatialEditUser } from '../../../../../src/lib/spatial/workflow/spatialEditPermissions.ts'
import { makeRoom, makeWall } from '../__helpers__/sceneFactory.ts'

const VARIANT = 'customer_corrections'

/** A customer whose role-correct writable variant IS `customer_corrections`. */
const CUSTOMER: SpatialEditUser = { userId: 'cust-test', role: 'customer', isOperator: false }

function scene() {
  return useCanonicalSceneStore.getState()
}
function history() {
  return useEditHistoryStore.getState()
}
/** Apply through the store as the test customer — passes the RBAC gate. */
function applyAs(cmd: Parameters<ReturnType<typeof history>['apply']>[0]) {
  return history().apply(cmd, CUSTOMER)
}

function room() {
  return makeRoom({
    walls: [
      makeWall({ id: 'w_s' }),
      makeWall({ id: 'w_e' }),
      makeWall({ id: 'w_n' }),
      makeWall({ id: 'w_w' }),
    ],
  })
}

function makeWishPin(id: string, surfaceId: string, uv: { u: number; v: number }): Pin {
  const now = '2026-05-20T00:00:00.000Z'
  return {
    id,
    type: 'pin',
    name: 'Wunsch',
    parent_id: surfaceId,
    children_ids: [],
    transform: IDENTITY_TRANSFORM,
    source: 'manual',
    confidence: 1,
    variant_id: VARIANT,
    created_at: now,
    updated_at: now,
    pin_type: 'wish',
    anchor_surface_id: surfaceId,
    anchor_surface_type: 'wall',
    anchor_uv: uv,
    anchor_offset_normal_m: 0.01,
    linked_photo_ids: [],
    linked_note_ids: [],
    linked_task_ids: [],
  }
}

beforeEach(() => {
  history().clear()
  scene().setScene(room())
  scene().setOverrides([])
  scene().setVariants([])
  scene().setActiveVariantId(VARIANT)
})

describe('AddPinCommand', () => {
  it('appends a 3D-native-anchored pin node to the base scene', () => {
    const pin = makeWishPin('pin-1', 'w_s', { u: 0.4, v: 0.7 })
    const result = applyAs(new AddPinCommand({ pin, variantId: VARIANT }))

    expect(result.applied).toBe(true)
    const pins = useCanonicalSceneStore.getState().scene?.pins ?? []
    expect(pins).toHaveLength(1)
    expect(pins[0].id).toBe('pin-1')
    expect(pins[0].anchor_surface_id).toBe('w_s')
    expect(pins[0].anchor_uv).toEqual({ u: 0.4, v: 0.7 })
    // The pin is forced onto the customer variant + manual provenance.
    expect(pins[0].variant_id).toBe(VARIANT)
    expect(pins[0].source).toBe('manual')
  })

  it('the pin appears in the resolved scene', () => {
    const pin = makeWishPin('pin-1', 'w_s', { u: 0.5, v: 0.5 })
    applyAs(new AddPinCommand({ pin, variantId: VARIANT }))
    expect(useCanonicalSceneStore.getState().resolved?.pins).toHaveLength(1)
  })

  it('undo removes the pin, redo re-adds it', () => {
    const pin = makeWishPin('pin-1', 'w_s', { u: 0.5, v: 0.5 })
    applyAs(new AddPinCommand({ pin, variantId: VARIANT }))
    expect(useCanonicalSceneStore.getState().scene?.pins).toHaveLength(1)

    history().undo()
    expect(useCanonicalSceneStore.getState().scene?.pins).toHaveLength(0)

    history().redo()
    expect(useCanonicalSceneStore.getState().scene?.pins).toHaveLength(1)
  })

  it('a re-applied AddPinCommand never duplicates the pin (idempotent do/redo)', () => {
    const pin = makeWishPin('pin-1', 'w_s', { u: 0.5, v: 0.5 })
    applyAs(new AddPinCommand({ pin, variantId: VARIANT }))
    history().undo()
    history().redo()
    history().redo()
    expect(useCanonicalSceneStore.getState().scene?.pins).toHaveLength(1)
  })

  it('undo throws instead of silently no-ooping when the base scene changed', () => {
    const pin = makeWishPin('pin-1', 'w_s', { u: 0.5, v: 0.5 })
    const cmd = new AddPinCommand({ pin, variantId: VARIANT })
    applyAs(cmd)
    // The base scene is REPLACED — the added pin is no longer present.
    scene().setScene(room())
    // undo can no longer remove the pin it added — it MUST surface a failure.
    expect(() => cmd.undo(scene())).toThrow(/pin-1|no longer/)
  })
})

describe('add_pin constraint gate', () => {
  it('hard-rejects a pin whose anchor surface is missing', () => {
    const r = useCanonicalSceneStore.getState().resolved
    expect(r).not.toBeNull()
    if (!r) return
    const verdict = validateComponentMove(
      {
        kind: 'add_pin',
        pin_id: 'pin-x',
        anchor: {
          anchor_surface_id: 'w_nope',
          anchor_surface_type: 'wall',
          anchor_uv: { u: 0.5, v: 0.5 },
          anchor_offset_normal_m: 0.01,
        },
      },
      r,
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.error?.code).toBe('PIN_ANCHOR_MISSING')
  })

  it('hard-rejects an out-of-range UV', () => {
    const r = useCanonicalSceneStore.getState().resolved
    if (!r) return
    const verdict = validateComponentMove(
      {
        kind: 'add_pin',
        pin_id: 'pin-x',
        anchor: {
          anchor_surface_id: 'w_s',
          anchor_surface_type: 'wall',
          anchor_uv: { u: 1.5, v: 0.5 },
          anchor_offset_normal_m: 0.01,
        },
      },
      r,
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.error?.code).toBe('PIN_UV_OUT_OF_RANGE')
  })

  it('a hard-rejected add_pin never reaches the scene (apply gate)', () => {
    const pin = makeWishPin('pin-bad', 'w_nope', { u: 0.5, v: 0.5 })
    const result = applyAs(new AddPinCommand({ pin, variantId: VARIANT }))
    expect(result.applied).toBe(false)
    expect(useCanonicalSceneStore.getState().scene?.pins).toHaveLength(0)
  })

  it('accepts a valid pin anchored on a wall', () => {
    const r = useCanonicalSceneStore.getState().resolved
    if (!r) return
    const verdict = validateComponentMove(
      {
        kind: 'add_pin',
        pin_id: 'pin-ok',
        anchor: {
          anchor_surface_id: 'w_s',
          anchor_surface_type: 'wall',
          anchor_uv: { u: 0.5, v: 0.5 },
          anchor_offset_normal_m: 0.01,
        },
      },
      r,
    )
    expect(verdict.ok).toBe(true)
  })
})
