import { describe, it, expect } from 'vitest'
import {
  runQualityEngine,
  bucketForScore,
  QUALITY_THRESHOLDS,
  QUALITY_WEIGHTS,
  ruleTooFewWalls,
  ruleAreaImplausible,
  ruleCeilingImplausible,
  ruleDoorDimensionsUnusual,
  ruleWindowDimensionsUnusual,
  ruleWallCoverageLow,
  ruleLowConfidence,
  type QualityInput,
  type MeshSummary,
} from '../../../src/lib/spatial'
import type {
  ScanRoom,
  ScanSurface,
  ScanMeasurement,
  ScanSurfaceKind,
} from '../../../src/lib/spatial'

const SCAN_ID = 'scan_test'
const ROOM_ID = 'room_test'

function room(overrides: Partial<ScanRoom> = {}): ScanRoom {
  return {
    id: ROOM_ID,
    scanId: SCAN_ID,
    name: 'Wohnzimmer',
    areaM2Estimated: 22,
    areaM2Verified: null,
    ceilingHEstimated: 2.6,
    ceilingHVerified: null,
    floorAnchor: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function surface(
  kind: ScanSurfaceKind,
  overrides: Partial<ScanSurface> = {},
): ScanSurface {
  return {
    id: 'srf_' + Math.random().toString(36).slice(2, 8),
    roomId: ROOM_ID,
    surfaceExternalId: 'wall_' + Math.random().toString(36).slice(2, 6),
    kind,
    dimWEstimated: kind === 'wall' ? 4 : kind === 'door' ? 0.9 : 1.2,
    dimHEstimated: kind === 'wall' ? 2.6 : kind === 'door' ? 2.1 : 1.4,
    dimWVerified: null,
    dimHVerified: null,
    transform: null,
    status: 'estimated_roomplan',
    confidence: 0.85,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeInput(args: {
  rooms?: ScanRoom[]
  surfaces?: ScanSurface[]
  measurements?: ScanMeasurement[]
  meshSummary?: MeshSummary
} = {}): QualityInput {
  return {
    rooms: args.rooms ?? [room()],
    surfaces: args.surfaces ?? [
      surface('wall'),
      surface('wall'),
      surface('wall'),
      surface('wall'),
      surface('door'),
      surface('window'),
    ],
    measurements: args.measurements ?? [],
    meshSummary: args.meshSummary,
  }
}

describe('quality engine — rule isolation', () => {
  it('ruleTooFewWalls fires when <4 walls', () => {
    const input = makeInput({ surfaces: [surface('wall'), surface('wall'), surface('door')] })
    expect(ruleTooFewWalls(input)?.warning).toBe('too_few_walls')
  })
  it('ruleTooFewWalls silent at exactly 4 walls', () => {
    const input = makeInput({
      surfaces: [surface('wall'), surface('wall'), surface('wall'), surface('wall')],
    })
    expect(ruleTooFewWalls(input)).toBeNull()
  })

  it('ruleAreaImplausible fires below threshold', () => {
    const input = makeInput({ rooms: [room({ areaM2Estimated: 2 })] })
    expect(ruleAreaImplausible(input)?.warning).toBe('area_implausible')
  })
  it('ruleAreaImplausible fires above threshold', () => {
    const input = makeInput({ rooms: [room({ areaM2Estimated: 250 })] })
    expect(ruleAreaImplausible(input)?.warning).toBe('area_implausible')
  })
  it('ruleAreaImplausible silent in band', () => {
    const input = makeInput({ rooms: [room({ areaM2Estimated: 30 })] })
    expect(ruleAreaImplausible(input)).toBeNull()
  })
  it('ruleAreaImplausible prefers verified over estimated', () => {
    const input = makeInput({
      rooms: [room({ areaM2Estimated: 999, areaM2Verified: 30 })],
    })
    expect(ruleAreaImplausible(input)).toBeNull()
  })
  it('ruleAreaImplausible silent when both null', () => {
    const input = makeInput({
      rooms: [room({ areaM2Estimated: null, areaM2Verified: null })],
    })
    expect(ruleAreaImplausible(input)).toBeNull()
  })

  it('ruleCeilingImplausible fires below 2.0 m', () => {
    const input = makeInput({ rooms: [room({ ceilingHEstimated: 1.5 })] })
    expect(ruleCeilingImplausible(input)?.warning).toBe('ceiling_implausible')
  })
  it('ruleCeilingImplausible fires above 4.5 m', () => {
    const input = makeInput({ rooms: [room({ ceilingHEstimated: 6 })] })
    expect(ruleCeilingImplausible(input)?.warning).toBe('ceiling_implausible')
  })
  it('ruleCeilingImplausible silent at exact boundary 2.0 m', () => {
    const input = makeInput({ rooms: [room({ ceilingHEstimated: 2.0 })] })
    expect(ruleCeilingImplausible(input)).toBeNull()
  })

  it('ruleDoorDimensionsUnusual fires on too-narrow door', () => {
    const input = makeInput({
      surfaces: [surface('door', { dimWEstimated: 0.4, dimHEstimated: 2.0 })],
    })
    expect(ruleDoorDimensionsUnusual(input)?.warning).toBe('door_dimensions_unusual')
  })
  it('ruleDoorDimensionsUnusual silent on plausible door', () => {
    const input = makeInput({
      surfaces: [surface('door', { dimWEstimated: 0.9, dimHEstimated: 2.1 })],
    })
    expect(ruleDoorDimensionsUnusual(input)).toBeNull()
  })
  it('ruleDoorDimensionsUnusual silent when no doors present', () => {
    const input = makeInput({ surfaces: [surface('wall'), surface('wall'), surface('wall'), surface('wall')] })
    expect(ruleDoorDimensionsUnusual(input)).toBeNull()
  })

  it('ruleWindowDimensionsUnusual fires on absurd window', () => {
    const input = makeInput({
      surfaces: [surface('window', { dimWEstimated: 5, dimHEstimated: 3 })],
    })
    expect(ruleWindowDimensionsUnusual(input)?.warning).toBe('window_dimensions_unusual')
  })
  it('ruleWindowDimensionsUnusual silent on plausible window', () => {
    const input = makeInput({
      surfaces: [surface('window', { dimWEstimated: 1.2, dimHEstimated: 1.4 })],
    })
    expect(ruleWindowDimensionsUnusual(input)).toBeNull()
  })

  it('ruleWallCoverageLow fires when mesh coverage < 0.7', () => {
    const input = makeInput({ meshSummary: { wallCoveragePct: 0.5 } })
    expect(ruleWallCoverageLow(input)?.warning).toBe('wall_coverage_low')
  })
  it('ruleWallCoverageLow silent without mesh (Plan B path)', () => {
    expect(ruleWallCoverageLow(makeInput())).toBeNull()
  })
  it('ruleWallCoverageLow silent at floor (0.7)', () => {
    const input = makeInput({ meshSummary: { wallCoveragePct: 0.7 } })
    expect(ruleWallCoverageLow(input)).toBeNull()
  })

  it('ruleLowConfidence fires when mesh avg < 0.5', () => {
    const input = makeInput({ meshSummary: { averageConfidence: 0.3 } })
    expect(ruleLowConfidence(input)?.warning).toBe('low_confidence')
  })
  it('ruleLowConfidence falls back to surface-confidence average without mesh', () => {
    const input = makeInput({
      surfaces: [
        surface('wall', { confidence: 0.2 }),
        surface('wall', { confidence: 0.2 }),
        surface('wall', { confidence: 0.3 }),
        surface('wall', { confidence: 0.3 }),
      ],
    })
    expect(ruleLowConfidence(input)?.warning).toBe('low_confidence')
  })
  it('ruleLowConfidence silent on high-confidence surfaces', () => {
    const input = makeInput({
      surfaces: [
        surface('wall', { confidence: 0.9 }),
        surface('wall', { confidence: 0.95 }),
        surface('wall', { confidence: 0.85 }),
        surface('wall', { confidence: 0.92 }),
      ],
    })
    expect(ruleLowConfidence(input)).toBeNull()
  })
  it('ruleLowConfidence silent when no confidences present (no mesh, no surface data)', () => {
    const input = makeInput({
      surfaces: [
        surface('wall', { confidence: null }),
        surface('wall', { confidence: null }),
      ],
    })
    expect(ruleLowConfidence(input)).toBeNull()
  })
})

describe('quality engine — score + bucket', () => {
  it('clean scan: score 100, bucket excellent, no warnings', () => {
    const result = runQualityEngine(
      makeInput({ meshSummary: { wallCoveragePct: 0.95, averageConfidence: 0.9 } }),
    )
    expect(result.score).toBe(100)
    expect(result.bucket).toBe('excellent')
    expect(result.warnings).toEqual([])
  })

  it('subtracts every fired weight from 100 and never goes below 0', () => {
    const input = makeInput({
      rooms: [room({ areaM2Estimated: 2, ceilingHEstimated: 1 })],
      surfaces: [
        surface('door', { dimWEstimated: 0.2 }),
        surface('window', { dimWEstimated: 6 }),
        surface('wall', { confidence: 0.1 }),
        surface('wall', { confidence: 0.1 }),
      ],
      meshSummary: { wallCoveragePct: 0.1, averageConfidence: 0.1 },
    })
    const result = runQualityEngine(input)
    // All seven rules fire → 25+18+15+9+9+14+10 = 100 penalty → score clamps at 0.
    expect(result.score).toBe(0)
    expect(result.bucket).toBe('poor')
    expect(result.warnings.length).toBe(7)
  })

  it('bucketForScore boundaries match plan (≥85 excellent / ≥70 good / ≥50 fair / else poor)', () => {
    expect(bucketForScore(100)).toBe('excellent')
    expect(bucketForScore(85)).toBe('excellent')
    expect(bucketForScore(84)).toBe('good')
    expect(bucketForScore(70)).toBe('good')
    expect(bucketForScore(69)).toBe('fair')
    expect(bucketForScore(50)).toBe('fair')
    expect(bucketForScore(49)).toBe('poor')
    expect(bucketForScore(0)).toBe('poor')
  })

  it('warnings are alphabetically sorted for byte-stable output', () => {
    const result = runQualityEngine(
      makeInput({
        rooms: [room({ areaM2Estimated: 1 })],
        surfaces: [
          surface('wall'),
          surface('wall'),
          surface('wall'),
          surface('door', { dimWEstimated: 0.2 }),
        ],
        meshSummary: { wallCoveragePct: 0.1, averageConfidence: 0.9 },
      }),
    )
    const sorted = [...result.warnings].sort((a, b) => a.localeCompare(b))
    expect(result.warnings).toEqual(sorted)
  })

  it('reports the engine version', () => {
    expect(runQualityEngine(makeInput()).engineVersion).toBe('v1.0.0')
  })

  it('Plan B path: works without mesh summary, no mesh-rules fire', () => {
    const result = runQualityEngine(makeInput())
    expect(result.warnings).not.toContain('wall_coverage_low')
    expect(result.warnings).not.toContain('low_confidence')
  })

  it('weight table sums to 100 (so a maximum-failure scan saturates to 0)', () => {
    const total = Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(total).toBe(100)
  })

  it('thresholds object is frozen (safety against accidental mutation)', () => {
    expect(Object.isFrozen(QUALITY_THRESHOLDS)).toBe(true)
  })
})
