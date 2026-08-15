/**
 * Structural verification of the Stage-2 attribution DB-defense migrations:
 *   - 20260420000001_attribution_dlq_state.sql
 *   - 20260420000002_attribution_audit_log.sql
 *   - 20260420000003_attribution_release_defense.sql
 *
 * These tests parse the migration files and assert on their structure rather
 * than executing against a live Postgres instance.  The SaFix test
 * infrastructure is text/structural-oriented (see tests/shared/block3ClosureVerification);
 * a live-trigger behavioural check runs via `supabase db reset` in the
 * operator environment.
 *
 * Behavioural integration coverage (live-DB):
 *   Stage 1 API guard tests (attributionGuard.test.ts, releaseTranche.test.ts
 *   AG1–AG8) already assert the same invariant at the app layer.  The trigger
 *   is a belt-and-suspenders defense — see the operator check-list at the end
 *   of this file for the manual SQL verification steps.
 *
 * Non-negotiable invariants asserted here:
 *   DLQ1. 'dlq' is a valid attribution_status value.
 *   DLQ2. attribution_dlq_reason column exists and is required when status='dlq'.
 *   DLQ3. Partial index covers 'dlq' rows.
 *   AUDIT1. attribution_audit_log table exists with RLS enabled.
 *   AUDIT2. Event-type CHECK includes all six documented transitions.
 *   AUDIT3. Reason required when event_type='dlq_entered'.
 *   AUDIT4. Operator-id required when event_type starts with 'operator_'.
 *   TRIG1. Trigger function raises SQLSTATE P0004 with prefix 'ATTRIBUTION_NOT_FINALIZED:'.
 *   TRIG2. Trigger is attached to escrow_tranches AND supplementary_payment_requests.
 *   TRIG3. Trigger short-circuits for OLD.status = 'released' (idempotent rewrites).
 *   TRIG4. Trigger short-circuits for NEW.status != 'released'.
 *   TRIG5. Trigger gates DLQ, unresolved, invalid-origin, job-not-found, missing-ids.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf8')
}

const dlqMigration = readMigration('20260420000001_attribution_dlq_state.sql')
const auditMigration = readMigration('20260420000002_attribution_audit_log.sql')
const defenseMigration = readMigration('20260420000003_attribution_release_defense.sql')

// ── DLQ state migration ───────────────────────────────────────────────────────

describe('Migration 20260420000001 — attribution DLQ state', () => {
  it("DLQ1: widens attribution_status CHECK to include 'dlq'", () => {
    expect(dlqMigration).toMatch(/attribution_status IN \('pending', 'finalized', 'retrying', 'dlq'\)/)
  })

  it('DLQ1b: drops the previous CHECK before adding the widened one', () => {
    expect(dlqMigration).toMatch(/DROP CONSTRAINT/)
    expect(dlqMigration).toMatch(/ADD CONSTRAINT jobs_attribution_status_check/)
  })

  it('DLQ2: adds attribution_dlq_reason TEXT column', () => {
    expect(dlqMigration).toMatch(/ADD COLUMN IF NOT EXISTS attribution_dlq_reason TEXT/)
  })

  it('DLQ2b: enforces reason required when status=dlq', () => {
    expect(dlqMigration).toMatch(/jobs_attribution_dlq_reason_required/)
    expect(dlqMigration).toMatch(
      /CHECK \(attribution_status <> 'dlq' OR attribution_dlq_reason IS NOT NULL\)/,
    )
  })

  it("DLQ3: partial index covers pending, retrying and dlq", () => {
    expect(dlqMigration).toMatch(/CREATE INDEX idx_jobs_attribution_status/)
    expect(dlqMigration).toMatch(
      /WHERE attribution_status IN \('pending', 'retrying', 'dlq'\)/,
    )
  })

  it('DLQ3b: drops the old index before recreating it', () => {
    expect(dlqMigration).toMatch(/DROP INDEX IF EXISTS public\.idx_jobs_attribution_status/)
  })
})

// ── Audit-log migration ───────────────────────────────────────────────────────

describe('Migration 20260420000002 — attribution audit log', () => {
  it('AUDIT1: creates attribution_audit_log table', () => {
    expect(auditMigration).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.attribution_audit_log/,
    )
  })

  it('AUDIT1b: enables row-level security on the table', () => {
    expect(auditMigration).toMatch(
      /ALTER TABLE public\.attribution_audit_log ENABLE ROW LEVEL SECURITY/,
    )
  })

  it('AUDIT2: event_type CHECK covers all six documented transitions', () => {
    for (const eventType of [
      'finalize_auto',
      'finalize_absent',
      'retry_incremented',
      'dlq_entered',
      'operator_resolve',
      'operator_reclassify',
    ]) {
      expect(auditMigration).toMatch(new RegExp(`'${eventType}'`))
    }
  })

  it('AUDIT3: reason required when event_type=dlq_entered', () => {
    expect(auditMigration).toMatch(/attribution_audit_log_dlq_reason_required/)
    expect(auditMigration).toMatch(
      /CHECK \(event_type <> 'dlq_entered' OR reason IS NOT NULL\)/,
    )
  })

  it('AUDIT4: operator_id required for operator_resolve / operator_reclassify', () => {
    expect(auditMigration).toMatch(/attribution_audit_log_operator_id_required/)
    expect(auditMigration).toMatch(
      /CHECK \(\s*event_type NOT IN \('operator_resolve', 'operator_reclassify'\)\s*OR operator_id IS NOT NULL\s*\)/,
    )
  })

  it('AUDIT5: grants SELECT only to authenticated, full access to service_role', () => {
    expect(auditMigration).toMatch(/GRANT SELECT ON public\.attribution_audit_log TO authenticated/)
    expect(auditMigration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.attribution_audit_log TO service_role/,
    )
  })

  it('AUDIT6: operator-read policy gates on profiles.is_operator', () => {
    expect(auditMigration).toMatch(/attribution_audit_log_operator_read/)
    expect(auditMigration).toMatch(/FROM public\.profiles p\s+WHERE p\.id = auth\.uid\(\)\s+AND p\.is_operator IS TRUE/)
  })

  it('AUDIT7: indexes tuned for the two primary access patterns', () => {
    expect(auditMigration).toMatch(/idx_attribution_audit_log_job_id/)
    expect(auditMigration).toMatch(/idx_attribution_audit_log_event_type_created_at/)
  })

  it('AUDIT8: ON DELETE CASCADE so audit rows follow job deletion', () => {
    expect(auditMigration).toMatch(/REFERENCES public\.jobs\(id\) ON DELETE CASCADE/)
  })
})

// ── Release-defense trigger ───────────────────────────────────────────────────

describe('Migration 20260420000003 — attribution release-defense trigger', () => {
  it('TRIG1: raises SQLSTATE P0004 with ATTRIBUTION_NOT_FINALIZED prefix', () => {
    expect(defenseMigration).toMatch(/ERRCODE = 'P0004'/)
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED:/)
  })

  it('TRIG2a: attaches trigger to escrow_tranches', () => {
    expect(defenseMigration).toMatch(
      /CREATE TRIGGER assert_attribution_finalized_before_release_tranche\s+BEFORE INSERT OR UPDATE ON public\.escrow_tranches/,
    )
  })

  it('TRIG2b: attaches trigger to supplementary_payment_requests', () => {
    expect(defenseMigration).toMatch(
      /CREATE TRIGGER assert_attribution_finalized_before_release_supplementary\s+BEFORE INSERT OR UPDATE ON public\.supplementary_payment_requests/,
    )
  })

  it('TRIG3: short-circuits for OLD.status already released (idempotent rewrite)', () => {
    expect(defenseMigration).toMatch(/v_old_status IS NOT DISTINCT FROM 'released'/)
    expect(defenseMigration).toMatch(/RETURN NEW;/) // the short-circuit path
  })

  it('TRIG4: short-circuits for NEW.status != released', () => {
    expect(defenseMigration).toMatch(/IF NEW\.status IS DISTINCT FROM 'released' THEN\s+RETURN NEW/)
  })

  it('TRIG5a: gates dlq', () => {
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED: dlq/)
  })

  it('TRIG5b: gates unresolved (non-finalized) status', () => {
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED: unresolved/)
  })

  it('TRIG5c: gates invalid origin after finalized', () => {
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED: origin_invalid/)
  })

  it('TRIG5d: gates job_not_found', () => {
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED: job_not_found/)
  })

  it('TRIG5e: gates missing plan_id / job_id', () => {
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED: missing_plan_id/)
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED: missing_job_id/)
  })

  it('TRIG6: trigger function is SECURITY DEFINER with locked search_path', () => {
    expect(defenseMigration).toMatch(/SECURITY DEFINER/)
    expect(defenseMigration).toMatch(/SET search_path = public/)
  })

  it('TRIG7: resolves owning job_id via escrow_payment_plans for tranche triggers', () => {
    expect(defenseMigration).toMatch(/FROM public\.escrow_payment_plans\s+WHERE id = NEW\.plan_id/)
  })

  it('TRIG8: misconfigured trigger on unknown table fails loud', () => {
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED: trigger_misconfigured/)
  })
})

// ── Cross-layer consistency (guard ↔ trigger) ─────────────────────────────────

describe('Guard/DB contract consistency (single source of truth)', () => {
  const guardSource = readFileSync(
    resolve(__dirname, '../../api/_attributionGuard.ts'),
    'utf8',
  )

  it('Guard and trigger both treat dlq as a distinct blocking branch', () => {
    expect(guardSource).toMatch(/'ATTRIBUTION_DLQ'/)
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED: dlq/)
  })

  it('Guard and trigger both require origin ∈ {merchant_brought, platform_acquired}', () => {
    expect(guardSource).toMatch(
      /origin !== 'merchant_brought' && origin !== 'platform_acquired'/,
    )
    expect(defenseMigration).toMatch(
      /v_origin IS DISTINCT FROM 'merchant_brought' AND v_origin IS DISTINCT FROM 'platform_acquired'/,
    )
  })

  it('Guard and trigger both fail-closed on missing job_id', () => {
    expect(guardSource).toMatch(/JOB_NOT_FOUND/)
    expect(defenseMigration).toMatch(/ATTRIBUTION_NOT_FINALIZED: (missing_plan_id|missing_job_id|job_not_found)/)
  })
})
