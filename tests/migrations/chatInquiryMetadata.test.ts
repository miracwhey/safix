/**
 * CHAT-CUTOVER Slice A — structural verification of the
 * `20260611000000_chat_inquiry_metadata.sql` migration.
 *
 * Locks the migration shape into the required CI gate (behavioral proof
 * lives in supabase/tests/database/07_chat_inquiry_rpc_metadata.sql):
 *   - 6 new chat_threads columns + CHECK on inquiry_origin + the partial
 *     craftsman-inbox index.
 *   - DROP FUNCTION of the old 2-param rpc_get_or_create_chat_customer_thread
 *     BEFORE the extended CREATE — CREATE OR REPLACE with new params would
 *     leave a second overload and break PostgREST rpc dispatch (ambiguity).
 *   - New params all DEFAULT NULL (existing 2-arg client calls stay valid).
 *   - Inquiry-path reuse must NOT overwrite existing inquiry metadata
 *     (set-only-when-inquiry_origin-IS-NULL update).
 *   - rpc_update_chat_thread_inquiry_state: COALESCE set-only-if-null for
 *     reviewed_at/declined_at + IS DISTINCT FROM craftsman guard (NULL
 *     craftsman ⇒ deny — no three-valued-logic bypass).
 *   - REVOKE hygiene on BOTH functions: PUBLIC + anon revoked (CREATE
 *     FUNCTION default-grants EXECUTE to PUBLIC incl. anon), authenticated +
 *     service_role granted.
 *   - PostgREST schema-cache reload; unique migration timestamp.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')
const FILENAME = '20260611000000_chat_inquiry_metadata.sql'
const sql = readFileSync(resolve(MIGRATIONS_DIR, FILENAME), 'utf8')

describe('chat inquiry metadata migration (Slice A)', () => {
  it('has a unique migration timestamp', () => {
    const stamp = FILENAME.slice(0, 14)
    const clashes = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith(stamp))
    expect(clashes).toEqual([FILENAME])
  })

  it('adds all six columns idempotently', () => {
    for (const col of [
      'inquiry_origin',
      'declined_at',
      'reviewed_at',
      'source_project_id',
      'inquiry_criteria',
      'display_metadata',
    ]) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}`))
    }
  })

  it('constrains inquiry_origin to the legacy value set', () => {
    expect(sql).toMatch(/chat_threads_inquiry_origin_check/)
    expect(sql).toMatch(/IN \('reel','profile','category','project'\)/)
  })

  it('creates the partial craftsman-inbox index', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS chat_threads_craftsman_inbox_idx/)
    expect(sql).toMatch(/WHERE channel_type = 'customer'\s*\n\s*AND inquiry_origin IS NOT NULL\s*\n\s*AND declined_at IS NULL/)
  })

  it('drops the old 2-param overload BEFORE creating the extended signature', () => {
    const dropIdx = sql.indexOf(
      'DROP FUNCTION IF EXISTS public.rpc_get_or_create_chat_customer_thread(uuid, text);',
    )
    const createIdx = sql.indexOf('CREATE FUNCTION public.rpc_get_or_create_chat_customer_thread(')
    expect(dropIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeGreaterThan(dropIdx)
  })

  it('defaults every new rpc param to NULL (old client calls stay valid)', () => {
    for (const param of ['p_inquiry_origin', 'p_source_project_id', 'p_inquiry_criteria', 'p_display_metadata']) {
      expect(sql).toMatch(new RegExp(`${param}\\s+\\w+\\s+DEFAULT NULL`))
    }
  })

  it('never overwrites existing inquiry metadata on reuse', () => {
    expect(sql).toMatch(/WHERE id = v_thread_id\s*\n\s*AND inquiry_origin IS NULL/)
  })

  it('keeps the inquiry-state RPC idempotent (set-only-if-null)', () => {
    expect(sql).toMatch(/reviewed_at = COALESCE\(reviewed_at, p_reviewed_at\)/)
    expect(sql).toMatch(/declined_at = COALESCE\(declined_at, p_declined_at\)/)
  })

  it('guards the inquiry-state RPC with IS DISTINCT FROM (no NULL bypass)', () => {
    expect(sql).toMatch(/IF v_craftsman IS DISTINCT FROM v_uid THEN/)
  })

  it('revokes PUBLIC + anon and grants authenticated + service_role on both functions', () => {
    const revokes = sql.match(/REVOKE EXECUTE ON FUNCTION [^;]+ FROM PUBLIC, anon;/g) ?? []
    const grants = sql.match(/GRANT {2}EXECUTE ON FUNCTION [^;]+ TO authenticated, service_role;/g) ?? []
    expect(revokes).toHaveLength(2)
    expect(grants).toHaveLength(2)
  })

  it('both functions are SECURITY DEFINER with pinned search_path', () => {
    const secdefs = sql.match(/SECURITY DEFINER\s*\nSET search_path TO 'public'/g) ?? []
    expect(secdefs).toHaveLength(2)
  })

  it('reloads the PostgREST schema cache', () => {
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';/)
  })
})
