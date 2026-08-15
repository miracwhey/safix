import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Validation for 20260504000001_provider_media_owner_access.sql
//
// The original provider_media migration (20260317000014) declared owner-
// scoped INSERT/UPDATE/DELETE/SELECT policies, but the production database
// drifted via Studio edits to a state with only INSERT, UPDATE, and a
// public-read SELECT (gated on `is_public = true`). DELETE has no policy
// at all and SELECT is blind for the owner when their provider is not
// yet public.
//
// This migration repairs both gaps by adding two owner-scoped policies
// that target the live state. These tests guard the SQL surface so a
// future edit cannot regress the predicate or drop the idempotency.
// ---------------------------------------------------------------------------

const migrationPath = resolve(
  __dirname,
  '../../supabase/migrations/20260504000001_provider_media_owner_access.sql',
)
const sql = readFileSync(migrationPath, 'utf-8')

describe('provider_media owner-access migration', () => {
  it('is idempotent (DROP POLICY IF EXISTS guards re-application)', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS provider_media_select_own/i)
    expect(sql).toMatch(/DROP POLICY IF EXISTS provider_media_delete_own/i)
  })

  it('grants the owner SELECT on their own provider_media rows', () => {
    expect(sql).toMatch(/CREATE POLICY provider_media_select_own[\s\S]+FOR SELECT/i)
    expect(sql).toMatch(/p\.profile_id = auth\.uid\(\)/i)
  })

  it('grants the owner DELETE on their own provider_media rows', () => {
    expect(sql).toMatch(/CREATE POLICY provider_media_delete_own[\s\S]+FOR DELETE/i)
  })

  it('uses the providers.profile_id predicate to scope ownership', () => {
    // Both policies must check membership through providers, not a raw
    // owner column on provider_media (which does not exist).
    const policyMatches = sql.match(
      /EXISTS\s*\(\s*SELECT 1 FROM public\.providers p[\s\S]+?p\.profile_id = auth\.uid\(\)/gi,
    )
    expect(policyMatches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('targets the authenticated role only (no anonymous access)', () => {
    expect(sql).toMatch(/TO authenticated/g)
    // Two policies, two TO authenticated clauses
    expect(sql.match(/TO authenticated/g)?.length ?? 0).toBe(2)
  })

  it('does not weaken the existing public-read policy', () => {
    // The public-read policy lives on a different POLICY name and is not
    // referenced here. A blanket DROP would be a regression.
    expect(sql).not.toMatch(/DROP POLICY[^;]*Public can read provider media/i)
    expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR SELECT[\s\S]+TO public/i)
  })
})
