import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemorySpatialRepository,
  initializeSpatialRepository,
  resetSpatialRepository,
  startCapture,
  finishCapture,
} from '../../../src/lib/spatial'

const USER = 'uuuuuuuu-0000-0000-0000-c00000000001'
const PROJECT = 'pppppppp-0000-0000-0000-c00000000001'

describe('Block C.4 — runQualityEngine via repository + finishCapture autoQuality', () => {
  let repo: InMemorySpatialRepository

  beforeEach(async () => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
  })

  it('runQualityEngine on an empty scan fires only too_few_walls (score 75, bucket good) and audits', async () => {
    const scan = await repo.createScan({
      projectId: PROJECT,
      source: 'roomplan',
      capturedBy: USER,
    })
    const report = await repo.runQualityEngine(scan.id)
    expect(report.scanId).toBe(scan.id)
    expect(report.engineVersion).toBe('v1.0.0')
    // No rooms / measurements / doors / windows / mesh — only the wall-count
    // rule has signal. 100 - 25 (too_few_walls weight) = 75 → bucket 'good'.
    expect(report.warnings).toEqual(['too_few_walls'])
    expect(report.score).toBe(75)
    expect(report.bucket).toBe('good')
    const events = await repo.listScanEvents(scan.id)
    expect(events.some(e => e.action === 'quality_run')).toBe(true)
    const latest = await repo.getLatestQualityReport(scan.id)
    expect(latest?.id).toBe(report.id)
  })

  it('runQualityEngine on a clean 4-wall scan returns score 100 + bucket excellent', async () => {
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
        confidence: 0.9,
      })
    }
    await repo.createScanSurface({
      roomId: room.id,
      surfaceExternalId: 'door_0',
      kind: 'door',
      dimWEstimated: 0.9,
      dimHEstimated: 2.1,
    })
    await repo.createScanSurface({
      roomId: room.id,
      surfaceExternalId: 'window_0',
      kind: 'window',
      dimWEstimated: 1.2,
      dimHEstimated: 1.4,
    })
    const report = await repo.runQualityEngine(scan.id)
    expect(report.bucket).toBe('excellent')
    expect(report.score).toBe(100)
    expect(report.warnings).toEqual([])
  })

  it('finishCapture(autoQuality=true) walks to quality_checked and emits a quality report', async () => {
    const scan = await repo.createScan({
      projectId: PROJECT,
      source: 'roomplan',
      capturedBy: USER,
    })
    await startCapture(scan.id)
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
        confidence: 0.9,
      })
    }
    const finished = await finishCapture({ scanId: scan.id, autoQuality: true })
    expect(finished.status).toBe('quality_checked')
    const latest = await repo.getLatestQualityReport(scan.id)
    expect(latest).not.toBeNull()
    expect(latest!.bucket).toBe('excellent')
  })

  it('finishCapture(autoQuality=false) stays at captured (default behaviour)', async () => {
    const scan = await repo.createScan({
      projectId: PROJECT,
      source: 'roomplan',
      capturedBy: USER,
    })
    await startCapture(scan.id)
    const finished = await finishCapture({ scanId: scan.id })
    expect(finished.status).toBe('captured')
    const latest = await repo.getLatestQualityReport(scan.id)
    expect(latest).toBeNull()
  })

  it('multiple runs append new reports — getLatestQualityReport returns the newest', async () => {
    const scan = await repo.createScan({
      projectId: PROJECT,
      source: 'roomplan',
      capturedBy: USER,
    })
    const first = await repo.runQualityEngine(scan.id)
    // Force a measurable time gap so the InMemory mock can sort by generatedAt.
    await new Promise(r => setTimeout(r, 2))
    const second = await repo.runQualityEngine(scan.id)
    expect(second.id).not.toBe(first.id)
    const all = await repo.listScanQualityReports(scan.id)
    expect(all.length).toBe(2)
    const latest = await repo.getLatestQualityReport(scan.id)
    expect(latest!.id).toBe(second.id)
  })
})
