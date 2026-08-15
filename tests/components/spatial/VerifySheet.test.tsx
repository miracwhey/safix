// @vitest-environment jsdom
/**
 * Integration tests for the Block-3.1 `VerifySheet` container.
 *
 * Covers the shell contract:
 *   - the 5-segment step-bar reflects the active stage,
 *   - Stage navigation (next / back) is multi-click-safe — a double-tapped
 *     "Weiter" never skips a stage,
 *   - resume: a persisted `lastStage` opens the sheet at that stage,
 *   - all five stages render real — Stage 5 is the Confirm stage (Block 3.8),
 *   - the Welcome `unrenderable` path disables the forward CTA,
 *   - "Skip" / dismiss closes the sheet,
 *   - Stage 5 submit: both paths + the multi-click double-submit guard.
 *
 * The L3 `<CanonicalSceneRoot>` + `<SurfaceTapLayer>` mount a real `<Canvas>`;
 * both are mocked to passthrough so the shell's DOM wiring runs under jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

// ── Mocks ──────────────────────────────────────────────────────────────────

const toastSpies = { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }
vi.mock('../../../src/hooks/useToast', () => ({ useToast: () => toastSpies }))
vi.mock('../../../src/hooks/useHaptics', () => ({
  useHaptics: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
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
import {
  getSpatialSceneRepository,
  resetSpatialSceneRepository,
} from '../../../src/lib/spatial/canonical/repository/registry'
import { STANDARD_VARIANTS, type Variant } from '../../../src/lib/spatial/canonical/types/variants'
import {
  installMockSession,
  resetMockSession,
  mockCustomerSession,
} from '../../helpers/mockSession'
import {
  makeRoom,
  makeWall,
  makeOpening,
} from '../../lib/spatial/canonical/__helpers__/sceneFactory'

const VARIANTS: Variant[] = [
  { id: STANDARD_VARIANTS.BASE_ROOMPLAN, display_name: 'Scan', is_default: true },
  { id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS, display_name: 'Korrekturen', is_default: false },
]

/** A renderable, validator-clean 4-wall room with a door → Welcome `ok` path. */
function okRoom() {
  return makeRoom({
    walls: [
      makeWall({
        id: 'w_s',
        openings: [makeOpening({ id: 'door-1', host_wall_id: 'w_s', type: 'door' })],
      }),
      makeWall({ id: 'w_e' }),
      makeWall({ id: 'w_n' }),
      makeWall({ id: 'w_w' }),
    ],
  })
}

/** A 2-wall room → Welcome `unrenderable` path. */
function unrenderableRoom() {
  return makeRoom({ walls: [makeWall({ id: 'w_s' }), makeWall({ id: 'w_e' })] })
}

beforeEach(() => {
  cleanup()
  resetMockSession()
  installMockSession(mockCustomerSession('cust-1'))
  resetSpatialSceneRepository()
  useEditHistoryStore.getState().clear()
  useCanonicalSceneStore.getState().setScene(null)
  useCanonicalSceneStore.getState().setOverrides([])
  useCanonicalSceneStore.getState().setVariants(VARIANTS)
})
afterEach(cleanup)

/**
 * Seed the InMemory scene repository with a `not_started` scene and return its
 * id — the Stage-5 confirm walks `customer_verify_state` on this row.
 */
async function seedScene(): Promise<string> {
  const scene = await getSpatialSceneRepository('in-memory').create({
    sourceScanId: 'scan-1',
    parametricStoragePath: 'scenes/scene-1/parametric.json',
    customerId: 'cust-1',
  })
  return scene.id
}

