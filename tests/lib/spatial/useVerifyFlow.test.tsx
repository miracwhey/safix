// @vitest-environment jsdom
/**
 * useVerifyFlow — ordered forward progression invariant (F14 · F15).
 *
 * Covers:
 *   - F14: pure stage navigation (goNext / goPrev, no edit) persists
 *     `customer_verify_last_stage` so an App-Kill resume reflects the
 *     furthest-seen stage.
 *   - F15: the resume / `goToStage` jump can never land past the furthest
 *     legitimately-reached stage, and the Stage-5 submit refuses until the
 *     customer has actually progressed to the Confirm stage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))

import { useVerifyFlow } from '../../../src/lib/spatial/hooks/useVerifyFlow'
import { useCanonicalSceneStore } from '../../../src/lib/spatial/canonical/store/sceneStore'
import { useEditHistoryStore } from '../../../src/lib/spatial/canonical/store/editHistoryStore'
import {
  getSpatialSceneRepository,
  resetSpatialSceneRepository,
} from '../../../src/lib/spatial/canonical/repository/registry'
import { STANDARD_VARIANTS, type Variant } from '../../../src/lib/spatial/canonical/types/variants'
import { VerifyStage } from '../../../src/lib/spatial/workflow/spatialVerifyWorkflow'
import { __testOnly_setSession, __testOnly_resetSession } from '../../../src/lib/session'
import { mockCustomerSession } from '../../helpers/mockSession'
import { makeRoom, makeWall, makeOpening } from './canonical/__helpers__/sceneFactory'

const VARIANTS: Variant[] = [
  { id: STANDARD_VARIANTS.BASE_ROOMPLAN, display_name: 'Scan', is_default: true },
  { id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS, display_name: 'Korrekturen', is_default: false },
]

function room() {
  return makeRoom({
    walls: [
      makeWall({
        id: 'w_s',
        openings: [makeOpening({ id: 'door-1', host_wall_id: 'w_s', type: 'door' })],
      }),
      makeWall({ id: 'w_e' }),
      makeWall({ id: 'w_n' }),
      makeWall({ id: 'w_w' }),
    ],
  })
}

async function seedScene(): Promise<string> {
  const scene = await getSpatialSceneRepository('in-memory').create({
    sourceScanId: 'scan-1',
    parametricStoragePath: 'scenes/scene-1/parametric.json',
    customerId: 'cust-1',
  })
  return scene.id
}

beforeEach(() => {
  __testOnly_resetSession()
  __testOnly_setSession(mockCustomerSession('cust-1'))
  resetSpatialSceneRepository()
  useEditHistoryStore.getState().clear()
  useCanonicalSceneStore.getState().setScene(room())
  useCanonicalSceneStore.getState().setOverrides([])
  useCanonicalSceneStore.getState().setVariants(VARIANTS)
  useCanonicalSceneStore.getState().setActiveVariantId(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
})
afterEach(() => {
  __testOnly_resetSession()
})

describe('useVerifyFlow · F14 navigation persistence', () => {
  it('goNext persists the furthest stage into customer_verify_last_stage', async () => {
    const sceneId = await seedScene()
    const repo = getSpatialSceneRepository('in-memory')
    const { result } = renderHook(() => useVerifyFlow({ sceneId }))

    act(() => result.current.goNext()) // → Measure (2)
    act(() => result.current.goNext()) // → Layout (3)
    expect(result.current.stage).toBe(VerifyStage.Layout)

    await waitFor(async () => {
      const scene = await repo.findById(sceneId)
      expect(scene?.customerVerifyLastStage).toBe(3)
      expect(scene?.customerVerifyLastActiveAt).not.toBeNull()
    })
  })
})

describe('useVerifyFlow · F15 ordered forward progression', () => {
  it('goToStage cannot skip ahead past the furthest reached stage', () => {
    const { result } = renderHook(() => useVerifyFlow({ sceneId: null }))
    expect(result.current.stage).toBe(VerifyStage.Welcome)

    // A jump straight to Confirm is clamped to the next legal stage (Measure).
    act(() => result.current.goToStage(VerifyStage.Confirm))
    expect(result.current.stage).toBe(VerifyStage.Measure)

    // Stepping forward one at a time IS allowed.
    act(() => result.current.goToStage(VerifyStage.Layout))
    expect(result.current.stage).toBe(VerifyStage.Layout)

    // A backward jump to an already-reached stage is always allowed.
    act(() => result.current.goToStage(VerifyStage.Welcome))
    expect(result.current.stage).toBe(VerifyStage.Welcome)
  })

  it('the Stage-5 submit refuses until the customer has reached Confirm', async () => {
    const sceneId = await seedScene()
    const { result } = renderHook(() => useVerifyFlow({ sceneId }))

    // The customer is parked on Welcome — submitting now is illegal.
    const blocked = await act(() => result.current.submitRequestProvider())
    expect(blocked.ok).toBe(false)
    expect(blocked.verifyState).toBeNull()

    // The scene must NOT have been confirmed.
    const repo = getSpatialSceneRepository('in-memory')
    const scene = await repo.findById(sceneId)
    expect(scene?.customerVerifyState).toBe('not_started')
  })

  it('the submit succeeds once the customer has navigated through to Confirm', async () => {
    const sceneId = await seedScene()
    const { result } = renderHook(() => useVerifyFlow({ sceneId }))

    act(() => result.current.goNext()) // 2
    act(() => result.current.goNext()) // 3
    act(() => result.current.goNext()) // 4
    act(() => result.current.goNext()) // 5 — Confirm
    expect(result.current.stage).toBe(VerifyStage.Confirm)

    const submitted = await act(() => result.current.submitSaveOnly())
    expect(submitted.ok).toBe(true)
    expect(submitted.verifyState).toBe('approved')
  })

  it('a resume at Confirm (last_stage=5) is legitimate and submits', async () => {
    const sceneId = await seedScene()
    // A resume at Confirm only happens when last_stage=5 was persisted — and
    // with F14/F15 that is only ever stamped after real progression.
    const { result } = renderHook(() =>
      useVerifyFlow({ sceneId, lastStage: 5, verifyState: 'in_progress' }),
    )
    expect(result.current.stage).toBe(VerifyStage.Confirm)

    const submitted = await act(() => result.current.submitSaveOnly())
    expect(submitted.ok).toBe(true)
    expect(submitted.verifyState).toBe('approved')
  })
})
