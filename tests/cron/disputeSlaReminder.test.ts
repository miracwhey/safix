/**
 * Block N13.SLA-Cron — `processDisputeSlaReminders` server-side contract.
 *
 * The cases below cover every observable branch the cron may take so a
 * regression cannot silently drop a reminder, fire one twice, mistake
 * a transient write failure for a successful send, or notify the wrong
 * party.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import {
  processDisputeSlaReminders,
  deterministicUuidV5,
} from '../../api/_disputeSlaReminder'
import type { SupabaseClient } from '@supabase/supabase-js'

const HOUR_MS = 60 * 60 * 1000
const NOW = 1_700_000_000_000
const NOW_ISO = new Date(NOW).toISOString()

type DisputeRow = {
  id: string
  job_id: string
  status: string
  updated_at: string
  metadata: Record<string, unknown> | null
}

function makeRow(overrides: Partial<DisputeRow> = {}): DisputeRow {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    job_id: overrides.job_id ?? '22222222-2222-4222-8222-222222222222',
    status: overrides.status ?? 'customer_waiting',
    updated_at:
      overrides.updated_at ?? new Date(NOW - 25 * HOUR_MS).toISOString(),
    metadata: overrides.metadata ?? {},
  }
}

type MockSupabase = SupabaseClient & {
  __captures: {
    selectFilters: { column: string; value: unknown }[]
    selectInFilters: { column: string; values: unknown[] }[]
    selectLimit: number | null
    inserts: Record<string, unknown>[]
    updates: { where: Record<string, unknown>; payload: Record<string, unknown> }[]
  }
}

function makeSupabase(opts: {
  rows: DisputeRow[]
  insertErrors?: Array<{ code?: string; message?: string } | null>
}): MockSupabase {
  const captures: MockSupabase['__captures'] = {
    selectFilters: [],
    selectInFilters: [],
    selectLimit: null,
    inserts: [],
    updates: [],
  }
  const insertErrors = opts.insertErrors ?? []
  let insertIndex = 0

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'disputes') {
        return {
          select: vi.fn(() => {
            const chain = {
              in: vi.fn((column: string, values: unknown[]) => {
                captures.selectInFilters.push({ column, values })
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

describe('processDisputeSlaReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('window-query: status filter pins customer_waiting + provider_waiting only', async () => {
    const supabase = makeSupabase({ rows: [] })
    await processDisputeSlaReminders(supabase, NOW)

    const inFilter = supabase.__captures.selectInFilters.find(
      (f) => f.column === 'status',
    )
    expect(inFilter).toBeTruthy()
    expect(inFilter?.values).toEqual([
      'customer_waiting',
      'provider_waiting',
    ])
  })

  it('window-query: lte cutoff is exactly NOW - 24h ISO', async () => {
    const supabase = makeSupabase({ rows: [] })
    await processDisputeSlaReminders(supabase, NOW)

    const cutoff = supabase.__captures.selectFilters.find(
      (f) => f.column === 'updated_at',
    )
    expect(cutoff?.value).toBe(new Date(NOW - 24 * HOUR_MS).toISOString())
  })

  it('customer_waiting at +25h: exactly one h24 signal targets customer', async () => {
    const row = makeRow({
      updated_at: new Date(NOW - 25 * HOUR_MS).toISOString(),
      status: 'customer_waiting',
    })
    const supabase = makeSupabase({ rows: [row] })

    const summary = await processDisputeSlaReminders(supabase, NOW)

    expect(summary.sent24h).toBe(1)
    expect(summary.sent48h).toBe(0)
    expect(summary.sent72h).toBe(0)
    expect(supabase.__captures.inserts).toHaveLength(1)
    expect(supabase.__captures.inserts[0]).toMatchObject({
      job_id: row.job_id,
      type: 'dispute_sla_reminder_24h',
      recipient_role: 'customer',
      priority: 'action',
      occurred_at: NOW,
    })
  })

  it('provider_waiting routes to craftsman role', async () => {
    const row = makeRow({
      status: 'provider_waiting',
      updated_at: new Date(NOW - 25 * HOUR_MS).toISOString(),
    })
    const supabase = makeSupabase({ rows: [row] })

    await processDisputeSlaReminders(supabase, NOW)

    expect(supabase.__captures.inserts[0]?.recipient_role).toBe('craftsman')
  })

  it('at +50h with no flags: 24h+48h fire on the same tick', async () => {
    const row = makeRow({
      updated_at: new Date(NOW - 50 * HOUR_MS).toISOString(),
    })
    const supabase = makeSupabase({ rows: [row] })

    const summary = await processDisputeSlaReminders(supabase, NOW)

    expect(summary.sent24h).toBe(1)
    expect(summary.sent48h).toBe(1)
    expect(summary.sent72h).toBe(0)
    expect(supabase.__captures.inserts.map((p) => p.type)).toEqual([
      'dispute_sla_reminder_24h',
      'dispute_sla_reminder_48h',
    ])
  })

  it('respects-already-sent: 24h flag suppresses re-fire, 48h still goes out', async () => {
    const row = makeRow({
      updated_at: new Date(NOW - 50 * HOUR_MS).toISOString(),
      metadata: { sla_reminders_sent: { h24: true } },
    })
    const supabase = makeSupabase({ rows: [row] })

    const summary = await processDisputeSlaReminders(supabase, NOW)

    expect(summary.sent24h).toBe(0)
    expect(summary.sent48h).toBe(1)
    expect(supabase.__captures.inserts).toHaveLength(1)
    expect(supabase.__captures.inserts[0]?.type).toBe('dispute_sla_reminder_48h')
  })

  it('at +80h with all flags set: nothing fires', async () => {
    const row = makeRow({
      updated_at: new Date(NOW - 80 * HOUR_MS).toISOString(),
      metadata: {
        sla_reminders_sent: { h24: true, h48: true, h72: true },
      },
    })
    const supabase = makeSupabase({ rows: [row] })

    const summary = await processDisputeSlaReminders(supabase, NOW)

    expect(summary.sent24h).toBe(0)
    expect(summary.sent48h).toBe(0)
    expect(summary.sent72h).toBe(0)
    expect(summary.skippedNoneDue).toBe(1)
    expect(supabase.__captures.inserts).toHaveLength(0)
  })

  it('h72 fires with alert priority', async () => {
    const row = makeRow({
      updated_at: new Date(NOW - 75 * HOUR_MS).toISOString(),
      metadata: { sla_reminders_sent: { h24: true, h48: true } },
    })
    const supabase = makeSupabase({ rows: [row] })

    await processDisputeSlaReminders(supabase, NOW)

    expect(supabase.__captures.inserts[0]).toMatchObject({
      type: 'dispute_sla_reminder_72h',
      priority: 'alert',
    })
  })

  it('signal id is deterministic uuid v5 across calls (cron-pod safe)', async () => {
    const row = makeRow({
      updated_at: new Date(NOW - 25 * HOUR_MS).toISOString(),
    })
    const supabase1 = makeSupabase({ rows: [row] })
    const supabase2 = makeSupabase({ rows: [row] })

    await processDisputeSlaReminders(supabase1, NOW)
    await processDisputeSlaReminders(supabase2, NOW)

    const id1 = supabase1.__captures.inserts[0]?.id
    const id2 = supabase2.__captures.inserts[0]?.id
    expect(id1).toBeTruthy()
    expect(id1).toBe(id2)
    expect(typeof id1).toBe('string')
    // RFC 4122 v5 shape (version nibble 5, variant bits 10xx)
    expect(String(id1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('persist-flag-update: sla_reminders_sent merges new flags into metadata', async () => {
    const row = makeRow({
      updated_at: new Date(NOW - 25 * HOUR_MS).toISOString(),
      metadata: { existing_field: 'preserved' },
    })
    const supabase = makeSupabase({ rows: [row] })

    await processDisputeSlaReminders(supabase, NOW)

    expect(supabase.__captures.updates).toHaveLength(1)
    const upd = supabase.__captures.updates[0]
    expect(upd.where.id).toBe(row.id)
    expect(upd.where.status).toBe('customer_waiting')
    expect((upd.payload.metadata as Record<string, unknown>).existing_field).toBe(
      'preserved',
    )
    expect(
      (upd.payload.metadata as { sla_reminders_sent: Record<string, boolean> })
        .sla_reminders_sent,
    ).toMatchObject({ h24: true })
    // updated_at bumped to NOW so the row leaves the cron's window for
    // the very next tick.
    expect(upd.payload.updated_at).toBe(NOW_ISO)
  })

  it('duplicate-PK on insert is treated as success (concurrent-pod safe)', async () => {
    const row = makeRow({
      updated_at: new Date(NOW - 25 * HOUR_MS).toISOString(),
    })
    const supabase = makeSupabase({
      rows: [row],
      insertErrors: [{ code: '23505', message: 'duplicate key' }],
    })

    const summary = await processDisputeSlaReminders(supabase, NOW)

    expect(summary.sent24h).toBe(1)
    expect(summary.failed).toBe(0)
  })

  it('non-duplicate insert error: counted as failure, no metadata bookkeeping', async () => {
    const row = makeRow({
      updated_at: new Date(NOW - 25 * HOUR_MS).toISOString(),
    })
    const supabase = makeSupabase({
      rows: [row],
      insertErrors: [{ code: '08006', message: 'connection lost' }],
    })

    const summary = await processDisputeSlaReminders(supabase, NOW)

    expect(summary.sent24h).toBe(0)
    expect(summary.failed).toBe(1)
    // No metadata write because no flag was actually set.
    expect(supabase.__captures.updates).toHaveLength(0)
  })

  it('empty-window: returns zero-summary without inserts or updates', async () => {
    const supabase = makeSupabase({ rows: [] })

    const summary = await processDisputeSlaReminders(supabase, NOW)

    expect(summary).toEqual({
      checked: 0,
      sent24h: 0,
      sent48h: 0,
      sent72h: 0,
      skippedNoneDue: 0,
      failed: 0,
    })
    expect(supabase.__captures.inserts).toHaveLength(0)
    expect(supabase.__captures.updates).toHaveLength(0)
  })
})

describe('deterministicUuidV5', () => {
  it('same input → same output', () => {
    const a = deterministicUuidV5('test', '6d8c9f4e-3a12-4e7b-9c5d-1a2b3c4d5e6f')
    const b = deterministicUuidV5('test', '6d8c9f4e-3a12-4e7b-9c5d-1a2b3c4d5e6f')
    expect(a).toBe(b)
  })

  it('different input → different output', () => {
    const a = deterministicUuidV5('a', '6d8c9f4e-3a12-4e7b-9c5d-1a2b3c4d5e6f')
    const b = deterministicUuidV5('b', '6d8c9f4e-3a12-4e7b-9c5d-1a2b3c4d5e6f')
    expect(a).not.toBe(b)
  })

  it('produces RFC 4122 v5 shape', () => {
    const u = deterministicUuidV5('demo', '6d8c9f4e-3a12-4e7b-9c5d-1a2b3c4d5e6f')
    expect(u).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('rejects malformed namespace', () => {
    expect(() => deterministicUuidV5('x', 'not-a-uuid')).toThrow()
  })
})
