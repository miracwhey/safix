import { WebPlugin } from '@capacitor/core'
import type {
  GetCanonicalSceneArgs,
  GetCanonicalSceneResult,
  RoomPlanPlugin,
  RoomScanResult,
  RoomScanTelemetryEvent,
} from './definitions'

export class RoomPlanWeb extends WebPlugin implements RoomPlanPlugin {
  async checkAvailability(): Promise<{ available: boolean }> {
    return { available: false }
  }

  async startScan(): Promise<RoomScanResult> {
    throw this.unavailable('RoomPlan requires iOS with LiDAR sensor.')
  }

  async getCanonicalScene(_args: GetCanonicalSceneArgs): Promise<GetCanonicalSceneResult> {
    // Web stub — the native converter runs only on iOS 17+. Tests + storybook
    // can mock this; production web bundles fall back to the TS bridge
    // (`scanToParametric.ts`) instead of calling this method.
    throw this.unavailable('Canonical converter is iOS-only — use the TS bridge on web.')
  }

  async addListener(
    _eventName: 'roomScanTelemetry',
    _listenerFunc: (event: RoomScanTelemetryEvent) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    return { remove: async () => undefined }
  }

  async removeAllListeners(): Promise<void> {
    return
  }
}
