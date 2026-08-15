import { registerPlugin } from '@capacitor/core'
import type { RoomPlanPlugin } from './definitions'
import { RoomPlanWeb } from './web'

const RoomPlan = registerPlugin<RoomPlanPlugin>('RoomPlan', {
  web: () => new RoomPlanWeb(),
})

export { RoomPlan }
export type {
  RoomPlanPlugin,
  RoomScanResult,
  WallInfo,
  OpeningInfo,
  RoomScanTelemetryEvent,
  RoomScanErrorCode,
  ScanDeviceMeta,
  MeshClassification,
  GetCanonicalSceneArgs,
  GetCanonicalSceneResult,
  GetCanonicalSceneErrorCode,
} from './definitions'
