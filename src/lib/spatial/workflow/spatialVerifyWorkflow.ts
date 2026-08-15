/**
 * Spatial · Workflow · Customer-Verify-Flow Orchestration (Phase 3 · Block 3.1-3.4)
 *
 * The workflow-layer orchestration for the Customer-Verify-Flow (Mockup 15).
 * The VerifySheet UI is a thin shell; every cross-cutting decision lives here:
 *
 *   - the 5-stage navigation model + the multi-click-safe stage transitions,
 *   - the resume target (App-Kill / Re-Enter — Implementation-Spec §2.3),
 *   - the RBAC-gated build path for a Stage-2 wall-measurement correction
 *     (`customer_corrections`-targeted {@link ResizeWallCommand}),
 *   - the `customer_verify_state` FSM transition on the first edit.
 *
 * ── Layer (binding · SaFix architecture rule) ───────────────────────────────
 * PURE workflow logic — no React, no zustand, no three.js, no DB. Deterministic
 * functions over explicit inputs. The repository write (`customer_verify_state`
 * persistence) is NOT done here — Block 3.12 wires it; this module only
 * computes the *target* FSM state + exposes it so the UI / a future repo step
 * can persist it. The `customer_corrections` RBAC guard is mandatory at this
 * layer because the VerifySheet builds commands in the browser BEFORE anything
 * reaches RLS (SaFix rule: "Workflow-layer RBAC guards mandatory").
 *
 * ── Verify-state mapping (Implementation-Spec §5.1 · binding) ────────────────
 * The DB enum is `('not_started','in_progress','approved','rejected','expired')`
 * (`customer_verify_state`). The verify-flow stages map onto it:
 *   - Stage 1 (Welcome)        → `not_started` (read-only, no mutation yet)
 *   - first Stage-2+ mutation  → `in_progress`
 *   - Stage 5 confirm          → `approved`   (Block 3.8 — not this block)
 * This module owns only the `not_started → in_progress` transition; the rest
 * is Block 3.8 / 3.12.
 */

import type { RoomScene } from '../canonical/types/scene-graph'
import type { Wall, WallOpening } from '../canonical/types/geometry'
import type { Pin, PinType, AnchorSurfaceType } from '../canonical/types/annotations'
import type { PinAnchor } from '../canonical/types/commands'
import { ResizeWallCommand } from '../canonical/commands/ResizeWallCommand'
import { DeleteNodeCommand } from '../canonical/commands/DeleteNodeCommand'
import { MoveNodeCommand } from '../canonical/commands/MoveNodeCommand'
import { AddDoorCommand } from '../canonical/commands/AddDoorCommand'
import { AddPinCommand } from '../canonical/commands/AddPinCommand'
import { MovePinCommand } from '../canonical/commands/MovePinCommand'
import { nextCommandId } from '../canonical/commands/BaseCommand'
import { IDENTITY_TRANSFORM } from '../canonical/types/primitives'
import {
  assertCanWriteVariant,
  resolveWritableVariantId,
  type SpatialEditScene,
  type SpatialEditUser,
} from './spatialEditPermissions'
import {
  canTransitionCustomerVerifyState,
  type CustomerVerifyState,
} from '../canonical/repository/spatialSceneFsm'

// ─────────────────────────────────────────────────────────────────────────────
// Stage model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 5 Customer-Verify sub-stages (Implementation-Spec §1). The numeric value
 * IS the 1-based stage index — it doubles as the `customer_verify_last_stage`
 * column value (Block 3.12) and the 5-segment step-bar index.
 *
 * Modelled as a frozen const object (not a TS `enum`) — the repo's
 * `erasableSyntaxOnly` tsconfig forbids `enum`. {@link VerifyStage} (the type)
 * is the value-union; `VerifyStage` (the const) is the named accessor, so call
 * sites read `VerifyStage.Welcome` exactly as an enum would.
 */
export const VerifyStage = Object.freeze({
  Welcome: 1,
  Measure: 2,
  Layout: 3,
  Pins: 4,
  Confirm: 5,
} as const)

/** A Customer-Verify sub-stage index (1-5). */
export type VerifyStage = (typeof VerifyStage)[keyof typeof VerifyStage]

