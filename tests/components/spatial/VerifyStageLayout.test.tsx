// @vitest-environment jsdom
/**
 * Integration tests for the Block-3.5 Stage-3 `VerifyStageLayout` driven
 * through the real `VerifySheet` + `useVerifyFlow` + Phase-2 command stack.
 *
 * Covers:
 *   - the wall + opening lists render from the resolved scene,
 *   - a wall delete is a two-step confirm → `DeleteNodeCommand` on
 *     `customer_corrections`,
 *   - deleting the second-to-last wall is hard-blocked (MIN_ROOM_WALLS),
 *   - an opening move builds a `MoveNodeCommand`,
 *   - adding a door builds an `AddDoorCommand`,
 *   - the Stage-3 skip path (no edit) leaves the scene untouched,
 *   - undo reverts the most recent layout edit.
 *
 * The canonical scene store is hydrated with a REAL scene so `apply()` runs
 * the actual command + validator path; only the `<Canvas>` renderer is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const toastSpies = { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }
vi.mock('../../../src/hooks/useToast', () => ({ useToast: () => toastSpies }))
vi.mock('../../../src/hooks/useHaptics', () => ({
  useHaptics: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    medium: vi.fn(),
  }),
}))
vi.mock('../../../src/lib/supabase', () => ({
  supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } },
}))
vi.mock('../../../src/components/spatial/three/canonical/CanonicalSceneRoot', () => ({
  CanonicalSceneRoot: ({ children }: { children?: ReactNode }) => (
    <div data-testid="canonical-scene-root">{children}</div>
  ),
}))
vi.mock('../../../src/components/spatial/three/canonical/SurfaceTapLayer', () => ({
  SurfaceTapLayer: () => null,
}))

import { VerifySheet } from '../../../src/components/spatial/verify/VerifySheet'
import { useCanonicalSceneStore } from '../../../src/lib/spatial/canonical/store/sceneStore'
import { useEditHistoryStore } from '../../../src/lib/spatial/canonical/store/editHistoryStore'
import { STANDARD_VARIANTS, type Variant } from '../../../src/lib/spatial/canonical/types/variants'
import {
  installMockSession,
  resetMockSession,
  mockCustomerSession,
} from '../../helpers/mockSession'
import { makeRoom, makeWall, makeOpening } from '../../lib/spatial/canonical/__helpers__/sceneFactory'

const VARIANTS: Variant[] = [
  { id: STANDARD_VARIANTS.BASE_ROOMPLAN, display_name: 'Scan', is_default: true },
  { id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS, display_name: 'Korrekturen', is_default: false },
]

/** A 4-wall room with one door on `w_s`. */
function room() {
  return makeRoom({
    walls: [
      makeWall({
        id: 'w_s',
        start_point: { x: 0, y: 0, z: 0 },
        end_point: { x: 4, y: 0, z: 0 },
        length_m: 4,
        openings: [
          makeOpening({
            id: 'door-1',
            host_wall_id: 'w_s',
            type: 'door',
            offset_along_wall_m: 1,
            width_m: 0.9,
            height_m: 2,
          }),
        ],
      }),
      makeWall({ id: 'w_e', length_m: 3 }),
      makeWall({ id: 'w_n', length_m: 4 }),
      makeWall({ id: 'w_w', length_m: 3 }),
    ],
  })
}

