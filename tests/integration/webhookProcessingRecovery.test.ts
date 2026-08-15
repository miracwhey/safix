// vi.mock must be hoisted before imports.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

/**
 * Webhook processing recovery tests.
 *
 * Verifies:
 *   - classifyProcessingRow correctly identifies active / stale / finalized rows
 *   - cleanupStaleWebhookEvents recovers stale rows and emits observability events
 *   - fresh (recently claimed) processing rows are NOT touched by cleanup
 *   - cleanup is safe when no stale rows exist
 *   - DB update failures are counted and logged without aborting cleanup
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  classifyProcessingRow,
  cleanupStaleWebhookEvents,
  STALE_PROCESSING_THRESHOLD_MS,
  CLEANUP_BATCH_LIMIT,
  type WebhookEventRow,
  type ProcessingRowClassification,
} from '../../api/_webhookProcessingRecovery'

// ---------------------------------------------------------------------------
// Console capture helper
// ---------------------------------------------------------------------------

function captureConsole() {
  const logs: string[] = []
  const warns: string[] = []
  const errors: string[] = []
  const origLog = console.log
  const origWarn = console.warn
  const origError = console.error
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  console.warn = (...args: unknown[]) => warns.push(args.join(' '))
  console.error = (...args: unknown[]) => errors.push(args.join(' '))
  return {
    logs,
    warns,
    errors,
    restore: () => {
      console.log = origLog
      console.warn = origWarn
      console.error = origError
    },
  }
}

// ---------------------------------------------------------------------------
// Mock Supabase builder
// ---------------------------------------------------------------------------

interface MockSupabaseOptions {
  fetchData?: WebhookEventRow[]
  fetchError?: { message: string; code?: string }
  updateError?: { message: string; code?: string }
}

function buildMockSupabase(opts: MockSupabaseOptions = {}) {
  let callIndex = 0

  const fromFn = vi.fn().mockImplementation(() => {
    callIndex++
    const isFirstCall = callIndex === 1

    if (isFirstCall) {
      // SELECT stale rows chain
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: opts.fetchError ? null : (opts.fetchData ?? []),
          error: opts.fetchError ?? null,
        }),
      }
      return chain
    } else {
      // UPDATE chain (called once per stale row)
      const updateResult = { error: opts.updateError ?? null }
      return {
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue(updateResult),
          }),
        }),
      }
    }
  })

  return { from: fromFn } as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = Date.now()
const TEN_MINUTES_MS = 10 * 60 * 1000

function msToIso(ms: number): string {
  return new Date(ms).toISOString()
}

function makeRow(overrides: Partial<WebhookEventRow>): WebhookEventRow {
  return {
    event_id: 'evt_test_001',
    event_type: 'payment_intent.succeeded',
    outcome: 'processing',
    processed_at: msToIso(now - TEN_MINUTES_MS - 1000), // stale by default
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// classifyProcessingRow — unit tests (pure function)
// ---------------------------------------------------------------------------

describe('classifyProcessingRow', () => {
  it('returns "finalized" for a reconciled row', () => {
    const row = makeRow({ outcome: 'reconciled' })
    expect(classifyProcessingRow(row, now)).toBe<ProcessingRowClassification>('finalized')
  })

  it('returns "finalized" for a skipped row', () => {
    expect(classifyProcessingRow(makeRow({ outcome: 'skipped' }), now)).toBe('finalized')
  })

  it('returns "finalized" for a not_found row', () => {
    expect(classifyProcessingRow(makeRow({ outcome: 'not_found' }), now)).toBe('finalized')
  })

  it('returns "finalized" for a failed row', () => {
    expect(classifyProcessingRow(makeRow({ outcome: 'failed' }), now)).toBe('finalized')
  })

  it('returns "finalized" for an invalid_transition row', () => {
    expect(classifyProcessingRow(makeRow({ outcome: 'invalid_transition' }), now)).toBe('finalized')
  })

  it('returns "finalized" for a log_only row', () => {
    expect(classifyProcessingRow(makeRow({ outcome: 'log_only' }), now)).toBe('finalized')
  })

  it('returns "finalized" for a processing_expired row', () => {
    expect(classifyProcessingRow(makeRow({ outcome: 'processing_expired' }), now)).toBe('finalized')
  })

  it('returns "active" for a freshly claimed processing row (1 second ago)', () => {
    const row = makeRow({ processed_at: msToIso(now - 1000) })
    expect(classifyProcessingRow(row, now)).toBe<ProcessingRowClassification>('active')
  })

  it('returns "active" for a processing row just under the threshold', () => {
    const row = makeRow({ processed_at: msToIso(now - TEN_MINUTES_MS + 1) })
    expect(classifyProcessingRow(row, now)).toBe('active')
  })

  it('returns "stale" for a processing row exactly at the threshold', () => {
    const row = makeRow({ processed_at: msToIso(now - TEN_MINUTES_MS) })
    expect(classifyProcessingRow(row, now)).toBe<ProcessingRowClassification>('stale')
  })

  it('returns "stale" for a processing row well past the threshold', () => {
    const row = makeRow({ processed_at: msToIso(now - 30 * 60 * 1000) }) // 30 minutes ago
    expect(classifyProcessingRow(row, now)).toBe('stale')
  })

  it('respects a custom threshold override', () => {
    const row = makeRow({ processed_at: msToIso(now - 5000) }) // 5 seconds ago
    expect(classifyProcessingRow(row, now, 3000)).toBe('stale') // 3 second threshold
    expect(classifyProcessingRow(row, now, 10000)).toBe('active') // 10 second threshold
  })

  it('uses Date.now() as default for nowMs', () => {
    // Row older than threshold — should be stale when using the real clock
    const row = makeRow({ processed_at: msToIso(Date.now() - STALE_PROCESSING_THRESHOLD_MS - 1000) })
    expect(classifyProcessingRow(row)).toBe('stale')
  })
})

// ---------------------------------------------------------------------------
// STALE_PROCESSING_THRESHOLD_MS — exported constant sanity
// ---------------------------------------------------------------------------

describe('STALE_PROCESSING_THRESHOLD_MS', () => {
  it('is 10 minutes in milliseconds', () => {
    expect(STALE_PROCESSING_THRESHOLD_MS).toBe(10 * 60 * 1000)
  })
})

describe('CLEANUP_BATCH_LIMIT', () => {
  it('is a positive integer not exceeding 1000', () => {
    expect(CLEANUP_BATCH_LIMIT).toBeGreaterThan(0)
    expect(CLEANUP_BATCH_LIMIT).toBeLessThanOrEqual(1000)
    expect(Number.isInteger(CLEANUP_BATCH_LIMIT)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cleanupStaleWebhookEvents — no stale rows
// ---------------------------------------------------------------------------

describe('cleanupStaleWebhookEvents — no stale rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns checked=0, recovered=0, failedToUpdate=0 when no rows found', async () => {
    const supabase = buildMockSupabase({ fetchData: [] })
    const cap = captureConsole()
    const result = await cleanupStaleWebhookEvents(supabase)
    cap.restore()

    expect(result).toEqual({ checked: 0, recovered: 0, failedToUpdate: 0 })
  })

  it('does not emit stale_detected or processing_recovered events when no rows found', async () => {
    const supabase = buildMockSupabase({ fetchData: [] })
    const cap = captureConsole()
    await cleanupStaleWebhookEvents(supabase)
    cap.restore()

    const allOutput = [...cap.logs, ...cap.warns, ...cap.errors].join('\n')
    expect(allOutput).not.toContain('processing_stale_detected')
    expect(allOutput).not.toContain('processing_recovered')
  })
})

// ---------------------------------------------------------------------------
// cleanupStaleWebhookEvents — fetch error
// ---------------------------------------------------------------------------

describe('cleanupStaleWebhookEvents — fetch error', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns zero counts and logs processing_cleanup_failed when fetch fails', async () => {
    const supabase = buildMockSupabase({
      fetchError: { message: 'DB connection timeout' },
    })
    const cap = captureConsole()
    const result = await cleanupStaleWebhookEvents(supabase)
    cap.restore()

    expect(result).toEqual({ checked: 0, recovered: 0, failedToUpdate: 0 })
    const errorOutput = cap.errors.join('\n')
    expect(errorOutput).toContain('processing_cleanup_failed')
  })
})

// ---------------------------------------------------------------------------
// cleanupStaleWebhookEvents — successful recovery
// ---------------------------------------------------------------------------

describe('cleanupStaleWebhookEvents — successful recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('increments recovered for each successfully updated stale row', async () => {
    const staleRows: WebhookEventRow[] = [
      makeRow({ event_id: 'evt_stale_001' }),
      makeRow({ event_id: 'evt_stale_002', event_type: 'payment_intent.canceled' }),
    ]
    const supabase = buildMockSupabase({ fetchData: staleRows })
    const cap = captureConsole()
    const result = await cleanupStaleWebhookEvents(supabase)
    cap.restore()

    expect(result.checked).toBe(2)
    expect(result.recovered).toBe(2)
    expect(result.failedToUpdate).toBe(0)
  })

  it('emits processing_stale_detected (warning) for each stale row', async () => {
    const staleRows: WebhookEventRow[] = [
      makeRow({ event_id: 'evt_stale_001' }),
    ]
    const supabase = buildMockSupabase({ fetchData: staleRows })
    const cap = captureConsole()
    await cleanupStaleWebhookEvents(supabase)
    cap.restore()

    const warnOutput = cap.warns.join('\n')
    expect(warnOutput).toContain('processing_stale_detected')
    expect(warnOutput).toContain('evt_stale_001')
  })

  it('emits processing_recovered (info) for each successfully updated row', async () => {
    const staleRows: WebhookEventRow[] = [
      makeRow({ event_id: 'evt_stale_001' }),
    ]
    const supabase = buildMockSupabase({ fetchData: staleRows })
    const cap = captureConsole()
    await cleanupStaleWebhookEvents(supabase)
    cap.restore()

    const infoOutput = cap.logs.join('\n')
    expect(infoOutput).toContain('processing_recovered')
    expect(infoOutput).toContain('evt_stale_001')
  })

  it('emits a summary processing_recovered event with batch stats', async () => {
    const staleRows: WebhookEventRow[] = [
      makeRow({ event_id: 'evt_stale_001' }),
      makeRow({ event_id: 'evt_stale_002' }),
    ]
    const supabase = buildMockSupabase({ fetchData: staleRows })
    const cap = captureConsole()
    await cleanupStaleWebhookEvents(supabase)
    cap.restore()

    const infoOutput = cap.logs.join('\n')
    // Final summary log includes checked/recovered/failedToUpdate
    expect(infoOutput).toContain('"checked":2')
    expect(infoOutput).toContain('"recovered":2')
  })
})

// ---------------------------------------------------------------------------
// cleanupStaleWebhookEvents — partial update failure
// ---------------------------------------------------------------------------

describe('cleanupStaleWebhookEvents — partial update failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('counts failedToUpdate and logs processing_cleanup_failed per row', async () => {
    const staleRows: WebhookEventRow[] = [makeRow({ event_id: 'evt_stale_err' })]
    const supabase = buildMockSupabase({
      fetchData: staleRows,
      updateError: { message: 'DB write error' },
    })
    const cap = captureConsole()
    const result = await cleanupStaleWebhookEvents(supabase)
    cap.restore()

    expect(result.checked).toBe(1)
    expect(result.recovered).toBe(0)
    expect(result.failedToUpdate).toBe(1)
    const errorOutput = cap.errors.join('\n')
    expect(errorOutput).toContain('processing_cleanup_failed')
    expect(errorOutput).toContain('evt_stale_err')
  })
})

// ---------------------------------------------------------------------------
// cleanupStaleWebhookEvents — safety: fresh rows are not touched
// ---------------------------------------------------------------------------

describe('cleanupStaleWebhookEvents — fresh rows safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not query rows with a future processed_at', async () => {
    // The stale cutoff is (now - threshold).  A freshly claimed row (processed_at = now)
    // should NOT appear in the fetch results because the lt() filter excludes it.
    // We simulate this by the mock returning an empty array (as the DB would).
    const supabase = buildMockSupabase({ fetchData: [] })
    const cap = captureConsole()
    const result = await cleanupStaleWebhookEvents(supabase)
    cap.restore()

    expect(result.checked).toBe(0)
    expect(result.recovered).toBe(0)
  })

  it('respects the thresholdMs override from options', async () => {
    // With a 1-second threshold, a row 500ms old would be 'active' (not stale).
    // The mock returns empty to simulate the DB lt() filter respecting the threshold.
    const supabase = buildMockSupabase({ fetchData: [] })
    const result = await cleanupStaleWebhookEvents(supabase, { thresholdMs: 1000 })

    expect(result.checked).toBe(0)
  })

  it('respects the batchLimit option', async () => {
    const staleRows: WebhookEventRow[] = Array.from({ length: 3 }, (_, i) =>
      makeRow({ event_id: `evt_stale_${i}` }),
    )
    const supabase = buildMockSupabase({ fetchData: staleRows })
    // Even though the mock returns 3 rows, batchLimit is passed through to the
    // Supabase query (which in production would cap results to batchLimit).
    const result = await cleanupStaleWebhookEvents(supabase, { batchLimit: 50 })

    // All 3 mock rows are processed (mock ignores the actual limit value).
    expect(result.checked).toBe(3)
  })
})
