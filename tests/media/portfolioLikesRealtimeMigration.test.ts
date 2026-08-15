/**
 * Realtime publication migration — provider_media_likes (M2.2)
 *
 * Locks the migration that adds the likes table to `supabase_realtime`,
 * which is required for the M2.2 lightbox subscription to actually receive
 * INSERT / DELETE events. Idempotent guard around a single ALTER PUBLICATION
 * statement so the migration is replay-safe.
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
    'supabase/migrations/20260504000004_portfolio_likes_realtime.sql',
  ),
  'utf-8',
)

describe('20260504000004_portfolio_likes_realtime', () => {
  it('adds provider_media_likes to supabase_realtime', () => {
    expect(sql).toContain(
      'ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_media_likes',
    )
  })

  it('guards the ALTER with pg_publication_tables membership lookup (idempotent)', () => {
    expect(sql).toContain('FROM pg_publication_tables')
    expect(sql).toContain("pubname = 'supabase_realtime'")
    expect(sql).toContain("tablename = 'provider_media_likes'")
    expect(sql).toMatch(/IF NOT EXISTS\s*\(/i)
  })

  it('runs inside a DO $$ … $$ block (server-side guard, not psql conditional)', () => {
    expect(sql).toMatch(/DO \$\$\s*\n/)
    expect(sql).toMatch(/END\$\$/)
  })

  it('does not attempt to enable RLS or create policies (orthogonal concern)', () => {
    expect(sql).not.toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).not.toContain('CREATE POLICY')
  })
})
