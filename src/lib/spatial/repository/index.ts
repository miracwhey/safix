export type { SpatialRepository } from './SpatialRepository'
export { InMemorySpatialRepository } from './InMemorySpatialRepository'
export { SupabaseSpatialRepository } from './SupabaseSpatialRepository'
export {
  getSpatialRepository,
  setSpatialRepository,
  initializeSpatialRepository,
  resetSpatialRepository,
} from './registry'
export {
  ALLOWED_SCAN_TRANSITIONS,
  SCAN_FSM_ERRCODE,
  ScanFsmViolation,
  assertScanTransition,
  assertScanInsertStatus,
} from './fsm'
