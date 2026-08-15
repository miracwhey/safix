/**
 * provider_media_comments migration — M2.3 schema contract
 *
 * Locks the live shape: append-only thread table, no UPDATE policy, RLS
 * for SELECT/INSERT/DELETE only, body length cap, indices, and Realtime
 * publication membership.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const sql = fs.readFileSync(
  path.resolve(
    repoRoot,
    'supabase/migrations/20260504000005_provider_media_comments.sql',
  ),
  'utf-8',
)

describe('20260504000005_provider_media_comments — table shape', () => {
  it('creates the table idempotently', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.provider_media_comments')
  })

  it('cascades media_id and user_id deletes', () => {
    expect(sql).toContain('REFERENCES public.provider_media(id) ON DELETE CASCADE')
    expect(sql).toContain('REFERENCES auth.users(id) ON DELETE CASCADE')
  })

  it('caps the body length at 500 chars', () => {
    expect(sql).toContain('length(body) <= 500')
  })

  it('rejects empty / whitespace-only bodies', () => {
    expect(sql).toContain('length(btrim(body)) > 0')
  })

  it('indexes (media_id, created_at DESC) for the thread render', () => {
    expect(sql).toMatch(/CREATE INDEX[\s\S]*\(media_id,\s*created_at\s+DESC\)/)
  })
})

describe('20260504000005_provider_media_comments — RLS', () => {
  it('enables RLS', () => {
    expect(sql).toContain('ALTER TABLE public.provider_media_comments ENABLE ROW LEVEL SECURITY')
  })

  it('public SELECT', () => {
    expect(sql).toContain('"provider_media_comments_select"')
    expect(sql).toMatch(/FOR SELECT USING \(true\)/)
  })

  it('INSERT only as your own user_id', () => {
    expect(sql).toContain('"provider_media_comments_insert"')
    expect(sql).toMatch(/FOR INSERT[\s\S]*WITH CHECK \(auth\.uid\(\) = user_id\)/)
  })

  it('DELETE: author OR provider that owns the media', () => {
    expect(sql).toContain('"provider_media_comments_delete"')
    expect(sql).toContain('auth.uid() = user_id')
    expect(sql).toContain('p.profile_id = auth.uid()')
  })

  it('does NOT define an UPDATE policy (append-only thread)', () => {
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]*FOR UPDATE/)
  })
})

describe('20260504000005_provider_media_comments — Realtime', () => {
  it('adds the table to supabase_realtime, idempotent guard', () => {
    expect(sql).toContain(
      'ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_media_comments',
    )
    expect(sql).toMatch(/IF NOT EXISTS\s*\([\s\S]*pg_publication_tables/)
  })
})
