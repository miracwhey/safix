/**
 * Spatial · Canonical · Workflow · Edit-History Reverter (Phase 2 · Block 2.15)
 *
 * The PERSISTENT reverter — distinct from the session-undo on the
 * `editHistoryStore`. The session-undo pops the in-memory stack; the reverter
 * is a FORWARD edit that re-applies a chosen historical state as a brand-new
 * override write and records a new `spatial_edit_history` row with
 * `command='restore'`.
 *
 * ── Revert semantics (V1) ───────────────────────────────────────────────────
 * Reverting a history row R restores the `(base_node_id, variant_id)` pair R
 * touched back to the state it had IMMEDIATELY BEFORE R was applied:
 *
 *   - if an earlier history row P exists for the same scene + node + variant,
 *     the pair is restored to P's recorded `override_fields` delta;
 *   - if R is the FIRST edit on that pair, the pair is restored to pure
 *     base-scene state — its override is removed.
 *
 * The revert is itself a command on the session stack (so it is undoable) and
 * goes through the SAME two gates as any edit:
 *   1. RBAC — {@link assertCanWriteVariant} (workflow-layer guard, not just
 *      RLS): the caller must own the variant the row lives on.
 *   2. Constraint-gate — `editHistoryStore.apply()` runs `validateComponentMove`
 *      before the write. A restored state that was legal when first applied
 *      re-validates cleanly.
 *
 * On a successful apply the restore is persisted via {@link persistEditCommand}
 * with `isRestore: true`, so the new audit row carries `command='restore'`.
 *
 * Layer: WORKFLOW — orchestrates the RBAC guard, the command store, and the
 * persistence helper. No React, no three.js. Imports the repository module
 * (Supabase-client-coupled) so it stays out of the L1 `canonical/` barrel.
 */

import { assertCanWriteVariant } from '../../workflow/spatialEditPermissions.ts'
import type {
  SpatialEditScene,
  SpatialEditUser,
} from '../../workflow/spatialEditPermissions.ts'
import { RestoreOverrideCommand } from '../commands/RestoreOverrideCommand.ts'
import { DELETION_MARKER_KEY } from '../overrides/layer-merge.ts'
import { useEditHistoryStore } from '../store/editHistoryStore.ts'
import type { EditOperation } from '../types/commands.ts'
import type { Transform } from '../types/primitives.ts'
import type { NodeOverride, VariantId } from '../types/variants.ts'
import { persistEditCommand } from './persistEditCommand.ts'
import type { EditHistoryRowEntry } from '../repository/editHistoryRepository.ts'
import type { SpatialEditHistoryRepository } from '../repository/editHistoryRepository.ts'

/**
 * Outcome of {@link revertEditHistoryEntry}.
 *
 * Discriminate on `reverted`:
 *   - `reverted: true`  — the restore was applied; `persisted` reports whether
 *     the new `spatial_edit_history` row was written (best-effort · the local
 *     restore stays even when the audit append fails).
 *   - `reverted: false` — the restore did NOT happen. `reason` says why:
 *       · `'rbac'`        the caller may not write the row's variant,
 *       · `'constraint'`  the constraint gate hard-rejected the restored state,
 *       · `'no-op'`       the pair is already in the target state.
 */
export type RevertResult =
  | { reverted: true; persisted: boolean }
  | { reverted: false; reason: 'rbac' | 'constraint' | 'no-op'; message: string }

/** Inputs {@link revertEditHistoryEntry} needs. */
export interface RevertEditHistoryEntryInput {
  /** The history row the user chose to revert. */
  entry: EditHistoryRowEntry
  /**
   * The full edit history of the scene — used to find the predecessor row for
   * the reverted entry's `(node, variant)` pair. ORDER is irrelevant; the
   * resolver sorts by the `(created_at, seq)` total order.
   */
  history: readonly EditHistoryRowEntry[]
  /** The caller — for the RBAC guard. */
  user: SpatialEditUser
  /** The scene's variant set — for the RBAC guard. */
  scene: SpatialEditScene
  /** Repository override — tests inject an InMemory instance. */
  repository?: SpatialEditHistoryRepository
}

