// @vitest-environment jsdom
/**
 * Tests for the Phase-3 dev POC screen — `/dev/spatial-verify`.
 *
 * The screen is the verification-parity surface for the Customer-Verify-Flow:
 * it mounts `<VerifySheet>` against a synthetic canonical bathroom scene so the
 * complete 5-stage flow runs in a real browser surface (the missing Phase-3
 * counterpart of `/dev/spatial-poc` and `/dev/spatial-edit`).
 *
 * These tests verify the screen mounts without crashing, the VerifySheet
 * appears, and Stage navigation walks the five stages. `<CanonicalSceneRoot>`
 * and `<SurfaceTapLayer>` mount a real `<Canvas>` (WebGL — unavailable under
 * jsdom) so both are mocked to passthrough.
 *
 * Because `<CanonicalSceneRoot>` is mocked, it does NOT hydrate the canonical
 * scene store from its `scene` prop — `useVerifyFlow` reads `resolved` from
 * that store. The tests hydrate it directly (mirroring exactly what the real
 * renderer does in the browser) so the Stage-1 sanity summary resolves and the
 * forward CTA is enabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))
vi.mock('../../../src/hooks/useHaptics', () => ({
  useHaptics: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}))
vi.mock('../../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))
vi.mock('../../../src/components/spatial/three/canonical/CanonicalSceneRoot', () => ({
  CanonicalSceneRoot: ({ children }: { children?: ReactNode }) => (
    <div data-testid="canonical-scene-root">{children}</div>
  ),
}))
vi.mock('../../../src/components/spatial/three/canonical/SurfaceTapLayer', () => ({
  SurfaceTapLayer: () => null,
}))

// Imported after the mocks are registered.
const { default: SpatialVerifyPocScreen } = await import(
  '../../../src/screens/dev/SpatialVerifyPocScreen.tsx'
)
const { resetSpatialSceneRepository } = await import(
  '../../../src/lib/spatial/canonical/repository/registry.ts'
)
const { __testOnly_resetSession } = await import('../../../src/lib/session.ts')
const { useCanonicalSceneStore } = await import(
  '../../../src/lib/spatial/canonical/store/sceneStore.ts'
)
const { useEditHistoryStore } = await import(
  '../../../src/lib/spatial/canonical/store/editHistoryStore.ts'
)
const { STANDARD_VARIANTS } = await import(
  '../../../src/lib/spatial/canonical/types/variants.ts'
)
const { makeRoom, makeWall, makeOpening } = await import(
  './canonical/__helpers__/sceneFactory.ts'
)

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

beforeEach(() => {
  cleanup()
  resetSpatialSceneRepository()
  __testOnly_resetSession()
  useEditHistoryStore.getState().clear()
  // `<CanonicalSceneRoot>` is mocked → it never hydrates the canonical store.
  // `useVerifyFlow` reads `resolved` from the store, so hydrate it directly
  // (mirrors what the real renderer does in the browser).
  useCanonicalSceneStore.getState().setScene(okRoom())
  useCanonicalSceneStore.getState().setOverrides([])
  useCanonicalSceneStore.getState().setVariants([
    { id: STANDARD_VARIANTS.BASE_ROOMPLAN, display_name: 'Scan', is_default: true },
    {
      id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS,
      display_name: 'Korrekturen',
      is_default: false,
    },
  ])
  useCanonicalSceneStore.getState().setActiveVariantId(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
})
afterEach(cleanup)

/** The text the dev panel shows for a given `sceneId`-style label row. */
function panelValueFor(label: string): string {
  const row = screen
    .getAllByText(label)
    .map((el) => el.nextElementSibling?.textContent ?? '')
  return row[0] ?? ''
}

/**
 * Render the screen and wait for the async InMemory scene-seed `setState` to
 * settle — keeps every test out of the un-acted-update warning.
 */
async function renderSettled(): Promise<void> {
  render(<SpatialVerifyPocScreen />)
  await waitFor(() => {
    expect(panelValueFor('sceneId').startsWith('—')).toBe(false)
  })
}

describe('SpatialVerifyPocScreen', () => {
  it('renders without crashing and mounts the VerifySheet', async () => {
    await renderSettled()
    expect(screen.getByTestId('verify-sheet')).toBeTruthy()
    // The dev panel + role switcher are present.
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  it('opens the verify flow at Stage 1 (Welcome)', async () => {
    await renderSettled()
    expect(screen.getByTestId('verify-stage-welcome')).toBeTruthy()
    expect(screen.getByTestId('verify-step-dot-1').getAttribute('data-state')).toBe('active')
  })

  it('seeds a real scene id once the InMemory repository row is created', async () => {
    await renderSettled()
    // The async-created `spatial_scenes` row id is shown in the dev panel.
    expect(panelValueFor('sceneId').length).toBeGreaterThan(0)
  })

  it('walks Stage navigation 1 → 2 → 3 → 4 → 5 through the POC', async () => {
    await renderSettled()
    // Stage 1 → 2
    fireEvent.click(screen.getByTestId('verify-primary-cta'))
    expect(screen.getByTestId('verify-stage-measure')).toBeTruthy()
    // Stage 2 → 3
    fireEvent.click(screen.getByTestId('verify-primary-cta'))
    expect(screen.getByTestId('verify-stage-layout')).toBeTruthy()
    // Stage 3 → 4
    fireEvent.click(screen.getByTestId('verify-primary-cta'))
    expect(screen.getByTestId('verify-stage-pins')).toBeTruthy()
    // Stage 4 → 5 (Confirm — owns its own actions, no shared CTA)
    fireEvent.click(screen.getByTestId('verify-primary-cta'))
    expect(screen.getByTestId('verify-stage-confirm')).toBeTruthy()
    expect(screen.queryByTestId('verify-primary-cta')).toBeNull()
  })

  it('the Stage-1 Quality-Detail seam is wired (badge is interactive)', async () => {
    await renderSettled()
    const badge = screen.getByTestId('quality-score-badge')
    // The POC passes `onOpenQualityDetail` → the badge renders as a button.
    expect(badge.tagName).toBe('BUTTON')
  })
})
