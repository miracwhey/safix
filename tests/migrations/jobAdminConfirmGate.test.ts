/**
 * Block 7.2.1b — structural verification of the
 * `20260501000001_job_admin_confirm_gate.sql` migration.
 *
 * Behavioural verification (Backfill semantics over real rows) lives in the
 * pre-deploy MCP check executed against Prod before merge — see the
 * project memory `feedback_pre_deploy_schema_verification.md`.
 *
 * Asserted here:
 *   1. `work_marked_complete_at` and `work_confirmed_complete_at` are added
 *      via `ADD COLUMN IF NOT EXISTS` (idempotent re-run-safe).
 *   2. Backfill UPDATE copies `work_completed_at` into both new stamps for
 *      bestand jobs, gated on `work_marked_complete_at IS NULL` so the
 *      migration is safe to re-run.
 *   3. `work_completed_at` is annotated as DEPRECATED via `COMMENT ON COLUMN`
 *      so a future cleanup block can drop it without surprise.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')
const sql = readFileSync(
  resolve(MIGRATIONS_DIR, '20260501000001_job_admin_confirm_gate.sql'),
  'utf8',
)

describe('Migration 20260501000001 — job admin-confirm-gate', () => {
  it('bestand_jobs_with_workCompletedAt_get_both_new_stamps', () => {
    // The backfill UPDATE copies the legacy stamp into both new columns when
    // the legacy one is set. Workspace tests against a real DB happen via
    // the Supabase MCP pre-deploy check; here we verify the SQL contract.
    expect(sql).toMatch(/UPDATE\s+public\.jobs/)
    expect(sql).toMatch(/SET\s+work_marked_complete_at\s*=\s*work_completed_at/)
    expect(sql).toMatch(/work_confirmed_complete_at\s*=\s*work_completed_at/)
    expect(sql).toMatch(/WHERE\s+work_completed_at\s+IS\s+NOT\s+NULL/)
  })

  it('bestand_jobs_without_workCompletedAt_get_no_new_stamps', () => {
    // The WHERE clause filters on `work_completed_at IS NOT NULL`, so jobs
    // that never had a completion stamp are skipped — they remain NULL on
    // both new columns.
    expect(sql).toMatch(/WHERE\s+work_completed_at\s+IS\s+NOT\s+NULL/)
    // Idempotency: re-running the migration must not overwrite already-set
    // marked stamps — guarded by `AND work_marked_complete_at IS NULL`.
    expect(sql).toMatch(/AND\s+work_marked_complete_at\s+IS\s+NULL/)
  })

  it('new_jobs_have_null_stamps_initially', () => {
    // ALTER TABLE adds the columns without a DEFAULT clause — new INSERTs
    // therefore produce NULL stamps, exactly as the workflow expects.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+work_marked_complete_at\s+bigint\s*,/)
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+work_confirmed_complete_at\s+bigint/)
    // Negative assertion: no DEFAULT clause on the new columns.
    expect(sql).not.toMatch(/work_marked_complete_at\s+bigint\s+DEFAULT/i)
    expect(sql).not.toMatch(/work_confirmed_complete_at\s+bigint\s+DEFAULT/i)
  })

  it('annotates the legacy work_completed_at column as DEPRECATED', () => {
    expect(sql).toMatch(/COMMENT ON COLUMN\s+public\.jobs\.work_completed_at\s+IS/)
    expect(sql).toMatch(/DEPRECATED/)
  })
})
