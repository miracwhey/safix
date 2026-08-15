/**
 * Verify-flow workflow orchestration — `spatialVerifyWorkflow.ts` (Block 3.1-3.4).
 *
 * Covers the stage model + navigation, the resume-target rule, the
 * `customer_verify_state` `not_started → in_progress` transition, measurement
 * validation, and — critically — the RBAC-gated `customer_corrections`
 * wall-correction command build (Block 3.4).
 */
import { describe, it, expect } from 'vitest'

import {
  VerifyStage,
  VERIFY_STAGES,
  VERIFY_STAGE_COUNT,
  isVerifyStage,
  nextStage,
  prevStage,
  resolveResumeStage,
  verifyStateAfterFirstEdit,
  planConfirmVerifyStateChain,
  validateMeasurement,
  readWallMeasurement,
  buildWallCorrectionCommand,
  VERIFY_MEASURE_MIN_M,
  VERIFY_MEASURE_MAX_M,
} from '../../../src/lib/spatial/workflow/spatialVerifyWorkflow'
import { canTransitionCustomerVerifyState } from '../../../src/lib/spatial/canonical/repository/spatialSceneFsm'
import { ResizeWallCommand } from '../../../src/lib/spatial/canonical/commands/ResizeWallCommand'
import { SpatialEditPermissionError } from '../../../src/lib/spatial/workflow/spatialEditPermissions'
import type { SpatialEditUser } from '../../../src/lib/spatial/workflow/spatialEditPermissions'
import { STANDARD_VARIANTS } from '../../../src/lib/spatial/canonical/types/variants'
import { makeRoom, makeWall } from './canonical/__helpers__/sceneFactory'

// ── Fixtures ───────────────────────────────────────────────────────────────

const CUSTOMER: SpatialEditUser = { userId: 'cust-1', role: 'customer', isOperator: false }
const PROVIDER: SpatialEditUser = { userId: 'prov-1', role: 'craftsman', isOperator: false }
const SIGNED_OUT: SpatialEditUser = { userId: null, role: null, isOperator: false }
const OPERATOR: SpatialEditUser = { userId: 'op-1', role: 'craftsman', isOperator: true }

// ── Stage model ────────────────────────────────────────────────────────────

describe('spatialVerifyWorkflow · stage model', () => {
  it('has 5 ordered stages', () => {
    expect(VERIFY_STAGE_COUNT).toBe(5)
    expect(VERIFY_STAGES).toEqual([1, 2, 3, 4, 5])
  })

  it('isVerifyStage accepts 1-5, rejects everything else', () => {
    expect(isVerifyStage(1)).toBe(true)
    expect(isVerifyStage(5)).toBe(true)
    expect(isVerifyStage(0)).toBe(false)
    expect(isVerifyStage(6)).toBe(false)
    expect(isVerifyStage(2.5)).toBe(false)
    expect(isVerifyStage('2')).toBe(false)
    expect(isVerifyStage(null)).toBe(false)
  })

  it('nextStage / prevStage walk the chain and clamp at the ends', () => {
    expect(nextStage(VerifyStage.Welcome)).toBe(VerifyStage.Measure)
    expect(nextStage(VerifyStage.Confirm)).toBeNull()
    expect(prevStage(VerifyStage.Measure)).toBe(VerifyStage.Welcome)
    expect(prevStage(VerifyStage.Welcome)).toBeNull()
  })
})

// ── Resume (App-Kill / Re-Enter) ───────────────────────────────────────────

