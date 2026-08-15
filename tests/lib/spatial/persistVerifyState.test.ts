/**
 * Verify-state persistence — `persistVerifyState.ts` (Block 3.12).
 *
 * Covers the FSM-chain walk for the Stage-5 confirm (`not_started` and
 * `in_progress` both reach `approved` legally), the first-edit progress flip,
 * the activity-touch, and the no-throw failure handling.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { InMemorySpatialSceneRepository } from '../../../src/lib/spatial/canonical/repository/InMemorySpatialSceneRepository'
import {
  persistVerifyProgress,
  touchVerifyActivity,
  persistVerifyConfirm,
} from '../../../src/lib/spatial/canonical/workflow/persistVerifyState'

let repo: InMemorySpatialSceneRepository

/** Seed a fresh `not_started` scene; returns its generated id. */
async function seed(): Promise<string> {
  const scene = await repo.create({
    sourceScanId: 'scan-1',
    parametricStoragePath: 'scenes/x/parametric.json',
  })
  return scene.id
}

beforeEach(() => {
  repo = new InMemorySpatialSceneRepository()
})

// ── progress flip (first edit · Block 3.4) ─────────────────────────────────

describe('persistVerifyProgress', () => {
  it('writes the `not_started → in_progress` flip + resume columns', async () => {
    const sceneId = await seed()
    const result = await persistVerifyProgress({ sceneId, repository: repo }, 'in_progress', 2)
    expect(result.applied).toBe(true)
    if (result.applied) expect(result.state).toBe('in_progress')

    const scene = await repo.findById(sceneId)
    expect(scene?.customerVerifyState).toBe('in_progress')
    expect(scene?.customerVerifyLastStage).toBe(2)
    expect(scene?.customerVerifyLastActiveAt).not.toBeNull()
  })

  it('stamps the resume columns even when no FSM change is needed', async () => {
    const sceneId = await seed()
    await persistVerifyProgress({ sceneId, repository: repo }, 'in_progress', 2)
    // A later edit — no transition (null) but the stage still advances.
    const result = await persistVerifyProgress({ sceneId, repository: repo }, null, 3)
    expect(result.applied).toBe(true)
    const scene = await repo.findById(sceneId)
    expect(scene?.customerVerifyState).toBe('in_progress')
    expect(scene?.customerVerifyLastStage).toBe(3)
  })

  it('never throws — a missing scene yields applied:false', async () => {
    const result = await persistVerifyProgress(
      { sceneId: 'ghost', repository: repo },
      'in_progress',
      2,
    )
    expect(result.applied).toBe(false)
  })
})

// ── activity touch (sheet-open · VF-4 anchor) ──────────────────────────────

describe('touchVerifyActivity', () => {
  it('stamps last-active-at + last-stage without an FSM change', async () => {
    const sceneId = await seed()
    const result = await touchVerifyActivity({ sceneId, repository: repo }, 1)
    expect(result.applied).toBe(true)
    const scene = await repo.findById(sceneId)
    expect(scene?.customerVerifyState).toBe('not_started')
    expect(scene?.customerVerifyLastStage).toBe(1)
    expect(scene?.customerVerifyLastActiveAt).not.toBeNull()
  })

  it('never throws on a missing scene', async () => {
    const result = await touchVerifyActivity({ sceneId: 'ghost', repository: repo }, 1)
    expect(result.applied).toBe(false)
  })
})

// ── Stage-5 confirm · FSM-chain walk (Block 3.8 / 3.12) ────────────────────

describe('persistVerifyConfirm', () => {
  it('a no-edit customer (`not_started`) walks → in_progress → approved', async () => {
    const sceneId = await seed()
    const result = await persistVerifyConfirm({ sceneId, repository: repo })
    expect(result.applied).toBe(true)
    if (result.applied) expect(result.state).toBe('approved')

    const scene = await repo.findById(sceneId)
    expect(scene?.customerVerifyState).toBe('approved')
    expect(scene?.customerVerifyLastStage).toBe(5)
    expect(scene?.customerVerifyLastActiveAt).not.toBeNull()
  })

  it('an editing customer (`in_progress`) walks → approved', async () => {
    const sceneId = await seed()
    await repo.update(sceneId, { customerVerifyState: 'in_progress' })
    const result = await persistVerifyConfirm({ sceneId, repository: repo })
    expect(result.applied).toBe(true)
    if (result.applied) expect(result.state).toBe('approved')
    const scene = await repo.findById(sceneId)
    expect(scene?.customerVerifyState).toBe('approved')
  })

  it('an already-approved scene is an idempotent no-op (re-confirm)', async () => {
    const sceneId = await seed()
    await persistVerifyConfirm({ sceneId, repository: repo })
    // Re-confirm — the FSM chain is empty; the call still succeeds.
    const result = await persistVerifyConfirm({ sceneId, repository: repo })
    expect(result.applied).toBe(true)
    if (result.applied) expect(result.state).toBe('approved')
    const scene = await repo.findById(sceneId)
    expect(scene?.customerVerifyState).toBe('approved')
    expect(scene?.customerVerifyLastStage).toBe(5)
  })

  it('never throws — a missing scene yields applied:false', async () => {
    const result = await persistVerifyConfirm({ sceneId: 'ghost', repository: repo })
    expect(result.applied).toBe(false)
  })
})
