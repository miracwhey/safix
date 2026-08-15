/**
 * CHAT-4 — structural verification of the
 * `20260610155500_chat4_signals_symmetric_insert_text_ids.sql` migration.
 *
 * The migration fixes the customer-side 42501 (red SyncStatusBar in money
 * flows): the live INSERT policies on `notification_signals` AND
 * `timeline_signals` were provider-only, and both `id` columns drifted to
 * uuid in prod while every deterministic writer sends text ids
 * (`notif-<uuid>[-c]`, `reminder-…`, `timeline_<type>__<ref>`) → 22P02
 * before RLS for BOTH roles.
 *
 * Asserted here (regression-map FIX 6 has zero vitest surface — this file
 * locks the migration shape into the required CI gate; behavioral proof
 * lives in supabase/tests/database/04_rls_signals_symmetric_insert.sql):
 *   - id uuid→text on both tables with a text default.
 *   - symmetric INSERT policies: customer branch (NULL-guarded) OR provider
 *     branch joining BOTH provider_id and assigned_provider_id.
 *   - Tautologie-Falle guard: NEW-row columns are table-qualified inside
 *     every EXISTS subquery (an unqualified `job_id` resolves to the
 *     subquery table and silently degrades the policy to always-true).
 *   - SELECT/UPDATE widening uses IN(provider_id, assigned_provider_id) —
 *     NOT a COALESCE join, which would STEAL visibility from the original
 *     provider whenever assigned_provider_id is set (narrowing).
 *   - timeline_signals_select_own stays untouched (already covers both
 *     roles per the live dump); no UPDATE/DELETE policy added there.
 *   - REVOKE hygiene: PUBLIC + anon fully revoked (anon had full default
 *     grants incl. TRUNCATE, which RLS does NOT protect); authenticated
 *     trimmed to SELECT/INSERT/UPDATE.
 *   - PostgREST schema-cache reload; unique migration timestamp.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')
const FILENAME = '20260610155500_chat4_signals_symmetric_insert_text_ids.sql'
const sql = readFileSync(resolve(MIGRATIONS_DIR, FILENAME), 'utf8')
// Comment-stripped view for NEGATIVE assertions (the migration's prose
// comments legitimately mention policy/role names that must not appear as
// actual statements).
const sqlCode = sql.replace(/--[^\n]*/g, '')

/** Extracts the body of a single CREATE POLICY statement. */
function policyBody(name: string, table: string): string {
  const re = new RegExp(
    `CREATE POLICY ${name} ON public\\.${table}[\\s\\S]*?;`,
    'm',
  )
  const match = sql.match(re)
  expect(match, `CREATE POLICY ${name} ON public.${table} present`).not.toBeNull()
  return (match as RegExpMatchArray)[0]
}