/** Every stage in order — drives the step-bar + the next/prev navigation. */
export const VERIFY_STAGES: readonly VerifyStage[] = Object.freeze([
  VerifyStage.Welcome,
  VerifyStage.Measure,
  VerifyStage.Layout,
  VerifyStage.Pins,
  VerifyStage.Confirm,
])

/** Short German label per stage — shown in the step-bar (`N/5 · {label}`). */
export const VERIFY_STAGE_LABEL: Record<VerifyStage, string> = {
  [VerifyStage.Welcome]: 'Willkommen',
  [VerifyStage.Measure]: 'Maße',
  [VerifyStage.Layout]: 'Layout',
  [VerifyStage.Pins]: 'Wünsche',
  [VerifyStage.Confirm]: 'Senden',
}

/** Total number of stages — the step-bar segment count. */
export const VERIFY_STAGE_COUNT = VERIFY_STAGES.length

/** `true` when `value` is a legal {@link VerifyStage}. */
export function isVerifyStage(value: unknown): value is VerifyStage {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= VerifyStage.Welcome &&
    value <= VerifyStage.Confirm
  )
}

/**
 * The next stage after `stage`, or `null` when `stage` is the last one.
 * Used by the sticky-footer primary CTA.
 */
export function nextStage(stage: VerifyStage): VerifyStage | null {
  const idx = VERIFY_STAGES.indexOf(stage)
  if (idx < 0 || idx === VERIFY_STAGES.length - 1) return null
  return VERIFY_STAGES[idx + 1]
}

/**
 * The previous stage before `stage`, or `null` when `stage` is the first one.
 * Used by the header back affordance.
 */
export function prevStage(stage: VerifyStage): VerifyStage | null {
  const idx = VERIFY_STAGES.indexOf(stage)
  if (idx <= 0) return null
  return VERIFY_STAGES[idx - 1]
}

