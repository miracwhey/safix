/**
 * Spatial V1.6.1 · structural verification of the verify-productionization +
 * RBAC-hardening migrations:
 *   - 20260601100000  parametric_version column (H1 CAS)
 *   - 20260601100100  spatial_edit_history_append role↔variant guard (H2)
 *   - 20260601100200  spatial_set_customer_verify_state column-scoped RPC (L4.b)
 *
 * The test suite is DB-blind (in-memory + SQL-text regex — there is no pglite
 * harness), so these assertions are the ONLY automated guard on the SQL
 * contract. Behavioural RLS verification (a customer setting customer_verify_
 * state on a HW-owned scene; a spoofed variant_id being rejected) lives in the
 * pre-deploy MCP repro against Prod — see project memory
 * `feedback_verify_autonomous_build_claims` + the plan handover.
 *
 * The load-bearing invariant asserted here: the verify-state RPC is
 * COLUMN-SCOPED — it must never write the parametric blob pointer, so the
 * blob-clobber protection (spatial_can_edit_scene, migration 20260529194918)
 * survives the SECURITY-DEFINER bypass.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  canTransitionCustomerVerifyState,
  type CustomerVerifyState,
} from '../../src/lib/spatial/canonical/repository/spatialSceneFsm.ts'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')
const read = (file: string) => readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8')

const M1 = read('20260601100000_spatial_v161_parametric_version_cas.sql')
const M2 = read('20260601100100_spatial_v161_edit_history_variant_guard.sql')
const M3 = read('20260601100200_spatial_v161_set_customer_verify_state_rpc.sql')

describe('M1 · parametric_version (H1 CAS column)', () => {
  it('adds the column idempotently, NOT NULL DEFAULT 0', () => {
    expect(M1).toMatch(
      /ALTER TABLE public\.spatial_scenes\s+ADD COLUMN IF NOT EXISTS parametric_version integer NOT NULL DEFAULT 0/,
    )
  })

  it('does not add a trigger or touch RLS (CAS lives in the repository)', () => {
    expect(M1).not.toMatch(/CREATE\s+(OR REPLACE\s+)?TRIGGER/i)
    expect(M1).not.toMatch(/CREATE POLICY/i)
  })

  it('reloads the PostgREST schema cache', () => {
    expect(M1).toMatch(/NOTIFY pgrst, 'reload schema'/)
  })
})

describe('M2 · spatial_edit_history_append role↔variant guard (H2)', () => {
  it('redefines the 8-arg function (preserves p_semantic_op signature)', () => {
    expect(M2).toMatch(
      /CREATE OR REPLACE FUNCTION public\.spatial_edit_history_append\([\s\S]*?p_semantic_op\s+text DEFAULT NULL/,
    )
    expect(M2).toMatch(/SECURITY DEFINER/)
    expect(M2).toMatch(/SET search_path TO 'public'/)
  })

  it('derives the caller-writable variant server-side (mirrors resolveWritableVariantId)', () => {
    // operator → operator_review · provider → provider_<uid>_annotations · else customer_corrections
    expect(M2).toMatch(/spatial_is_operator\(v_uid\)[\s\S]*?v_expected_variant\s*:=\s*'operator_review'/)
    expect(M2).toMatch(/v_uid\s*=\s*v_provider_id[\s\S]*?'provider_'\s*\|\|\s*v_uid::text\s*\|\|\s*'_annotations'/)
    expect(M2).toMatch(/v_expected_variant\s*:=\s*'customer_corrections'/)
  })

  it('rejects a mismatching p_variant_id with 42501 (the H2 spoof hole)', () => {
    expect(M2).toMatch(
      /IF p_variant_id IS DISTINCT FROM v_expected_variant THEN[\s\S]*?ERRCODE = '42501'/,
    )
  })

  it('still loads provider_id from the scene to run the guard', () => {
    expect(M2).toMatch(/SELECT[\s\S]*?provider_id[\s\S]*?FROM public\.spatial_scenes/)
  })

  it('re-asserts the grant surface (authenticated + service_role only)', () => {
    expect(M2).toMatch(/REVOKE ALL ON FUNCTION public\.spatial_edit_history_append[\s\S]*?FROM PUBLIC, anon/)
    expect(M2).toMatch(/GRANT EXECUTE ON FUNCTION public\.spatial_edit_history_append[\s\S]*?TO authenticated, service_role/)
  })
})

describe('M3 · spatial_set_customer_verify_state (L4.b column-scoped RPC)', () => {
  it('is a SECURITY DEFINER function returning the scene row', () => {
    expect(M3).toMatch(
      /CREATE OR REPLACE FUNCTION public\.spatial_set_customer_verify_state\([\s\S]*?\)\s*\n\s*RETURNS public\.spatial_scenes/,
    )
    expect(M3).toMatch(/SECURITY DEFINER/)
    expect(M3).toMatch(/SET search_path TO 'public'/)
  })

  it('writes EXACTLY the three verify columns (allowlist) — never any other column', () => {
    // Load-bearing invariant: SECDEF bypasses spatial_can_edit_scene, so the
    // UPDATE must touch ONLY the verify columns — a leak would re-open the
    // blob-clobber the can-edit gate (20260529194918) closes. Assert the exact
    // SET-clause column set (an allowlist), not just a blocklist of known-bad
    // columns: a future SET addition would slip past a blocklist.
    const setMatch = M3.match(
      /UPDATE public\.spatial_scenes\s+SET([\s\S]*?)WHERE id = p_scene_id/,
    )
    expect(setMatch).not.toBeNull()
    const assignedColumns = [...setMatch![1].matchAll(/(\w+)\s*=/g)].map((m) => m[1]).sort()
    expect(assignedColumns).toEqual(
      [
        'customer_verify_last_active_at',
        'customer_verify_last_stage',
        'customer_verify_state',
      ].sort(),
    )
    // COALESCE NULL-safety + server-stamped now() (no client-clock active-at).
    expect(M3).toMatch(/customer_verify_state\s*=\s*COALESCE\(p_state, customer_verify_state\)/)
    expect(M3).toMatch(/customer_verify_last_active_at\s*=\s*now\(\)/)
  })

  it('scopes the UPDATE to the target scene (WHERE id = p_scene_id)', () => {
    // A dropped WHERE on a SECURITY DEFINER UPDATE = mass verify-state clobber.
    expect(M3).toMatch(/UPDATE public\.spatial_scenes[\s\S]*?WHERE id = p_scene_id/)
  })

  it('gates on the customer recipient and EXCLUDES the provider', () => {
    // operator / scene customer / HW-shared recipient / customer self-scan — and
    // crucially NO provider_id branch (verify is the customer's act).
    expect(M3).toMatch(/spatial_is_operator\(v_uid\)/)
    expect(M3).toMatch(/v_uid\s*=\s*v_customer_id/)
    expect(M3).toMatch(/shared_with_customer\s*=\s*true/)
    expect(M3).toMatch(/j\.customer_user_id\s*=\s*v_uid/)
    expect(M3).not.toMatch(/provider_id/)
    expect(M3).toMatch(/ERRCODE = '42501'/)
  })

  it('REVOKEs from anon and grants only authenticated + service_role', () => {
    expect(M3).toMatch(
      /REVOKE ALL ON FUNCTION public\.spatial_set_customer_verify_state\(uuid, text, integer\) FROM PUBLIC, anon/,
    )
    expect(M3).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.spatial_set_customer_verify_state\(uuid, text, integer\) TO authenticated, service_role/,
    )
  })

  it('validates state + stage inputs and reloads the schema cache', () => {
    expect(M3).toMatch(/p_state NOT IN \('not_started','in_progress','approved','rejected','expired'\)/)
    expect(M3).toMatch(/p_stage < 1 OR p_stage > 5/)
    expect(M3).toMatch(/NOTIFY pgrst, 'reload schema'/)
  })
})

describe('customer_verify FSM · TS ↔ DB parity', () => {
  // The persistVerifyConfirm chain walks intermediate states by calling the
  // verify RPC once per hop; correctness hinges entirely on the TS planner FSM
  // (spatialSceneFsm) staying edge-for-edge identical to the DB guard trigger
  // (20260520120011). The InMemory suite mirrors the TS side, so a drift in
  // EITHER would otherwise stay green. This guard parses both and compares.
  const STATES: CustomerVerifyState[] = [
    'not_started',
    'in_progress',
    'approved',
    'rejected',
    'expired',
  ]

  it('TS canTransitionCustomerVerifyState matches the DB CASE edges exactly', () => {
    // TS edge set (self-edges excluded — the DB trigger early-returns on equal).
    const tsEdges = new Set<string>()
    for (const from of STATES) {
      for (const to of STATES) {
        if (from !== to && canTransitionCustomerVerifyState(from, to)) {
          tsEdges.add(`${from}->${to}`)
        }
      }
    }

    // DB edge set parsed from the CASE OLD.customer_verify_state ... END block.
    const fsmSql = read('20260520120011_spatial_canonical_triggers.sql')
    const caseBlock = fsmSql.match(
      /v_allowed\s*:=\s*CASE OLD\.customer_verify_state([\s\S]*?)END;/,
    )
    expect(caseBlock).not.toBeNull()
    const dbEdges = new Set<string>()
    for (const whenMatch of caseBlock![1].matchAll(
      /WHEN '(\w+)'\s*THEN ARRAY\[([^\]]*)\]/g,
    )) {
      const from = whenMatch[1]
      for (const toMatch of whenMatch[2].matchAll(/'(\w+)'/g)) {
        dbEdges.add(`${from}->${toMatch[1]}`)
      }
    }

    expect([...tsEdges].sort()).toEqual([...dbEdges].sort())
  })
})
