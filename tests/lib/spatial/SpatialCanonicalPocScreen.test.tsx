// @vitest-environment jsdom
/**
 * Tests for the Block R6 dev POC screen — `/dev/spatial-poc`.
 *
 * The screen is a verification surface that hydrates a representative
 * canonical `RoomScene` into `<CanonicalSceneRoot>`. These tests verify the
 * screen mounts without crashing and that the demo scene it builds exercises
 * every Phase-1.5 renderer path (procedural assets, GLB furniture, PBR
 * material overrides, a real lighting preset, HDRI IBL, post-FX).
 *
 * `<CanonicalSceneRoot>` and `<PostProcessing>` are mocked: a real `<Canvas>`
 * needs a WebGL context that jsdom cannot provide. The mock captures the
 * props the screen passes so the demo-scene shape is asserted directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import type { CanonicalSceneRootProps } from '../../../src/components/spatial/three/canonical/CanonicalSceneRoot.tsx'

// ── Capture the props passed to <CanonicalSceneRoot> ─────────────────────────
const sceneRootCalls: CanonicalSceneRootProps[] = []

vi.mock('../../../src/components/spatial/three/canonical/CanonicalSceneRoot', () => ({
  CanonicalSceneRoot: (props: CanonicalSceneRootProps) => {
    sceneRootCalls.push(props)
    // Render the children so the mocked <PostProcessing> mounts too.
    return <div data-testid="canonical-scene-root">{props.children}</div>
  },
}))

vi.mock('../../../src/components/spatial/three/canonical/postfx/PostProcessing', () => ({
  PostProcessing: () => <div data-testid="post-processing" />,
}))

// Imported after the mocks are registered.
const { default: SpatialCanonicalPocScreen } = await import(
  '../../../src/screens/dev/SpatialCanonicalPocScreen.tsx'
)

beforeEach(() => {
  sceneRootCalls.length = 0
})
afterEach(cleanup)

/** The latest props the screen handed to <CanonicalSceneRoot>. */
function latestProps(): CanonicalSceneRootProps {
  const p = sceneRootCalls[sceneRootCalls.length - 1]
  if (!p) throw new Error('CanonicalSceneRoot was never rendered')
  return p
}

describe('SpatialCanonicalPocScreen', () => {
  it('renders without crashing and mounts the canonical scene + post-FX', () => {
    render(<SpatialCanonicalPocScreen />)
    expect(screen.getByTestId('canonical-scene-root')).toBeTruthy()
    expect(screen.getByTestId('post-processing')).toBeTruthy()
  })

  it('hydrates a scene with walls, a floor, a ceiling and openings', () => {
    render(<SpatialCanonicalPocScreen />)
    const scene = latestProps().scene
    expect(scene).not.toBeNull()
    expect(scene!.walls.length).toBeGreaterThanOrEqual(4)
    expect(scene!.floor).toBeTruthy()
    expect(scene!.ceiling).toBeTruthy()
    // A door + a window opening across the walls.
    const openings = scene!.walls.flatMap((w) => w.openings)
    expect(openings.some((o) => o.type === 'door')).toBe(true)
    expect(openings.some((o) => o.type === 'window')).toBe(true)
  })

  it('hydrates free objects mixing procedural assets and GLB furniture', () => {
    render(<SpatialCanonicalPocScreen />)
    const objects = latestProps().scene!.free_objects
    expect(objects.length).toBeGreaterThanOrEqual(4)
    // Procedural sanitary slug (R2).
    expect(objects.some((o) => o.asset_id === 'sanitary-toilet-standard-floor')).toBe(true)
    // GLB furniture slugs (R4) — real Polyhaven CC0 models.
    expect(objects.some((o) => o.asset_id === 'furn-sofa-3seater-fabric-grey')).toBe(true)
    expect(objects.some((o) => o.asset_id === 'furn-armchair-fabric-rounded')).toBe(true)
  })

  it('applies catalog material overrides to walls, floor and ceiling (R5)', () => {
    render(<SpatialCanonicalPocScreen />)
    const scene = latestProps().scene!
    expect(scene.walls.every((w) => typeof w.material_id === 'string')).toBe(true)
    expect(typeof scene.floor.material_id).toBe('string')
    expect(typeof scene.ceiling.material_id).toBe('string')
  })

  it('enables a real lighting preset and HDRI IBL + post-FX', () => {
    render(<SpatialCanonicalPocScreen />)
    const props = latestProps()
    expect(props.lightingPresetId).toBe('modern-bath')
    expect(props.presetHdriEnabled).toBe(true)
  })

  it('the dev panel switches the wall material live', () => {
    render(<SpatialCanonicalPocScreen />)
    const before = latestProps().scene!.walls[0]!.material_id
    const selects = screen.getAllByRole('combobox')
    // First combobox is the wall-material picker.
    fireEvent.change(selects[0]!, { target: { value: 'wall-marble' } })
    const after = latestProps().scene!.walls[0]!.material_id
    expect(after).toBe('wall-marble')
    expect(after).not.toBe(before)
  })

  it('the dev panel switches the lighting preset live', () => {
    render(<SpatialCanonicalPocScreen />)
    const selects = screen.getAllByRole('combobox')
    // Second combobox is the lighting-preset picker.
    fireEvent.change(selects[1]!, { target: { value: 'golden-hour' } })
    expect(latestProps().lightingPresetId).toBe('golden-hour')
  })
})
