/**
 * Spatial Core · Block B.3 · Scan Workflow Layer
 *
 * Cross-domain orchestration for the spatial scan lifecycle. CLAUDE.md layer
 * rule: workflow methods *coordinate* — they MUST NOT contain business rules.
 * The rules live in:
 *
 *   1. The DB trigger `enforce_scan_fsm()` — SoT for allowed status pairs.
 *   2. The TS mirror `assertScanTransition()` in `repository/fsm.ts` — same
 *      table, exercised by the InMemory repo so tests do not need Postgres.
 *
 * Each verb-method here combines exactly two side-effects in one call:
 *
 *   (a) repo.updateScan(...) → trips the FSM trigger / TS mirror
 *   (b) repo.recordScanEvent(...) → SECURITY DEFINER append-only audit
 *
 * The verb names are deliberately user-facing (startCapture, lockForDispute)
 * rather than status-pair coded (transitionToCapturing) — callers should
 * never need to know which exact transition is being walked.
 *
 * Idempotency keys: every audit insert that is paired with a destructive or
 * legally-relevant transition (locked / archived / verified) gets a
 * deterministic key so a network retry does not double-log the action.
 *
 * Error model: any FSM violation surfaces as `ScanFsmViolation` (errcode
 * 23514) from the underlying repo. We wrap unexpected errors in
 * `ScanWorkflowError` with the offending `scanId` + `action` for tracing.
 */

import type { MeshSummary } from '../quality/rules'
import { ScanFsmViolation } from '../repository/fsm'
import { getSpatialRepository } from '../repository/registry'
import type {
  Scan,
  ScanEventAction,
} from '../types'

export class ScanWorkflowError extends Error {
  readonly scanId: string
  readonly action: ScanEventAction | 'transition'
  readonly cause?: unknown
  constructor(args: {
    scanId: string
    action: ScanEventAction | 'transition'
    message: string
    cause?: unknown
  }) {
    super(args.message)
    this.name = 'ScanWorkflowError'
    this.scanId = args.scanId
    this.action = args.action
    this.cause = args.cause
  }
}

interface FinishCaptureInput {
  scanId: string
  /** Optional capture-time telemetry. Persisted in the audit payload only —
   *  the scan.device_meta jsonb is owned by createScan() per immutability. */
  fpsSample?: number
  thermalState?: 'nominal' | 'fair' | 'serious' | 'critical'
  durationSec?: number
  /**
   * Block C.4: when true, runs the Quality Engine + transitions to
   * `quality_checked` after the FSM walk to `captured` succeeds. Default
   * false so existing call-sites keep the manual-review flow.
   */
  autoQuality?: boolean
  /**
   * Phase 2 · Harvested mesh aggregate from `MeshClassificationHarvester`,
   * already mapped through `meshSummaryFromClassification()`. Forwarded to
   * `repo.runQualityEngine({ meshSummary })` when `autoQuality === true` so
   * R6 + R7 evaluate against real data instead of Plan B. Ignored when
   * `autoQuality === false`.
   */
  meshSummary?: MeshSummary
}

export async function startCapture(scanId: string): Promise<Scan> {
  const repo = getSpatialRepository()
  try {
    const next = await repo.updateScan(scanId, { status: 'capturing' })
    await repo.recordScanEvent(
      scanId,
      'captured',
      { phase: 'started', at: new Date().toISOString() },
    )
    return next
  } catch (err) {
    if (err instanceof ScanFsmViolation) throw err
    throw new ScanWorkflowError({
      scanId,
      action: 'transition',
      message: `startCapture failed for ${scanId}`,
      cause: err,
    })
  }
}

export async function finishCapture(input: FinishCaptureInput): Promise<Scan> {
  const repo = getSpatialRepository()
  try {
    let next = await repo.updateScan(input.scanId, {
      status: 'captured',
      scanEndedAt: Date.now(),
    })
    await repo.recordScanEvent(
      input.scanId,
      'captured',
      {
        phase: 'finished',
        fpsSample: input.fpsSample,
        thermalState: input.thermalState,
        durationSec: input.durationSec,
      },
    )
    if (input.autoQuality) {
      // Quality Engine + transition in the same workflow step so callers get
      // one return value with the post-quality state.
      //
      // Error semantics: if runQualityEngine throws, the catch below wraps
      // it in ScanWorkflowError and the scan REMAINS at 'captured' (the
      // capture FSM step + audit are already persisted). Callers can retry
      // via `submitForReview()` or manually re-run via `repo.runQualityEngine()`.
      // The 'captured' state is a safe terminal-ish anchor for retries —
      // no UI breakage, the user can re-trigger Quality from a CTA.
      await repo.runQualityEngine(input.scanId, { meshSummary: input.meshSummary })
      next = await repo.updateScan(input.scanId, { status: 'quality_checked' })
      await repo.recordScanEvent(input.scanId, 'quality_run', {
        phase: 'auto_after_capture',
        meshSummaryUsed: input.meshSummary != null,
      })
    }
    return next
  } catch (err) {
    if (err instanceof ScanFsmViolation) throw err
    throw new ScanWorkflowError({
      scanId: input.scanId,
      action: 'captured',
      message: `finishCapture failed for ${input.scanId}`,
      cause: err,
    })
  }
}

/** captured → quality_checked. Quality Engine V1 (Block C) will populate the
 *  scan_quality_reports row in the same call — for now this is a pure
 *  transition + audit so the workflow layer is shippable independently. */
