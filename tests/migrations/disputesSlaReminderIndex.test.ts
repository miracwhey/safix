/**
 * Block N13.SLA-Cron — structural verification of the
 * `20260503000002_disputes_sla_reminder_index.sql` migration.
 *
 * Asserted here:
 *   - Partial index `idx_disputes_sla_waiting_updated_at` exists.
 *   - Index is over `disputes(updated_at)` — supports the cron's lte
 *     cutoff filter directly.
 *   - WHERE-clause is the exact `*_waiting` pair the cron iterates.
 *   - Idempotent (`CREATE INDEX IF NOT EXISTS`).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')
const sql = readFileSync(
  resolve(MIGRATIONS_DIR, '20260503000002_disputes_sla_reminder_index.sql'),
  'utf8',
)

describe('Migration 20260503000002 — disputes SLA-reminder partial index', () => {
  it('creates idx_disputes_sla_waiting_updated_at as a partial index over updated_at', () => {
    expect(sql).toMatch(
      /CREATE INDEX\s+IF NOT EXISTS\s+idx_disputes_sla_waiting_updated_at/,
    )
    expect(sql).toMatch(/ON\s+public\.disputes\s*\(updated_at\)/)
  })

  it('partial WHERE matches the cron status filter exactly', () => {
    // The cron does .in('status', ['customer_waiting', 'provider_waiting'])
    // — index must cover both for the planner to use it.
    expect(sql).toMatch(/WHERE\s+status\s+IN\s*\(\s*'customer_waiting'\s*,\s*'provider_waiting'\s*\)/)
  })

  it('migration is idempotent (re-runnable without error)', () => {
    expect(sql).toMatch(/IF NOT EXISTS/)
  })
})

describe('Migration 20260503000002 — SLA-flag reset trigger', () => {
  it('creates the BEFORE UPDATE trigger on disputes.status', () => {
    expect(sql).toMatch(/CREATE TRIGGER\s+disputes_sla_reset_trigger/)
    expect(sql).toMatch(/BEFORE UPDATE OF status\s+ON\s+public\.disputes/)
    expect(sql).toMatch(/FOR EACH ROW/)
  })

  it('trigger function clears sla_reminders_sent on the *_waiting transition only', () => {
    expect(sql).toMatch(/disputes_sla_reset_trigger_fn/)
    expect(sql).toMatch(
      /NEW\.status\s+IN\s*\(\s*'customer_waiting'\s*,\s*'provider_waiting'\s*\)/,
    )
    // Guard against in-set → in-set churn (no-op clear).
    expect(sql).toMatch(
      /OLD\.status\s+NOT\s+IN\s*\(\s*'customer_waiting'\s*,\s*'provider_waiting'\s*\)/,
    )
    expect(sql).toMatch(/-\s+'sla_reminders_sent'/)
  })

  it('trigger drop is idempotent (re-runnable)', () => {
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS\s+disputes_sla_reset_trigger/)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION/)
  })
})
