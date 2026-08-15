/**
 * Tests for spatialWalkModel.ts — pure logic for the worker field walk.
 */

import { describe, it, expect } from 'vitest'
import {
  ACTIONS_BY_KIND,
  INITIAL_WALK_SESSION,
  getActionsForKind,
  selectElement,
  deselect,
  setPendingAction,
  clearPendingAction,
  type WalkableElement,
  type WalkableElementKind,
} from '../../../../../src/lib/spatial/canonical/workflow/spatialWalkModel.ts'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeElement(kind: WalkableElementKind, id = 'el-1'): WalkableElement {
  return {
    id,
    kind,
    label: `Test ${kind}`,
    subtitle: '2,80 × 2,55 m',
  }
}

// ── ACTIONS_BY_KIND ───────────────────────────────────────────────────────────

describe('ACTIONS_BY_KIND', () => {
  const ALL_KINDS: WalkableElementKind[] = ['wall', 'floor', 'ceiling', 'object', 'opening']

  it('has entries for every WalkableElementKind', () => {
    for (const kind of ALL_KINDS) {
      expect(ACTIONS_BY_KIND[kind]).toBeDefined()
      expect(ACTIONS_BY_KIND[kind].length).toBeGreaterThan(0)
    }
  })

  it('every kind includes add_photo_pin, add_pin_note, and report_problem', () => {
    for (const kind of ALL_KINDS) {
      const ids = ACTIONS_BY_KIND[kind].map((a) => a.id)
      expect(ids).toContain('add_photo_pin')
      expect(ids).toContain('add_pin_note')
      expect(ids).toContain('report_problem')
    }
  })

  it('wall includes edit_dimensions and change_wall_material', () => {
    const ids = ACTIONS_BY_KIND.wall.map((a) => a.id)
    expect(ids).toContain('edit_dimensions')
    expect(ids).toContain('change_wall_material')
  })

  it('floor includes change_floor_material but NOT edit_dimensions', () => {
    const ids = ACTIONS_BY_KIND.floor.map((a) => a.id)
    expect(ids).toContain('change_floor_material')
    expect(ids).not.toContain('edit_dimensions')
  })

  it('ceiling includes change_ceiling_material', () => {
    const ids = ACTIONS_BY_KIND.ceiling.map((a) => a.id)
    expect(ids).toContain('change_ceiling_material')
  })

  it('object includes replace_object and reposition_object', () => {
    const ids = ACTIONS_BY_KIND.object.map((a) => a.id)
    expect(ids).toContain('replace_object')
    expect(ids).toContain('reposition_object')
  })

  it('opening includes edit_opening_dimensions and change_opening_type', () => {
    const ids = ACTIONS_BY_KIND.opening.map((a) => a.id)
    expect(ids).toContain('edit_opening_dimensions')
    expect(ids).toContain('change_opening_type')
  })

  it('every action has a non-empty label, hint, icon, and accent', () => {
    for (const kind of ALL_KINDS) {
      for (const action of ACTIONS_BY_KIND[kind]) {
        expect(action.label.length).toBeGreaterThan(0)
        expect(action.hint.length).toBeGreaterThan(0)
        expect(action.icon.length).toBeGreaterThan(0)
        expect(action.accent).toBeDefined()
      }
    }
  })

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(ACTIONS_BY_KIND)).toBe(true)
  })
})

// ── getActionsForKind ─────────────────────────────────────────────────────────

describe('getActionsForKind', () => {
  it('returns the same array as ACTIONS_BY_KIND', () => {
    expect(getActionsForKind('wall')).toBe(ACTIONS_BY_KIND.wall)
    expect(getActionsForKind('floor')).toBe(ACTIONS_BY_KIND.floor)
  })
})

// ── INITIAL_WALK_SESSION ──────────────────────────────────────────────────────

describe('INITIAL_WALK_SESSION', () => {
  it('has no selected element and no pending action', () => {
    expect(INITIAL_WALK_SESSION.selectedElement).toBeNull()
    expect(INITIAL_WALK_SESSION.pendingAction).toBeNull()
  })
})

// ── selectElement ─────────────────────────────────────────────────────────────

describe('selectElement', () => {
  it('sets selectedElement and clears pendingAction', () => {
    const prev = {
      selectedElement: makeElement('floor'),
      pendingAction: 'add_photo_pin' as const,
    }
    const wall = makeElement('wall', 'wall-1')
    const next = selectElement(prev, wall)
    expect(next.selectedElement).toBe(wall)
    expect(next.pendingAction).toBeNull()
  })

  it('works from initial state', () => {
    const el = makeElement('object', 'obj-1')
    const next = selectElement(INITIAL_WALK_SESSION, el)
    expect(next.selectedElement).toBe(el)
  })
})

// ── deselect ─────────────────────────────────────────────────────────────────

describe('deselect', () => {
  it('clears selection and pending action', () => {
    const prev = {
      selectedElement: makeElement('wall'),
      pendingAction: 'edit_dimensions' as const,
    }
    const next = deselect(prev)
    expect(next.selectedElement).toBeNull()
    expect(next.pendingAction).toBeNull()
  })

  it('is idempotent when already at initial state', () => {
    const next = deselect(INITIAL_WALK_SESSION)
    expect(next.selectedElement).toBeNull()
    expect(next.pendingAction).toBeNull()
  })
})

// ── setPendingAction ──────────────────────────────────────────────────────────

describe('setPendingAction', () => {
  it('sets pendingAction when an element is selected', () => {
    const prev = {
      selectedElement: makeElement('wall'),
      pendingAction: null,
    }
    const next = setPendingAction(prev, 'edit_dimensions')
    expect(next.pendingAction).toBe('edit_dimensions')
    expect(next.selectedElement).toBe(prev.selectedElement)
  })

  it('returns prev state unchanged when no element is selected (defensive)', () => {
    const next = setPendingAction(INITIAL_WALK_SESSION, 'add_photo_pin')
    expect(next).toBe(INITIAL_WALK_SESSION)
  })

  it('overwrites an existing pendingAction', () => {
    const prev = {
      selectedElement: makeElement('wall'),
      pendingAction: 'edit_dimensions' as const,
    }
    const next = setPendingAction(prev, 'add_pin_note')
    expect(next.pendingAction).toBe('add_pin_note')
  })
})

// ── clearPendingAction ────────────────────────────────────────────────────────

describe('clearPendingAction', () => {
  it('clears pendingAction while preserving selectedElement', () => {
    const el = makeElement('ceiling')
    const prev = { selectedElement: el, pendingAction: 'add_photo_pin' as const }
    const next = clearPendingAction(prev)
    expect(next.pendingAction).toBeNull()
    expect(next.selectedElement).toBe(el)
  })

  it('is idempotent when pendingAction is already null', () => {
    const el = makeElement('floor')
    const prev = { selectedElement: el, pendingAction: null }
    const next = clearPendingAction(prev)
    expect(next.pendingAction).toBeNull()
  })
})
