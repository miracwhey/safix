/**
 * Verify-flow Stage-1 summary derivation — `verifySceneSummary.ts` (Block 3.2).
 *
 * Covers the three validation paths (`ok` / `warnings` / `unrenderable`), the
 * element-count derivation, and that the simplified Quality-Score is the
 * canonical quality-engine output (VF-1 — not a second algorithm).
 */
import { describe, it, expect } from 'vitest'

import {
  deriveSceneCounts,
  deriveVerifySceneSummary,
  sceneToQualityInput,
} from '../../../src/lib/spatial/workflow/verifySceneSummary'
import { runQualityEngine } from '../../../src/lib/spatial/quality/qualityEngine'
import {
  makeRoom,
  makeWall,
  makeOpening,
  makeObject,
} from './canonical/__helpers__/sceneFactory'

/**
 * A clean, renderable room that passes the validator with no warnings — a
 * 4-wall room WITH a door (a doorless room legitimately raises the validator's
 * `ROOM_HAS_NO_DOORS` warning, which is the `warnings` path, not `ok`).
 */
function cleanRoom() {
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

describe('verifySceneSummary · deriveSceneCounts', () => {
  it('counts walls, doors, windows and objects across the scene-graph', () => {
    const room = makeRoom({
      walls: [
        makeWall({
          id: 'w_s',
          openings: [
            makeOpening({ id: 'door-1', host_wall_id: 'w_s', type: 'door' }),
            makeOpening({ id: 'win-1', host_wall_id: 'w_s', type: 'window' }),
          ],
        }),
        makeWall({ id: 'w_e' }),
        makeWall({ id: 'w_n' }),
      ],
      free_objects: [
        makeObject({ id: 'wc', category: 'toilet', host: 'floor', host_id: 'floor' }),
      ],
    })
    const counts = deriveSceneCounts(room)
    expect(counts).toEqual({ walls: 3, doors: 1, windows: 1, objects: 1 })
  })

  it('counts mounted objects on walls / floor / ceiling', () => {
    const room = makeRoom()
    room.walls[0].wall_mounted.push(
      makeObject({ id: 'sink', category: 'sink', host: 'wall', host_id: 'w_s' }),
    )
    room.floor.floor_mounted.push(
      makeObject({ id: 'rug', category: 'other', host: 'floor', host_id: 'floor' }),
    )
    expect(deriveSceneCounts(room).objects).toBe(2)
  })
})

describe('verifySceneSummary · quality reuses the canonical engine (VF-1)', () => {
  it('produces the same score the quality-engine produces for the projected input', () => {
    const room = cleanRoom()
    const summary = deriveVerifySceneSummary(room)
    const direct = runQualityEngine(sceneToQualityInput(room))
    // The summary score is NOT a second algorithm — it is verbatim engine out.
    expect(summary.quality.score).toBe(direct.score)
    expect(summary.quality.bucket).toBe(direct.bucket)
    expect(summary.quality.engineVersion).toBe(direct.engineVersion)
  })

  it('maps the bucket to a German label', () => {
    const summary = deriveVerifySceneSummary(cleanRoom())
    expect(['Sehr gut', 'Gut', 'Ausreichend', 'Niedrig']).toContain(
      summary.qualityLabel,
    )
  })
})

describe('verifySceneSummary · validation paths', () => {
  it('path `ok` — a clean 4-wall room with a door + floor', () => {
    const summary = deriveVerifySceneSummary(cleanRoom())
    expect(summary.path).toBe('ok')
    expect(summary.canProceed).toBe(true)
    expect(summary.hints).toEqual([])
  })

  it('path `unrenderable` — fewer than 3 walls (renderer cannot draw it)', () => {
    const room = makeRoom({
      walls: [makeWall({ id: 'w_s' }), makeWall({ id: 'w_e' })],
    })
    const summary = deriveVerifySceneSummary(room)
    expect(summary.path).toBe('unrenderable')
    expect(summary.canProceed).toBe(false)
    expect(summary.hints.length).toBeGreaterThan(0)
  })

  it('path `unrenderable` — a null scene never crashes, falls to re-scan block', () => {
    const summary = deriveVerifySceneSummary(null)
    expect(summary.path).toBe('unrenderable')
    expect(summary.canProceed).toBe(false)
    expect(summary.quality.score).toBe(0)
    expect(summary.counts).toEqual({ walls: 0, doors: 0, windows: 0, objects: 0 })
  })

  it('path `warnings` — renderable but the validator flagged an issue', () => {
    // A renderable room (floor + 4 walls) but one wall has zero height — the
    // validator raises a wall issue, so the scene is renderable-with-warnings.
    const room = makeRoom({
      walls: [
        makeWall({ id: 'w_s', height_m: 0 }),
        makeWall({ id: 'w_e' }),
        makeWall({ id: 'w_n' }),
        makeWall({ id: 'w_w' }),
      ],
    })
    const summary = deriveVerifySceneSummary(room)
    expect(summary.path).toBe('warnings')
    // `warnings` still allows proceeding — the customer can correct.
    expect(summary.canProceed).toBe(true)
    expect(summary.hints.length).toBeGreaterThan(0)
  })
})
