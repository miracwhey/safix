/**
 * Block 7.2.1e — `processAcceptanceReminders` server-side contract.
 *
 * The cases below cover every observable branch the cron may take so a
 * regression cannot silently drop a reminder, fire one twice, or mistake a
 * transient write failure for a successful send.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import { processAcceptanceReminders } from '../../api/_acceptanceReminder'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000
const NOW = 1_700_000_000_000
const FRESH_CREATED_AT = NOW - 25 * HOUR_MS
const ACCEPTANCE_DEADLINE_MS = 72 * HOUR_MS

type AcceptanceRow = {
  id: string
  job_id: string
  customer_user_id: string | null
  status: string
  expires_at: number | null
  created_at: number
  reminders_sent: Record<string, boolean> | null
}

function makeRow(overrides: Partial<AcceptanceRow> = {}): AcceptanceRow {
  const created_at = overrides.created_at ?? FRESH_CREATED_AT
  return {
    id: overrides.id ?? 'acc-1',
    job_id: overrides.job_id ?? 'job-1',
    customer_user_id: overrides.customer_user_id ?? 'cust-1',
    status: overrides.status ?? 'pending',
    expires_at: overrides.expires_at ?? created_at + ACCEPTANCE_DEADLINE_MS,
    created_at,
    reminders_sent: overrides.reminders_sent ?? {},
  }
}

type MockSupabase = SupabaseClient & {
  __captures: {
    selectFilters: { column: string; value: unknown }[]
    selectLimit: number | null
    inserts: Record<string, unknown>[]
    updates: { where: Record<string, unknown>; payload: Record<string, unknown> }[]
  }
}

function makeSupabase(opts: {
  rows: AcceptanceRow[]
  insertErrors?: Array<{ code?: string; message?: string } | null>
}): MockSupabase {
  const captures: MockSupabase['__captures'] = {
    selectFilters: [],
    selectLimit: null,
    inserts: [],
    updates: [],
  }
  const insertErrors = opts.insertErrors ?? []
  let insertIndex = 0

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'acceptances') {
        return {
          select: vi.fn(() => {
            const chain = {
              eq: vi.fn((column: string, value: unknown) => {
                captures.selectFilters.push({ column, value })
                return chain
              }),
              gte: vi.fn((column: string, value: unknown) => {
                captures.selectFilters.push({ column, value })
                return chain
              }),
              lte: vi.fn((column: string, value: unknown) => {
                captures.selectFilters.push({ column, value })
                return chain
              }),
              limit: vi.fn((value: number) => {
                captures.selectLimit = value
                return Promise.resolve({ data: opts.rows, error: null })
              }),
            }
            return chain
          }),
          update: vi.fn((payload: Record<string, unknown>) => {
            const where: Record<string, unknown> = {}
            const chain = {
              eq: vi.fn((column: string, value: unknown) => {
                where[column] = value
                if (Object.keys(where).length === 2) {
                  captures.updates.push({ where, payload })
                  return Promise.resolve({ error: null })
                }
                return chain
              }),
            }
            return chain
          }),
        }
      }
      if (table === 'notification_signals') {
        return {
          insert: vi.fn((payload: Record<string, unknown>) => {
            captures.inserts.push(payload)
            const err = insertErrors[insertIndex++] ?? null
            return Promise.resolve({ error: err })
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    }),
  } as unknown as MockSupabase

  supabase.__captures = captures
  return supabase
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processAcceptanceReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('iterates-only-pending: SELECT filter pins status=pending', async () => {
    const supabase = makeSupabase({ rows: [] })

    await processAcceptanceReminders(supabase, NOW)

    expect(
      supabase.__captures.selectFilters.some(
        (f) => f.column === 'status' && f.value === 'pending',
      ),
    ).toBe(true)
  })

  it('sends-once-per-threshold: at +25h, exactly one customer_24h signal lands', async () => {
    const row = makeRow({
      id: 'acc-25h',
      created_at: NOW - 25 * HOUR_MS,
    })
    const supabase = makeSupabase({ rows: [row] })

    const summary = await processAcceptanceReminders(supabase, NOW)

    expect(summary.sent24h).toBe(1)
    expect(summary.sent60h).toBe(0)
    expect(supabase.__captures.inserts).toHaveLength(1)
    expect(supabase.__captures.inserts[0]).toMatchObject({
      type: 'acceptance_reminder_24h',
      job_id: 'job-1',
      recipient_role: 'customer',
      id: 'reminder-acc-25h-acceptance_reminder_24h',
    })
  })

  it('both-thresholds-fire: at +61h with no flag, both signals are inserted', async () => {
    const row = makeRow({
      id: 'acc-61h',
      created_at: NOW - 61 * HOUR_MS,
    })
    const supabase = makeSupabase({ rows: [row] })

    const summary = await processAcceptanceReminders(supabase, NOW)

    expect(summary.sent24h).toBe(1)
    expect(summary.sent60h).toBe(1)
    expect(supabase.__captures.inserts.map((p) => p.type)).toEqual([
      'acceptance_reminder_24h',
      'acceptance_reminder_60h',
    ])
  })

  it('respects-already-sent: 24h-flag suppresses re-fire and only flips 60h', async () => {
    const row = makeRow({
      id: 'acc-late',
      created_at: NOW - 61 * HOUR_MS,
      reminders_sent: { customer_24h: true },
    })
    const supabase = makeSupabase({ rows: [row] })

    const summary = await processAcceptanceReminders(supabase, NOW)

    expect(summary.sent24h).toBe(0)
    expect(summary.sent60h).toBe(1)
    expect(supabase.__captures.inserts).toHaveLength(1)
    expect(supabase.__captures.inserts[0]).toMatchObject({
      type: 'acceptance_reminder_60h',
    })
  })

  it('row-isolation: an unexpected throw on row 1 does not block row 2', async () => {
    const supabase = makeSupabase({
      rows: [
        makeRow({ id: 'acc-bad', created_at: NOW - 25 * HOUR_MS }),
        makeRow({ id: 'acc-good', created_at: NOW - 25 * HOUR_MS, job_id: 'job-2' }),
      ],
      insertErrors: [{ code: 'XX000', message: 'simulated transient' }, null],
    })

    const summary = await processAcceptanceReminders(supabase, NOW)

    expect(summary.checked).toBe(2)
    expect(summary.sent24h).toBe(1)
    expect(summary.failed).toBe(1)
  })

  it('push-failure-doesnt-mark-flag: a non-duplicate insert error skips the reminders_sent UPDATE', async () => {
    const row = makeRow({
      id: 'acc-fail',
      created_at: NOW - 25 * HOUR_MS,
    })
    const supabase = makeSupabase({
      rows: [row],
      insertErrors: [{ code: 'XX000', message: 'transient db error' }],
    })

    const summary = await processAcceptanceReminders(supabase, NOW)

    expect(summary.sent24h).toBe(0)
    expect(summary.failed).toBe(1)
    expect(supabase.__captures.updates).toHaveLength(0)
  })

  it('duplicate-key-counts-as-sent: 23505 from a parallel pod is treated as success and persists the flag', async () => {
    const row = makeRow({
      id: 'acc-dup',
      created_at: NOW - 25 * HOUR_MS,
    })
    const supabase = makeSupabase({
      rows: [row],
      insertErrors: [{ code: '23505', message: 'duplicate key value' }],
    })

    const summary = await processAcceptanceReminders(supabase, NOW)

    expect(summary.sent24h).toBe(1)
    expect(summary.failed).toBe(0)
    expect(supabase.__captures.updates).toHaveLength(1)
    expect(supabase.__captures.updates[0].payload.reminders_sent).toMatchObject({
      customer_24h: true,
    })
  })

  it('no-rows-summary-empty: an empty SELECT returns an all-zero summary and emits no inserts', async () => {
    const supabase = makeSupabase({ rows: [] })

    const summary = await processAcceptanceReminders(supabase, NOW)

    expect(summary).toEqual({
      checked: 0,
      sent24h: 0,
      sent60h: 0,
      skippedNoneDue: 0,
      failed: 0,
    })
    expect(supabase.__captures.inserts).toHaveLength(0)
  })
})
