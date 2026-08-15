/**
 * Spatial Core · Phase 2 · Quality Engine TS ↔ SQL Parity Suite
 *
 * Parity contract for the mesh-aware overload of `run_quality_engine`. The
 * SECURITY DEFINER RPC in `supabase/migrations/20260519000000_quality_engine_mesh_summary.sql`
 * MUST emit byte-identical (score, bucket, warnings) tuples to the pure-
 * function engine in `src/lib/spatial/quality/rules.ts` for every input
 * combination of room state × mesh summary that this suite enumerates.
 *
 * The test runs the pure function directly + the InMemorySpatialRepository's
 * mirror (which also calls the pure function under the hood). The SQL side
 * is not invoked from this suite — the InMemory mirror IS the SQL contract.
 * Whenever a rule branch changes here, the SQL migration above must be
 * touched in the same PR.
 *
 * Suite is grouped by (mesh present, mesh absent) × (R6 hit / miss) ×
 * (R7 mesh-branch hit / miss / fallback). Each row is documented inline so
 * future engineers can see at a glance which combinations are covered.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemorySpatialRepository,
  initializeSpatialRepository,
  resetSpatialRepository,
} from '../../../src/lib/spatial'
import {
  runQualityEngine as pureRunQualityEngine,
  QUALITY_THRESHOLDS,
  type MeshSummary,
} from '../../../src/lib/spatial/quality'
import type { MeshClassification } from '@fixup/capacitor-roomplan'
import { meshSummaryFromClassification } from '../../../src/lib/spatial/quality/meshSummaryFromClassification'

const USER = 'uuuuuuuu-0000-0000-0000-c00000000001'
const PROJECT = 'pppppppp-0000-0000-0000-c00000000001'

/** Seed a clean 4-wall scan so R1 + R7-fallback don't fire by accident. */
async function seedCleanScan(repo: InMemorySpatialRepository, surfaceConfidence: number | null = 0.9) {
  const scan = await repo.createScan({
    projectId: PROJECT,
    source: 'roomplan',
    capturedBy: USER,
  })
  const room = await repo.createScanRoom({
    scanId: scan.id,
    areaM2Estimated: 22,
    ceilingHEstimated: 2.6,
  })
  for (let i = 0; i < 4; i += 1) {
    await repo.createScanSurface({
      roomId: room.id,
      surfaceExternalId: `wall_${i}`,
      kind: 'wall',
      dimWEstimated: 4,
      dimHEstimated: 2.6,
      confidence: surfaceConfidence,
    })
  }
  return { scan, room }
}

/** Build the mock plugin payload used by the harvester→summary mapper. */
function makeClassification(overrides: Partial<MeshClassification>): MeshClassification {
  const base: MeshClassification = {
    anchorCount: 8,
    totalFaces: 5000,
    classFaces: {
      none: 200,
      wall: 3800,
      floor: 700,
      ceiling: 200,
      table: 50,
      seat: 30,
      window: 10,
      door: 10,
    },
    wallCoverageRatio: 0.76,
    degraded: false,
    thermalStateAtSnapshot: 'nominal',
    samplesCollected: 240,
    anchorsWithoutClassification: 0,
    durationSec: 120,
    avgPollHz: 2,
  }
  return { ...base, ...overrides, classFaces: { ...base.classFaces, ...(overrides.classFaces ?? {}) } }
}

