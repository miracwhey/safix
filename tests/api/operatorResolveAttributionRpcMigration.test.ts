/**
 * Structural verification of supabase/migrations/20260420000004_operator_resolve_attribution_rpc.sql.
 *
 * The live-DB behavioural tests run via the API-handler test (which mocks the
 * RPC response) and via manual SQL-driven operator-flow verification.  These
 * tests guard the migration contract itself: any drift between the RPC SQL
 * and the app layer must surface here.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const sql = readFileSync(
  resolve(__dirname, '../../supabase/migrations/20260420000004_operator_resolve_attribution_rpc.sql'),
  'utf8',
)

describe('operator_resolve_attribution RPC migration — structure', () => {
  it('defines SECURITY DEFINER with locked search_path', () => {
    expect(sql).toMatch(/SECURITY DEFINER/)
    expect(sql).toMatch(/SET search_path = public/)
  })

  it('verifies operator flag on profiles (42501 on missing)', () => {
    expect(sql).toMatch(/is_operator/)
    expect(sql).toMatch(/ERRCODE = '42501'/)
    expect(sql).toMatch(/unauthorized: caller is not an operator/)
  })

  it('validates mode enum: resolve | reclassify | reject', () => {
    expect(sql).toMatch(/p_mode NOT IN \('resolve', 'reclassify', 'reject'\)/)
    expect(sql).toMatch(/invalid_mode: %/)
  })

  it('requires a non-empty reason (operator note)', () => {
    expect(sql).toMatch(/NULLIF\(btrim\(COALESCE\(p_reason, ''\)\), ''\)/)
    expect(sql).toMatch(/reason_required/)
  })

  it('restricts to_origin to merchant_brought | platform_acquired for resolve/reclassify', () => {
    expect(sql).toMatch(
      /p_to_origin IS NULL OR p_to_origin NOT IN \('merchant_brought', 'platform_acquired'\)/,
    )
    expect(sql).toMatch(/invalid_to_origin/)
  })

  it('rejects carrying an origin on mode=reject', () => {
    expect(sql).toMatch(/reject must not carry an origin/)
  })

  it('locks the job row (FOR UPDATE) and raises P0002 on missing job', () => {
    expect(sql).toMatch(/FROM public\.jobs\s+WHERE id = p_job_id\s+FOR UPDATE/)
    expect(sql).toMatch(/job_not_found: %/)
    expect(sql).toMatch(/ERRCODE = 'P0002'/)
  })

  it('resolve permits pending | retrying | dlq as source', () => {
    expect(sql).toMatch(/resolve requires pending\|retrying\|dlq/)
  })

  it('reclassify requires finalized source', () => {
    expect(sql).toMatch(/reclassify requires finalized/)
  })

  it('reject restricts source to pending | retrying', () => {
    expect(sql).toMatch(/reject requires pending\|retrying/)
  })

  it('clears attribution_dlq_reason on resolve / reclassify', () => {
    expect(sql).toMatch(/attribution_dlq_reason\s*=\s*NULL/)
  })

  it('persists reason into attribution_dlq_reason on reject', () => {
    expect(sql).toMatch(/attribution_dlq_reason\s*=\s*v_normalized_reason/)
  })

  it('writes one attribution_audit_log row atomically per transition', () => {
    expect(sql).toMatch(/INSERT INTO public\.attribution_audit_log/)
    expect(sql).toMatch(/operator_id,\s*reason/)
  })

  it('maps event types: operator_resolve | operator_reclassify | dlq_entered', () => {
    expect(sql).toMatch(/'operator_resolve'/)
    expect(sql).toMatch(/'operator_reclassify'/)
    expect(sql).toMatch(/'dlq_entered'/)
  })

  it('revokes execute from PUBLIC / anon / authenticated and grants to service_role', () => {
    expect(sql).toMatch(/REVOKE EXECUTE .* FROM PUBLIC/)
    expect(sql).toMatch(/REVOKE EXECUTE .* FROM anon/)
    expect(sql).toMatch(/REVOKE EXECUTE .* FROM authenticated/)
    expect(sql).toMatch(/GRANT {2}EXECUTE .* TO service_role/)
  })

  it('returns the canonical outcome JSON envelope', () => {
    expect(sql).toMatch(/'outcome',\s*'resolved'/)
    expect(sql).toMatch(/'mode',\s*p_mode/)
    expect(sql).toMatch(/'fromStatus',\s*v_current_status/)
    expect(sql).toMatch(/'toStatus',\s*v_new_status/)
  })
})
