/**
 * Spatial · Canonical · Workflow · Edit-Command Persistence (Phase 2 · Block 2.13)
 *
 * The orchestration seam between the command-pattern edit-system and the
 * `spatial_edit_history` audit trail.
 *
 * ── Layer (binding · SaFix architecture rule) ───────────────────────────────
 *   - The zustand `editHistoryStore` is the SESSION command stack — pure
 *     in-memory undo/redo. It MUST NOT call a repository (no DB in a state
 *     store).
 *   - This module is the WORKFLOW layer: it takes the `ApplyResult.command`
 *     a successful `editHistoryStore.apply()` produced, plus the scene
 *     context, and drives the {@link SpatialEditHistoryRepository}.
 *   - The repository is the PERSISTENCE layer (InMemory ↔ Supabase RPC).
 *
 * The `EditModeViewerHost` calls {@link persistEditCommand} after every
 * `applied:true` result — the audit row is written without the host touching
 * the repository directly.
 *
 * ── Persistence-failure symmetry (binding · documented) ─────────────────────
 * The `spatial_edit_history` append is an AUDIT-APPEND — it records that an
 * edit happened; it is NOT the edit's source of truth. The source of truth for
 * the live edit is the override stack in `useCanonicalSceneStore` (in V1 that
 * stack is what is persisted into the `parametric.json` blob, separately).
 *
 * Therefore the persistence symmetry is deliberately ASYMMETRIC and one-way:
 *
 *   local edit applied  ⇒  audit append attempted (best-effort)
 *   audit append fails  ⇒  local edit is NOT rolled back
 *
 * Rationale: rolling back a clean, constraint-valid edit because an audit-log
 * write failed would punish the user for an infrastructure hiccup and lose
 * their work. The audit trail is allowed to have a gap; the scene state is
 * not. A failed append is logged (`console.error`) and surfaced to the caller
 * via the {@link PersistEditCommandResult} discriminator so the UI can show a
 * non-blocking toast ("Änderung übernommen — Verlauf konnte nicht gesichert
 * werden"). The edit itself stays applied.
 *
 * This mirrors the SaFix `notifications` / `timeline` audit-append pattern:
 * the audit write is downstream of and non-fatal to the domain mutation.
 *
 * Layer note: this file imports the repository (which imports the Supabase
 * client) — it lives in `canonical/workflow/`, NOT in the L1 `canonical/`
 * barrel, and is never re-exported from `canonical/index.ts`.
 */

import { stableStringify } from '../storage/parametric-storage.ts'
import {
  getSpatialEditHistoryRepository,
  mapCommandToRows,
  mapRestoreCommandToRows,
  type EditHistoryAppendRow,
  type EditHistoryRowEntry,
  type SpatialEditHistoryRepository,
} from '../repository/editHistoryRepository.ts'
import type { EditCommand, EditOperationKind } from '../types/commands.ts'
import type { NodeOverride } from '../types/variants.ts'

/**
 * Outcome of {@link persistEditCommand}.
 *
 * Discriminate on `persisted`:
 *   - `persisted: true`  — the audit rows were written; `entries` are them.
 *   - `persisted: false` — the append failed. The local edit STAYS APPLIED
 *     (see the module header). `error` is the failure; `rowCount` is how many
 *     rows the append would have written, for the caller's toast copy.
 */
export type PersistEditCommandResult =
  | { persisted: true; entries: EditHistoryRowEntry[] }
  | { persisted: false; error: Error; rowCount: number }

