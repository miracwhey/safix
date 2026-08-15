export {
  startCapture,
  finishCapture,
  submitForReview,
  verify,
  markOfferReady,
  lockForDispute,
  archive,
  ScanWorkflowError,
} from './scanStateMachine'
export { captureScan, type CaptureScanInput, type CaptureScanResult } from './captureScan'
export {
  enqueueConvertJob,
  type EnqueueConvertArgs,
  type EnqueueConvertResult,
} from './enqueueConvert'

// NOTE: `resumePendingCapture` + `createEmptyRoomProject` are intentionally
// NOT re-exported here. Both transitively import `presales/repository/registry`
// → `createProviderPresalesProject` → `session.ts`, whose module-load
// `onAuthStateChange` side effect would be dragged into every importer of the
// `lib/spatial` barrel — breaking offline unit tests that mock only
// `supabase.storage` (CI run 26372778081 caught this on PR #937). Import
// these workflows directly from their files instead. Mirrors the existing
// carve-out for `spatialEditPermissions`.

// NOTE: `spatialEditPermissions` is intentionally NOT re-exported here. It
// imports `session.ts`, whose module-load `onAuthStateChange` side effect
// would be dragged into every importer of the `lib/spatial` barrel — breaking
// offline unit tests that mock only `supabase.storage`. Import the guard
// directly from `workflow/spatialEditPermissions` instead.
