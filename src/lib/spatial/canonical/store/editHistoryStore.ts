/**
 * Spatial · Canonical · Store · Edit-History Store (Phase 2 · Block 2.1-2.4)
 *
 * The command-pattern undo/redo stack for the spatial edit-system.
 *
 * Architecture (locked decision):
 *   the command stack is a SEPARATE zustand store, NOT folded into
 *   `sceneStore`. This keeps the L1 read-side (`useCanonicalSceneStore` — base
 *   scene + override resolution) cleanly separated from the L4 edit-side
 *   (this store — command history). The scene store stays a pure projection;
 *   only this store mutates it, and only via {@link BaseCommand}s.
 *
 * Apply mechanics:
 *   `apply(cmd)` runs the command against the live `useCanonicalSceneStore`
 *   (which structurally satisfies {@link SceneEditContext}): the command
 *   captures its `before` override snapshot, writes its `after` overrides
 *   onto the ACTIVE variant, and is pushed onto the undo stack. The redo
 *   stack is cleared — a new edit invalidates any redo branch (Edit-Spec §5.1).
 *   `undo()` / `redo()` move a command across the two stacks and re-apply the
 *   inverse / forward override writes.
 *
 * Undo-stack cap (locked decision · Edit-Spec §14 #6):
 *   the undo stack holds at most {@link UNDO_STACK_CAP} = 50 commands. When a
 *   51st command is applied the OLDEST is dropped — its edit stays in the
 *   scene (already applied to the override stack) but can no longer be undone
 *   in this session. The stack is session-local + ephemeral: it is wiped on
 *   logout / reload. The persistent reverter (Block 2.13-2.16) is a distinct
 *   path and is NOT built here.
 *
 * Single-user: no concurrency / locks / version tokens (Phase 4 scope).
 */

import { create } from 'zustand'

import type { EditCommand } from '../types/commands.ts'
import { useCanonicalSceneStore } from './sceneStore.ts'
import type { BaseCommand, SceneEditContext } from '../commands/BaseCommand.ts'
import { validateComponentMove } from '../validator/validate-component-move.ts'
import type { ConstraintError, ConstraintWarning } from '../validator/move-validation.ts'
import {
  assertCanWriteVariant,
  toSpatialEditUser,
  SpatialEditPermissionError,
  type SpatialEditScene,
  type SpatialEditUser,
} from '../../workflow/spatialEditPermissions.ts'

/**
 * Maximum number of commands retained on the undo stack. Beyond this the
 * oldest command is dropped (its edit is already applied and stays in the
 * scene; it just falls out of undo reach). Locked at 50 — battery + memory
 * trade-off, Edit-Spec §14 #6.
 */
export const UNDO_STACK_CAP = 50

/**
 * Outcome of {@link EditHistoryState.apply}.
 *
 * `apply()` runs TWO pre-apply gates BEFORE executing the command — the
 * Block-2.10 RBAC gate, then the Block-2.6 constraint gate. Both are EXPECTED
 * failure modes (a user without write rights, or an illegal edit), not
 * exceptions, so they are modelled as a discriminated result, never a throw.
 *
 *   - `applied: true`  : the command passed both gates, ran, was pushed onto
 *     the undo stack, and wrote its overrides. `command` is its serialisable
 *     form; `warnings` carries any soft-constraint violations (§8.2) the UI
 *     should surface.
 *   - `applied: false` : the command was REJECTED. It did NOT run, did NOT
 *     write an override, and is NOT on the undo stack. `reason` discriminates:
 *       · `'permission'` — the acting user may not write the command's variant
 *         (Block-2.10 RBAC gate); `error` is the {@link SpatialEditPermissionError}.
 *       · `'constraint'` — a Block-2.6 hard-constraint violation; `error` is
 *         the {@link ConstraintError}.
 *     `error.message` is uniform across both; `hint` is a short German line
 *     for the Confirm/Reject toast (always set for a permission denial).
 */
