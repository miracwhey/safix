// @vitest-environment jsdom
/**
 * Spatial · V1.6.1 · ExampleRoomViewer contract (PR #951 review)
 *
 * Covers:
 *   - chrome renders (top-nav + hint + sheet + 4 Maß-Cells + 2 CTAs)
 *   - the SpatialSceneErrorBoundary swaps in the outline-fallback when
 *     `<CanonicalSceneRoot>` throws (HIGH review-fix)
 *   - on unmount the local cleanup resets the canonical scene store
 *     (MEDIUM review-fix · Viewer-local stale-store cleanup)
 *
 * The `<CanonicalSceneRoot>` mounts a real <Canvas> in production. The mock
 * here either renders a marker div (happy path) or throws on demand (boundary
 * path) so we exercise both branches without Three.js.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'

import { useCanonicalSceneStore } from '../../../../src/lib/spatial/canonical/store/sceneStore'

// The mock is hoisted by vitest; we drive its behaviour via a module-scope
// flag toggled before each render.
let throwOnSceneRender = false
vi.mock(
  '../../../../src/components/spatial/three/canonical/CanonicalSceneRoot',
  () => ({
    CanonicalSceneRoot: (): ReactElement => {
      if (throwOnSceneRender) {
        throw new Error('boom · simulated WebGL context loss')
      }
      return <div data-testid="canonical-scene-root-stub" />
    },
  }),
)

import ExampleRoomViewer from '../../../../src/components/spatial/customer/ExampleRoomViewer'

function defaultProps() {
  return {
    kind: 'bath' as const,
    onBack: vi.fn(),
    onClose: vi.fn(),
    onCreateProject: vi.fn(),
    onMeasureSelf: vi.fn(),
  }
}

describe('ExampleRoomViewer', () => {
  beforeEach(() => {
    throwOnSceneRender = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Reset the canonical scene store between tests so the cleanup assertion
    // is not contaminated by a previous render.
    useCanonicalSceneStore.setState({ scene: null, resolved: null })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useCanonicalSceneStore.setState({ scene: null, resolved: null })
  })

  it('renders top-nav, hint, sheet, four Maß-Cells, and two CTAs (happy path)', () => {
    render(<ExampleRoomViewer {...defaultProps()} />)
    expect(screen.getByTestId('example-room-viewer')).toBeTruthy()
    expect(screen.getByTestId('example-room-viewer-topnav')).toBeTruthy()
    expect(screen.getByTestId('example-room-viewer-hint')).toBeTruthy()
    expect(screen.getByTestId('example-room-viewer-sheet')).toBeTruthy()
    expect(screen.getByTestId('canonical-scene-root-stub')).toBeTruthy()

    // 4 Maß-Cells (Breite / Tiefe / Höhe / Fläche) — derived from bounds,
    // never hard-coded.
    expect(screen.getByTestId('example-room-measure-breite')).toBeTruthy()
    expect(screen.getByTestId('example-room-measure-tiefe')).toBeTruthy()
    expect(screen.getByTestId('example-room-measure-höhe')).toBeTruthy()
    expect(screen.getByTestId('example-room-measure-fläche')).toBeTruthy()

    // CTAs
    expect(screen.getByTestId('example-room-cta-create')).toBeTruthy()
    expect(screen.getByTestId('example-room-cta-measure')).toBeTruthy()

    // Fallback should NOT be visible on the happy path.
    expect(screen.queryByTestId('spatial-scene-fallback')).toBeNull()
  })

  it('renders the SceneErrorBoundary fallback when the scene root throws', () => {
    throwOnSceneRender = true
    render(<ExampleRoomViewer {...defaultProps()} />)
    expect(screen.getByTestId('spatial-scene-fallback')).toBeTruthy()
    // The Maß-Cells must stay usable — the user can still read measurements.
    expect(screen.getByTestId('example-room-measure-fläche')).toBeTruthy()
    expect(screen.getByTestId('example-room-cta-create')).toBeTruthy()
  })

  it('resets the canonical scene store on unmount (Viewer-local cleanup)', () => {
    const { unmount } = render(<ExampleRoomViewer {...defaultProps()} />)
    // Sanity: after the first paint the scene root has hydrated the store
    // with a non-null scene. Read via getState() so we are not subscribing.
    // (The CanonicalSceneRoot stub does NOT itself hydrate the store, so we
    // hydrate by hand to model the production behaviour before unmount.)
    useCanonicalSceneStore.setState({ scene: { sentinel: true } as never })
    expect(useCanonicalSceneStore.getState().scene).not.toBeNull()

    unmount()

    // The Viewer's unmount-effect must have wiped the store so a follow-up
    // consumer (Hub, picker) never reads a stale scene.
    expect(useCanonicalSceneStore.getState().scene).toBeNull()
    expect(useCanonicalSceneStore.getState().resolved).toBeNull()
  })
})
