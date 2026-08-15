/**
 * Tests for catalog/instancing.ts (Block 1.20 · BatchedMesh planning).
 */
import { describe, it, expect } from 'vitest'

import {
  INSTANCING_THRESHOLD,
  planAssetInstancing,
  shouldBatchAsset,
} from '../../../../../src/lib/spatial/canonical/catalog/instancing.ts'

describe('instancing', () => {
  it('batches an asset only above the threshold', () => {
    expect(shouldBatchAsset(INSTANCING_THRESHOLD)).toBe(false)
    expect(shouldBatchAsset(INSTANCING_THRESHOLD + 1)).toBe(true)
  })

  it('partitions scene assets into batched vs individual draw groups', () => {
    // 6 dining chairs → batched; 2 tables, 1 sofa → individual.
    const plan = planAssetInstancing([
      'chair', 'chair', 'chair', 'chair', 'chair', 'chair',
      'table', 'table',
      'sofa',
    ])
    expect(plan.batched.get('chair')).toBe(6)
    expect(plan.batched.has('table')).toBe(false)
    expect(plan.individual.get('table')).toBe(2)
    expect(plan.individual.get('sofa')).toBe(1)
  })

  it('ignores null / undefined asset ids (generic cuboids)', () => {
    const plan = planAssetInstancing(['chair', null, undefined, 'chair'])
    expect(plan.individual.get('chair')).toBe(2)
    expect(plan.batched.size).toBe(0)
    expect(plan.individual.size).toBe(1)
  })

  it('returns empty groups for an empty scene', () => {
    const plan = planAssetInstancing([])
    expect(plan.batched.size).toBe(0)
    expect(plan.individual.size).toBe(0)
  })
})