function setup(
  props: Partial<Parameters<typeof VerifySheet>[0]> & { sceneId?: string | null } = {},
) {
  const scene = props.scene ?? okRoom()
  // `CanonicalSceneRoot` is mocked to a passthrough — it does NOT hydrate the
  // canonical store. `useVerifyFlow` reads `resolved` from the store, so the
  // test hydrates it directly (mirrors what the real renderer would do).
  useCanonicalSceneStore.getState().setScene(scene)
  useCanonicalSceneStore.getState().setActiveVariantId(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
  // Default `sceneId` is `null` — the shell + navigation tests run as a bare
  // preview (no verify-state persistence). The Stage-5 confirm tests pass a
  // seeded scene id explicitly.
  return render(
    <VerifySheet
      open
      onClose={props.onClose ?? vi.fn()}
      sceneId={props.sceneId === undefined ? null : props.sceneId}
      scene={scene}
      overrides={[]}
      variants={VARIANTS}
      lastStage={props.lastStage ?? null}
      verifyState={props.verifyState}
      onRequestProvider={props.onRequestProvider}
      onSubmitted={props.onSubmitted}
    />,
  )
}

describe('VerifySheet — shell + navigation', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <VerifySheet open={false} onClose={vi.fn()} scene={okRoom()} variants={VARIANTS} />,
    )
    expect(container.querySelector('[data-testid="verify-sheet"]')).toBeNull()
  })

  it('opens at Stage 1 (Welcome) by default — step-bar segment 1 active', () => {
    setup()
    expect(screen.getByTestId('verify-stage-welcome')).toBeTruthy()
    expect(screen.getByTestId('verify-step-dot-1').getAttribute('data-state')).toBe('active')
    expect(screen.getByTestId('verify-step-dot-2').getAttribute('data-state')).toBe('upcoming')
  })

  it('advances to Stage 2 (Maße) on "Weiter" — and the step-bar updates', () => {
    setup()
    fireEvent.click(screen.getByTestId('verify-primary-cta'))
    expect(screen.getByTestId('verify-stage-measure')).toBeTruthy()
    expect(screen.getByTestId('verify-step-dot-1').getAttribute('data-state')).toBe('done')
    expect(screen.getByTestId('verify-step-dot-2').getAttribute('data-state')).toBe('active')
  })

  it('a double-tapped "Weiter" advances exactly ONE stage (multi-click-safe)', () => {
    setup()
    const cta = screen.getByTestId('verify-primary-cta')
    fireEvent.click(cta)
    // Second synchronous click on the (now Stage-2) CTA — must land on Stage 3
    // (Layout), not Stage 4. Each click is a single deterministic step.
    fireEvent.click(screen.getByTestId('verify-primary-cta'))
    expect(screen.getByTestId('verify-stage-layout')).toBeTruthy()
    expect(screen.getByTestId('verify-step-dot-3').getAttribute('data-state')).toBe('active')
  })

  it('"Zurück" steps back one stage', () => {
    setup()
    fireEvent.click(screen.getByTestId('verify-primary-cta')) // → Stage 2
    fireEvent.click(screen.getByTestId('verify-back')) // ← Stage 1
    expect(screen.getByTestId('verify-stage-welcome')).toBeTruthy()
  })

  it('Stages 3+4+5 all render real — Stage 5 is the Confirm stage', () => {
    setup({ lastStage: 3 })
    expect(screen.getByTestId('verify-stage-layout')).toBeTruthy()
    fireEvent.click(screen.getByTestId('verify-primary-cta')) // → 4 (Pins)
    expect(screen.getByTestId('verify-stage-pins')).toBeTruthy()
    fireEvent.click(screen.getByTestId('verify-primary-cta')) // → 5 (Confirm)
    expect(screen.getByTestId('verify-stage-confirm')).toBeTruthy()
    // Stage 5 owns its own actions — the shared "Weiter" CTA is gone.
    expect(screen.queryByTestId('verify-primary-cta')).toBeNull()
  })
})

