// @vitest-environment jsdom
/**
 * Integration tests for the Block-2.9-2.12 `EditModeViewerHost`.
 *
 * Covers the host contract:
 *   - `<MaterialPickerSheet>` stays MOUNTED when closed (the Undo-Toast +
 *     live-region must survive a panel close),
 *   - a surface tap opens the picker; `onApply` builds a SetMaterialCommand
 *     and runs it through `editHistoryStore.apply()`,
 *   - `apply()` → `applied:false` surfaces a reject toast,
 *   - `apply()` → `applied:true` + warnings surfaces a soft-warn confirm toast,
 *   - Undo / Redo controls are gated on `canUndo` / `canRedo`,
 *   - edit mode is disabled when the user has no writable variant.
 *
 * The L3 `<CanonicalSceneRoot>` (a real `<Canvas>`) and `<VisualDiffOverlay>`
 * are mocked so the host's DOM-level wiring can be exercised under jsdom. Since
 * #6 the surface-tap layer lives INSIDE CanonicalSceneRoot (reported via its
 * `onPinPlaced` prop, gated by `editMode`); the CanonicalSceneRoot mock exposes
 * a tap button that fires `onPinPlaced` — no synthetic r3f event needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

// ── Mocks ──────────────────────────────────────────────────────────────────

const toastSpies = { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }
vi.mock('../../../src/hooks/useToast', () => ({ useToast: () => toastSpies }))
vi.mock('../../../src/hooks/useHaptics', () => ({
  useHaptics: () => ({ success: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../../src/lib/supabase', () => ({
  supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } },
}))

// CanonicalSceneRoot mounts a real <Canvas> AND (since #6) owns the surface-tap
// layer — replace it with a passthrough that renders the host's children and
// exposes a tap button firing `onPinPlaced` (gated by `editMode`, mirroring the
// real SurfaceTapLayer's `enabled` flag).
vi.mock('../../../src/components/spatial/three/canonical/CanonicalSceneRoot', () => ({
  CanonicalSceneRoot: ({
    children,
    editMode,
    onPinPlaced,
  }: {
    children?: ReactNode
    editMode?: boolean
    onPinPlaced?: (input: {
      kind: string
      surfaceExternalId: string
      uv: [number, number]
      worldXyz?: { x: number; y: number; z: number }
    }) => void
  }) => (
    <div data-testid="canonical-scene-root">
      <button
        type="button"
        data-testid="mock-surface-tap"
        data-enabled={editMode ? '1' : '0'}
        onClick={() => {
          if (editMode) onPinPlaced?.({ kind: 'wall', surfaceExternalId: 'w_s', uv: [0.5, 0.5] })
        }}
      >
        tap
      </button>
      {children}
    </div>
  ),
}))
vi.mock('../../../src/components/spatial/three/canonical/VisualDiffOverlay', () => ({
  VisualDiffOverlay: () => null,
}))

// Drive editHistoryStore.apply() deterministically per-test.
const applyMock = vi.fn()
const undoMock = vi.fn()
const redoMock = vi.fn()
let storeState = {
  apply: applyMock,
  undo: undoMock,
  redo: redoMock,
  canUndo: false,
  canRedo: false,
}
vi.mock('../../../src/lib/spatial/canonical/store/editHistoryStore', () => ({
  useEditHistoryStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

import { EditModeViewerHost } from '../../../src/components/spatial/edit/EditModeViewerHost'
import { useCanonicalSceneStore } from '../../../src/lib/spatial/canonical/store/sceneStore'
import {
  STANDARD_VARIANTS,
  type Variant,
} from '../../../src/lib/spatial/canonical/types/variants'
import type { RoomScene } from '../../../src/lib/spatial/canonical/types/scene-graph'
import type { Wall, Floor, Ceiling } from '../../../src/lib/spatial/canonical/types/geometry'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
} from '../../../src/lib/spatial/canonical/types/primitives'
import { resetSpatialCatalogRepository } from '../../../src/lib/spatial/canonical/repository/catalog-repository'
import {
  installMockSession,
  resetMockSession,
  mockCustomerSession,
} from '../../helpers/mockSession'
import { __testOnly_setSession } from '../../../src/lib/session'

const VARIANTS: Variant[] = [
  { id: STANDARD_VARIANTS.BASE_ROOMPLAN, display_name: 'Scan', is_default: true },
  { id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS, display_name: 'Kunden-Korrekturen', is_default: false },
]

const NOW = '2026-05-20T00:00:00.000Z'

function baseNode<T extends string>(id: string, type: T, parentId: string) {
  return {
    id,
    type,
    parent_id: parentId,
    children_ids: [] as string[],
    variant_id: 'base_roomplan',
    source: 'manual' as const,
    confidence: 1,
    transform: { position: IDENTITY_VECTOR3, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
    created_at: NOW,
    updated_at: NOW,
  }
}

function mkScene(): RoomScene {
  const ring = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 5 },
    { x: 0, y: 0, z: 5 },
  ]
  const wall: Wall = {
    ...baseNode('w_s', 'wall', 'room'),
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 4, y: 0, z: 0 },
    height_m: 2.5,
    thickness_m: 0.15,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true as const,
    material_id: 'wall-tile-white',
    length_m: 4,
    normal: { x: 0, y: 0, z: 0 },
  }
  const floor: Floor = {
    ...baseNode('room-floor', 'floor', 'room'),
    polygon: ring,
    walkable_surface: true as const,
    floor_mounted: [],
  }
  const ceiling: Ceiling = {
    ...baseNode('room-ceiling', 'ceiling', 'room'),
    polygon: ring,
    height_m: 2.5,
    ceiling_mounted: [],
  }
  return {
    ...baseNode('room', 'room', 'building'),
    category: 'bathroom',
    walls: [wall],
    floor,
    ceiling,
    free_objects: [],
    pins: [],
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: 4, y: 2.5, z: 5 },
    computed_area_m2: 20,
    computed_volume_m3: 50,
  }
}

/** Simulate a surface tap on the wall via the mocked SurfaceTapLayer. */
function tapWall() {
  fireEvent.click(screen.getByTestId('mock-surface-tap'))
}