describe('Phase 2 — Quality Engine mesh-summary parity', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
  })

  it('meshSummaryFromClassification maps wallCoverageRatio + totalFaces, drops everything else', () => {
    const summary = meshSummaryFromClassification(
      makeClassification({ wallCoverageRatio: 0.82, totalFaces: 9001 }),
    )
    expect(summary).toEqual({ wallCoveragePct: 0.82, triangleCount: 9001 })
  })

  it('meshSummaryFromClassification returns undefined when degraded=true', () => {
    const summary = meshSummaryFromClassification(
      makeClassification({ degraded: true, wallCoverageRatio: 0.5 }),
    )
    expect(summary).toBeUndefined()
  })

  it('meshSummaryFromClassification returns undefined when input is null/undefined', () => {
    expect(meshSummaryFromClassification(null)).toBeUndefined()
    expect(meshSummaryFromClassification(undefined)).toBeUndefined()
  })

  it('R6 fires when wallCoveragePct < 0.7 floor — TS pure-fn + repo agree', async () => {
    const { scan } = await seedCleanScan(repo)
    const mesh: MeshSummary = { wallCoveragePct: 0.5 }
    const pure = pureRunQualityEngine({
      rooms: await repo.listScanRooms(scan.id),
      surfaces: await listAllSurfaces(repo, scan.id),
      measurements: await repo.listScanMeasurements(scan.id),
      meshSummary: mesh,
    })
    const repoReport = await repo.runQualityEngine(scan.id, { meshSummary: mesh })
    expect(repoReport.warnings).toEqual(pure.warnings)
    expect(repoReport.score).toBe(pure.score)
    expect(repoReport.bucket).toBe(pure.bucket)
    expect(repoReport.warnings).toContain('wall_coverage_low')
  })

  it('R6 silent when wallCoveragePct exactly at floor 0.7 (boundary is exclusive-below)', async () => {
    const { scan } = await seedCleanScan(repo)
    const mesh: MeshSummary = { wallCoveragePct: QUALITY_THRESHOLDS.meshWallCoveragePctFloor }
    const repoReport = await repo.runQualityEngine(scan.id, { meshSummary: mesh })
    expect(repoReport.warnings).not.toContain('wall_coverage_low')
  })

  it('R7 mesh-branch wins over surface-fallback when meshSummary.averageConfidence present', async () => {
    // Seed with high surface confidence (0.9) so surface-fallback would NOT
    // fire. Mesh-branch with low average (0.2) MUST still trigger R7.
    const { scan } = await seedCleanScan(repo, 0.9)
    const mesh: MeshSummary = { wallCoveragePct: 0.95, averageConfidence: 0.2 }
    const pure = pureRunQualityEngine({
      rooms: await repo.listScanRooms(scan.id),
      surfaces: await listAllSurfaces(repo, scan.id),
      measurements: await repo.listScanMeasurements(scan.id),
      meshSummary: mesh,
    })
    const repoReport = await repo.runQualityEngine(scan.id, { meshSummary: mesh })
    expect(repoReport.warnings).toEqual(pure.warnings)
    expect(repoReport.warnings).toContain('low_confidence')
  })

  it('R7 mesh-branch suppresses surface-fallback when mesh has high confidence + surfaces have low', async () => {
    // Surface confidence is low (0.1) — would fire R7 on Plan B. But mesh
    // averageConfidence is 0.9 → mesh-branch wins, R7 silent.
    const { scan } = await seedCleanScan(repo, 0.1)
    const mesh: MeshSummary = { wallCoveragePct: 0.95, averageConfidence: 0.9 }
    const repoReport = await repo.runQualityEngine(scan.id, { meshSummary: mesh })
    expect(repoReport.warnings).not.toContain('low_confidence')
  })

  it('R7 falls through to surface-fallback when meshSummary present but averageConfidence missing', async () => {
    // Plan B path within mesh-aware call: only wallCoveragePct provided, R7
    // mesh-branch sees undefined → fall through. Surface avg 0.3 → R7 fires.
    const { scan } = await seedCleanScan(repo, 0.3)
    const mesh: MeshSummary = { wallCoveragePct: 0.95 }
    const repoReport = await repo.runQualityEngine(scan.id, { meshSummary: mesh })
    expect(repoReport.warnings).toContain('low_confidence')
  })

  it('omitting opts entirely reproduces the legacy 1-arg behaviour (Plan B fully active)', async () => {
    const { scan } = await seedCleanScan(repo, 0.3)
    const planB = await repo.runQualityEngine(scan.id)
    const explicit = await repo.runQualityEngine(scan.id, { meshSummary: undefined })
    expect(planB.warnings).toEqual(explicit.warnings)
    expect(planB.score).toBe(explicit.score)
    expect(planB.bucket).toBe(explicit.bucket)
  })

  it('meshSummaryFromClassification maps boundary values cleanly (0, 1, totalFaces=0)', () => {
    const zero = meshSummaryFromClassification(
      makeClassification({ wallCoverageRatio: 0, totalFaces: 0 }),
    )
    expect(zero).toEqual({ wallCoveragePct: 0, triangleCount: 0 })
    const one = meshSummaryFromClassification(
      makeClassification({ wallCoverageRatio: 1, totalFaces: 9000 }),
    )
    expect(one).toEqual({ wallCoveragePct: 1, triangleCount: 9000 })
  })

  it('R6 fires alone in a clean scan with only low coverage — warnings strictly === [wall_coverage_low]', async () => {
    const { scan } = await seedCleanScan(repo, 0.9)
    const repoReport = await repo.runQualityEngine(scan.id, {
      meshSummary: { wallCoveragePct: 0.3 },
    })
    expect(repoReport.warnings).toEqual(['wall_coverage_low'])
    // Score: 100 - 14 (R6 weight) = 86 → bucket 'excellent'.
    expect(repoReport.score).toBe(86)
    expect(repoReport.bucket).toBe('excellent')
  })

  it('R7 silent at exact 0.5 boundary (exclusive-below)', async () => {
    const { scan } = await seedCleanScan(repo, 0.9)
    const repoReport = await repo.runQualityEngine(scan.id, {
      meshSummary: { averageConfidence: 0.5 },
    })
    expect(repoReport.warnings).not.toContain('low_confidence')
  })

  it('R7 mesh-branch fires below floor — score pinned at 90 (no double-count with surface)', async () => {
    // Surface confidence 0.9 → no surface-fallback hit. Mesh 0.2 → R7 fires
    // ONCE via mesh-branch. Score must be exactly 100 - 10 = 90, not 80.
    const { scan } = await seedCleanScan(repo, 0.9)
    const repoReport = await repo.runQualityEngine(scan.id, {
      meshSummary: { wallCoveragePct: 0.95, averageConfidence: 0.2 },
    })
    expect(repoReport.warnings).toEqual(['low_confidence'])
    expect(repoReport.score).toBe(90)
  })

  it('finishCapture forwards meshSummary into the engine + records meshSummaryUsed in audit', async () => {
    const { finishCapture, startCapture } = await import(
      '../../../src/lib/spatial/workflow/scanStateMachine'
    )
    const { scan } = await seedCleanScan(repo, 0.9)
    await startCapture(scan.id)
    const mesh: MeshSummary = { wallCoveragePct: 0.4 }
    const finished = await finishCapture({
      scanId: scan.id,
      autoQuality: true,
      meshSummary: mesh,
    })
    expect(finished.status).toBe('quality_checked')
    const latest = await repo.getLatestQualityReport(scan.id)
    expect(latest?.warnings).toContain('wall_coverage_low')
    // Audit payload must surface the flag so operators can tell at a glance
    // whether the run used real mesh data or fell through to Plan B.
    const events = await repo.listScanEvents(scan.id)
    const auto = events.find(
      e => e.action === 'quality_run' && (e.payload as { phase?: string }).phase === 'auto_after_capture',
    )
    expect(auto).toBeDefined()
    expect((auto!.payload as { meshSummaryUsed?: boolean }).meshSummaryUsed).toBe(true)
  })
})

async function listAllSurfaces(repo: InMemorySpatialRepository, scanId: string) {
  const rooms = await repo.listScanRooms(scanId)
  const all = []
  for (const r of rooms) {
    all.push(...(await repo.listScanSurfaces(r.id)))
  }
  return all
}
