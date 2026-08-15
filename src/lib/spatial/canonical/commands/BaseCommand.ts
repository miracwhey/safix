/**
 * Spatial · Canonical · Commands · BaseCommand
 *
 * The command-pattern foundation for the Phase-2 edit-system (Block 2.1-2.4).
 *
 * Every user edit is a {@link BaseCommand} subclass. A command:
 *   1. wraps one typed {@link EditOperation},
 *   2. captures a `before` override snapshot of the nodes it will touch,
 *   3. on `do()` / `redo()` writes its `after` overrides onto the ACTIVE
 *      variant via the {@link SceneOverrideWriter},
 *   4. on `undo()` writes the `before` overrides back (verbatim inverse).
 *
 * Layer: pure L1 — no three.js / React / DOM. Commands operate against the
 * {@link SceneOverrideWriter} interface, which the zustand `useCanonicalSceneStore`
 * happens to satisfy; the command code itself never imports zustand or React.
 *
 * Override-write model (binding · Master-Spec §6.2):
 *   the base scene is never mutated. A command expresses every change as a
 *   shallow-merge {@link NodeOverride} on the active variant. Deletion uses the
 *   `{ __deleted: true }` marker. `undo()` is therefore symmetric: it restores
 *   the exact override rows that existed before — or removes a row entirely
 *   when the node had no override (pure base state).
 */

import type { RoomScene } from '../types/scene-graph.ts'
import type { Transform } from '../types/primitives.ts'
import type { NodeOverride, VariantId } from '../types/variants.ts'
import type { EditCommand, EditOperation } from '../types/commands.ts'

/**
 * The minimal scene-store surface a command needs to apply / revert overrides.
 *
 * Deliberately a structural subset of `CanonicalSceneState` (sceneStore.ts) so
 * the command layer has zero dependency on zustand: any object exposing these
 * three members — the live store, a test double, a future server-side
 * applier — can drive a command.
 */
export interface SceneOverrideWriter {
  /** Current flat override list across all variants. */
  readonly overrides: NodeOverride[]
  /** Insert or replace the override for `(base_node_id, variant_id)`. */
  upsertOverride(o: NodeOverride): void
  /** Remove the override for `(baseNodeId, variantId)` if present. */
  removeOverride(baseNodeId: string, variantId: VariantId): void
}

/**
 * Full apply context a command runs against.
 *
 * Extends {@link SceneOverrideWriter} with read/write access to the base
 * scene. 7 of the 8 commands only ever touch overrides; `add_door` is the one
 * operation that introduces a NEW node, which the override engine cannot
 * synthesise (`resolveScene` only merges deltas onto pre-existing base nodes),
 * so it appends/removes the node on the base scene directly. Every other
 * command leaves `scene` / `setScene` untouched.
 *
 * The canonical `useCanonicalSceneStore` satisfies this interface verbatim.
 */
export interface SceneEditContext extends SceneOverrideWriter {
  /** Current base scene (never mutated in place — replaced via `setScene`). */
  readonly scene: RoomScene | null
  /** Replace the base scene (used only by node-adding commands). */
  setScene(scene: RoomScene | null): void
}

/**
 * Read the override row for a `(node, variant)` pair, or `null` when the node
 * is showing pure base-scene state. Shared by every command's snapshot logic.
 */
export function readOverride(
  writer: SceneOverrideWriter,
  baseNodeId: string,
  variantId: VariantId,
): NodeOverride | null {
  return (
    writer.overrides.find(
      (o) => o.base_node_id === baseNodeId && o.variant_id === variantId,
    ) ?? null
  )
}

/**
 * Apply one override row, or REMOVE it when `row` is `null`. The inverse of a
 * snapshot capture: a command's `before` snapshot stores `null` for nodes
 * that were un-overridden, and restoring that `null` removes the override the
 * command added.
 */
export function writeOverrideOrRemove(
  writer: SceneOverrideWriter,
  baseNodeId: string,
  variantId: VariantId,
  row: NodeOverride | null,
): void {
  if (row === null) {
    writer.removeOverride(baseNodeId, variantId)
  } else {
    writer.upsertOverride(row)
  }
}