beforeEach(() => {
  cleanup()
  resetMockSession()
  resetSpatialCatalogRepository()
  applyMock.mockReset()
  undoMock.mockReset()
  redoMock.mockReset()
  storeState = { apply: applyMock, undo: undoMock, redo: redoMock, canUndo: false, canRedo: false }
  useCanonicalSceneStore.getState().setScene(null)
  useCanonicalSceneStore.getState().setOverrides([])
  useCanonicalSceneStore.getState().setVariants(VARIANTS)
})
afterEach(cleanup)

function setup(role: 'customer' | 'none' = 'customer') {
  if (role === 'customer') installMockSession(mockCustomerSession('cust-1'))
  else __testOnly_setSession({
    user: null,
    role: null,
    craftsmanRole: null,
    isOperator: false,
    tosAcceptedAt: null,
    loading: false,
    sessionValidated: true,
    error: null,
    errorKind: null,
  })
  return render(
    <EditModeViewerHost
      scene={mkScene()}
      overrides={[]}
      variants={VARIANTS}
    />,
  )
}

describe('EditModeViewerHost — host contract', () => {
  it('keeps the MaterialPickerSheet mounted (no dialog) when closed', () => {
    setup()
    // Picker is closed: no dialog in the DOM, but the component is mounted —
    // its live-region <span role="status"> is present.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('span[role="status"]')).toBeTruthy()
  })

  it('disables edit mode when the user has no writable variant', () => {
    setup('none')
    const editToggle = screen.getByRole('button', { name: /Bearbeiten nicht verfügbar/ })
    expect(editToggle.hasAttribute('disabled')).toBe(true)
  })

  it('a surface tap in edit mode opens the material picker', async () => {
    setup()
    // Enter edit mode.
    fireEvent.click(screen.getByRole('button', { name: /Bearbeitungs-Modus/ }))
    tapWall()
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('a surface tap is ignored when NOT in edit mode', () => {
    setup()
    tapWall()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('EditModeViewerHost — apply flows', () => {
  it('onApply builds a SetMaterialCommand and runs editHistoryStore.apply()', async () => {
    applyMock.mockReturnValue({ applied: true, command: {}, warnings: [] })
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Bearbeitungs-Modus/ }))
    tapWall()
    const card = await screen.findByRole('button', { name: /Paint White/ })
    fireEvent.click(card)
    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1))
    const command = applyMock.mock.calls[0][0]
    // The command targets the customer's writable variant (Block 2.11).
    expect(command.variantId).toBe(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
    expect(command.operation.kind).toBe('set_material')
    expect(command.operation.node_id).toBe('w_s')
  })

  it('a hard-reject apply result surfaces an error toast', async () => {
    applyMock.mockReturnValue({
      applied: false,
      error: { code: 'WALL_IMMOVABLE', affected_node_ids: ['w_s'], message: 'Wand unbeweglich' },
      hint: 'Wände können nicht geändert werden.',
    })
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Bearbeitungs-Modus/ }))
    tapWall()
    const card = await screen.findByRole('button', { name: /Paint White/ })
    fireEvent.click(card)
    await waitFor(() =>
      expect(toastSpies.error).toHaveBeenCalledWith('Wände können nicht geändert werden.'),
    )
  })

  it('a soft-warn apply result surfaces a confirm toast', async () => {
    applyMock.mockReturnValue({
      applied: true,
      command: {},
      warnings: [
        { code: 'OBJECT_CLEARANCE_VIOLATED', affected_node_ids: ['w_s'], message: 'Überlappung mit WC' },
      ],
    })
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Bearbeitungs-Modus/ }))
    tapWall()
    const card = await screen.findByRole('button', { name: /Paint White/ })
    fireEvent.click(card)
    await waitFor(() => expect(applyMock).toHaveBeenCalled())
    expect(toastSpies.info).toHaveBeenCalled()
    const infoMsg = toastSpies.info.mock.calls.map((c) => String(c[0])).join(' ')
    expect(infoMsg).toContain('Überlappung mit WC')
  })
})

describe('EditModeViewerHost — undo/redo gating', () => {
  it('undo/redo controls are disabled when the stacks are empty', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Bearbeitungs-Modus/ }))
    expect(screen.getByRole('button', { name: 'Rückgängig' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Wiederholen' }).hasAttribute('disabled')).toBe(true)
  })

  it('undo fires editHistoryStore.undo() when canUndo is true', () => {
    storeState = { apply: applyMock, undo: undoMock, redo: redoMock, canUndo: true, canRedo: false }
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Bearbeitungs-Modus/ }))
    const undoBtn = screen.getByRole('button', { name: 'Rückgängig' })
    expect(undoBtn.hasAttribute('disabled')).toBe(false)
    fireEvent.click(undoBtn)
    expect(undoMock).toHaveBeenCalledTimes(1)
  })
})
