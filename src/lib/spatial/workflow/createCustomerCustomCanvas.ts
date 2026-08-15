/**
 * Spatial · V1.6 Phase 3 · createCustomerCustomCanvas
 *
 * Thin wrapper over {@link createCustomerManualScene} for the "Leerer Raum"
 * entry-point (Master-Plan §5, B4-D3). The Customer taps the third tile in
 * `CustomerNewRoomSheet`, the Hub opens `CustomerCustomCanvasSheet`, the
 * user adjusts at least one stepper, and Save lands here.
 *
 * Pipeline contract:
 *   - Inputs are centimetres (the sheet UI's native unit); we convert to
 *     metres before forwarding to `createCustomerManualScene`.
 *   - `presetKind` is hard-locked to {@link CUSTOM_CANVAS_PRESET_KIND}. The
 *     preset's `category='other'` ensures the canonical scene reads as a
 *     generic room downstream (no bathroom-lighting bias).
 *   - Result-typing is inherited from `createCustomerManualScene` — this
 *     wrapper adds no new failure modes. The mandatory dirty-guard is
 *     enforced by the UI (P3-TBD #2); the workflow accepts any dims so a
 *     test or automation can still drive it with the defaults if needed.
 *
 * NOT re-exported from `src/lib/spatial/workflow/index.ts` — see
 * `feedback_spatial_barrel_no_session_imports`. Consumers import the file
 * directly to avoid pulling `supabase.auth.onAuthStateChange` into offline
 * test fixtures.
 */

import {
  createCustomerManualScene,
  type CreateCustomerManualSceneResult,
} from './createCustomerManualScene'
import { CUSTOM_CANVAS_PRESET_KIND } from '../canonical/presets/presetCustomerRooms'

export interface CreateCustomerCustomCanvasInput {
  /** Width axis (X) in centimetres — must come from the sheet stepper. */
  widthCm: number
  /** Length axis (Z) in centimetres. */
  lengthCm: number
  /** Ceiling height (Y) in centimetres. */
  heightCm: number
  /** Optional display label; defaults to "Leerer Raum" via the preset. */
  name?: string
}

export type CreateCustomerCustomCanvasResult = CreateCustomerManualSceneResult

export async function createCustomerCustomCanvas(
  input: CreateCustomerCustomCanvasInput,
): Promise<CreateCustomerCustomCanvasResult> {
  return createCustomerManualScene({
    presetKind: CUSTOM_CANVAS_PRESET_KIND,
    name: input.name,
    widthM: input.widthCm / 100,
    lengthM: input.lengthCm / 100,
    heightM: input.heightCm / 100,
  })
}