/** Inputs {@link persistEditCommand} needs beyond the command itself. */
export interface PersistEditCommandContext {
  /** The canonical scene id the edit belongs to (`spatial_scenes.id`). */
  sceneId: string
  /**
   * The override stack BEFORE the command ran. Used to content-address the
   * `parametric_sha256_before`. Optional — when omitted the before-hash is
   * `null` (the first edit on a scene has no prior content address).
   */
  overridesBefore?: readonly NodeOverride[]
  /**
   * The override stack AFTER the command ran. Used to content-address the
   * `parametric_sha256_after`. Optional — when omitted the after-hash is `null`.
   */
  overridesAfter?: readonly NodeOverride[]
  /**
   * Whether this is the persistent REVERTER path (Block 2.15). When `true` the
   * rows are mapped with `command='restore'`; when `false` (default) the
   * coarse primitive is derived per-override (`set` / `delete`).
   */
  isRestore?: boolean
  /**
   * For the reverter path only — the `semantic_op` of the operation that was
   * REVERTED. The reverter command carries a constraint-safe gate operation
   * that is not always the reverted kind; this keeps the audit `semantic_op`
   * faithful. Ignored when `isRestore` is falsy.
   */
  restoreSemanticOp?: EditOperationKind
  /**
   * For the reverter path only — explicit audit rows to append, used instead
   * of {@link mapRestoreCommandToRows}. The reverter supplies these because a
   * restore-to-BASE removes the override (the command's `after` snapshot is
   * empty) yet the audit trail must STILL record one `restore` row per touched
   * node. Ignored when `isRestore` is falsy.
   */
  restoreRows?: EditHistoryAppendRow[]
  /** Repository override — tests inject an InMemory instance. */
  repository?: SpatialEditHistoryRepository
}

/**
 * Content-address a flat override stack. SHA-256 of the stable-stringified
 * override list — deterministic regardless of array / key order, so two
 * content-equal stacks hash identically. Mirrors `parametric-storage.ts`'s
 * `stableStringify` + SHA-256 pipeline (the V1 parametric blob embeds the
 * override stack, so this hash is a faithful blob-level content address).
 *
 * Returns `null` when `overrides` is `undefined` — the caller did not supply a
 * snapshot, so there is no content address to record.
 */
async function hashOverrides(
  overrides: readonly NodeOverride[] | undefined,
): Promise<string | null> {
  if (overrides === undefined) return null
  const json = stableStringify(overrides)
  const bytes = new TextEncoder().encode(json)
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  const view = new Uint8Array(digest)
  let out = ''
  for (let i = 0; i < view.length; i += 1) {
    out += view[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * Persist one executed (or reverted) {@link EditCommand} to the
 * `spatial_edit_history` audit trail.
 *
 * Called by the `EditModeViewerHost` after a successful
 * `editHistoryStore.apply()` (and after the reverter writes a restore command).
 * NEVER throws — an append failure is captured into the
 * {@link PersistEditCommandResult} so a persistence hiccup cannot crash the
 * edit-mode host or roll back the local edit (see the module header).
 *
 * @param command the command's serialisable form (`ApplyResult.command`).
 * @param ctx     scene id + optional before/after override snapshots.
 */
export async function persistEditCommand(
  command: EditCommand,
  ctx: PersistEditCommandContext,
): Promise<PersistEditCommandResult> {
  const repository = ctx.repository ?? getSpatialEditHistoryRepository()
  const rows = ctx.isRestore
    ? (ctx.restoreRows ?? mapRestoreCommandToRows(command, ctx.restoreSemanticOp))
    : mapCommandToRows(command)

  try {
    const [shaBefore, shaAfter] = await Promise.all([
      hashOverrides(ctx.overridesBefore),
      hashOverrides(ctx.overridesAfter),
    ])
    const entries = await repository.append({
      scene_id: ctx.sceneId,
      rows,
      parametric_sha256_before: shaBefore,
      parametric_sha256_after: shaAfter,
    })
    return { persisted: true, entries }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    // Best-effort: log + report, but DO NOT rethrow — the local edit stays.
    console.error(
      `[spatial] edit-history persistence failed for scene ${ctx.sceneId} ` +
        `(command ${command.id}, ${rows.length} row(s)) — local edit kept applied:`,
      error,
    )
    return { persisted: false, error, rowCount: rows.length }
  }
}
