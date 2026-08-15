/**
 * Spatial · Canonical · Edit-Command Types (Phase 2 · Pre-2)
 *
 * The typed surface of the Phase-2 command-pattern edit-system.
 *
 * Canonical command taxonomy (Master-Spec §10.1 + Phase-3 Pin-Ops):
 *   the {@link EditOperation} discriminated union with 9 variants —
 *   `move_node`, `resize_wall`, `add_door`, `add_pin`, `delete_node`,
 *   `snap_object`, `set_material`, `move_pin`, `set_room_height`. The first
 *   8 are the Phase-2 locked set; `add_pin` is the Phase-3 Customer-Verify
 *   Stage-4 addition (Implementation-Spec §Stage-4 + §6 #7 · "Pin-Ops"),
 *   analogous to `add_door` — it introduces a NEW scene-graph node. The DB
 *   `command` column keeps the coarse override PRIMITIVE (`set` / `delete` /
 *   `restore`); the fine semantic discriminator is recorded in the
 *   `semantic_op` column — migration `20260520120030_spatial_edit_history_
 *   semantic_op.sql` for the Phase-2 set, `…120031_…add_pin_semantic_op.sql`
 *   for `add_pin`.
 *
 * Layer: pure L1 — no three.js / React / DOM. This file only describes the
 * shape of an edit; the command objects that EXECUTE an edit live in
 * `canonical/commands/` and the stack lives in the `editHistoryStore`.
 *
 * Apply model (binding):
 *   every command is reduced to one or more {@link NodeOverride} writes onto
 *   the ACTIVE variant layer — the base scene is never mutated. `before` /
 *   `after` carry the exact override snapshots so `undo()` is a verbatim
 *   inverse write. Deletion is the `{ __deleted: true }` override marker.
 */

import type { Transform, Vector3 } from './primitives.ts'
import type { ObjectHost } from './objects.ts'
import type { WallOpening } from './geometry.ts'
import type { AnchorSurfaceType, CanonicalSurfaceAnchorUv } from './annotations.ts'
import type { NodeOverride, VariantId } from './variants.ts'
import type { ISO8601 } from './scene-graph.ts'

// ─────────────────────────────────────────────────────────────────────────────
// EditOperation — the 8-variant canonical command union (Master-Spec §10.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pin anchor payload — the mutable subset of {@link Pin}'s 3D-native anchor
 * fields. `move_pin` re-anchors a pin to a (possibly different) surface; the
 * UV / normal-offset always travel together so a partial re-anchor cannot
 * leave the pin half on the old surface.
 */
export interface PinAnchor {
  /** ID of the wall / floor / ceiling / object the pin is anchored to. */
  anchor_surface_id: string
  /** Category of the anchored surface (resolver discriminator). */
  anchor_surface_type: AnchorSurfaceType
  /** UV coordinate in [0,1]² on the anchored surface. */
  anchor_uv: CanonicalSurfaceAnchorUv
  /** Offset along the surface normal in meters (default 0.01). */
  anchor_offset_normal_m: number
}

/**
 * Discriminated union of every edit the V1 command-pattern can express.
 *
 * The discriminator is `kind` (not `type`) so an EditOperation never collides
 * with a scene-graph {@link Node}'s `type` field when both appear in the same
 * scope.
 */
export type EditOperation =
  /** Move a node (object / pin host) to a new parent-relative transform. */
  | {
      kind: 'move_node'
      node_id: string
      new_transform: Transform
    }
  /** Resize a wall — height and/or thickness. */
  | {
      kind: 'resize_wall'
      wall_id: string
      new_height_m: number
      new_thickness_m: number
    }
  /**
   * Add a door (a {@link WallOpening} with `type: 'door'`) to a host wall.
   * The door object carries its own id, so undo is a `delete_node` of it.
   */
  | {
      kind: 'add_door'
      wall_id: string
      door: WallOpening
    }
  /**
   * Add a 3D-native {@link import('./annotations.ts').Pin} anchored to a
   * surface (Phase-3 Customer-Verify Stage-4). Like `add_door` this introduces
   * a NEW scene-graph node — the pin carries its own id, so undo is a
   * `delete_node` of it. The pin is fully anchored at creation (surface id +
   * UV), so the operation also carries the {@link PinAnchor}.
   */
  | {
      kind: 'add_pin'
      pin_id: string
      anchor: PinAnchor
    }
  /** Delete a node from the active variant via the `__deleted` marker. */
  | {
      kind: 'delete_node'
      node_id: string
    }
  /** Re-host an object onto a different surface (floor / wall / ceiling / ...). */
  | {
      kind: 'snap_object'
      object_id: string
      new_host: ObjectHost
      new_host_id: string
      /** World-space transform produced by the snap resolver. */
      new_transform: Transform
    }
  /** Set the material slug of a wall / floor / ceiling / object surface. */
  | {
      kind: 'set_material'
      node_id: string
      surface: 'wall' | 'floor' | 'ceiling' | 'object'
      material_id: string
    }
  /** Re-anchor a pin to a (possibly different) surface UV. */
  | {
      kind: 'move_pin'
      pin_id: string
      new_anchor: PinAnchor
    }
  /** Set the room ceiling height (also resizes every wall to match). */
  | {
      kind: 'set_room_height'
      room_id: string
      new_height_m: number
    }
  /**
   * Lane-2.5 · Stream B · B3 — append a new wall to the room. Used by the
   * Tap-to-Place tool (B5) on the empty-canvas preset, plus the Detail-Screen
   * "Wand hinzufügen" affordance on the 2×2 preset. Mirrors `add_door`:
   * introduces a NEW scene-graph node, so the command applies on the base
   * scene rather than as an override.
   */
  | {
      kind: 'add_wall'
      wall_id: string
      room_id: string
      start_point: Vector3
      end_point: Vector3
      height_m: number
      thickness_m: number
    }
  /**
   * Lane-2.5 · Stream B · B3 — remove a wall from the room. Mirrors the
   * inverse of `add_wall` (and a constrained delete_node restricted to wall
   * nodes — kept distinct so the persisted history shows the user's intent).
   */
  | {
      kind: 'delete_wall'
      wall_id: string
      room_id: string
    }