export async function submitForReview(scanId: string): Promise<Scan> {
  const repo = getSpatialRepository()
  try {
    const next = await repo.updateScan(scanId, { status: 'quality_checked' })
    await repo.recordScanEvent(scanId, 'quality_run', { phase: 'submitted' })
    return next
  } catch (err) {
    if (err instanceof ScanFsmViolation) throw err
    throw new ScanWorkflowError({
      scanId,
      action: 'quality_run',
      message: `submitForReview failed for ${scanId}`,
      cause: err,
    })
  }
}

/** Provider-verify path. Accepts both quality_checked and needs_provider_review
 *  as legal predecessors; the FSM trigger rejects anything else. */
export async function verify(args: { scanId: string; verifiedBy: string }): Promise<Scan> {
  const repo = getSpatialRepository()
  const idempotencyKey = deterministicKey('verify', args.scanId, args.verifiedBy)
  try {
    const next = await repo.updateScan(args.scanId, { status: 'provider_verified' })
    await repo.recordScanEvent(
      args.scanId,
      'verified',
      { verifiedBy: args.verifiedBy, at: new Date().toISOString() },
      idempotencyKey,
    )
    return next
  } catch (err) {
    if (err instanceof ScanFsmViolation) throw err
    throw new ScanWorkflowError({
      scanId: args.scanId,
      action: 'verified',
      message: `verify failed for ${args.scanId}`,
      cause: err,
    })
  }
}

export async function markOfferReady(scanId: string): Promise<Scan> {
  const repo = getSpatialRepository()
  try {
    const next = await repo.updateScan(scanId, { status: 'offer_ready' })
    await repo.recordScanEvent(scanId, 'verified', { phase: 'offer_ready' })
    return next
  } catch (err) {
    if (err instanceof ScanFsmViolation) throw err
    throw new ScanWorkflowError({
      scanId,
      action: 'verified',
      message: `markOfferReady failed for ${scanId}`,
      cause: err,
    })
  }
}

export async function lockForDispute(args: {
  scanId: string
  reason: string
  disputeId?: string
}): Promise<Scan> {
  const repo = getSpatialRepository()
  const idempotencyKey = deterministicKey('lock', args.scanId, args.disputeId ?? args.reason)
  try {
    // Audit first so the lock reason is visible even if the transition fails.
    await repo.recordScanEvent(
      args.scanId,
      'locked',
      { reason: args.reason, disputeId: args.disputeId ?? null, at: new Date().toISOString() },
      idempotencyKey,
    )
    return await repo.updateScan(args.scanId, { status: 'locked_for_dispute' })
  } catch (err) {
    if (err instanceof ScanFsmViolation) throw err
    throw new ScanWorkflowError({
      scanId: args.scanId,
      action: 'locked',
      message: `lockForDispute failed for ${args.scanId}`,
      cause: err,
    })
  }
}

export async function archive(args: { scanId: string; reason: string }): Promise<Scan> {
  const repo = getSpatialRepository()
  const idempotencyKey = deterministicKey('archive', args.scanId, args.reason)
  try {
    const next = await repo.updateScan(args.scanId, {
      status: 'archived',
      archivedAt: Date.now(),
    })
    await repo.recordScanEvent(
      args.scanId,
      'archived',
      { reason: args.reason, at: new Date().toISOString() },
      idempotencyKey,
    )
    return next
  } catch (err) {
    if (err instanceof ScanFsmViolation) throw err
    throw new ScanWorkflowError({
      scanId: args.scanId,
      action: 'archived',
      message: `archive failed for ${args.scanId}`,
      cause: err,
    })
  }
}

/**
 * RFC 4122 §4.4-ish deterministic UUID. Uses a 128-bit FNV-1a fold so we
 * fill every byte of the UUID — far lower collision risk than the previous
 * 31-bit hash mapped onto UUID-v4 layout. Still not cryptographic, but the
 * DB partial UNIQUE index only requires intra-(scanId, verb) uniqueness and
 * the verb+scanId+extra triple already provides that domain separation.
 *
 * We pin the variant bits to RFC 4122 (10xx) and version nibble to 8 (random
 * version 8 is the RFC 9562 "custom" slot, which is exactly what this is).
 */
function deterministicKey(verb: string, scanId: string, extra: string): string {
  const seed = `spatial.v1:${verb}:${scanId}:${extra}`
  // 128-bit state as four 32-bit lanes — gives a 2^128 codomain in practice.
  let a = 0x811c9dc5 | 0
  let b = 0x01000193 | 0
  let c = 0xdeadbeef | 0
  let d = 0xfeedface | 0
  for (let i = 0; i < seed.length; i += 1) {
    const ch = seed.charCodeAt(i)
    a = Math.imul(a ^ ch, 0x01000193) >>> 0
    b = Math.imul(b ^ (ch + i), 0xcc9e2d51) >>> 0
    c = Math.imul(c ^ a, 0x1b873593) >>> 0
    d = Math.imul(d ^ b, 0x85ebca6b) >>> 0
  }
  const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  const raw = hex8(a) + hex8(b) + hex8(c) + hex8(d)
  // Slot the version nibble (RFC 9562 v8 = "custom") and the variant bits.
  const versioned = raw.slice(0, 12) + '8' + raw.slice(13, 16) +
    ((parseInt(raw.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') +
    raw.slice(18)
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20, 32)}`
}