export type ApplyResult =
  | {
      applied: true
      /** The executed command's serialisable form (for persistence · Block 2.13). */
      command: EditCommand
      /** Soft-constraint violations — empty when the edit was clean (§8.2). */
      warnings: ConstraintWarning[]
    }
  | {
      applied: false
      /** Why the command was rejected — `'permission'` (RBAC) or `'constraint'`. */
      reason: 'permission' | 'constraint'
      /**
       * The violation that blocked the command. A {@link ConstraintError} when
       * `reason === 'constraint'`, a {@link SpatialEditPermissionError} when
       * `reason === 'permission'`. Both expose `message`; both expose a `code`.
       */
      error: ConstraintError | SpatialEditPermissionError
      /** Short German hint for the rejection toast. */
      hint?: string
    }

/**
 * Public shape of {@link useEditHistoryStore}.
 */
export interface EditHistoryState {
  /** Commands available to undo — newest last. Capped at {@link UNDO_STACK_CAP}. */
  undoStack: BaseCommand[]
  /** Commands available to redo — newest last. Cleared on every fresh `apply`. */
  redoStack: BaseCommand[]

  /** True when there is at least one command to undo. */
  canUndo: boolean
  /** True when there is at least one command to redo. */
  canRedo: boolean

  /**
   * Run the two pre-apply gates against a command and — if both pass — execute
   * it, push it onto the undo stack, and clear the redo stack.
   *
   * Gate 1 · RBAC (Block 2.10): {@link assertCanWriteVariant} is asserted for
   * the command's `variantId` and the acting user. A command targeting a
   * variant the user may not write — a foreign provider's annotation layer, an
   * immutable layer — is rejected here, BEFORE any override is written, so a
   * caller cannot land a spy write through the store API even if it skipped
   * the UI's permission hook. `actingUser` defaults to the live SaFix session
   * ({@link toSpatialEditUser}); tests / non-React callers pass an explicit
   * snapshot.
   *
   * Gate 2 · Constraint (Block 2.6): the command's operation is validated
   * against the live resolved scene. A hard-constraint violation drops the
   * command. The validator may also produce an auto-snap correction
   * (`correctedTransform`); when it does, `apply()` ADOPTS it — the command is
   * rebuilt with the snapped transform before it executes, so the persisted
   * override reflects the snap (Master-Spec §8.3).
   *
   * Returns an {@link ApplyResult}:
   *   - RBAC denial   ⇒ `{ applied: false, reason: 'permission', ... }`.
   *   - hard-reject   ⇒ `{ applied: false, reason: 'constraint', error }`.
   *   - accepted      ⇒ `{ applied: true, command, warnings }`. `command` is
   *     the FINAL (possibly snap-corrected) command's serialisable form.
   *
   * In every reject case the command is dropped entirely — no `do()`, no
   * override, no stack push.
   */
  apply(cmd: BaseCommand, actingUser?: SpatialEditUser): ApplyResult

  /** Undo the most recent command. No-op (returns `null`) when the stack is empty. */
  undo(): EditCommand | null

  /** Redo the most recently undone command. No-op (returns `null`) when empty. */
  redo(): EditCommand | null

  /** Wipe both stacks — used on logout / scene-switch. */
  clear(): void
}

/**
 * Resolve the live {@link SceneEditContext}. The canonical scene store is the
 * single runtime context; `getState()` is read fresh on every apply so a
 * command always sees the current override list.
 */
function sceneContext(): SceneEditContext {
  return useCanonicalSceneStore.getState()
}

/**
 * Push an executed command onto the undo stack, capping at
 * {@link UNDO_STACK_CAP} (oldest dropped) and clearing the redo branch.
 * Shared by the two accept-paths of `apply()`.
 */
function pushUndo(
  set: (partial: Partial<EditHistoryState> | ((s: EditHistoryState) => Partial<EditHistoryState>)) => void,
  cmd: BaseCommand,
): void {
  set((s) => {
    const undoStack = [...s.undoStack, cmd]
    if (undoStack.length > UNDO_STACK_CAP) {
      undoStack.splice(0, undoStack.length - UNDO_STACK_CAP)
    }
    return {
      undoStack,
      // A fresh edit invalidates any redo branch.
      redoStack: [],
      canUndo: true,
      canRedo: false,
    }
  })
}