/**
 * Total order over two history rows: `created_at` first, then the monotonic
 * `seq` as the tiebreak. `created_at` alone is millisecond-resolution, so a
 * fast multi-edit burst produces several rows with an identical `created_at`;
 * relying on `created_at` only would treat them as unordered and could skip
 * the true predecessor. `seq` is strictly increasing in append order and
 * disambiguates them deterministically (Supabase rows carry `seq = 0`, so
 * there the order degrades cleanly to `created_at` only).
 *
 * Returns `< 0` when `a` precedes `b`, `> 0` when it follows, `0` when equal.
 */
function compareHistoryRows(
  a: EditHistoryRowEntry,
  b: EditHistoryRowEntry,
): number {
  if (a.created_at < b.created_at) return -1
  if (a.created_at > b.created_at) return 1
  return a.seq - b.seq
}

/**
 * Find the override delta the `(node, variant)` pair had BEFORE `entry` was
 * applied: the most recent history row for the same pair that is strictly
 * earlier than `entry` in the `(created_at, seq)` total order. Returns `null`
 * when `entry` is the first edit on the pair — meaning the revert target is
 * base-scene state.
 */
function predecessorDelta(
  entry: EditHistoryRowEntry,
  history: readonly EditHistoryRowEntry[],
): Record<string, unknown> | null {
  const priors = history
    .filter(
      (h) =>
        h.id !== entry.id &&
        h.scene_id === entry.scene_id &&
        h.base_node_id === entry.base_node_id &&
        h.variant_id === entry.variant_id &&
        // Strictly earlier than `entry` in the monotonic total order. This
        // keeps a same-`created_at` predecessor (distinguished by `seq`)
        // instead of dropping straight to base state and losing an edit.
        compareHistoryRows(h, entry) < 0,
    )
    // Newest of the priors first — the immediate predecessor leads.
    .sort((a, b) => compareHistoryRows(b, a))
  const prior = priors[0] ?? null
  return prior ? { ...prior.override_fields } : null
}

/**
 * Reconstruct the {@link EditOperation} the restore is constraint-validated as.
 * The operation drives BOTH the Block-2.6 constraint gate and the `semantic_op`
 * audit column.
 *
 * Three reconstructable shapes, derived from the restore target delta:
 *   - delta carries the `__deleted` marker  → `delete_node`,
 *   - delta carries a `material_id`         → `set_material`,
 *   - delta carries a `transform`           → `move_node` with that transform.
 *
 * Every OTHER case — a base-state restore (`delta === null`), or a delta from a
 * `resize_wall` / `add_door` / `snap_object` / `move_pin` / `set_room_height`
 * edit — resolves to a `delete_node`-shaped operation. Rationale: the
 * constraint gate (`validateComponentMove`) accepts `delete_node`
 * unconditionally, and a restore is by definition a return to a state that was
 * already legal — re-running its full geometric validation would need the base
 * scene the workflow layer does not carry. `delete_node` is the safe,
 * always-valid gate operation; the COARSE `command` column still records the
 * restore as `restore`, and the user-facing timeline label is derived from the
 * reverted row's `semantic_op` directly (not from this gate operation), so
 * audit fidelity for the user is preserved.
 */
function reconstructOperation(
  nodeId: string,
  delta: Record<string, unknown> | null,
): EditOperation {
  if (delta) {
    if (delta[DELETION_MARKER_KEY] === true) {
      return { kind: 'delete_node', node_id: nodeId }
    }
    if (typeof delta.material_id === 'string') {
      return {
        kind: 'set_material',
        node_id: nodeId,
        surface: 'object',
        material_id: delta.material_id,
      }
    }
    if (isTransform(delta.transform)) {
      return { kind: 'move_node', node_id: nodeId, new_transform: delta.transform }
    }
  }
  // Base-state restore or a non-reconstructable delta — `delete_node` is the
  // constraint-safe gate operation (see the doc comment).
  return { kind: 'delete_node', node_id: nodeId }
}

