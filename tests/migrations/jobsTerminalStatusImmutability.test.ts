/**
 * H12 — structural verification of the
 * `20260610154500_h12_jobs_terminal_status_immutability.sql` migration.
 *
 * Prod grounding (live dumps 2026-06-10): public.jobs carries ONLY
 * `set_jobs_updated_at`; `jobs_status_check` validates status membership but
 * no transitions. The migration adds the first DB-side transition guard:
 * terminal statuses (completed/cancelled) can no longer be left by regular
 * authenticated users.
 *
 * Asserted here:
 *   - BEFORE UPDATE OF status + WHEN (OLD.status IS DISTINCT FROM NEW.status)
 *     → full-row updates that keep status unchanged (e.g.
 *     finalize_payment_state_atomic on terminal jobs) never fire the guard.
 *   - Bypass mirrors the live disputes_status_change_guard pattern:
 *     auth.uid() IS NULL (service-role: stripe-webhook, cron reconciliation,
 *     api/* admin client) OR public.is_current_user_operator().
 *   - ERRCODE '23514' (check_violation, class 23) is MANDATORY:
 *     classifyFailure maps class 23 → 'business-rejected' so
 *     flushPendingMutations drops replayed queue entries permanently. A
 *     default P0001 raise would classify as 'unknown' and replay forever
 *     (SyncStatusBar loop).
 *   - Default-EXECUTE hygiene (CREATE FUNCTION grants EXECUTE to PUBLIC/anon
 *     via default privileges) and PostgREST cache reload.
 *
 * Behavioral verification (real customer session → 23514; service-role →
 * pass-through; payment_state-only update on terminal job → trigger silent)
 * runs documented post-apply — pgTAP is deliberately NOT a gate (non-required
 * + red from public.jobs migration-ledger drift).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

import { classifyFailure } from '../../src/lib/persistence/classifyFailure'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')
const sql = readFileSync(
  resolve(MIGRATIONS_DIR, '20260610154500_h12_jobs_terminal_status_immutability.sql'),
  'utf8',
)

describe('Migration 20260610154500 — jobs terminal-status immutability', () => {
  it('creates the guard function on public schema with pinned search_path', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION\s+public\.jobs_terminal_status_guard\(\)/)
    expect(sql).toMatch(/RETURNS trigger/)
    expect(sql).toMatch(/SET search_path TO 'pg_catalog', 'public'/)
  })

  it('guards exactly the terminal statuses completed and cancelled', () => {
    expect(sql).toMatch(/OLD\.status IN \('completed', 'cancelled'\)/)
    expect(sql).toMatch(/NEW\.status IS DISTINCT FROM OLD\.status/)
  })

  it('bypasses service-role (auth.uid() IS NULL) and operators — mirror of disputes_status_change_guard', () => {
    expect(sql).toMatch(/auth\.uid\(\) IS NULL\s+OR\s+public\.is_current_user_operator\(\)/)
    // Bypass must RETURN NEW (allow the repair write), not silently swallow it
    expect(sql).toMatch(/IF auth\.uid\(\) IS NULL OR public\.is_current_user_operator\(\) THEN\s*\n\s*RETURN NEW;/)
  })

  it("raises with ERRCODE '23514' so the client classifies it as business-rejected", () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'terminal_status_immutable/)
    expect(sql).toMatch(/USING ERRCODE = '23514'/)
    // Negative: no default-P0001 raise — every RAISE EXCEPTION carries the ERRCODE
    const raises = sql.match(/RAISE EXCEPTION/g) ?? []
    const errcodes = sql.match(/USING ERRCODE = '23514'/g) ?? []
    expect(raises.length).toBeGreaterThan(0)
    expect(errcodes.length).toBe(raises.length)
  })

  it('classifyFailure maps the trigger ERRCODE to business-rejected (queue entries drop permanently)', () => {
    expect(classifyFailure({ code: '23514', message: 'terminal_status_immutable' })).toBe(
      'business-rejected',
    )
  })

  it('wires the trigger BEFORE UPDATE OF status with a status-change WHEN clause', () => {
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS\s+jobs_terminal_status_guard_tg\s+ON public\.jobs/)
    expect(sql).toMatch(/CREATE TRIGGER\s+jobs_terminal_status_guard_tg/)
    expect(sql).toMatch(/BEFORE UPDATE OF status ON public\.jobs/)
    expect(sql).toMatch(/FOR EACH ROW/)
    expect(sql).toMatch(/WHEN \(OLD\.status IS DISTINCT FROM NEW\.status\)/)
    expect(sql).toMatch(/EXECUTE FUNCTION public\.jobs_terminal_status_guard\(\)/)
  })

  it('revokes default EXECUTE from PUBLIC, anon and authenticated', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.jobs_terminal_status_guard\(\) FROM PUBLIC, anon, authenticated;/,
    )
  })

  it('runs as trigger-invoker — NOT SECURITY DEFINER (auth.uid() must reflect the writing caller)', () => {
    expect(sql).not.toMatch(/SECURITY DEFINER/i)
  })

  it('reloads the PostgREST schema cache defensively', () => {
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';/)
  })
})
