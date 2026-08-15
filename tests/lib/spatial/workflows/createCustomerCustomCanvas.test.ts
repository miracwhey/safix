/**
 * Spatial V1.6 · Phase 3 · createCustomerCustomCanvas workflow tests
 *
 * The wrapper delegates to `createCustomerManualScene`; this suite verifies:
 *   1. arguments are forwarded with `presetKind='custom'` and cm→m converted
 *   2. user-provided name is forwarded
 *   3. the result-typed success path bubbles up unchanged
 *   4. the result-typed error path bubbles up unchanged
 *   5. the workflow accepts dirty AND default dims (dirty-guard lives in UI)
 *   6. each axis conversion is independent (no field cross-contamination)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import { createCustomerCustomCanvas } from '../../../../src/lib/spatial/workflow/createCustomerCustomCanvas'
import { CUSTOM_CANVAS_PRESET_KIND } from '../../../../src/lib/spatial/canonical/presets/presetCustomerRooms'
import type {
  CreateCustomerManualSceneInput,
  CreateCustomerManualSceneResult,
} from '../../../../src/lib/spatial/workflow/createCustomerManualScene'

const manualSceneSpy = vi.fn<
  (input: CreateCustomerManualSceneInput) => Promise<CreateCustomerManualSceneResult>
>()

vi.mock(
  '../../../../src/lib/spatial/workflow/createCustomerManualScene',
  () => ({
    createCustomerManualScene: (input: CreateCustomerManualSceneInput) =>
      manualSceneSpy(input),
  }),
)

function fakeSuccess(): CreateCustomerManualSceneResult {
  return {
    ok: true,
    sceneId: 'scene-1',
    scan: {
      id: 'scan-1',
      jobId: null,
      projectId: null,
      presalesProjectId: null,
      ownerType: 'customer',
      capturedBy: 'user-1',
      source: 'manual',
      status: 'completed',
      scanStartedAt: 0,
      scanEndedAt: 0,
      createdAt: 0,
      updatedAt: 0,
      sharedWithCustomer: false,
      sharedAt: null,
      sharedWithProviderId: null,
      sharedWithProviderAt: null,
      anchorTransformsJson: null,
      pointCloudPath: null,
      meshSummaryJson: null,
      hash: null,
      deviceMeta: {},
      parentScanId: null,
      qualityScore: null,
      qualityLabel: null,
    },
    scene: { id: 'scene-1' } as never,
    parametricPath: 'path/scene-1.json.gz',
    presetKind: CUSTOM_CANVAS_PRESET_KIND,
    name: 'Leerer Raum',
  }
}

beforeEach(() => {
  manualSceneSpy.mockReset()
})

describe('createCustomerCustomCanvas', () => {
  it('forwards `presetKind=custom` with cm→m converted dims', async () => {
    manualSceneSpy.mockResolvedValueOnce(fakeSuccess())

    await createCustomerCustomCanvas({ widthCm: 320, lengthCm: 280, heightCm: 270 })

    expect(manualSceneSpy).toHaveBeenCalledTimes(1)
    expect(manualSceneSpy).toHaveBeenCalledWith({
      presetKind: CUSTOM_CANVAS_PRESET_KIND,
      name: undefined,
      widthM: 3.2,
      lengthM: 2.8,
      heightM: 2.7,
    })
  })

  it('forwards the user-supplied name', async () => {
    manualSceneSpy.mockResolvedValueOnce(fakeSuccess())

    await createCustomerCustomCanvas({
      widthCm: 300,
      lengthCm: 300,
      heightCm: 260,
      name: 'Mein Atelier',
    })

    expect(manualSceneSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Mein Atelier' }),
    )
  })

  it('passes the success result through unchanged', async () => {
    const success = fakeSuccess()
    manualSceneSpy.mockResolvedValueOnce(success)

    const result = await createCustomerCustomCanvas({
      widthCm: 260,
      lengthCm: 240,
      heightCm: 250,
    })

    expect(result).toEqual(success)
  })

  it('passes the error result through unchanged', async () => {
    const error: CreateCustomerManualSceneResult = {
      ok: false,
      reason: 'not_authenticated',
      message: 'Anmeldung erforderlich.',
    }
    manualSceneSpy.mockResolvedValueOnce(error)

    const result = await createCustomerCustomCanvas({
      widthCm: 260,
      lengthCm: 240,
      heightCm: 250,
    })

    expect(result).toEqual(error)
  })

  it('accepts default 250/250/250 dims (dirty-guard is UI-only)', async () => {
    manualSceneSpy.mockResolvedValueOnce(fakeSuccess())

    await createCustomerCustomCanvas({ widthCm: 250, lengthCm: 250, heightCm: 250 })

    expect(manualSceneSpy).toHaveBeenCalledWith(
      expect.objectContaining({ widthM: 2.5, lengthM: 2.5, heightM: 2.5 }),
    )
  })

  it('converts each axis independently — no field cross-contamination', async () => {
    manualSceneSpy.mockResolvedValueOnce(fakeSuccess())

    await createCustomerCustomCanvas({ widthCm: 100, lengthCm: 1500, heightCm: 200 })

    expect(manualSceneSpy).toHaveBeenCalledWith(
      expect.objectContaining({ widthM: 1, lengthM: 15, heightM: 2 }),
    )
  })
})
