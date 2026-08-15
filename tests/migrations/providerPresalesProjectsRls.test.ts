/**
 * Spatial V1.5 · Phase B-P1 · provider_presales_projects RLS verification
 *
 * Asserts the RLS policies + grants in
 * `20260523181353_provider_presales_projects.sql` are exactly the cross-org
 * isolation contract the workflow layer relies on:
 *   - SELECT/UPDATE: same provider-org OR operator escalation
 *   - INSERT:        same provider-org AND created_by_user_id = self
 *   - DELETE:        creator-self (within org) OR operator
 *   - REVOKE:        anon has no access
 *
 * Plus the trigger-search-path hardening migration is checked separately so
 * we don't regress on the advisor finding.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')
const presalesSql = readFileSync(
  resolve(MIGRATIONS_DIR, '20260523181353_provider_presales_projects.sql'),
  'utf8',
)
const searchPathSql = readFileSync(
  resolve(MIGRATIONS_DIR, '20260523182423_provider_presales_projects_trg_search_path.sql'),
  'utf8',
)

describe('Migration 20260523181353 — provider_presales_projects table', () => {
  it('creates the table with org + creator + FSM columns', () => {
    expect(presalesSql).toMatch(/CREATE TABLE IF NOT EXISTS public\.provider_presales_projects/)
    expect(presalesSql).toMatch(/provider_org_id\s+uuid NOT NULL REFERENCES public\.providers\(id\) ON DELETE CASCADE/)
    expect(presalesSql).toMatch(/created_by_user_id\s+uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE RESTRICT/)
    expect(presalesSql).toMatch(/converted_to_job_id\s+uuid REFERENCES public\.jobs\(id\) ON DELETE SET NULL/)
  })

  it('CHECK constraint enumerates all five FSM states', () => {
    expect(presalesSql).toMatch(
      /CONSTRAINT presales_status_chk[\s\S]*?status IN \(\s*'draft',\s*'scanned',\s*'quoted',\s*'converted',\s*'archived'\s*\)/,
    )
  })

  it('creates the supporting btree + partial indexes', () => {
    expect(presalesSql).toMatch(/CREATE INDEX IF NOT EXISTS provider_presales_projects_org_idx/)
    expect(presalesSql).toMatch(/CREATE INDEX IF NOT EXISTS provider_presales_projects_status_idx/)
    expect(presalesSql).toMatch(
      /CREATE INDEX IF NOT EXISTS provider_presales_projects_converted_idx[\s\S]*?WHERE converted_to_job_id IS NOT NULL/,
    )
  })

  it('enables RLS', () => {
    expect(presalesSql).toMatch(
      /ALTER TABLE public\.provider_presales_projects ENABLE ROW LEVEL SECURITY/,
    )
  })
})

describe('Migration 20260523181353 — provider_presales_projects RLS policies', () => {
  it('SELECT policy: same provider-org OR operator', () => {
    expect(presalesSql).toMatch(
      /CREATE POLICY provider_presales_projects_select[\s\S]*?FOR SELECT TO authenticated[\s\S]*?provider_org_id\s*=\s*public\.spatial_user_provider_org\(\(SELECT auth\.uid\(\)\)\)/,
    )
    expect(presalesSql).toMatch(
      /CREATE POLICY provider_presales_projects_select[\s\S]*?OR public\.spatial_is_operator\(\(SELECT auth\.uid\(\)\)\)/,
    )
  })

  it('INSERT policy: WITH CHECK enforces same-org AND creator-self', () => {
    expect(presalesSql).toMatch(
      /CREATE POLICY provider_presales_projects_insert[\s\S]*?WITH CHECK[\s\S]*?provider_org_id\s*=\s*public\.spatial_user_provider_org\(\(SELECT auth\.uid\(\)\)\)[\s\S]*?AND created_by_user_id\s*=\s*\(SELECT auth\.uid\(\)\)/,
    )
  })

  it('UPDATE policy: USING + WITH CHECK both gate on provider-org; created_by_user_id immutable for non-operators', () => {
    expect(presalesSql).toMatch(
      /CREATE POLICY provider_presales_projects_update[\s\S]*?USING[\s\S]*?provider_org_id\s*=\s*public\.spatial_user_provider_org\(\(SELECT auth\.uid\(\)\)\)/,
    )
    expect(presalesSql).toMatch(
      /CREATE POLICY provider_presales_projects_update[\s\S]*?WITH CHECK[\s\S]*?public\.spatial_is_operator\(\(SELECT auth\.uid\(\)\)\)[\s\S]*?OR created_by_user_id\s*=\s*\(\s*SELECT created_by_user_id FROM public\.provider_presales_projects\s+WHERE id = provider_presales_projects\.id/,
    )
  })

  it('DELETE policy: creator-self (within org) OR operator only', () => {
    expect(presalesSql).toMatch(
      /CREATE POLICY provider_presales_projects_delete[\s\S]*?FOR DELETE TO authenticated[\s\S]*?public\.spatial_is_operator\(\(SELECT auth\.uid\(\)\)\)[\s\S]*?OR \([\s\S]*?created_by_user_id\s*=\s*\(SELECT auth\.uid\(\)\)[\s\S]*?AND provider_org_id\s*=\s*public\.spatial_user_provider_org\(\(SELECT auth\.uid\(\)\)\)/,
    )
  })

  it('revokes PUBLIC + anon grants, leaves authenticated with CRUD only', () => {
    expect(presalesSql).toMatch(/REVOKE ALL ON public\.provider_presales_projects FROM PUBLIC/)
    expect(presalesSql).toMatch(/REVOKE ALL ON public\.provider_presales_projects FROM anon/)
    expect(presalesSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.provider_presales_projects TO authenticated/,
    )
    expect(presalesSql).toMatch(/GRANT ALL ON public\.provider_presales_projects TO service_role/)
  })

  it('migration is idempotent (DROP-then-CREATE for every policy + IF NOT EXISTS on table/indexes)', () => {
    expect(presalesSql).toMatch(/DROP POLICY IF EXISTS provider_presales_projects_select/)
    expect(presalesSql).toMatch(/DROP POLICY IF EXISTS provider_presales_projects_insert/)
    expect(presalesSql).toMatch(/DROP POLICY IF EXISTS provider_presales_projects_update/)
    expect(presalesSql).toMatch(/DROP POLICY IF EXISTS provider_presales_projects_delete/)
  })
})

describe('Migration 20260523182423 — trigger search_path hardening', () => {
  it('pins search_path = public on provider_presales_projects_set_updated_at()', () => {
    // Migration re-creates the function (CREATE OR REPLACE … SET search_path)
    // rather than ALTER FUNCTION, so check for the SET clause inside the body.
    expect(searchPathSql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.provider_presales_projects_set_updated_at\(\)[\s\S]*?SET search_path\s*=\s*public/,
    )
  })
})
