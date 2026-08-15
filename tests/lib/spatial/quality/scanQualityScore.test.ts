import { describe, it, expect } from 'vitest'
import {
  computeCustomerScanQuality,
  customerLabelForScore,
  CUSTOMER_QUALITY_THRESHOLDS,
  type QualityInput,
} from '../../../../src/lib/spatial'
import type {
  ScanRoom,
  ScanSurface,
  ScanSurfaceKind,
} from '../../../../src/lib/spatial'

const ROOM_ID = 'room_customer_q'
const SCAN_ID = 'scan_customer_q'

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
    surfaceExternalId: 'sx_' + Math.random().toString(36).slice(2, 6),
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

function perfectInput(): QualityInput {
  // Four walls + plausible area/ceiling + door + window → engine returns 100.
  return {
    rooms: [room()],
    surfaces: [
      surface('wall'),
      surface('wall'),
      surface('wall'),
      surface('wall'),
      surface('door'),
      surface('window'),
    ],
    measurements: [],
  }
}

describe('customerLabelForScore — three-tier mapping', () => {
  it('score ≥ 80 maps to "high"', () => {
    expect(customerLabelForScore(80)).toBe('high')
    expect(customerLabelForScore(100)).toBe('high')
  })

  it('score = 79 maps to "medium" (just below highMin)', () => {
    expect(customerLabelForScore(79)).toBe('medium')
  })

  it('score = 50 maps to "medium" (mediumMin boundary, inclusive)', () => {
    expect(customerLabelForScore(50)).toBe('medium')
  })

  it('score = 49 maps to "low" (just below mediumMin)', () => {
    expect(customerLabelForScore(49)).toBe('low')
  })

  it('score = 0 maps to "low"', () => {
    expect(customerLabelForScore(0)).toBe('low')
  })

  it('negative score is clamped to 0 then mapped to "low"', () => {
    expect(customerLabelForScore(-25)).toBe('low')
  })

  it('score > 100 is clamped to 100 then mapped to "high"', () => {
    expect(customerLabelForScore(150)).toBe('high')
  })

  it('non-finite input (NaN, Infinity) is treated as 0 → "low"', () => {
    // Defensive: runQualityEngine never returns non-finite, so any NaN/Infinity
    // is a corrupted upstream value. Map to 'low' (worst tier) rather than
    // accidentally elevating to 'high' via Infinity-clamp.
    expect(customerLabelForScore(Number.NaN)).toBe('low')
    expect(customerLabelForScore(Number.POSITIVE_INFINITY)).toBe('low')
    expect(customerLabelForScore(Number.NEGATIVE_INFINITY)).toBe('low')
  })

  it('fractional score is rounded before mapping (79.5 → 80 → "high")', () => {
    expect(customerLabelForScore(79.5)).toBe('high')
    expect(customerLabelForScore(49.49)).toBe('low')
    expect(customerLabelForScore(49.5)).toBe('medium') // rounds to 50
  })
})

describe('computeCustomerScanQuality — integration with runQualityEngine', () => {
  it('perfect input → score 100, label "high"', () => {
    const result = computeCustomerScanQuality(perfectInput())
    expect(result.score).toBe(100)
    expect(result.label).toBe('high')
  })

  it('≤3 walls triggers ruleTooFewWalls (-25) → score 75, label "medium"', () => {
    const input: QualityInput = {
      rooms: [room()],
      surfaces: [surface('wall'), surface('wall'), surface('wall'), surface('door')],
      measurements: [],
    }
    const result = computeCustomerScanQuality(input)
    expect(result.score).toBe(75)
    expect(result.label).toBe('medium')
  })

  it('multiple rule hits drop score below 50 → label "low"', () => {
    // too_few_walls (-25) + area_implausible (-18) + ceiling_implausible (-15) = -58 → 42
    const input: QualityInput = {
      rooms: [room({ areaM2Estimated: 250, ceilingHEstimated: 5.5 })],
      surfaces: [surface('wall'), surface('wall'), surface('door')],
      measurements: [],
    }
    const result = computeCustomerScanQuality(input)
    expect(result.score).toBeLessThan(CUSTOMER_QUALITY_THRESHOLDS.mediumMin)
    expect(result.label).toBe('low')
  })

  it('exposes CUSTOMER_QUALITY_THRESHOLDS as frozen object', () => {
    expect(CUSTOMER_QUALITY_THRESHOLDS.highMin).toBe(80)
    expect(CUSTOMER_QUALITY_THRESHOLDS.mediumMin).toBe(50)
    expect(Object.isFrozen(CUSTOMER_QUALITY_THRESHOLDS)).toBe(true)
  })
})