/** Structural guard — `value` is a {@link Transform}-shaped object. */
function isTransform(value: unknown): value is Transform {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.position === 'object' && t.position !== null &&
    typeof t.rotation === 'object' && t.rotation !== null &&
    typeof t.scale === 'object' && t.scale !== null
  )
}

/**
 * Revert one `spatial_edit_history` row — restore its `(node, variant)` pair to
 * the state it had before the row's command, as a NEW persisted override write.
 *
 * Never throws — RBAC denial, a constraint hard-reject, and a no-op are all
 * modelled into the {@link RevertResult}. A persistence failure leaves the
 * local restore applied (`reverted: true, persisted: false`).
 */
export async function revertEditHistoryEntry(
  input: RevertEditHistoryEntryInput,
): Promise<RevertResult> {
  const { entry, history, user, scene } = input
  const variantId = entry.variant_id as VariantId

  // ── Gate 1 · RBAC (workflow-layer guard) ─────────────────────────────────
  try {
    assertCanWriteVariant(user, scene, variantId)
  } catch (err) {
    return {
      reverted: false,
      reason: 'rbac',
      message: err instanceof Error ? err.message : 'Keine Schreibrechte für diese Ebene.',
    }
  }

  // ── Resolve the restore target ───────────────────────────────────────────
  const targetDelta = predecessorDelta(entry, history)
  const targetOverride: NodeOverride | null = targetDelta
    ? {
        base_node_id: entry.base_node_id,
        variant_id: variantId,
        override_fields: targetDelta,
      }
    : null

  const operation = reconstructOperation(entry.base_node_id, targetDelta)

  // ── Build + apply the restore command (Gate 2 · constraint gate) ─────────
  const command = new RestoreOverrideCommand({
    nodeId: entry.base_node_id,
    variantId,
    targetOverride,
    operation,
    label: 'Stand wiederhergestellt',
  })

  // Pass the RBAC-validated caller into the store's apply funnel — the store
  // re-asserts the permission gate, and it must see the SAME user this
  // workflow already authorised (not just whatever the live session happens
  // to be). The store's Gate-1 RBAC and this function's Gate-1 then agree.
  const result = useEditHistoryStore.getState().apply(command, user)
  if (!result.applied) {
    return {
      reverted: false,
      // The store's RBAC gate already passed (same user, same variant) — a
      // reject here is the constraint gate. Map a permission reject defensively
      // to 'rbac' so the result reason stays faithful.
      reason: result.reason === 'permission' ? 'rbac' : 'constraint',
      message: result.hint ?? result.error.message,
    }
  }

  // ── Persist the restore (best-effort · isRestore ⇒ command='restore') ────
  // An explicit audit row is supplied (not derived from `command.after`):
  // a restore-to-BASE removes the override, leaving `command.after` empty, yet
  // the audit trail must still record one `restore` row. The row's
  // `override_fields` is the restored target delta (`{}` for a base restore);
  // its `semantic_op` stays faithful to the operation the user reverted, even
  // though the constraint-gate operation may be `delete_node` (see
  // `reconstructOperation`).
  const persistResult = await persistEditCommand(result.command, {
    sceneId: entry.scene_id,
    isRestore: true,
    restoreSemanticOp: entry.semantic_op,
    restoreRows: [
      {
        variant_id: variantId,
        base_node_id: entry.base_node_id,
        override_fields: targetDelta ?? {},
        command: 'restore',
        semantic_op: entry.semantic_op,
      },
    ],
    repository: input.repository,
  })

  return { reverted: true, persisted: persistResult.persisted }
}
