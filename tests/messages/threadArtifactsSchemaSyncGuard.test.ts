/**
 * Thread Artifacts Schema Sync Guard
 *
 * Validates that the NET schema state across all thread_artifacts migrations
 * matches the intended live schema:
 *
 *   ✅  No global UNIQUE(conversation_id, artifact_type) — project artifacts
 *       are append-only (multiple per conversation).
 *   ✅  Partial unique index for offer artifacts — one offer per conversation.
 *   ✅  Partial unique index for payment_phase — one per conversation.
 *
 * Background:
 *   The live runtime issue for repeated project sends was caused by the
 *   database still having UNIQUE(conversation_id, artifact_type), which
 *   blocked append-only multi-project sends.  The base migration
 *   (20260323000002) intentionally creates this constraint for the initial
 *   backfill, and migration 20260323000004 drops it in favour of partial
 *   unique indexes.
 *
 *   This guard ensures the DROP actually exists and no later migration
 *   re-introduces the global constraint.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations')

/** Read every migration file that touches the thread_artifacts table. */
function getThreadArtifactMigrations(): { name: string; sql: string }[] {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  return files
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8') }))
    .filter(({ sql }) => /thread_artifacts/i.test(sql))
}

describe('Thread Artifacts Schema Sync Guard', () => {
  const migrations = getThreadArtifactMigrations()

  it('finds at least the base and multi-project migrations', () => {
    const names = migrations.map((m) => m.name)
    expect(names).toContain('20260323000002_thread_artifacts.sql')
    expect(names).toContain('20260323000004_thread_artifacts_multi_project.sql')
  })

  it('base migration creates the global UNIQUE constraint (needed for backfill)', () => {
    const base = migrations.find((m) => m.name === '20260323000002_thread_artifacts.sql')!
    expect(base.sql).toContain('UNIQUE(conversation_id, artifact_type)')
  })

  it('multi-project migration drops the global UNIQUE constraint', () => {
    const mp = migrations.find(
      (m) => m.name === '20260323000004_thread_artifacts_multi_project.sql'
    )!
    expect(mp.sql).toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+thread_artifacts_conversation_id_artifact_type_key/i)
  })

  it('multi-project migration adds partial unique index for offer', () => {
    const mp = migrations.find(
      (m) => m.name === '20260323000004_thread_artifacts_multi_project.sql'
    )!
    expect(mp.sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+thread_artifacts_offer_unique/i)
    expect(mp.sql).toMatch(/WHERE\s+artifact_type\s*=\s*'offer'/i)
  })

  it('multi-project migration adds partial unique index for payment_phase', () => {
    const mp = migrations.find(
      (m) => m.name === '20260323000004_thread_artifacts_multi_project.sql'
    )!
    expect(mp.sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+thread_artifacts_payment_phase_unique/i)
    expect(mp.sql).toMatch(/WHERE\s+artifact_type\s*=\s*'payment_phase'/i)
  })

  it('no migration after the DROP re-introduces a global UNIQUE on (conversation_id, artifact_type)', () => {
    // Find index of the multi-project migration
    const dropIndex = migrations.findIndex(
      (m) => m.name === '20260323000004_thread_artifacts_multi_project.sql'
    )
    expect(dropIndex).toBeGreaterThan(-1)

    // Strip SQL comments so detection is not confused by commented-out SQL.
    function stripComments(sql: string): string {
      return sql
        .replace(/--[^\n]*/g, '') // single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    }

    // Match both column orderings: (conversation_id, artifact_type) and
    // (artifact_type, conversation_id).
    const GLOBAL_UNIQUE_RE =
      /UNIQUE\s*\(\s*(?:conversation_id\s*,\s*artifact_type|artifact_type\s*,\s*conversation_id)\s*\)/i

    // Check every migration AFTER the drop — operate on the full SQL text
    // (not line-by-line) to catch multi-line statements.
    const laterMigrations = migrations.slice(dropIndex + 1)
    for (const m of laterMigrations) {
      const cleaned = stripComments(m.sql)

      // Inline table-level UNIQUE constraint (either column order)
      if (GLOBAL_UNIQUE_RE.test(cleaned)) {
        throw new Error(
          `Migration ${m.name} re-introduces a global UNIQUE(conversation_id, artifact_type) ` +
          `constraint that would block multi-project sends.`
        )
      }

      // Non-partial CREATE UNIQUE INDEX on the same column pair.
      // Split on semicolons to isolate statements, then check each one.
      const statements = cleaned.split(';')
      for (const stmt of statements) {
        if (
          /CREATE\s+UNIQUE\s+INDEX/i.test(stmt) &&
          /conversation_id/i.test(stmt) &&
          /artifact_type/i.test(stmt) &&
          !/WHERE/i.test(stmt)
        ) {
          throw new Error(
            `Migration ${m.name} creates a non-partial UNIQUE INDEX on ` +
            `(conversation_id, artifact_type) that would block multi-project sends.`
          )
        }
      }
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // FUNDING STEP SCHEMA SYNC — confirms migration 20260326000002 matches
  // the now-live thread_artifacts funding columns and CHECK constraint.
  // ═══════════════════════════════════════════════════════════════════════

  it('Funding step migration exists', () => {
    const names = migrations.map((m) => m.name)
    expect(names).toContain('20260326000002_thread_artifacts_funding_step.sql')
  })

  it('Funding step migration expands CHECK constraint to include funding_step', () => {
    const fundingMigration = migrations.find(
      (m) => m.name === '20260326000002_thread_artifacts_funding_step.sql'
    )!
    expect(fundingMigration.sql).toMatch(/funding_step/)
    expect(fundingMigration.sql).toMatch(
      /CHECK\s*\(\s*artifact_type\s+IN\s*\(\s*'project'\s*,\s*'offer'\s*,\s*'payment_phase'\s*,\s*'funding_step'\s*\)/i
    )
  })

  it('Funding step migration adds funding_request_id column', () => {
    const fundingMigration = migrations.find(
      (m) => m.name === '20260326000002_thread_artifacts_funding_step.sql'
    )!
    expect(fundingMigration.sql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+funding_request_id/i)
  })

  it('Funding step migration adds escrow_plan_id column', () => {
    const fundingMigration = migrations.find(
      (m) => m.name === '20260326000002_thread_artifacts_funding_step.sql'
    )!
    expect(fundingMigration.sql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+escrow_plan_id/i)
  })

  it('Funding step migration runs after base and multi-project migrations', () => {
    const baseIndex = migrations.findIndex(
      (m) => m.name === '20260323000002_thread_artifacts.sql'
    )
    const multiIndex = migrations.findIndex(
      (m) => m.name === '20260323000004_thread_artifacts_multi_project.sql'
    )
    const fundingIndex = migrations.findIndex(
      (m) => m.name === '20260326000002_thread_artifacts_funding_step.sql'
    )
    expect(fundingIndex).toBeGreaterThan(baseIndex)
    expect(fundingIndex).toBeGreaterThan(multiIndex)
  })

  it('net schema: the DROP runs AFTER the CREATE — correct migration ordering', () => {
    const createIndex = migrations.findIndex(
      (m) => m.name === '20260323000002_thread_artifacts.sql'
    )
    const dropIndex = migrations.findIndex(
      (m) => m.name === '20260323000004_thread_artifacts_multi_project.sql'
    )
    expect(dropIndex).toBeGreaterThan(createIndex)
  })
})
