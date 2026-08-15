/**
 * Realtime replica-identity migration — review-fix follow-up.
 *
 * The M2.2 / M2.3 hooks subscribe to DELETE postgres_changes with a
 * server-side `filter: media_id=eq.<X>`. With the default replica
 * identity (PK-only), the OLD row payload on a DELETE doesn't include
 * `media_id`, so the filter cannot match and the event is dropped —
 * cross-client unlike + comment-delete UI never updates without a full
 * refetch. REPLICA IDENTITY FULL fixes this by emitting the full OLD
 * row in WAL.
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
    'supabase/migrations/20260504000007_portfolio_realtime_replica_identity.sql',
  ),
  'utf-8',
)

describe('20260504000007_portfolio_realtime_replica_identity', () => {
  it('sets REPLICA IDENTITY FULL on provider_media_likes', () => {
    expect(sql).toContain('ALTER TABLE public.provider_media_likes REPLICA IDENTITY FULL;')
  })

  it('sets REPLICA IDENTITY FULL on provider_media_comments', () => {
    expect(sql).toContain('ALTER TABLE public.provider_media_comments REPLICA IDENTITY FULL;')
  })

  it('explains the DELETE-filter rationale in the body', () => {
    expect(sql.toLowerCase()).toContain('replica identity')
    expect(sql.toLowerCase()).toContain('delete')
    expect(sql.toLowerCase()).toContain('media_id')
  })
})
