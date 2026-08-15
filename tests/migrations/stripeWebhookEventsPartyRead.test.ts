/**
 * Block N13.RLS — structural verification of the
 * `20260503000001_stripe_webhook_events_party_read.sql` migration.
 *
 * Behavioural verification (RLS enforcement against real auth.uid()
 * sessions) lives in the pre-deploy MCP check executed against Prod
 * before merge — see project memory
 * `feedback_pre_deploy_schema_verification.md`.
 *
 * Asserted here:
 *   1. SELECT policy `stripe_webhook_events_select_party` grants read
 *      to job parties (customer + provider owner + assigned-provider
 *      owner) and operators.
 *   2. The migration creates the `idx_stripe_webhook_events_job_id`
 *      partial index that backs the loader's `.eq('job_id', …)`.
 *   3. The migration explicitly REVOKEs write privileges from `anon`
 *      and `authenticated` (defense-in-depth on top of RLS).
 *   4. Operator check uses `is_operator = true` (matches existing
 *      dispute_select_own_side pattern), NOT `role = 'admin'`.
 *   5. The job_id JOIN casts to text (column types differ:
 *      jobs.id UUID vs stripe_webhook_events.job_id TEXT).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')
const sql = readFileSync(
  resolve(
    MIGRATIONS_DIR,
    '20260503000001_stripe_webhook_events_party_read.sql',
  ),
  'utf8',
)

describe('Migration 20260503000001 — stripe_webhook_events party-read RLS', () => {
  it('creates the SELECT policy scoped to authenticated role', () => {
    expect(sql).toMatch(
      /CREATE POLICY\s+stripe_webhook_events_select_party/,
    )
    expect(sql).toMatch(/ON\s+public\.stripe_webhook_events/)
    expect(sql).toMatch(/FOR\s+SELECT/)
    expect(sql).toMatch(/TO\s+authenticated/)
  })

  it('grants read to all three job-party paths', () => {
    // Customer path — direct auth.uid() match
    expect(sql).toMatch(/j\.customer_user_id\s*=\s*auth\.uid\(\)/)
    // Provider-owner path — provider via providers.profile_id
    expect(sql).toMatch(
      /j\.provider_id\s+IN\s*\(\s*SELECT\s+pr\.id\s+FROM\s+public\.providers\s+pr\s+WHERE\s+pr\.profile_id\s*=\s*auth\.uid\(\)/i,
    )
    // Assigned-provider path — for jobs reassigned to a different provider
    expect(sql).toMatch(
      /j\.assigned_provider_id\s+IN\s*\(\s*SELECT\s+pr\.id\s+FROM\s+public\.providers\s+pr\s+WHERE\s+pr\.profile_id\s*=\s*auth\.uid\(\)/i,
    )
  })

  it('uses is_operator (not role=admin) for the operator escalation', () => {
    expect(sql).toMatch(/p\.is_operator\s*=\s*true/)
    // Negative assertion: no role='admin' string — that pattern was
    // wrong in the original audit and would fail open against the
    // real prod schema.
    expect(sql).not.toMatch(/role\s*=\s*'admin'/)
  })

  it('casts jobs.id to text to match stripe_webhook_events.job_id', () => {
    // jobs.id is uuid, stripe_webhook_events.job_id is text — the
    // EXISTS subquery must cast or the policy would fail at runtime.
    expect(sql).toMatch(
      /j\.id::text\s*=\s*stripe_webhook_events\.job_id/,
    )
  })

  it('requires job_id IS NOT NULL gate so unrelated rows stay private', () => {
    // Webhook events without a job_id (e.g. account-level events)
    // must not leak — the policy gates on job_id IS NOT NULL.
    expect(sql).toMatch(/job_id\s+IS\s+NOT\s+NULL/)
  })

  it('creates the partial index on job_id for the loader', () => {
    expect(sql).toMatch(
      /CREATE INDEX\s+IF NOT EXISTS\s+idx_stripe_webhook_events_job_id/,
    )
    expect(sql).toMatch(/ON\s+public\.stripe_webhook_events\s*\(job_id\)/)
    // Partial index — saves space because most rows historically have
    // job_id NULL during the early-Stripe phase.
    expect(sql).toMatch(/WHERE\s+job_id\s+IS\s+NOT\s+NULL/)
  })

  it('revokes write privileges from anon and authenticated (defense-in-depth)', () => {
    expect(sql).toMatch(
      /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE,\s*TRUNCATE\s+ON\s+public\.stripe_webhook_events\s+FROM\s+anon,\s*authenticated/,
    )
  })
})
