/**
 * getCanonicalScene bridge wrapper — error-code mapping unit tests
 * (Szenen-Produktion · B3).
 *
 * The native `RoomPlan` plugin is module-mocked so each native reject code can
 * be asserted against its typed {@link CanonicalSceneResult} mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roomPlanMock } = vi.hoisted(() => ({
  roomPlanMock: { getCanonicalScene: vi.fn() },
}))
vi.mock('@fixup/capacitor-roomplan', () => ({ RoomPlan: roomPlanMock }))

import { getCanonicalSceneFromNative } from '../../../../../src/lib/spatial/canonical/bridge/getCanonicalScene'

/** A Capacitor-style reject — an Error carrying a stable `code`. */
function rejectWith(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code })
}

describe('getCanonicalSceneFromNative', () => {
  beforeEach(() => {
    roomPlanMock.getCanonicalScene.mockReset()
  })

  it('returns ok with the document on success', async () => {
    roomPlanMock.getCanonicalScene.mockResolvedValue({
      document: { schema_version: '1.0' },
    })
    const result = await getCanonicalSceneFromNative({ scanId: 'scan-1' })
    expect(result).toEqual({ ok: true, document: { schema_version: '1.0' } })
  })

  it('maps CANONICAL_CONVERT_NO_SCAN → no_scan', async () => {
    roomPlanMock.getCanonicalScene.mockRejectedValue(rejectWith('CANONICAL_CONVERT_NO_SCAN'))
    expect(await getCanonicalSceneFromNative({ scanId: 'scan-1' })).toMatchObject({
      ok: false,
      reason: 'no_scan',
    })
  })

  it('maps CANONICAL_CONVERT_FAILED → convert_failed', async () => {
    roomPlanMock.getCanonicalScene.mockRejectedValue(rejectWith('CANONICAL_CONVERT_FAILED'))
    expect(await getCanonicalSceneFromNative({ scanId: 'scan-1' })).toMatchObject({
      ok: false,
      reason: 'convert_failed',
    })
  })

  it('maps ROOMPLAN_V2_UNAVAILABLE → unavailable', async () => {
    roomPlanMock.getCanonicalScene.mockRejectedValue(rejectWith('ROOMPLAN_V2_UNAVAILABLE'))
    expect(await getCanonicalSceneFromNative({ scanId: 'scan-1' })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('maps the Capacitor web-stub UNAVAILABLE reject → unavailable', async () => {
    roomPlanMock.getCanonicalScene.mockRejectedValue(rejectWith('UNAVAILABLE'))
    expect(await getCanonicalSceneFromNative({ scanId: 'scan-1' })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('maps an unexpected reject → convert_failed', async () => {
    roomPlanMock.getCanonicalScene.mockRejectedValue(new Error('weird'))
    expect(await getCanonicalSceneFromNative({ scanId: 'scan-1' })).toMatchObject({
      ok: false,
      reason: 'convert_failed',
      message: 'weird',
    })
  })

  it('forwards scanId / jobId / projectId to the native plugin', async () => {
    roomPlanMock.getCanonicalScene.mockResolvedValue({ document: {} })
    await getCanonicalSceneFromNative({ scanId: 's', jobId: 'j', projectId: 'p' })
    expect(roomPlanMock.getCanonicalScene).toHaveBeenCalledWith({
      scanId: 's',
      jobId: 'j',
      projectId: 'p',
    })
  })
})