describe('spatialVerifyWorkflow · resolveResumeStage', () => {
  it('starts at Welcome with no persisted stage', () => {
    expect(resolveResumeStage(null)).toBe(VerifyStage.Welcome)
    expect(resolveResumeStage(undefined)).toBe(VerifyStage.Welcome)
  })

  it('resumes at the persisted stage', () => {
    expect(resolveResumeStage(3)).toBe(VerifyStage.Layout)
    expect(resolveResumeStage(5)).toBe(VerifyStage.Confirm)
  })

  it('clamps an out-of-range persisted stage to Welcome (defensive)', () => {
    expect(resolveResumeStage(0)).toBe(VerifyStage.Welcome)
    expect(resolveResumeStage(99)).toBe(VerifyStage.Welcome)
  })

  it('an approved scene re-opens fresh at Welcome regardless of lastStage', () => {
    expect(resolveResumeStage(4, 'approved')).toBe(VerifyStage.Welcome)
  })

  it('an in-progress scene resumes at its last stage', () => {
    expect(resolveResumeStage(2, 'in_progress')).toBe(VerifyStage.Measure)
  })
})

// ── customer_verify_state FSM ──────────────────────────────────────────────

describe('spatialVerifyWorkflow · verifyStateAfterFirstEdit', () => {
  it('flips not_started → in_progress on the first edit', () => {
    expect(verifyStateAfterFirstEdit('not_started')).toBe('in_progress')
  })

  it('returns null when already in_progress (no re-transition)', () => {
    expect(verifyStateAfterFirstEdit('in_progress')).toBeNull()
  })

  it('returns null for terminal/other states (never throws)', () => {
    expect(verifyStateAfterFirstEdit('approved')).toBeNull()
    expect(verifyStateAfterFirstEdit('rejected')).toBeNull()
    expect(verifyStateAfterFirstEdit('expired')).toBeNull()
  })
})

// ── Stage-5 confirm FSM chain (Block 3.8 / 3.12) ───────────────────────────

describe('spatialVerifyWorkflow · planConfirmVerifyStateChain', () => {
  it('a no-edit customer (not_started) walks → in_progress → approved', () => {
    expect(planConfirmVerifyStateChain('not_started')).toEqual(['in_progress', 'approved'])
  })

  it('an edited customer (in_progress) walks → approved', () => {
    expect(planConfirmVerifyStateChain('in_progress')).toEqual(['approved'])
  })

  it('an already-approved scene needs no transition (empty chain)', () => {
    expect(planConfirmVerifyStateChain('approved')).toEqual([])
  })

  it('re-entry states (rejected / expired) walk via in_progress', () => {
    expect(planConfirmVerifyStateChain('rejected')).toEqual(['in_progress', 'approved'])
    expect(planConfirmVerifyStateChain('expired')).toEqual(['in_progress', 'approved'])
  })

  it('EVERY step of EVERY chain is a legal FSM edge (guard-safe)', () => {
    const states = ['not_started', 'in_progress', 'approved', 'rejected', 'expired'] as const
    for (const start of states) {
      const chain = planConfirmVerifyStateChain(start)
      let from = start
      for (const to of chain) {
        expect(canTransitionCustomerVerifyState(from, to)).toBe(true)
        from = to
      }
      // Every non-empty chain lands on `approved`.
      if (chain.length > 0) expect(chain[chain.length - 1]).toBe('approved')
    }
  })
})

// ── Measurement validation ─────────────────────────────────────────────────

describe('spatialVerifyWorkflow · validateMeasurement', () => {
  it('accepts a plausible value', () => {
    expect(validateMeasurement(2.5)).toEqual({ ok: true })
  })

  it('rejects a value below the minimum (Edge-Case · "zu klein")', () => {
    const v = validateMeasurement(0.05)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe('too_small')
  })

  it('rejects a value above the maximum', () => {
    const v = validateMeasurement(VERIFY_MEASURE_MAX_M + 1)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe('too_large')
  })

  it('rejects NaN / Infinity', () => {
    expect(validateMeasurement(Number.NaN).ok).toBe(false)
    expect(validateMeasurement(Number.POSITIVE_INFINITY).ok).toBe(false)
  })

  it('accepts exactly the boundary values', () => {
    expect(validateMeasurement(VERIFY_MEASURE_MIN_M).ok).toBe(true)
    expect(validateMeasurement(VERIFY_MEASURE_MAX_M).ok).toBe(true)
  })
})