describe('VerifySheet — Stage 5 Confirm submit', () => {
  it('"Erstmal speichern" calls onSubmitted on success', async () => {
    const sceneId = await seedScene()
    const onSubmitted = vi.fn()
    setup({ sceneId, lastStage: 5, onSubmitted })
    expect(screen.getByTestId('verify-stage-confirm')).toBeTruthy()
    fireEvent.click(screen.getByTestId('verify-confirm-save-only'))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1))
  })

  it('"Provider anfragen" needs the inline confirm before it commits', async () => {
    const sceneId = await seedScene()
    const onRequestProvider = vi.fn(async () => ({ ok: true }))
    setup({ sceneId, lastStage: 5, onRequestProvider })
    // First tap shows the confirm panel — no inquiry fired yet.
    fireEvent.click(screen.getByTestId('verify-confirm-request-provider'))
    expect(screen.getByTestId('verify-confirm-inquiry-panel')).toBeTruthy()
    expect(onRequestProvider).not.toHaveBeenCalled()
    // Second tap on the commit button fires the inquiry.
    fireEvent.click(screen.getByTestId('verify-confirm-inquiry-commit'))
    await waitFor(() => expect(onRequestProvider).toHaveBeenCalledTimes(1))
  })

  it('a double-tapped "Erstmal speichern" submits exactly once', async () => {
    const sceneId = await seedScene()
    const onSubmitted = vi.fn()
    setup({ sceneId, lastStage: 5, onSubmitted })
    const cta = screen.getByTestId('verify-confirm-save-only')
    fireEvent.click(cta)
    fireEvent.click(cta)
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(onSubmitted).toHaveBeenCalledTimes(1)
  })
})

describe('VerifySheet — resume (App-Kill / Re-Enter)', () => {
  it('opens at the persisted lastStage', () => {
    setup({ lastStage: 2 })
    expect(screen.getByTestId('verify-stage-measure')).toBeTruthy()
    expect(screen.getByTestId('verify-step-dot-2').getAttribute('data-state')).toBe('active')
  })

  it('an approved scene re-opens fresh at Welcome', () => {
    setup({ lastStage: 4, verifyState: 'approved' })
    expect(screen.getByTestId('verify-stage-welcome')).toBeTruthy()
  })
})

// ── F14 · pure navigation persists the resume stage ────────────────────────
describe('VerifySheet — navigation persists last_stage (F14)', () => {
  it('a pure Weiter navigation (no edit) persists customer_verify_last_stage', async () => {
    const sceneId = await seedScene()
    const repo = getSpatialSceneRepository('in-memory')
    setup({ sceneId })

    // Welcome → Maße → Layout — three pure navigations, zero edits.
    fireEvent.click(screen.getByTestId('verify-primary-cta')) // → 2
    fireEvent.click(screen.getByTestId('verify-primary-cta')) // → 3
    expect(screen.getByTestId('verify-stage-layout')).toBeTruthy()

    // The resume column must reflect the furthest stage SEEN, not Welcome.
    await waitFor(async () => {
      const scene = await repo.findById(sceneId)
      expect(scene?.customerVerifyLastStage).toBe(3)
    })
  })

  it('navigating back does NOT lower the persisted furthest stage (F15 invariant)', async () => {
    const sceneId = await seedScene()
    const repo = getSpatialSceneRepository('in-memory')
    setup({ sceneId })

    fireEvent.click(screen.getByTestId('verify-primary-cta')) // → 2
    fireEvent.click(screen.getByTestId('verify-primary-cta')) // → 3
    fireEvent.click(screen.getByTestId('verify-back')) // ← 2 (back-step)
    expect(screen.getByTestId('verify-stage-measure')).toBeTruthy()

    // Furthest-reached stays 3 even though the customer is now back at 2 —
    // a resume must never land BEFORE the furthest stage the customer saw.
    await waitFor(async () => {
      const scene = await repo.findById(sceneId)
      expect(scene?.customerVerifyLastStage).toBe(3)
    })
  })
})

describe('VerifySheet — Welcome validation paths', () => {
  it('the `unrenderable` path disables the forward CTA', () => {
    setup({ scene: unrenderableRoom() })
    const welcome = screen.getByTestId('verify-stage-welcome')
    expect(welcome.getAttribute('data-path')).toBe('unrenderable')
    expect(screen.getByTestId('verify-primary-cta').hasAttribute('disabled')).toBe(true)
  })

  it('the `ok` path enables the forward CTA', () => {
    setup({ scene: okRoom() })
    expect(screen.getByTestId('verify-stage-welcome').getAttribute('data-path')).toBe('ok')
    expect(screen.getByTestId('verify-primary-cta').hasAttribute('disabled')).toBe(false)
  })
})

describe('VerifySheet — dismiss', () => {
  it('"Skip" calls onClose', () => {
    const onClose = vi.fn()
    setup({ onClose })
    fireEvent.click(screen.getByTestId('verify-skip'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
