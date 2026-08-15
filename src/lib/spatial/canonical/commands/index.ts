/**
 * Spatial · Canonical · Commands · Barrel
 *
 * Public surface of the command-pattern edit-system: the {@link BaseCommand}
 * foundation + the 9 concrete commands matching the canonical
 * {@link import('../types/commands.ts').EditOperation} union (8 Phase-2 +
 * the Phase-3 {@link AddPinCommand}).
 *
 * Layer: pure L1 — no three.js / React / DOM. The command-stack store
 * (`editHistoryStore`) is NOT re-exported here because it depends on zustand;
 * import it from `../store/editHistoryStore.ts` directly.
 */

export {
  BaseCommand,
  readOverride,
  writeOverrideOrRemove,
  cloneOverride,
  nextCommandId,
  type SceneOverrideWriter,
  type SceneEditContext,
} from './BaseCommand.ts'

export { MoveNodeCommand } from './MoveNodeCommand.ts'
export { ResizeWallCommand } from './ResizeWallCommand.ts'
export { AddDoorCommand } from './AddDoorCommand.ts'
export { AddPinCommand } from './AddPinCommand.ts'
export { DeleteNodeCommand } from './DeleteNodeCommand.ts'
export { SnapObjectCommand, snapResultToTransform } from './SnapObjectCommand.ts'
export { SetMaterialCommand, type MaterialSurface } from './SetMaterialCommand.ts'
export { MovePinCommand } from './MovePinCommand.ts'
export { SetRoomHeightCommand } from './SetRoomHeightCommand.ts'
// Lane-2.5 · Stream B · B3 — manual-room wall add/remove commands.
export { AddWallCommand } from './AddWallCommand.ts'
export { DeleteWallCommand } from './DeleteWallCommand.ts'

// Phase 2 · Block 2.15 — the persistent reverter's override-write command.
export { RestoreOverrideCommand } from './RestoreOverrideCommand.ts'