export const useEditHistoryStore = create<EditHistoryState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,

  apply(cmd, actingUser) {
    // ── Gate 1 · RBAC (Block 2.10 · workflow-layer guard) ────────────────────
    // EVERY apply is forced through assertCanWriteVariant — the store API is a
    // write funnel reachable from the JS console, so a foreign-variant command
    // must be rejected HERE, before any override is written. The acting user
    // defaults to the live SaFix session; tests pass an explicit snapshot.
    const user = actingUser ?? toSpatialEditUser()
    const editScene: SpatialEditScene = {
      variantIds: useCanonicalSceneStore.getState().variants.map((v) => v.id),
    }
    try {
      assertCanWriteVariant(user, editScene, cmd.variantId)
    } catch (err) {
      if (err instanceof SpatialEditPermissionError) {
        return {
          applied: false,
          reason: 'permission',
          error: err,
          hint: err.message,
        }
      }
      throw err
    }

    // ── Gate 2 · Constraint (Block 2.6 · Master-Spec §8.1-8.3) ───────────────
    //    The validator runs against the RESOLVED scene — the post-override
    //    view the command is about to mutate. A hard-reject drops the command
    //    entirely: no do(), no override write, no stack push.
    const resolved = useCanonicalSceneStore.getState().resolved
    if (resolved) {
      const verdict = validateComponentMove(cmd.operation, resolved)
      if (!verdict.ok && verdict.error) {
        return {
          applied: false,
          reason: 'constraint',
          error: verdict.error,
          hint: verdict.hint,
        }
      }
      // `error` typed-narrows to `ConstraintError` for a constraint reject.

      // Auto-snap adoption (§8.3): when the validator nudged the transform,
      // rebuild the command with the snapped value so the persisted override
      // reflects the snap. Transform-free commands return `this` unchanged.
      const effective = verdict.correctedTransform
        ? cmd.withCorrectedTransform(verdict.correctedTransform)
        : cmd

      // Execute against the live scene store, then push — cap at UNDO_STACK_CAP.
      effective.do(sceneContext())
      pushUndo(set, effective)
      return {
        applied: true,
        command: effective.toEditCommand(),
        warnings: verdict.warnings,
      }
    }

    // No scene loaded — there is nothing to validate against. This path keeps
    // the store usable in bare unit tests that never hydrate a scene; a
    // command applied here writes its override unconditionally (the RBAC gate
    // above still ran — that gate needs no scene).
    cmd.do(sceneContext())
    pushUndo(set, cmd)
    return { applied: true, command: cmd.toEditCommand(), warnings: [] }
  },

  undo() {
    const { undoStack } = get()
    if (undoStack.length === 0) return null

    const cmd = undoStack[undoStack.length - 1]
    cmd.undo(sceneContext())

    set((s) => {
      const nextUndo = s.undoStack.slice(0, -1)
      const nextRedo = [...s.redoStack, cmd]
      return {
        undoStack: nextUndo,
        redoStack: nextRedo,
        canUndo: nextUndo.length > 0,
        canRedo: true,
      }
    })

    return cmd.toEditCommand()
  },

  redo() {
    const { redoStack } = get()
    if (redoStack.length === 0) return null

    const cmd = redoStack[redoStack.length - 1]
    cmd.redo(sceneContext())

    set((s) => {
      const nextRedo = s.redoStack.slice(0, -1)
      const nextUndo = [...s.undoStack, cmd]
      // The undo stack can only grow back to commands that were already on
      // it, so it never exceeds UNDO_STACK_CAP here — no re-cap needed.
      return {
        undoStack: nextUndo,
        redoStack: nextRedo,
        canUndo: true,
        canRedo: nextRedo.length > 0,
      }
    })

    return cmd.toEditCommand()
  },

  clear() {
    set({ undoStack: [], redoStack: [], canUndo: false, canRedo: false })
  },
}))

/**
 * Non-React snapshot accessor — mirrors `getResolvedSceneSnapshot()` in
 * sceneStore.ts. Useful for tests + non-React callers.
 */
export function getEditHistorySnapshot(): EditHistoryState {
  return useEditHistoryStore.getState()
}
