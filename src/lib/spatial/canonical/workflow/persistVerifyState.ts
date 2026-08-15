/**
 * Spatial · Canonical · Workflow · Verify-State Persistence (Phase 3 · Block 3.12)
 *
 * The orchestration seam between the Customer-Verify-Flow UI and the
 * `spatial_scenes.customer_verify_state` / `customer_verify_last_stage` /
 * `customer_verify_last_active_at` columns.
 *
 * ── Layer (binding · SaFix architecture rule) ───────────────────────────────
 *   - `useVerifyFlow` (the React hook) owns view-state — it MUST NOT call a
 *     repository directly.
 *   - This module is the WORKFLOW layer: it takes a target `customer_verify_
 *     state` (computed by the PURE `spatialVerifyWorkflow` helpers) plus the
 *     scene id and drives the {@link SpatialSceneRepository}.
 *   - The repository is the PERSISTENCE layer (InMemory ↔ Supabase).
 *
 * ── FSM-chain walking (binding · Implementation-Spec §5.1) ──────────────────
 * The DB enum is `not_started / in_progress / approved / rejected / expired`
 * with a guard trigger (`20260520120011`) whose legal edges are
 * `not_started → in_progress`, `in_progress → approved|rejected|expired`,
 * `approved → not_started` (re-verify reset), and `rejected|expired →
 * in_progress` (re-entry). A customer who reaches the Stage-5 Confirm WITHOUT
 * ever mutating the scene is still `not_started`; a direct `not_started →
 * approved` write would be an ILLEGAL transition the trigger rejects.
 * {@link spatialVerifyWorkflow.planConfirmVerifyStateChain} returns the ordered
 * list of legal intermediate states (`not_started → in_progress → approved`);
 * this module applies them in sequence, each a legal FSM edge, so the trigger
 * accepts every step.
 *
 * On Supabase these writes route through the column-scoped SECURITY DEFINER RPC
 * `spatial_set_customer_verify_state` (so a customer can persist verify-state on
 * a craftsman-shared scene where `spatial_can_edit_scene` is false); the DB FSM
 * trigger remains the authoritative gate. See
 * {@link SpatialSceneRepository.updateCustomerVerifyState}.
 *
 * ── Persistence-failure symmetry (binding · documented) ─────────────────────
 * Like `persistEditCommand`, this is a best-effort downstream write. The verify
 * state is a TRACKING column — the customer's actual corrections live on the
 * `customer_corrections` override layer (persisted separately). A failed verify-
 * state write must NOT crash the verify sheet or discard the customer's edits.
 * Every function here returns a discriminated result and NEVER throws; an
 * `applied:false` result is surfaced as a non-blocking toast.
 *
 * Layer note: this file imports the scene repository (which imports the
 * Supabase client) — it lives in `canonical/workflow/`, never re-exported from
 * the L1 `canonical/index.ts` barrel.
 */

import { getSpatialSceneRepository } from '../repository/registry.ts'
import type { SpatialSceneRepository } from '../repository/SpatialSceneRepository.ts'
import type { CustomerVerifyState } from '../repository/spatialSceneFsm.ts'
import { planConfirmVerifyStateChain } from '../../workflow/spatialVerifyWorkflow.ts'

/** Outcome of a verify-state persistence call. */
export type PersistVerifyStateResult =
  /**
   * The columns were written. `state` is the verify-state now on the row
   * (the LAST state of an applied chain, or the prior state when the chain
   * was empty).
   */
  | { applied: true; state: CustomerVerifyState }
  /**
   * The write failed (scene missing, FSM violation, network). The verify
   * sheet stays usable; this is surfaced as a non-blocking toast. `error`
   * explains why.
   */
  | { applied: false; error: Error }

/** Inputs shared by the verify-state persistence helpers. */
export interface PersistVerifyStateContext {
  /** The canonical scene id (`spatial_scenes.id`). */
  sceneId: string
  /** Repository override — tests inject an InMemory instance. */
  repository?: SpatialSceneRepository
}

/** Coerce an unknown throw into an `Error`. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Persist the `customer_verify_state` `not_started → in_progress` flip plus the
 * resume columns after the customer's FIRST verify mutation (Block 3.4 / 3.12).
 *
 * `targetState` is the value `spatialVerifyWorkflow.verifyStateAfterFirstEdit`
 * computed — `'in_progress'` on the first edit, or `null` when no transition
 * is needed (already `in_progress` or further). When `null` the helper still
 * touches the resume columns (`customer_verify_last_stage` /
 * `_last_active_at`) so an App-Kill mid-stage resumes correctly, but skips the
 * FSM write.
 *
 * NEVER throws — a failure is captured into the result.
 *
 * @param ctx          scene id + optional repository.
 * @param targetState  the verify-state to write, or `null` for no FSM change.
 * @param lastStage    the 1-5 sub-stage to stamp into `customer_verify_last_stage`.
 * @param activeAtIso  ISO-8601 timestamp for `customer_verify_last_active_at`.
 */
