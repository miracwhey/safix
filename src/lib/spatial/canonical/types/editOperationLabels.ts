/**
 * Spatial · Canonical · Edit-Operation German Labels (Phase 2 · Block 2.14)
 *
 * Human-readable German labels for the 11 canonical {@link EditOperationKind}s
 * and the 3 coarse {@link EditHistoryCommand} primitives. The History-Timeline
 * (Block 2.14) and the reverter (Block 2.15) both render these — keeping them
 * in one L1 module avoids two drifting copies.
 *
 * Lane-2.5 · Stream B added `add_wall` + `delete_wall` (the Tap-to-Place tool
 * and the wall-delete affordance on manual rooms).
 *
 * Layer: pure L1 — no React / DOM. A constant + two pure lookups.
 */

import type { EditHistoryCommand, EditOperationKind } from './commands.ts'

/**
 * German label per fine semantic operation. Phrased as a completed action
 * ("Wand verschoben") so it reads naturally in a chronological timeline:
 * "Wand verschoben · vor 2 Min".
 */
export const EDIT_OPERATION_LABELS: Readonly<Record<EditOperationKind, string>> = Object.freeze({
  move_node: 'Objekt verschoben',
  resize_wall: 'Wand angepasst',
  add_door: 'Tür hinzugefügt',
  add_pin: 'Markierung gesetzt',
  delete_node: 'Objekt gelöscht',
  snap_object: 'Objekt ausgerichtet',
  set_material: 'Material geändert',
  move_pin: 'Markierung verschoben',
  set_room_height: 'Raumhöhe geändert',
  add_wall: 'Wand hinzugefügt',
  delete_wall: 'Wand entfernt',
})

/**
 * Resolve the German label for a fine semantic operation. Falls back to the
 * raw kind string when an unknown discriminator slips through (defensive — the
 * type makes this unreachable for well-typed callers).
 */
export function editOperationLabel(kind: EditOperationKind): string {
  return EDIT_OPERATION_LABELS[kind] ?? kind
}

/**
 * German label for a coarse override primitive. The timeline uses this as a
 * secondary tag — `restore` is the visually distinct one (a revert), so it is
 * surfaced explicitly; `set` / `delete` are implied by the semantic label.
 */
export function editHistoryCommandLabel(command: EditHistoryCommand): string {
  switch (command) {
    case 'set':
      return 'Geändert'
    case 'delete':
      return 'Gelöscht'
    case 'restore':
      return 'Wiederhergestellt'
    default:
      return command
  }
}

/**
 * Compose the full timeline label for one history row: the semantic action,
 * suffixed with "(wiederhergestellt)" when the row is a reverter write so the
 * user can tell a restore apart from the original edit.
 */
export function historyRowLabel(
  semanticOp: EditOperationKind,
  command: EditHistoryCommand,
): string {
  const base = editOperationLabel(semanticOp)
  return command === 'restore' ? `${base} (wiederhergestellt)` : base
}