let commandSeq = 0

/**
 * Generate a process-unique command id. Uses `crypto.randomUUID()` when
 * available (browser + modern Node), falling back to a monotonic counter so
 * the command layer never throws in a bare test environment.
 */
export function nextCommandId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  commandSeq += 1
  return `cmd_${Date.now().toString(36)}_${commandSeq.toString(36)}`
}

/**
 * Abstract base for every edit command.
 *
 * Subclasses implement {@link computeAfter} — the pure mapping from the
 * captured `before` snapshot to the override rows the command should write.
 * `BaseCommand` owns the rest: id, label, variant-targeting, snapshot capture,
 * and the symmetric `do` / `undo` / `redo` apply loop.
 */
export abstract class BaseCommand {
  /** Stable UUID of this command instance. */
  readonly id: string
  /** Human-readable label for the Undo-Toast / History-Timeline (German UI). */
  readonly label: string
  /** The variant layer this command targets — ALWAYS the active variant. */
  readonly variantId: VariantId
  /** The semantic operation this command performs. */
  readonly operation: EditOperation
  /** Epoch-ms creation time. */
  readonly timestamp: number

  /**
   * The set of base-node ids this command reads/writes. Drives snapshot
   * capture; computed once by the subclass constructor.
   */
  protected readonly affectedNodeIds: readonly string[]

  /**
   * Override rows present on the affected pairs BEFORE the command ran.
   * Captured lazily on the first `do()` so a command can be constructed
   * before the store reaches the state it will edit.
   */
  protected before: NodeOverride[] | null = null

  /** Override rows the command WROTE — its `after` state. */
  protected after: NodeOverride[] | null = null

  protected constructor(params: {
    operation: EditOperation
    label: string
    variantId: VariantId
    affectedNodeIds: readonly string[]
  }) {
    this.id = nextCommandId()
    this.operation = params.operation
    this.label = params.label
    this.variantId = params.variantId
    this.affectedNodeIds = params.affectedNodeIds
    this.timestamp = Date.now()
  }

  /**
   * Compute the override rows the command must write, given the `before`
   * snapshot. Pure — no store access, no side effects. `null` entries in the
   * RETURN value mean "remove the override for that pair" (e.g. an undo of an
   * add, or a no-op reset to base).
   *
   * The returned array is keyed positionally to {@link affectedNodeIds}: entry
   * `i` is the desired override (or `null`) for `affectedNodeIds[i]`.
   */
  protected abstract computeAfter(before: readonly (NodeOverride | null)[]): (NodeOverride | null)[]

  /** Capture the pre-edit override snapshot from the live store. */
  private captureBefore(ctx: SceneEditContext): (NodeOverride | null)[] {
    return this.affectedNodeIds.map((nodeId) =>
      readOverride(ctx, nodeId, this.variantId),
    )
  }

  /**
   * `true` once {@link do} has captured the pre-edit `before` snapshot.
   * Separate from `before !== null` because an all-base pre-edit state yields
   * an EMPTY `before` array — a truthy-array check would mis-classify it as
   * "never captured" and re-snapshot the (now post-edit) store on a second
   * `do()`, corrupting the inverse.
   */
  private beforeCaptured = false

  /**
   * Execute the command. Idempotent re-runs are safe — `do()` always writes
   * the same `after` state. The FIRST call captures `before` (exactly once);
   * every later call (e.g. after an `undo`, or a stray double-`do()`) reuses
   * that original snapshot so the inverse stays exact.
   */
  do(ctx: SceneEditContext): void {
    if (!this.beforeCaptured) {
      // First execution — capture the live pre-edit state, exactly once.
      const beforeRows = this.captureBefore(ctx)
      this.before = beforeRows.map((r) => (r ? cloneOverride(r) : null)).filter(isNonNull)
      this.beforeByIndex = beforeRows
      this.beforeCaptured = true
    }
    // `beforeByIndex` is guaranteed set by the block above on first run and is
    // never re-derived afterwards — a second `do()` cannot overwrite it.
    const beforeByIndex = this.beforeByIndex as (NodeOverride | null)[]
    const afterRows = this.computeAfter(beforeByIndex)
    this.afterByIndex = afterRows
    this.after = afterRows.filter(isNonNull).map(cloneOverride)
    this.applyForward(ctx)
    this.applyRows(ctx, afterRows)
  }

