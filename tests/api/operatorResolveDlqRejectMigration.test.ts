/**
 * Structural verification of migration
 * supabase/migrations/20260420000005_operator_resolve_attribution_rpc_dlq_reject.sql.
 *
 * Companion to operatorResolveAttributionRpcMigration.test.ts — covers the
 * semantic delta introduced by 000005: reject now accepts dlq as source so the
 * operator DLQ screen's "Hinweis festhalten" action has a working backend.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const sql = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260420000005_operator_resolve_attribution_rpc_dlq_reject.sql',
  ),
  'utf8',
)

describe('Migration 20260420000005 — operator_resolve_attribution reject widens to dlq', () => {
  it('is a CREATE OR REPLACE on the existing RPC (idempotent amend)', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.operator_resolve_attribution/)
  })

  it('keeps SECURITY DEFINER + locked search_path', () => {
    expect(sql).toMatch(/SECURITY DEFINER/)
    expect(sql).toMatch(/SET search_path = public/)
  })

  it('reject transition matrix now includes dlq', () => {
    expect(sql).toMatch(
      /ELSIF p_mode = 'reject' THEN[\s\S]*?v_current_status NOT IN \('pending', 'retrying', 'dlq'\)/,
    )
    expect(sql).toMatch(/reject requires pending\|retrying\|dlq/)
  })

  it('reject still forbids a carried origin', () => {
    expect(sql).toMatch(/reject must not carry an origin/)
  })

  it('reject-branch continues to emit event_type=dlq_entered (audit parity)', () => {
    expect(sql).toMatch(/v_event_type := 'dlq_entered'/)
  })

  it('reject-update keeps status=dlq and overwrites attribution_dlq_reason', () => {
    expect(sql).toMatch(
      /IF p_mode = 'reject' THEN[\s\S]*?attribution_status\s*=\s*v_new_status[\s\S]*?attribution_dlq_reason\s*=\s*v_normalized_reason/,
    )
  })

  it('reject-branch touches attribution_last_retry_at so reviewed DLQ rows sink', () => {
    expect(sql).toMatch(
      /IF p_mode = 'reject' THEN[\s\S]*?attribution_last_retry_at\s*=\s*clock_timestamp\(\)/,
    )
  })

  it('resolve/reclassify transitions remain unchanged (no regression)', () => {
    expect(sql).toMatch(/resolve requires pending\|retrying\|dlq/)
    expect(sql).toMatch(/reclassify requires finalized/)
  })

  it('reason is still mandatory for every mode', () => {
    expect(sql).toMatch(/reason_required: every operator action must carry a note/)
  })

  it('permissions remain SERVICE_ROLE only', () => {
    expect(sql).toMatch(/REVOKE EXECUTE .* FROM PUBLIC/)
    expect(sql).toMatch(/REVOKE EXECUTE .* FROM anon/)
    expect(sql).toMatch(/REVOKE EXECUTE .* FROM authenticated/)
    expect(sql).toMatch(/GRANT {2}EXECUTE .* TO service_role/)
  })

  it('audit insert still writes one row atomically', () => {
    expect(sql).toMatch(/INSERT INTO public\.attribution_audit_log/)
    expect(sql).toMatch(/operator_id,\s*reason/)
  })
})