function hydrate(scene = room()) {
  useCanonicalSceneStore.getState().setScene(scene)
  useCanonicalSceneStore.getState().setOverrides([])
  useCanonicalSceneStore.getState().setVariants(VARIANTS)
  useCanonicalSceneStore.getState().setActiveVariantId(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
}

beforeEach(() => {
  cleanup()
  resetMockSession()
  installMockSession(mockCustomerSession('cust-1'))
  useEditHistoryStore.getState().clear()
  hydrate()
  Object.values(toastSpies).forEach((s) => s.mockReset())
})
afterEach(cleanup)

/** Render the sheet at Stage 3 (Layout). */
function setupAtLayout(scene = room()) {
  hydrate(scene)
  render(
    <VerifySheet
      open
      onClose={vi.fn()}
      sceneId="scene-1"
      scene={scene}
      overrides={[]}
      variants={VARIANTS}
      lastStage={3}
    />,
  )
}

describe('VerifyStageLayout — wall + opening edits (Block 3.5)', () => {
  it('renders the wall list and the opening list from the scene', () => {
    setupAtLayout()
    expect(screen.getByTestId('verify-stage-layout')).toBeTruthy()
    expect(screen.getByTestId('verify-layout-wall-row-w_s')).toBeTruthy()
    expect(screen.getByTestId('verify-layout-wall-row-w_e')).toBeTruthy()
    expect(screen.getByTestId('verify-layout-opening-row-door-1')).toBeTruthy()
  })

  it('a wall delete is a two-step confirm → DeleteNodeCommand on customer_corrections', async () => {
    setupAtLayout()
    // Select the wall to reveal its action buttons.
    fireEvent.click(screen.getByTestId('verify-layout-wall-row-w_e'))
    const delBtn = screen.getByTestId('verify-layout-delete-wall-w_e')
    // First tap arms — nothing deleted yet.
    fireEvent.click(delBtn)
    expect(useCanonicalSceneStore.getState().overrides.length).toBe(0)
    expect(delBtn.textContent).toContain('Wirklich löschen?')
    // Second tap commits.
    fireEvent.click(screen.getByTestId('verify-layout-delete-wall-w_e'))
    await waitFor(() => {
      const overrides = useCanonicalSceneStore.getState().overrides
      expect(overrides.length).toBe(1)
    })
    const override = useCanonicalSceneStore.getState().overrides[0]
    expect(override.variant_id).toBe(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
    expect(override.base_node_id).toBe('w_e')
    expect(override.override_fields.__deleted).toBe(true)
  })

  it('blocks deleting a wall when the room would drop below 2 walls', async () => {
    // A 2-wall room — every wall delete must be refused.
    const twoWall = makeRoom({
      walls: [makeWall({ id: 'w_a' }), makeWall({ id: 'w_b' })],
    })
    setupAtLayout(twoWall)
    fireEvent.click(screen.getByTestId('verify-layout-wall-row-w_a'))
    fireEvent.click(screen.getByTestId('verify-layout-delete-wall-w_a')) // arm
    fireEvent.click(screen.getByTestId('verify-layout-delete-wall-w_a')) // confirm
    await waitFor(() => {
      expect(toastSpies.error).toHaveBeenCalled()
    })
    expect(useCanonicalSceneStore.getState().overrides.length).toBe(0)
  })

  it('moving an opening builds a MoveNodeCommand', async () => {
    setupAtLayout()
    fireEvent.click(screen.getByTestId('verify-layout-opening-row-door-1'))
    const slider = screen.getByTestId('verify-layout-opening-offset-door-1')
    fireEvent.change(slider, { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('verify-layout-move-opening-door-1'))
    await waitFor(() => {
      expect(useEditHistoryStore.getState().canUndo).toBe(true)
    })
    const override = useCanonicalSceneStore.getState().overrides[0]
    expect(override.base_node_id).toBe('door-1')
    expect(override.variant_id).toBe(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
  })

  it('adding a door appends a base-scene door node', async () => {
    setupAtLayout()
    fireEvent.click(screen.getByTestId('verify-layout-wall-row-w_n'))
    fireEvent.click(screen.getByTestId('verify-layout-add-door-w_n'))
    await waitFor(() => {
      const wall = useCanonicalSceneStore.getState().scene?.walls.find((w) => w.id === 'w_n')
      expect(wall?.openings.length).toBe(1)
    })
    const wall = useCanonicalSceneStore.getState().scene?.walls.find((w) => w.id === 'w_n')
    expect(wall?.openings[0].type).toBe('door')
  })

  it('the Stage-3 skip path leaves the scene untouched', () => {
    setupAtLayout()
    // No interaction — advance past Stage 3.
    fireEvent.click(screen.getByTestId('verify-primary-cta'))
    expect(useCanonicalSceneStore.getState().overrides.length).toBe(0)
    expect(useEditHistoryStore.getState().canUndo).toBe(false)
  })

  it('undo reverts the most recent layout edit', async () => {
    setupAtLayout()
    fireEvent.click(screen.getByTestId('verify-layout-wall-row-w_e'))
    fireEvent.click(screen.getByTestId('verify-layout-delete-wall-w_e')) // arm
    fireEvent.click(screen.getByTestId('verify-layout-delete-wall-w_e')) // confirm
    await waitFor(() => {
      expect(useCanonicalSceneStore.getState().overrides.length).toBe(1)
    })
    fireEvent.click(screen.getByTestId('verify-layout-undo'))
    await waitFor(() => {
      expect(useCanonicalSceneStore.getState().overrides.length).toBe(0)
    })
  })
})