export async function persistVerifyProgress(
  ctx: PersistVerifyStateContext,
  targetState: CustomerVerifyState | null,
  lastStage: number,
  activeAtIso: string = new Date().toISOString(),
): Promise<PersistVerifyStateResult> {
  const repository = ctx.repository ?? getSpatialSceneRepository()
  try {
    // Column-scoped verify-state write — routes through the SECURITY DEFINER
    // RPC on Supabase so a customer can persist verify progress on a craftsman-
    // shared scene (where spatial_can_edit_scene is false). Never touches blob.
    const updated = await repository.updateCustomerVerifyState(ctx.sceneId, {
      ...(targetState !== null && { customerVerifyState: targetState }),
      customerVerifyLastStage: lastStage,
      customerVerifyLastActiveAt: activeAtIso,
    })
    return { applied: true, state: updated.customerVerifyState }
  } catch (err) {
    const error = toError(err)
    console.error(
      `[spatial] verify-state progress write failed for scene ${ctx.sceneId} ` +
        `(target ${targetState ?? 'no-change'}, stage ${lastStage}) — sheet kept usable:`,
      error,
    )
    return { applied: false, error }
  }
}

/**
 * Stamp `customer_verify_last_active_at` (and optionally `last_stage`) WITHOUT
 * an FSM transition — called when the verify sheet opens so the VF-4 reminder
 * cadence + the re-prompt copy have a fresh anchor (Implementation-Spec §Stage-1
 * "Beim Sheet-Open: customer_verify_last_active_at = now()").
 *
 * NEVER throws.
 */
export async function touchVerifyActivity(
  ctx: PersistVerifyStateContext,
  lastStage: number,
  activeAtIso: string = new Date().toISOString(),
): Promise<PersistVerifyStateResult> {
  const repository = ctx.repository ?? getSpatialSceneRepository()
  try {
    const updated = await repository.updateCustomerVerifyState(ctx.sceneId, {
      customerVerifyLastStage: lastStage,
      customerVerifyLastActiveAt: activeAtIso,
    })
    return { applied: true, state: updated.customerVerifyState }
  } catch (err) {
    const error = toError(err)
    console.error(
      `[spatial] verify-activity touch failed for scene ${ctx.sceneId} ` +
        `(stage ${lastStage}) — sheet kept usable:`,
      error,
    )
    return { applied: false, error }
  }
}

/**
 * Persist the Stage-5 confirm — drive `customer_verify_state` to `approved`
 * legally (Block 3.8 / 3.12).
 *
 * BOTH Stage-5 actions ("Provider anfragen" and "Erstmal speichern") land the
 * scene on `approved` (the Implementation-Spec §5.1 mapping of the spec's
 * "completed"). This helper reads the scene's CURRENT verify-state, asks
 * {@link planConfirmVerifyStateChain} for the legal intermediate chain, and
 * applies each transition in sequence so the `20260520120011` FSM guard
 * accepts every step:
 *
 *   - a no-edit customer (`not_started`) walks `→ in_progress → approved`,
 *   - an editing customer (`in_progress`) walks `→ approved`,
 *   - an already-`approved` scene is a no-op (idempotent re-confirm).
 *
 * The final write also stamps `customer_verify_last_stage = 5` +
 * `customer_verify_last_active_at`. NEVER throws.
 *
 * @param ctx         scene id + optional repository.
 * @param activeAtIso ISO-8601 timestamp for `customer_verify_last_active_at`.
 */
export async function persistVerifyConfirm(
  ctx: PersistVerifyStateContext,
  activeAtIso: string = new Date().toISOString(),
): Promise<PersistVerifyStateResult> {
  const repository = ctx.repository ?? getSpatialSceneRepository()
  try {
    const scene = await repository.findById(ctx.sceneId)
    if (!scene) {
      return { applied: false, error: new Error(`SpatialScene ${ctx.sceneId} not found`) }
    }
    const chain = planConfirmVerifyStateChain(scene.customerVerifyState)

    // No transition needed — the scene is already `approved`. Still stamp the
    // resume columns so a re-confirm leaves `last_stage = 5`.
    if (chain.length === 0) {
      const updated = await repository.updateCustomerVerifyState(ctx.sceneId, {
        customerVerifyLastStage: 5,
        customerVerifyLastActiveAt: activeAtIso,
      })
      return { applied: true, state: updated.customerVerifyState }
    }

    // Walk the legal FSM chain — every step is a permitted edge. Only the
    // FINAL step carries the resume-column stamp; intermediate hops touch
    // only the FSM column so the trigger sees a clean single-field transition.
    let finalState: CustomerVerifyState = scene.customerVerifyState
    for (let i = 0; i < chain.length; i += 1) {
      const isLast = i === chain.length - 1
      const updated = await repository.updateCustomerVerifyState(ctx.sceneId, {
        customerVerifyState: chain[i],
        ...(isLast && {
          customerVerifyLastStage: 5,
          customerVerifyLastActiveAt: activeAtIso,
        }),
      })
      finalState = updated.customerVerifyState
    }
    return { applied: true, state: finalState }
  } catch (err) {
    const error = toError(err)
    console.error(
      `[spatial] verify-confirm write failed for scene ${ctx.sceneId} — sheet kept usable:`,
      error,
    )
    return { applied: false, error }
  }
}