/** String-literal discriminator of an {@link EditOperation}. */
export type EditOperationKind = EditOperation['kind']

/**
 * The 11 canonical operation kinds, frozen. Mirrors the
 * `spatial_edit_history.semantic_op` CHECK constraint and the RPC validation
 * set — keep all three in sync when adding an operation.
 *
 * Lane-2.5 · Stream B added `add_wall` + `delete_wall` (migration
 * 20260525000100). The DB CHECK was extended in the same step.
 */
export const EDIT_OPERATION_KINDS: readonly EditOperationKind[] = Object.freeze([
  'move_node',
  'resize_wall',
  'add_door',
  'add_pin',
  'delete_node',
  'snap_object',
  'set_material',
  'move_pin',
  'set_room_height',
  'add_wall',
  'delete_wall',
])

// ─────────────────────────────────────────────────────────────────────────────
// EditCommand — an executed (or executable) edit wrapped for the history stack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single entry on the session command stack.
 *
 * `before` / `after` are the OVERRIDE snapshots — the exact `NodeOverride`
 * rows that were present on the affected `(base_node_id, variant_id)` pairs
 * BEFORE the command ran (`before`) and the rows the command WROTE (`after`).
 * `undo()` restores `before`; `do()` / `redo()` re-applies `after`. Because a
 * single edit can touch several override rows (e.g. `set_room_height` resizes
 * every wall), both are arrays.
 *
 * `variant_id` is the active variant the command targeted — commands ALWAYS
 * write to the active variant, never to `base_roomplan`.
 */
export interface EditCommand {
  /** Stable UUID of this command instance. */
  id: string
  /** The semantic operation this command performed. */
  operation: EditOperation
  /** Human-readable label for the Undo-Toast / History-Timeline (German UI). */
  label: string
  /** The variant layer the command wrote to. */
  variant_id: VariantId
  /** Override rows present on the touched pairs before the command ran. */
  before: NodeOverride[]
  /** Override rows the command wrote (its `after` state). */
  after: NodeOverride[]
  /** Wall-clock creation time (epoch ms) — for ordering within the session. */
  timestamp: number
}

// ─────────────────────────────────────────────────────────────────────────────
// EditHistoryEntry — the persistent audit-trail row (Master-Spec §10.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coarse override primitive recorded in `spatial_edit_history.command`.
 * Distinct from the fine {@link EditOperationKind} stored in `semantic_op`.
 */
export type EditHistoryCommand = 'set' | 'delete' | 'restore'

/**
 * One row of the persistent `spatial_edit_history` audit trail.
 *
 * NOT the same as an {@link EditCommand}: the EditCommand is the ephemeral
 * session-stack object (max 50, gone on logout); the EditHistoryEntry is the
 * durable record written via the `spatial_edit_history_append()` RPC. Block
 * 2.13-2.16 wires the persistence; this type is defined here so the
 * command-pattern and the future timeline share one shape.
 */
export interface EditHistoryEntry {
  id: string
  scene_id: string
  variant_id: VariantId
  /** auth.users.id of the actor — forced server-side to `auth.uid()`. */
  user_id: string
  /** Coarse override primitive (`spatial_edit_history.command`). */
  command: EditHistoryCommand
  /** Fine semantic discriminator (`spatial_edit_history.semantic_op`). */
  semantic_op: EditOperationKind
  /** The full operation payload. */
  operation: EditOperation
  before_snapshot: NodeOverride[]
  after_snapshot: NodeOverride[]
  created_at: ISO8601
}

// ─────────────────────────────────────────────────────────────────────────────
// ComponentState — the reversible state of one node for snapshot diffing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reversible state of one scene node, as captured for a command's
 * before/after snapshot. Edit-Spec §5.1 calls this `ComponentState`; in the
 * canonical model a node's per-variant state IS its `NodeOverride` (or its
 * absence), so `ComponentState` is the override row keyed by node + variant.
 *
 * `override` is `null` when the node had NO override on the variant before
 * the command — i.e. it was showing pure base-scene state.
 */
export interface ComponentState {
  /** ID of the base-scene node this state describes. */
  base_node_id: string
  /** Variant layer the state belongs to. */
  variant_id: VariantId
  /** The override row, or `null` when the node was un-overridden (base state). */
  override: NodeOverride | null
}
