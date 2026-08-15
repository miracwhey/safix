/**
 * Surface-tap resolution tests — `surfaceTap.ts` (Block 2.12 host).
 *
 * Covers adapter group-name parsing + ancestor-chain walking, the two paths
 * a raycast hit can take into the canonical scene-graph.
 */
import { describe, it, expect } from 'vitest'

import {
  objectCandidatesByDepth,
  parseAdapterGroupName,
  resolveTappedSurface,
  tappedKindToMaterialSurface,
  tappedKindToPickerSurfaceType,
  type NamedObject,
  type ProbeSample,
} from '../../../../src/components/spatial/three/canonical/surfaceTap'

describe('parseAdapterGroupName', () => {
  it('parses each adapter group kind', () => {
    expect(parseAdapterGroupName('wall-w_s')).toEqual({ kind: 'wall', nodeId: 'w_s' })
    expect(parseAdapterGroupName('floor-poc-floor')).toEqual({ kind: 'floor', nodeId: 'poc-floor' })
    expect(parseAdapterGroupName('ceiling-c1')).toEqual({ kind: 'ceiling', nodeId: 'c1' })
    expect(parseAdapterGroupName('object-obj-toilet')).toEqual({
      kind: 'object',
      nodeId: 'obj-toilet',
    })
  })

  it('returns null for non-adapter names', () => {
    expect(parseAdapterGroupName('canonical-scene-root')).toBeNull()
    expect(parseAdapterGroupName('visual-diff-overlay')).toBeNull()
    expect(parseAdapterGroupName(undefined)).toBeNull()
    expect(parseAdapterGroupName('')).toBeNull()
  })
})

describe('resolveTappedSurface', () => {
  it('resolves a hit on the adapter group itself', () => {
    const hit: NamedObject = { name: 'wall-w_n' }
    expect(resolveTappedSurface(hit)).toEqual({ kind: 'wall', nodeId: 'w_n' })
  })

  it('walks the ancestor chain from a leaf mesh up to the adapter group', () => {
    const adapterGroup: NamedObject = { name: 'object-obj-bathtub', parent: null }
    const innerGroup: NamedObject = { name: '', parent: adapterGroup }
    const leafMesh: NamedObject = { name: 'mesh', parent: innerGroup }
    expect(resolveTappedSurface(leafMesh)).toEqual({ kind: 'object', nodeId: 'obj-bathtub' })
  })

  it('returns null when no ancestor is a canonical surface', () => {
    const root: NamedObject = { name: 'canonical-scene-root', parent: null }
    const helper: NamedObject = { name: 'grid-helper', parent: root }
    expect(resolveTappedSurface(helper)).toBeNull()
  })

  it('returns null for a null hit', () => {
    expect(resolveTappedSurface(null)).toBeNull()
    expect(resolveTappedSurface(undefined)).toBeNull()
  })

  it('does not loop forever on a deep / cyclic chain', () => {
    const a: NamedObject = { name: 'x' }
    const b: NamedObject = { name: 'y', parent: a }
    a.parent = b // cycle
    expect(resolveTappedSurface(a)).toBeNull()
  })
})

describe('objectCandidatesByDepth', () => {
  const sample = (
    kind: 'object' | 'wall' | 'floor' | null,
    nodeId: string,
    distance: number,
  ): ProbeSample => ({
    surface: kind ? { kind, nodeId } : null,
    distance,
  })

  it('returns distinct objects nearest-first (front → back) — the cycle order', () => {
    const samples: ProbeSample[] = [
      sample('object', 'chair', 4.2),
      sample('object', 'table', 3.1),
      sample('object', 'chair', 4.0),
    ]
    expect(objectCandidatesByDepth(samples).map((c) => c.nodeId)).toEqual(['table', 'chair'])
  })

  it('keeps the NEAREST hit distance when an object appears in several samples', () => {
    const samples: ProbeSample[] = [
      sample('object', 'chair', 5.0),
      sample('object', 'chair', 3.5),
      sample('object', 'chair', 4.0),
    ]
    const candidates = objectCandidatesByDepth(samples)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ nodeId: 'chair', distance: 3.5 })
  })

  it('ignores wall/floor/ceiling + null samples — only objects can be cycled', () => {
    const samples: ProbeSample[] = [
      sample('wall', 'w_n', 2.0),
      sample('floor', 'f1', 2.5),
      sample(null, '', Number.POSITIVE_INFINITY),
      sample('object', 'lamp', 3.0),
    ]
    expect(objectCandidatesByDepth(samples).map((c) => c.nodeId)).toEqual(['lamp'])
  })

  it('returns [] when no object lies under the probe (no cycle)', () => {
    expect(objectCandidatesByDepth([sample('wall', 'w_n', 1)])).toEqual([])
    expect(objectCandidatesByDepth([])).toEqual([])
  })
})

describe('kind mappers', () => {
  it('maps tapped kind → material command surface', () => {
    expect(tappedKindToMaterialSurface('wall')).toBe('wall')
    expect(tappedKindToMaterialSurface('object')).toBe('object')
  })

  it('maps tapped kind → picker surface type (object → fixture)', () => {
    expect(tappedKindToPickerSurfaceType('wall')).toBe('wall')
    expect(tappedKindToPickerSurfaceType('object')).toBe('fixture')
  })
})