describe('Migration 20260610155500 — id uuid→text (writer contract)', () => {
  it.each(['notification_signals', 'timeline_signals'])(
    'converts %s.id to text with a text default',
    (table) => {
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table}\\s+` +
            `ALTER COLUMN id DROP DEFAULT,\\s+` +
            `ALTER COLUMN id TYPE text USING id::text,\\s+` +
            `ALTER COLUMN id SET DEFAULT \\(gen_random_uuid\\(\\)\\)::text;`,
        ),
      )
    },
  )

  it('never touches job_id types (FK to jobs stays uuid-compatible)', () => {
    expect(sqlCode).not.toMatch(/ALTER COLUMN job_id/)
  })
})

describe('Migration 20260610155500 — symmetric INSERT policies', () => {
  it.each(['notification_signals', 'timeline_signals'])(
    'drops and recreates %s_insert_own FOR INSERT TO authenticated',
    (table) => {
      expect(sql).toMatch(
        new RegExp(
          `DROP POLICY IF EXISTS ${table}_insert_own ON public\\.${table};`,
        ),
      )
      const body = policyBody(`${table}_insert_own`, table)
      expect(body).toMatch(/FOR INSERT TO authenticated/)
    },
  )

  it.each(['notification_signals', 'timeline_signals'])(
    '%s INSERT: customer branch is NULL-guarded and matches auth.uid()',
    (table) => {
      const body = policyBody(`${table}_insert_own`, table)
      expect(body).toMatch(/j\.customer_user_id IS NOT NULL/)
      expect(body).toMatch(/j\.customer_user_id = auth\.uid\(\)/)
    },
  )

  it.each(['notification_signals', 'timeline_signals'])(
    '%s INSERT: provider branch joins BOTH provider_id and assigned_provider_id',
    (table) => {
      const body = policyBody(`${table}_insert_own`, table)
      expect(body).toMatch(
        /p\.id IN \(j\.provider_id, j\.assigned_provider_id\)/,
      )
      expect(body).toMatch(/p\.profile_id = auth\.uid\(\)/)
    },
  )

  it.each(['notification_signals', 'timeline_signals'])(
    '%s INSERT: NEW-row job_id is table-qualified in every EXISTS (Tautologie-Falle)',
    (table) => {
      const body = policyBody(`${table}_insert_own`, table)
      const qualified = new RegExp(`j\\.id = ${table}\\.job_id`, 'g')
      expect(body.match(qualified)).toHaveLength(2)
      // No unqualified comparison may survive: every `j.id = …job_id` in the
      // policy must be the table-qualified form matched above.
      expect(body.match(/j\.id = (?:\w+\.)?job_id/g)).toHaveLength(2)
      expect(body).not.toMatch(/j\.id = job_id/)
    },
  )
})

describe('Migration 20260610155500 — SELECT/UPDATE widening (strict, no narrowing)', () => {
  it.each(['notification_signals_select_own', 'notification_signals_update_own'])(
    '%s keeps recipient_role semantics and widens the provider join',
    (policy) => {
      expect(sql).toMatch(
        new RegExp(`DROP POLICY IF EXISTS ${policy} ON public\\.notification_signals;`),
      )
      const body = policyBody(policy, 'notification_signals')
      expect(body).toMatch(/recipient_role = 'craftsman'/)
      expect(body).toMatch(/recipient_role = 'customer'/)
      expect(body).toMatch(/p\.id IN \(j\.provider_id, j\.assigned_provider_id\)/)
      expect(body).toMatch(/j\.id = notification_signals\.job_id/)
    },
  )

  it('uses IN — never a COALESCE provider join (COALESCE would steal owner visibility)', () => {
    expect(sqlCode).not.toMatch(/COALESCE\s*\(\s*j\.assigned_provider_id\s*,\s*j\.provider_id\s*\)/i)
    expect(sqlCode).not.toMatch(/COALESCE\s*\(\s*j\.provider_id\s*,\s*j\.assigned_provider_id\s*\)/i)
  })

  it('leaves timeline_signals_select_own untouched and adds no timeline UPDATE/DELETE policy', () => {
    expect(sqlCode).not.toMatch(/timeline_signals_select_own/)
    expect(sqlCode).not.toMatch(/ON public\.timeline_signals\s+FOR (UPDATE|DELETE|SELECT)/)
  })

  it('creates no DELETE policy at all (default-deny stays)', () => {
    expect(sqlCode).not.toMatch(/FOR DELETE/)
  })
})

describe('Migration 20260610155500 — grant hygiene + cache reload', () => {
  it('revokes ALL from PUBLIC and anon on both tables (TRUNCATE is not covered by RLS)', () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.notification_signals FROM PUBLIC, anon;/)
    expect(sql).toMatch(/REVOKE ALL ON public\.timeline_signals\s+FROM PUBLIC, anon;/)
  })

  it('trims authenticated to SELECT/INSERT/UPDATE on both tables', () => {
    for (const table of ['notification_signals', 'timeline_signals']) {
      expect(sql).toMatch(
        new RegExp(
          `REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\\.${table}\\s+FROM authenticated;`,
        ),
      )
      expect(sql).toMatch(
        new RegExp(`GRANT SELECT, INSERT, UPDATE ON public\\.${table}\\s+TO authenticated;`),
      )
    }
  })

  it('never touches service_role grants (BYPASSRLS server paths stay intact)', () => {
    expect(sqlCode).not.toMatch(/(REVOKE|GRANT)[^;]*service_role/)
  })

  it('reloads the PostgREST schema cache', () => {
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';/)
  })
})

describe('Migration 20260610155500 — ledger placement', () => {
  it('has a unique timestamp prefix that sorts after the fresh 2026-06-10 migrations', () => {
    const todays = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.startsWith('20260610'))
      .sort()
    expect(todays.filter((f) => f.startsWith('20260610155500'))).toEqual([FILENAME])
    // Must sort after the three sacred fixes (000000/090000/120000) and the
    // CHAT-3 push-dispatch migration (150000). Parallel ship-gate builders may
    // append later timestamps — only the relative order matters here.
    for (const predecessor of [
      '20260610000000_dsgvo1_moderation_log_fk_set_null.sql',
      '20260610090000_c4_c5_dispute_decision_immutability.sql',
      '20260610120000_h24_party_submit_dispute_statement.sql',
      '20260610150000_chat3_chat_message_push_dispatch.sql',
    ]) {
      expect(todays).toContain(predecessor)
      expect(FILENAME > predecessor).toBe(true)
    }
  })
})
