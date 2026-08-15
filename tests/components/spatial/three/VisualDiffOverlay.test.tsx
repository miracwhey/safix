// @vitest-environment jsdom
/**
 * Render tests for the Block-2.12 `VisualDiffOverlay` — the L3 component that
 * tints added / removed / modified nodes.
 *
 * Like `ClearanceZoneOverlay`, the component returns only r3f intrinsics
 * (`<group>` / `<mesh>` / `<sphereGeometry>` / `<meshBasicMaterial>`) with no
 * r3f hooks, so it reconciles under jsdom without a real `<Canvas>`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import { VisualDiffOverlay } from '../../../../src/components/spatial/three/canonical/VisualDiffOverlay'
import {
  DIFF_MARKER_COLORS,
  type DiffMarker,
} from '../../../../src/lib/spatial/canonical/overrides/diff-markers'

const MARKERS: DiffMarker[] = [
  { node_id: 'o-new', kind: 'added', node_type: 'object', position: { x: 1, y: 0, z: 1 }, color: DIFF_MARKER_COLORS.added },
  { node_id: 'o-gone', kind: 'removed', node_type: 'object', position: { x: 2, y: 0, z: 2 }, color: DIFF_MARKER_COLORS.removed },
  { node_id: 'w1', kind: 'modified', node_type: 'wall', position: { x: 3, y: 1, z: 0 }, color: DIFF_MARKER_COLORS.modified },
]

afterEach(cleanup)

describe('VisualDiffOverlay', () => {
  it('renders one marker mesh per diff entry', () => {
    const { container } = render(<VisualDiffOverlay markers={MARKERS} enabled />)
    expect(container.querySelector('group[name="visual-diff-overlay"]')).toBeTruthy()
    expect(container.querySelectorAll('mesh')).toHaveLength(3)
    expect(container.querySelector('mesh[name="diff-marker-added-o-new"]')).toBeTruthy()
    expect(container.querySelector('mesh[name="diff-marker-removed-o-gone"]')).toBeTruthy()
    expect(container.querySelector('mesh[name="diff-marker-modified-w1"]')).toBeTruthy()
  })

  it('renders nothing when disabled', () => {
    const { container } = render(<VisualDiffOverlay markers={MARKERS} enabled={false} />)
    expect(container.querySelector('group[name="visual-diff-overlay"]')).toBeNull()
  })

  it('renders nothing when there are no markers', () => {
    const { container } = render(<VisualDiffOverlay markers={[]} enabled />)
    expect(container.querySelector('group[name="visual-diff-overlay"]')).toBeNull()
  })
})
