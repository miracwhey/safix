/**
 * Spatial · Canonical · Store · Customer Scene-History (V1.6.1 · Block L4.a)
 *
 * Undo/Redo for the Customer-Hub editing suite.
 *
 * WHY A SNAPSHOT STACK, NOT `editHistoryStore`:
 *   `editHistoryStore` is a command-pattern stack over VARIANT OVERRIDES
 *   (`BaseCommand.do/undo`, `validateComponentMove`, `assertCanWriteVariant`) —
 *   built for the Provider / Verify edit flows. The Customer-Hub deliberately
 *   does NOT use the override/variant apparatus (see `customerObjectMutator`):
 *   every customer mutation produces a fresh, immutable full `RoomScene` and is
 *   applied via `setScene` + a debounced blob re-upload. For that direct
 *   full-scene-replacement model the natural undo unit is a SCENE SNAPSHOT, not
 *   a command. Forcing the command apparatus on it would be the L4.b
 *   Variant-RBAC work, not L4.a. This store is that snapshot stack.
 *
 * Mechanics:
 *   `push(prev)` is called with the scene as it was BEFORE an edit, right when
 *   the edit is committed. `undo()` returns the scene to restore (and moves the
 *   current scene onto the redo stack); `redo()` is the inverse. The hub holds
 *   the live scene in `useCanonicalSceneStore`, so this store only needs the
 *   caller to hand it the current scene on undo/redo (see `useSceneEditCommit`).
 *
 * Caps + lifecycle:
 *   undo stack capped at {@link CUSTOMER_UNDO_CAP} (oldest dropped). Session-
 *   local + ephemeral — wiped on `reset()` (scene-switch / unmount). A snapshot
 *   is a structural clone already produced by the immutable mutators, so the
 *   stack holds references, not deep copies — cheap.
 */

import { create } from 'zustand'

import type { RoomScene } from '../types/scene-graph.ts'

/**
 * Max retained undo snapshots. Beyond this the oldest is dropped — its edit
 * stays in the scene, it just falls out of undo reach. 30 balances reach vs the
 * memory of holding that many full-scene references on a phone.
 */
export const CUSTOMER_UNDO_CAP = 30

export interface CustomerSceneHistoryState {
  /** Scenes to restore on undo — newest last. Capped at {@link CUSTOMER_UNDO_CAP}. */
  past: RoomScene[]
  /** Scenes to restore on redo — newest last. Cleared on every fresh push. */
  future: RoomScene[]
  canUndo: boolean
  canRedo: boolean

  /**
   * Record the pre-edit scene as a new undo step. Clears the redo branch (a
   * fresh edit invalidates any redo). Call this with the scene as it was BEFORE
   * applying the edit, at the moment the edit is committed.
   */
  push(previousScene: RoomScene): void

  /**
   * Pop one undo step. Returns the scene to restore, or null when nothing to
   * undo. `current` (the live scene being replaced) is pushed onto the redo
   * stack so a subsequent `redo()` can return to it.
   */
  undo(current: RoomScene): RoomScene | null

  /**
   * Pop one redo step. Returns the scene to restore, or null when nothing to
   * redo. `current` is pushed back onto the undo stack.
   */
  redo(current: RoomScene): RoomScene | null

  /** Wipe both stacks — scene-switch / unmount. */
  reset(): void
}

export const useCustomerSceneHistoryStore = create<CustomerSceneHistoryState>((set, get) => ({
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,

  push(previousScene) {
    set((s) => {
      const past = [...s.past, previousScene]
      if (past.length > CUSTOMER_UNDO_CAP) {
        past.splice(0, past.length - CUSTOMER_UNDO_CAP)
      }
      return { past, future: [], canUndo: true, canRedo: false }
    })
  },

  undo(current) {
    const { past } = get()
    if (past.length === 0) return null
    const restore = past[past.length - 1]
    set((s) => {
      const nextPast = s.past.slice(0, -1)
      const nextFuture = [...s.future, current]
      return {
        past: nextPast,
        future: nextFuture,
        canUndo: nextPast.length > 0,
        canRedo: true,
      }
    })
    return restore
  },

  redo(current) {
    const { future } = get()
    if (future.length === 0) return null
    const restore = future[future.length - 1]
    set((s) => {
      const nextFuture = s.future.slice(0, -1)
      const nextPast = [...s.past, current]
      return {
        past: nextPast,
        future: nextFuture,
        canUndo: true,
        canRedo: nextFuture.length > 0,
      }
    })
    return restore
  },

  reset() {
    set({ past: [], future: [], canUndo: false, canRedo: false })
  },
}))