  /** Re-execute after an undo — re-applies the `after` state. */
  redo(ctx: SceneEditContext): void {
    if (this.afterByIndex === undefined) {
      // Never executed — fall back to a fresh `do()`.
      this.do(ctx)
      return
    }
    this.applyForward(ctx)
    this.applyRows(ctx, this.afterByIndex)
  }

  /** Revert the command — restores the `before` snapshot verbatim. */
  undo(ctx: SceneEditContext): void {
    if (this.beforeByIndex === undefined) {
      // `undo` before `do` is a no-op rather than a throw — the stack guards
      // against this, but defence-in-depth keeps a stray call harmless.
      return
    }
    this.applyInverse(ctx)
    this.applyRows(ctx, this.beforeByIndex)
  }

  /**
   * Optional base-scene mutation a command performs on `do()` / `redo()` —
   * BEFORE its override rows are written. Default no-op; `AddDoorCommand`
   * overrides it to append the new door node. Pure override commands never
   * touch this hook.
   */
  protected applyForward(_ctx: SceneEditContext): void {
    /* no-op for pure override commands */
  }

  /**
   * Optional base-scene mutation a command performs on `undo()` — BEFORE its
   * `before` override rows are restored. Default no-op; `AddDoorCommand`
   * overrides it to remove the door node it added.
   */
  protected applyInverse(_ctx: SceneEditContext): void {
    /* no-op for pure override commands */
  }

  /** Positional `before` rows (incl. `null`s) — kept for exact restore. */
  private beforeByIndex?: (NodeOverride | null)[]
  /** Positional `after` rows (incl. `null`s) — kept for exact re-apply. */
  private afterByIndex?: (NodeOverride | null)[]

  private applyRows(writer: SceneOverrideWriter, rows: readonly (NodeOverride | null)[]): void {
    rows.forEach((row, i) => {
      writeOverrideOrRemove(writer, this.affectedNodeIds[i], this.variantId, row)
    })
  }

  /**
   * Return a command equivalent to this one but re-parameterised with an
   * auto-snap-corrected {@link Transform} (Master-Spec §8.3).
   *
   * The per-move validator may snap a transform-carrying edit (snap-to-wall,
   * snap-to-floor, 15°-rotation snap) and return the snapped value as
   * `verdict.correctedTransform`. The apply funnel adopts it by calling this
   * BEFORE the command executes, so the persisted override reflects the snap.
   *
   * Default is a no-op (`return this`) — most commands carry no transform.
   * Transform-carrying commands ({@link MoveNodeCommand}, {@link SnapObjectCommand})
   * override this to rebuild themselves with the corrected transform. The
   * rebuild must happen before the FIRST `do()` — a command that has already
   * captured its `before` snapshot must not be re-parameterised.
   */
  withCorrectedTransform(_transform: Transform): BaseCommand {
    return this
  }

  /** Serialise this command into a stack-storable {@link EditCommand}. */
  toEditCommand(): EditCommand {
    return {
      id: this.id,
      operation: this.operation,
      label: this.label,
      variant_id: this.variantId,
      before: (this.before ?? []).map(cloneOverride),
      after: (this.after ?? []).map(cloneOverride),
      timestamp: this.timestamp,
    }
  }
}

/** Type-guard dropping `null`s from a mixed array. */
function isNonNull<T>(v: T | null): v is T {
  return v !== null
}

/** Deep-ish clone of an override row so snapshots cannot alias live state. */
export function cloneOverride(o: NodeOverride): NodeOverride {
  return {
    base_node_id: o.base_node_id,
    variant_id: o.variant_id,
    override_fields: { ...o.override_fields },
  }
}