// ── readWallMeasurement ────────────────────────────────────────────────────

describe('spatialVerifyWorkflow · readWallMeasurement', () => {
  it('reads length / height / thickness off a wall', () => {
    const room = makeRoom({
      walls: [makeWall({ id: 'w_s', height_m: 2.4, thickness_m: 0.18, length_m: 3.2 })],
    })
    expect(readWallMeasurement(room, 'w_s')).toEqual({
      lengthM: 3.2,
      heightM: 2.4,
      thicknessM: 0.18,
    })
  })

  it('returns null for an unknown wall id', () => {
    expect(readWallMeasurement(makeRoom(), 'no-such-wall')).toBeNull()
  })
})

// ── RBAC-gated wall-correction command (Block 3.4) ─────────────────────────

describe('spatialVerifyWorkflow · buildWallCorrectionCommand (RBAC)', () => {
  it('a customer gets a ResizeWallCommand targeting customer_corrections', () => {
    const room = makeRoom({
      walls: [makeWall({ id: 'w_s', height_m: 2.5, thickness_m: 0.15 })],
    })
    const result = buildWallCorrectionCommand(CUSTOMER, room, 'w_s', 2.7)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.command).toBeInstanceOf(ResizeWallCommand)
      // The command MUST target customer_corrections — never the active layer.
      expect(result.command.variantId).toBe(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
      expect(result.command.operation).toMatchObject({
        kind: 'resize_wall',
        wall_id: 'w_s',
        new_height_m: 2.7,
        // Thickness is carried through unchanged.
        new_thickness_m: 0.15,
      })
    }
  })

  it('an operator gets a command targeting operator_review (own writable layer)', () => {
    const room = makeRoom({ walls: [makeWall({ id: 'w_s' })] })
    const result = buildWallCorrectionCommand(OPERATOR, room, 'w_s', 2.6)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.command.variantId).toBe(STANDARD_VARIANTS.OPERATOR_REVIEW)
    }
  })

  it('a provider gets their own provider_*_annotations layer (still RBAC-correct)', () => {
    const room = makeRoom({ walls: [makeWall({ id: 'w_s' })] })
    const result = buildWallCorrectionCommand(PROVIDER, room, 'w_s', 2.6)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.command.variantId).toBe('provider_prov-1_annotations')
    }
  })

  it('refuses to build for a signed-out caller (no writable variant)', () => {
    const room = makeRoom({ walls: [makeWall({ id: 'w_s' })] })
    const result = buildWallCorrectionCommand(SIGNED_OUT, room, 'w_s', 2.6)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no_writable_variant')
  })

  it('refuses an invalid height before building a command', () => {
    const room = makeRoom({ walls: [makeWall({ id: 'w_s' })] })
    const tooSmall = buildWallCorrectionCommand(CUSTOMER, room, 'w_s', 0.01)
    expect(tooSmall.ok).toBe(false)
    if (!tooSmall.ok) expect(tooSmall.code).toBe('invalid_height')
  })

  it('refuses an unknown wall id', () => {
    const room = makeRoom({ walls: [makeWall({ id: 'w_s' })] })
    const result = buildWallCorrectionCommand(CUSTOMER, room, 'ghost-wall', 2.6)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('wall_not_found')
  })

  it('the RBAC assertion is genuinely enforced (no SpatialEditPermissionError leak)', () => {
    // The happy path must NOT throw — the assert is a no-op for a correct
    // customer→customer_corrections write.
    const room = makeRoom({ walls: [makeWall({ id: 'w_s' })] })
    expect(() =>
      buildWallCorrectionCommand(CUSTOMER, room, 'w_s', 2.6),
    ).not.toThrow(SpatialEditPermissionError)
  })
})