// ─────────────────────────────────────────────────────────────────────────────
// Resume target (App-Kill / Re-Enter · Implementation-Spec §2.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resume the verify flow at the right stage.
 *
 * `lastStage` is the persisted `customer_verify_last_stage` (Block 3.12 wires
 * the DB column; until then the caller passes `null` / `undefined`). This
 * module is the single source of truth for the resume rule so the UI never
 * branches on raw DB values:
 *
 *   - no persisted stage           → start at {@link VerifyStage.Welcome},
 *   - an out-of-range value        → clamp to `Welcome` (defensive: a future
 *     schema change must not crash an old client),
 *   - the Confirm stage            → resume at `Confirm` (the customer was
 *     about to submit — drop them back there, not at the start),
 *   - any in-range stage           → resume there verbatim.
 *
 * `verifyState` gates the resume: an `approved` scene has already completed
 * verify, so re-opening the sheet starts fresh at `Welcome` (Re-Enter "Alles
 * neu prüfen" path is a distinct reset — Block 3.12).
 */
export function resolveResumeStage(
  lastStage: number | null | undefined,
  verifyState: CustomerVerifyState = 'not_started',
): VerifyStage {
  if (verifyState === 'approved') return VerifyStage.Welcome
  if (lastStage == null || !isVerifyStage(lastStage)) return VerifyStage.Welcome
  return lastStage
}

// ─────────────────────────────────────────────────────────────────────────────
// customer_verify_state FSM (Block 3.4 in_progress transition)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the `customer_verify_state` AFTER the customer's first verify
 * mutation (a Stage-2+ edit). The flow flips `not_started → in_progress` on
 * the first correction (Implementation-Spec §Stage-2).
 *
 * Returns `null` when no transition is needed (the scene is already
 * `in_progress` or further along) — the caller then skips the repo write.
 * An illegal current state (e.g. `expired` without a re-entry reset) also
 * returns `null` so the workflow never throws on a stale value; Block 3.12's
 * full FSM handles the re-entry resets.
 */
export function verifyStateAfterFirstEdit(
  current: CustomerVerifyState,
): CustomerVerifyState | null {
  if (current === 'not_started' && canTransitionCustomerVerifyState(current, 'in_progress')) {
    return 'in_progress'
  }
  return null
}

/**
 * Plan the `customer_verify_state` transition chain for the Stage-5 confirm
 * (Block 3.8 / 3.12).
 *
 * Implementation-Spec §5.1 maps BOTH Stage-5 actions — "Provider anfragen" and
 * "Erstmal speichern" — onto the `approved` DB enum value (the spec's
 * "completed"). But the FSM only permits `in_progress → approved`
 * (`20260520120011` guard). A customer who reached Confirm WITHOUT ever
 * mutating the scene is still `not_started`; jumping straight to `approved`
 * would be an illegal transition.
 *
 * This helper returns the ORDERED list of states the repository must walk to
 * land on `approved` legally:
 *
 *   - `not_started`  → `['in_progress', 'approved']`  (no-edit customer)
 *   - `in_progress`  → `['approved']`                 (edited customer)
 *   - `approved`     → `[]`                           (already done — re-confirm)
 *   - `rejected` / `expired` → `['in_progress', 'approved']`  (re-entry path)
 *
 * Every step in the returned chain is a legal FSM edge — the repository can
 * apply them in sequence and the `…customer_verify_fsm` trigger accepts each.
 * An empty array means "no transition needed".
 */
export function planConfirmVerifyStateChain(
  current: CustomerVerifyState,
): CustomerVerifyState[] {
  if (current === 'approved') return []
  if (current === 'in_progress') return ['approved']
  // not_started / rejected / expired — all reach `in_progress` legally first.
  return ['in_progress', 'approved']
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage-2 · wall-measurement correction (Block 3.3 + 3.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard numeric bounds for a customer measurement override (Implementation-Spec
 * §2.1 · Numeric-Picker). A length / height outside `[MIN, MAX]` is rejected by
 * the UI BEFORE a command is built — the Phase-2 constraint validator also
 * rejects non-positive dimensions, but catching it here gives the customer an
 * immediate, specific message instead of a generic constraint reject.
 */
export const VERIFY_MEASURE_MIN_M = 0.1
export const VERIFY_MEASURE_MAX_M = 100

/** A wall's correctable measurements — the Stage-2 numeric-picker payload. */
export interface WallMeasurement {
  /** Wall length in meters (centerline · computed, read-only display). */
  lengthM: number
  /** Wall height in meters — the editable dimension. */
  heightM: number
  /** Wall thickness in meters — carried through a resize unchanged. */
  thicknessM: number
}

/** Read a wall's current measurements off the resolved scene. */
export function readWallMeasurement(
  scene: RoomScene,
  wallId: string,
): WallMeasurement | null {
  const wall = scene.walls.find((w) => w.id === wallId)
  if (!wall) return null
  return {
    lengthM: wall.length_m,
    heightM: wall.height_m,
    thicknessM: wall.thickness_m,
  }
}

/** Outcome of {@link validateMeasurement}. */
export type MeasurementValidation =
  | { ok: true }
  | { ok: false; code: 'too_small' | 'too_large' | 'not_a_number'; hint: string }

/**
 * Validate a customer-entered measurement value (meters) against the hard
 * bounds. Returns a branchable result with a German hint — the Stage-2 picker
 * surfaces `hint` directly and disables its confirm button while `ok` is false.
 */
export function validateMeasurement(valueM: number): MeasurementValidation {
  if (!Number.isFinite(valueM)) {
    return { ok: false, code: 'not_a_number', hint: 'Bitte einen gültigen Wert eingeben.' }
  }
  if (valueM < VERIFY_MEASURE_MIN_M) {
    return {
      ok: false,
      code: 'too_small',
      hint: `Das ist zu klein — mindestens ${VERIFY_MEASURE_MIN_M.toFixed(2)} m.`,
    }
  }
  if (valueM > VERIFY_MEASURE_MAX_M) {
    return {
      ok: false,
      code: 'too_large',
      hint: `Das ist zu groß — höchstens ${VERIFY_MEASURE_MAX_M} m.`,
    }
  }
  return { ok: true }
}

/** Reason a {@link buildWallCorrectionCommand} call refused to build. */
export type WallCorrectionBuildErrorCode =
  /** The caller has no writable variant (signed out / role with no rights). */
  | 'no_writable_variant'
  /** The new height failed {@link validateMeasurement}. */
  | 'invalid_height'
  /** The targeted wall is not present in the scene. */
  | 'wall_not_found'

/** Outcome of {@link buildWallCorrectionCommand}. */
export type WallCorrectionBuildResult =
  | { ok: true; command: ResizeWallCommand }
  | { ok: false; code: WallCorrectionBuildErrorCode; hint: string }

/**
 * Build the {@link ResizeWallCommand} for a Stage-2 measurement correction —
 * RBAC-GATED to the `customer_corrections` variant.
 *
 * This is the Block-3.4 write-path seam: the VerifySheet NEVER constructs a
 * command itself; it calls this, gets back a ready command (or a branchable
 * refusal), and runs the command through `editHistoryStore.apply()`. The
 * variant id is resolved via {@link resolveWritableVariantId} — for a customer
 * that is always `customer_corrections` — and the spy-prevention guard
 * {@link assertCanWriteVariant} is asserted defensively. A non-customer caller
 * (or a signed-out one) cannot get a command back at all.
 *
 * Width / length are intentionally NOT correctable here: walls store length
 * parametrically via start/end points and `resize_wall` only touches
 * height + thickness (Master-Spec §10.1 · the same restriction the Phase-2
 * `ResizeWallCommand` enforces). The Stage-2 picker therefore edits height;
 * length is shown read-only.
 *
 * @param user    the verify-flow caller (a customer).
 * @param scene   the resolved scene the correction applies to.
 * @param wallId  the tapped wall.
 * @param newHeightM the customer-entered height (meters).
 */
export function buildWallCorrectionCommand(
  user: SpatialEditUser,
  scene: RoomScene,
  wallId: string,
  newHeightM: number,
): WallCorrectionBuildResult {
  const variantId = resolveWritableVariantId(user)
  if (variantId === null) {
    return {
      ok: false,
      code: 'no_writable_variant',
      hint: 'Du darfst diesen Scan nicht bearbeiten.',
    }
  }

  const heightCheck = validateMeasurement(newHeightM)
  if (!heightCheck.ok) {
    return { ok: false, code: 'invalid_height', hint: heightCheck.hint }
  }

  const measurement = readWallMeasurement(scene, wallId)
  if (!measurement) {
    return {
      ok: false,
      code: 'wall_not_found',
      hint: 'Diese Wand ist nicht mehr vorhanden.',
    }
  }

  // Defense-in-depth: assert the (customer → customer_corrections) write is
  // legal. `assertCanWriteVariant` throws a `SpatialEditPermissionError` for an
  // illegal target — for a correctly-resolved customer variant it is a no-op,
  // so the throw only ever fires on a tampered caller.
  const editScene: SpatialEditScene = {
    variantIds: [variantId],
  }
  assertCanWriteVariant(user, editScene, variantId)

  const command = new ResizeWallCommand({
    wallId,
    newHeightM,
    // Thickness is carried through unchanged — the customer only corrects the
    // visible height; `resize_wall` writes both together so the wall geometry
    // can never be left half-updated (Phase-2 `ResizeWallCommand` contract).
    newThicknessM: measurement.thicknessM,
    variantId,
    label: 'Wandhöhe korrigiert',
    // F11 — supply the resolved wall so the command re-anchors hosted openings
    // / wall-mounted objects that no longer fit the corrected height. The
    // `readWallMeasurement` lookup above already guarantees the wall exists.
    wall: scene.walls.find((w) => w.id === wallId),
  })

  return { ok: true, command }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage-3 · Layout edits (Block 3.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard floor on the wall count (Implementation-Spec §Stage-3 · Edge-Case §9
 * "Customer löscht alle Wände"). A room with fewer than {@link MIN_ROOM_WALLS}
 * walls is not renderable as an enclosure; the Stage-3 delete path refuses to
 * cross this floor BEFORE a command is built — the Phase-2 constraint validator
 * does not re-check global wall-count on a `delete_node`, so this gate is the
 * single point that enforces the minimum.
 */
export const MIN_ROOM_WALLS = 2

/** What a tapped Stage-3 surface resolves to — drives the action palette. */
export type LayoutTargetKind =
  /** A bounding wall — V1 allows DELETE only (walls are immovable · Phase 2). */
  | 'wall'
  /** A door / window opening — V1 allows MOVE (re-position along the host wall). */
  | 'opening'

/** A resolved Stage-3 edit target — what the customer selected in the 3D view. */
export interface LayoutEditTarget {
  kind: LayoutTargetKind
  /** The canonical node id of the wall / opening. */
  nodeId: string
  /** German label for the action sheet (e.g. "Wand · Eingang"). */
  label: string
}

/** Reason a Stage-3 build helper refused to build. */
export type LayoutBuildErrorCode =
  /** The caller has no writable variant (signed out / role with no rights). */
  | 'no_writable_variant'
  /** The targeted node is not present in the scene. */
  | 'node_not_found'
  /** Deleting this wall would drop the room below {@link MIN_ROOM_WALLS}. */
  | 'min_walls'
  /** `add_door` had no host wall (the wall id does not resolve). */
  | 'host_wall_missing'
  /** The opening / door geometry does not fit its host wall. */
  | 'does_not_fit'

/** Outcome of a Stage-3 command-build helper. */
export type LayoutBuildResult<TCommand> =
  | { ok: true; command: TCommand }
  | { ok: false; code: LayoutBuildErrorCode; hint: string }

/**
 * Resolve the writable variant for a verify-flow caller, refusing when the
 * caller has none. Shared by every Stage-3 / Stage-4 build helper so the RBAC
 * gate is asserted in exactly one place.
 */
function resolveVerifyVariant(
  user: SpatialEditUser,
):
  | { ok: true; variantId: import('../canonical/types/variants').VariantId }
  | { ok: false; code: 'no_writable_variant'; hint: string } {
  const variantId = resolveWritableVariantId(user)
  if (variantId === null) {
    return {
      ok: false,
      code: 'no_writable_variant',
      hint: 'Du darfst diesen Scan nicht bearbeiten.',
    }
  }
  // Defense-in-depth — the spy-prevention guard throws on a tampered caller;
  // for a correctly-resolved customer variant it is a no-op.
  const editScene: SpatialEditScene = { variantIds: [variantId] }
  assertCanWriteVariant(user, editScene, variantId)
  return { ok: true, variantId }
}

/** Find an opening by id together with its host wall. */
function findOpeningWithWall(
  scene: RoomScene,
  openingId: string,
): { wall: Wall; opening: WallOpening } | null {
  for (const wall of scene.walls) {
    const opening = wall.openings.find((o) => o.id === openingId)
    if (opening) return { wall, opening }
  }
  return null
}

/**
 * Build the {@link DeleteNodeCommand} for a Stage-3 wall deletion — RBAC-gated
 * to the `customer_corrections` variant.
 *
 * A fehl-erkannte ("mis-detected") wall is removed via the canonical
 * `{ __deleted: true }` override marker; the variant resolver also drops every
 * annotation orphaned by the deletion (H22 orphan-handling). The
 * {@link MIN_ROOM_WALLS} floor is enforced HERE — the build refuses before a
 * command exists when the deletion would leave fewer than 2 walls.
 */
export function buildWallDeleteCommand(
  user: SpatialEditUser,
  scene: RoomScene,
  wallId: string,
): LayoutBuildResult<DeleteNodeCommand> {
  const variant = resolveVerifyVariant(user)
  if (!variant.ok) return variant

  if (!scene.walls.some((w) => w.id === wallId)) {
    return {
      ok: false,
      code: 'node_not_found',
      hint: 'Diese Wand ist nicht mehr vorhanden.',
    }
  }
  if (scene.walls.length <= MIN_ROOM_WALLS) {
    return {
      ok: false,
      code: 'min_walls',
      hint: `Ein Raum braucht mindestens ${MIN_ROOM_WALLS} Wände.`,
    }
  }

  return {
    ok: true,
    command: new DeleteNodeCommand({
      nodeId: wallId,
      variantId: variant.variantId,
      label: 'Wand entfernt',
    }),
  }
}

/**
 * Build the {@link MoveNodeCommand} for a Stage-3 opening re-position —
 * RBAC-gated to `customer_corrections`.
 *
 * Openings are NOT walls — moving them is allowed (Phase-2 constraint reality:
 * `move_node` hard-rejects walls / floor / ceiling, but an opening is a legal
 * move target). The parametric `offset_along_wall_m` is the source of truth the
 * renderer derives the pose from; `move_node` carries a transform for the
 * audit trail and the per-move validator re-checks the opening still fits its
 * host wall (`DOOR_OUTSIDE_WALL` / `WINDOW_ABOVE_WALL` hard-rejects).
 */
export function buildOpeningMoveCommand(
  user: SpatialEditUser,
  scene: RoomScene,
  openingId: string,
  newOffsetAlongWallM: number,
): LayoutBuildResult<MoveNodeCommand> {
  const variant = resolveVerifyVariant(user)
  if (!variant.ok) return variant

  const found = findOpeningWithWall(scene, openingId)
  if (!found) {
    return {
      ok: false,
      code: 'node_not_found',
      hint: 'Diese Öffnung ist nicht mehr vorhanden.',
    }
  }
  const { wall, opening } = found
  if (
    newOffsetAlongWallM < 0 ||
    newOffsetAlongWallM + opening.width_m > wall.length_m
  ) {
    return {
      ok: false,
      code: 'does_not_fit',
      hint: 'Hier passt die Öffnung nicht in die Wand.',
    }
  }

  // The opening's world pose is derived parametrically — the `move_node`
  // transform is an audit-faithful position along the wall centerline so the
  // history row carries a meaningful payload. The renderer ignores it.
  const t = wall.length_m === 0 ? 0 : newOffsetAlongWallM / wall.length_m
  const transform = {
    ...IDENTITY_TRANSFORM,
    position: {
      x: wall.start_point.x + (wall.end_point.x - wall.start_point.x) * t,
      y: opening.offset_from_floor_m,
      z: wall.start_point.z + (wall.end_point.z - wall.start_point.z) * t,
    },
  }

  return {
    ok: true,
    command: new MoveNodeCommand({
      nodeId: openingId,
      newTransform: transform,
      variantId: variant.variantId,
      label: opening.type === 'window' ? 'Fenster verschoben' : 'Tür verschoben',
    }),
  }
}

/** Default door dimensions for a Stage-3 "+ Tür" insert (meters). */
export const VERIFY_DEFAULT_DOOR_WIDTH_M = 0.9
export const VERIFY_DEFAULT_DOOR_HEIGHT_M = 2.0

/**
 * Build the {@link AddDoorCommand} for a Stage-3 door insertion — RBAC-gated to
 * `customer_corrections`.
 *
 * Adding a DOOR (an opening) is in V1 scope — openings are not walls. The new
 * door is centred at `offsetAlongWallM`; the per-move validator's `add_door`
 * branch then hard-rejects a door that does not fit the host wall.
 *
 * V1 scope note (Implementation-Spec §6 #4): adding a free-form WALL is NOT in
 * V1 — the Phase-2 constraint engine has no wall-add path and the Master-Plan
 * forbids free-form modeling. The Mockup-15 "+ Wand" toolbar button is V1.x;
 * Stage-3 ships door/window add + wall delete + opening move only.
 */
export function buildAddDoorCommand(
  user: SpatialEditUser,
  scene: RoomScene,
  wallId: string,
  offsetAlongWallM: number,
): LayoutBuildResult<AddDoorCommand> {
  const variant = resolveVerifyVariant(user)
  if (!variant.ok) return variant

  const wall = scene.walls.find((w) => w.id === wallId)
  if (!wall) {
    return {
      ok: false,
      code: 'host_wall_missing',
      hint: 'Diese Wand ist nicht mehr vorhanden.',
    }
  }

  const width = VERIFY_DEFAULT_DOOR_WIDTH_M
  const offset = offsetAlongWallM - width / 2
  if (offset < 0 || offset + width > wall.length_m) {
    return {
      ok: false,
      code: 'does_not_fit',
      hint: 'Hier passt keine Tür in die Wand.',
    }
  }
  if (VERIFY_DEFAULT_DOOR_HEIGHT_M > wall.height_m) {
    return {
      ok: false,
      code: 'does_not_fit',
      hint: 'Die Wand ist zu niedrig für eine Tür.',
    }
  }

  const door: WallOpening = {
    id: `door_${nextCommandId()}`,
    name: 'Tür',
    type: 'door',
    parent_id: wallId,
    children_ids: [],
    transform: IDENTITY_TRANSFORM,
    source: 'manual',
    confidence: 1,
    variant_id: variant.variantId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    host_wall_id: wallId,
    offset_along_wall_m: offset,
    offset_from_floor_m: 0,
    width_m: width,
    height_m: VERIFY_DEFAULT_DOOR_HEIGHT_M,
    is_walkable_portal: true,
    swing_direction: 'unknown',
  }

  return {
    ok: true,
    command: new AddDoorCommand({
      wallId,
      door,
      variantId: variant.variantId,
      label: 'Tür hinzugefügt',
    }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage-4 · Wunsch-Pins (Block 3.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 4 customer-authored pin kinds the Stage-4 Pin-Picker offers
 * (Implementation-Spec §Stage-4 · Mockup-15 Phone 4). A strict subset of the
 * canonical {@link PinType} — the other kinds (`measurement` / `material` /
 * `task`) are scan-bridge / provider-annotation output, never customer input.
 */
export const VERIFY_PIN_TYPES: readonly PinType[] = Object.freeze([
  'damage',
  'wish',
  'note',
  'photo',
])

/** `true` when `value` is one of the 4 customer-settable pin kinds. */
export function isVerifyPinType(value: unknown): value is PinType {
  return (
    typeof value === 'string' &&
    (VERIFY_PIN_TYPES as readonly string[]).includes(value)
  )
}

/** A surface the customer tapped to drop a pin (Stage-4). */
export interface PinDropTarget {
  /** The canonical surface node id (wall / floor / ceiling / object). */
  surfaceId: string
  /** The surface category — the resolver discriminator. */
  surfaceType: AnchorSurfaceType
  /** UV in [0,1]² of the tapped point on that surface. */
  uv: { u: number; v: number }
}

/** Reason a Stage-4 pin-build helper refused to build. */
export type PinBuildErrorCode =
  /** The caller has no writable variant. */
  | 'no_writable_variant'
  /** The pin's anchor surface is not present in the scene. */
  | 'anchor_missing'
  /** The pin UV is outside [0,1]². */
  | 'uv_out_of_range'
  /** A `move_pin` targeted a pin id that does not exist. */
  | 'pin_not_found'

/** Outcome of a Stage-4 pin-build helper. */
export type PinBuildResult<TCommand> =
  | { ok: true; command: TCommand }
  | { ok: false; code: PinBuildErrorCode; hint: string }

/** German label per customer pin kind — the History-Timeline + summary copy. */
export const VERIFY_PIN_LABEL: Record<'damage' | 'wish' | 'note' | 'photo', string> = {
  damage: 'Schaden',
  wish: 'Wunsch',
  note: 'Notiz',
  photo: 'Foto',
}

/** `true` when `id` is a wall / floor / ceiling / object — a valid pin anchor. */
function pinAnchorSurfaceExists(scene: RoomScene, id: string): boolean {
  if (scene.floor.id === id || scene.ceiling.id === id) return true
  if (scene.walls.some((w) => w.id === id)) return true
  const objects = [
    ...scene.free_objects,
    ...scene.floor.floor_mounted,
    ...scene.ceiling.ceiling_mounted,
    ...scene.walls.flatMap((w) => w.wall_mounted),
  ]
  return objects.some((o) => o.id === id)
}

/** Detail fields captured for a Stage-4 pin (Implementation-Spec §Stage-4). */
export interface VerifyPinDetail {
  /** Pin kind — one of the 4 customer types. */
  pinType: PinType
  /** Pin title (the picker's first field) — optional. */
  title?: string
  /** Severity (leicht / mittel / stark) — meaningful for `damage` pins. */
  severity?: Pin['severity']
  /** Free-text note — optional. */
  note?: string
  /** Linked photo ids (the `photo` pin attaches an uploaded image). */
  photoIds?: string[]
}

/**
 * Build the {@link AddPinCommand} for a Stage-4 pin drop — RBAC-gated to
 * `customer_corrections`.
 *
 * The pin is fully anchored at creation (`anchor_surface_id` + `anchor_uv`),
 * so it is 3D-native from the first frame (Implementation-Spec §Stage-4
 * Pin-Anchor — no UI chip). The per-move validator's `add_pin` branch
 * hard-rejects a missing anchor surface or an out-of-range UV; this helper
 * pre-checks both so the customer gets a specific message instead of a generic
 * constraint reject.
 *
 * @param createdByUserId  the auth.users.id stamped onto `edited_by_user_id`.
 */
export function buildAddPinCommand(
  user: SpatialEditUser,
  scene: RoomScene,
  drop: PinDropTarget,
  detail: VerifyPinDetail,
  createdByUserId: string,
): PinBuildResult<AddPinCommand> {
  const variant = resolveVerifyVariant(user)
  if (!variant.ok) return variant

  if (!pinAnchorSurfaceExists(scene, drop.surfaceId)) {
    return {
      ok: false,
      code: 'anchor_missing',
      hint: 'Die Markierung muss auf einer Fläche liegen.',
    }
  }
  const { u, v } = drop.uv
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    return {
      ok: false,
      code: 'uv_out_of_range',
      hint: 'Die Markierung liegt außerhalb der Fläche.',
    }
  }

  const now = new Date().toISOString()
  const pin: Pin = {
    id: `pin_${nextCommandId()}`,
    type: 'pin',
    name: detail.title?.trim() || VERIFY_PIN_LABEL[verifyPinKind(detail.pinType)],
    parent_id: drop.surfaceId,
    children_ids: [],
    transform: IDENTITY_TRANSFORM,
    source: 'manual',
    confidence: 1,
    variant_id: variant.variantId,
    created_at: now,
    updated_at: now,
    edited_by_user_id: createdByUserId,
    pin_type: detail.pinType,
    anchor_surface_id: drop.surfaceId,
    anchor_surface_type: drop.surfaceType,
    anchor_uv: { u, v },
    anchor_offset_normal_m: 0.01,
    title: detail.title?.trim() || undefined,
    severity: detail.severity,
    linked_photo_ids: detail.photoIds ?? [],
    linked_note_ids: [],
    linked_task_ids: [],
  }

  return {
    ok: true,
    command: new AddPinCommand({
      pin,
      variantId: variant.variantId,
      label: `${VERIFY_PIN_LABEL[verifyPinKind(detail.pinType)]} gesetzt`,
    }),
  }
}

/** Narrow a {@link PinType} to the 4-kind customer subset for label lookup. */
function verifyPinKind(t: PinType): 'damage' | 'wish' | 'note' | 'photo' {
  return t === 'damage' || t === 'wish' || t === 'note' || t === 'photo'
    ? t
    : 'note'
}

/**
 * Build the {@link MovePinCommand} for a Stage-4 pin re-anchor — RBAC-gated to
 * `customer_corrections`. The pin must already exist on the scene; the new
 * anchor surface must exist and the UV must lie in [0,1]² (the per-move
 * validator's `move_pin` branch re-checks all three).
 */
export function buildMovePinCommand(
  user: SpatialEditUser,
  scene: RoomScene,
  pinId: string,
  drop: PinDropTarget,
): PinBuildResult<MovePinCommand> {
  const variant = resolveVerifyVariant(user)
  if (!variant.ok) return variant

  if (!scene.pins.some((p) => p.id === pinId)) {
    return {
      ok: false,
      code: 'pin_not_found',
      hint: 'Diese Markierung ist nicht mehr vorhanden.',
    }
  }
  if (!pinAnchorSurfaceExists(scene, drop.surfaceId)) {
    return {
      ok: false,
      code: 'anchor_missing',
      hint: 'Die Markierung muss auf einer Fläche liegen.',
    }
  }
  const { u, v } = drop.uv
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    return {
      ok: false,
      code: 'uv_out_of_range',
      hint: 'Die Markierung liegt außerhalb der Fläche.',
    }
  }

  const newAnchor: PinAnchor = {
    anchor_surface_id: drop.surfaceId,
    anchor_surface_type: drop.surfaceType,
    anchor_uv: { u, v },
    anchor_offset_normal_m: 0.01,
  }

  return {
    ok: true,
    command: new MovePinCommand({
      pinId,
      newAnchor,
      variantId: variant.variantId,
      label: 'Markierung verschoben',
    }),
  }
}
