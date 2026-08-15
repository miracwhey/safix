// @vitest-environment jsdom
/**
 * Integration tests for the Block-3.6 Stage-4 `VerifyStagePins` driven through
 * the real `VerifySheet` + `useVerifyFlow` + Phase-2 command stack.
 *
 * Covers:
 *   - the 4-tile pin picker renders all customer pin kinds,
 *   - a surface tap opens the pin-detail capture,
 *   - each of the 4 pin kinds (`damage` / `wish` / `note` / `photo`) drops a
 *     pin via `AddPinCommand` onto `customer_corrections`,
 *   - the dropped pin is 3D-native anchored (surface + UV),
 *   - a `damage` pin captures severity; the picker hides severity for others,
 *   - undo removes the most recent pin.
 *
 * `SurfaceTapLayer` is mocked to a probe that captures the `onTap` callback so
 * the test can drive a synthetic surface tap (the real raycast needs a Canvas).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
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

// SurfaceTapLayer probe — captures the latest `onTap` so a test can fire a tap.
type TapFn = (s: { kind: string; nodeId: string; point?: { x: number; y: number; z: number } }) => void
const tapProbe: { onTap: TapFn | null } = { onTap: null }
vi.mock('../../../src/components/spatial/three/canonical/SurfaceTapLayer', () => ({
  SurfaceTapLayer: ({ onTap }: { onTap: TapFn }) => {
    tapProbe.onTap = onTap
    return null
  },
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
import { makeRoom, makeWall } from '../../lib/spatial/canonical/__helpers__/sceneFactory'

const VARIANTS: Variant[] = [
  { id: STANDARD_VARIANTS.BASE_ROOMPLAN, display_name: 'Scan', is_default: true },
  { id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS, display_name: 'Korrekturen', is_default: false },
]

function room() {
  return makeRoom({
    walls: [
      makeWall({
        id: 'w_s',
        start_point: { x: 0, y: 0, z: 0 },
        end_point: { x: 4, y: 0, z: 0 },
        length_m: 4,
      }),
      makeWall({ id: 'w_e' }),
      makeWall({ id: 'w_n' }),
      makeWall({ id: 'w_w' }),
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
  tapProbe.onTap = null
  hydrate()
  Object.values(toastSpies).forEach((s) => s.mockReset())
})
afterEach(cleanup)

/** Render the sheet at Stage 4 (Pins). */
function setupAtPins() {
  const scene = room()
  hydrate(scene)
  render(
    <VerifySheet
      open
      onClose={vi.fn()}
      sceneId="scene-1"
      scene={scene}
      overrides={[]}
      variants={VARIANTS}
      lastStage={4}
      ownerUserId="cust-1"
      projectId="proj-1"
    />,
  )
}

/** Fire a synthetic surface tap on wall `w_s` at the given UV-equivalent point. */
function tapWall(point = { x: 2, y: 1.25, z: 0 }) {
  expect(tapProbe.onTap).not.toBeNull()
  // `onTap` triggers React state updates — wrap in `act` so they flush.
  act(() => {
    tapProbe.onTap?.({ kind: 'wall', nodeId: 'w_s', point })
  })
}

describe('VerifyStagePins — pin picker + drop (Block 3.6)', () => {
  it('renders the 4-tile pin picker', () => {
    setupAtPins()
    expect(screen.getByTestId('verify-stage-pins')).toBeTruthy()
    expect(screen.getByTestId('verify-pin-tile-damage')).toBeTruthy()
    expect(screen.getByTestId('verify-pin-tile-wish')).toBeTruthy()
    expect(screen.getByTestId('verify-pin-tile-note')).toBeTruthy()
    expect(screen.getByTestId('verify-pin-tile-photo')).toBeTruthy()
  })

  it('a surface tap opens the pin-detail capture', () => {
    setupAtPins()
    expect(screen.queryByTestId('verify-pin-detail')).toBeNull()
    tapWall()
    expect(screen.getByTestId('verify-pin-detail')).toBeTruthy()
  })

  it.each(['damage', 'wish', 'note', 'photo'] as const)(
    'drops a %s pin via AddPinCommand on customer_corrections',
    async (kind) => {
      setupAtPins()
      fireEvent.click(screen.getByTestId(`verify-pin-tile-${kind}`))
      tapWall()
      fireEvent.click(screen.getByTestId('verify-pin-save'))

      await waitFor(() => {
        const pins = useCanonicalSceneStore.getState().scene?.pins ?? []
        expect(pins.length).toBe(1)
      })
      const pin = useCanonicalSceneStore.getState().scene!.pins[0]
      expect(pin.pin_type).toBe(kind)
      expect(pin.variant_id).toBe(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
      // 3D-native anchored — surface id + UV set at creation.
      expect(pin.anchor_surface_id).toBe('w_s')
      expect(pin.anchor_surface_type).toBe('wall')
      expect(pin.anchor_uv.u).toBeGreaterThanOrEqual(0)
      expect(pin.anchor_uv.u).toBeLessThanOrEqual(1)
    },
  )

  it('the dropped pin UV projects from the tapped world point', async () => {
    setupAtPins()
    fireEvent.click(screen.getByTestId('verify-pin-tile-wish'))
    // w_s runs (0,0,0)→(4,0,0), height 2.5 — a hit at x=1 is U=0.25.
    tapWall({ x: 1, y: 0.5, z: 0 })
    fireEvent.click(screen.getByTestId('verify-pin-save'))
    await waitFor(() => {
      expect(useCanonicalSceneStore.getState().scene?.pins.length).toBe(1)
    })
    const pin = useCanonicalSceneStore.getState().scene!.pins[0]
    expect(pin.anchor_uv.u).toBeCloseTo(0.25, 5)
  })

  it('a damage pin shows the severity control; a wish pin does not', () => {
    setupAtPins()
    fireEvent.click(screen.getByTestId('verify-pin-tile-damage'))
    tapWall()
    expect(screen.queryByTestId('verify-pin-severity-high')).toBeTruthy()

    // Cancel + switch to wish.
    fireEvent.click(screen.getByTestId('verify-pin-cancel'))
    fireEvent.click(screen.getByTestId('verify-pin-tile-wish'))
    tapWall()
    expect(screen.queryByTestId('verify-pin-severity-high')).toBeNull()
  })

  it('a dropped pin appears in the placed-pins list', async () => {
    setupAtPins()
    fireEvent.click(screen.getByTestId('verify-pin-tile-note'))
    tapWall()
    fireEvent.click(screen.getByTestId('verify-pin-save'))
    await waitFor(() => {
      expect(screen.getByTestId('verify-pins-list')).toBeTruthy()
    })
  })

  it('undo removes the most recent pin', async () => {
    setupAtPins()
    fireEvent.click(screen.getByTestId('verify-pin-tile-wish'))
    tapWall()
    fireEvent.click(screen.getByTestId('verify-pin-save'))
    await waitFor(() => {
      expect(useCanonicalSceneStore.getState().scene?.pins.length).toBe(1)
    })
    fireEvent.click(screen.getByTestId('verify-pins-undo'))
    await waitFor(() => {
      expect(useCanonicalSceneStore.getState().scene?.pins.length).toBe(0)
    })
  })

  it('the Stage-4 skip path (no pin) leaves the scene untouched', () => {
    setupAtPins()
    fireEvent.click(screen.getByTestId('verify-primary-cta')) // → Stage 5
    expect(useCanonicalSceneStore.getState().scene?.pins.length).toBe(0)
    expect(useEditHistoryStore.getState().canUndo).toBe(false)
  })
})
