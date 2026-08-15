/**
 * provider_media.h264_url migration — Block 0 schema contract
 *
 * The DDL is intentionally minimal: a NULL-able text column added
 * idempotently. We freeze the additive shape so a future migration
 * cannot drop the column or change its type without flagging the
 * change in this lockfile.
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
    'supabase/migrations/20260504000006_provider_media_h264_url.sql',
  ),
  'utf-8',
)

describe('20260504000006_provider_media_h264_url', () => {
  it('adds h264_url as a NULL-able text column, idempotent', () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.provider_media\s+ADD COLUMN IF NOT EXISTS h264_url text;/,
    )
  })

  it('does not add a NOT NULL constraint', () => {
    expect(sql).not.toMatch(/h264_url\s+text\s+NOT\s+NULL/i)
  })

  it('attaches a column comment that documents the source-of-truth', () => {
    expect(sql).toContain('COMMENT ON COLUMN public.provider_media.h264_url')
    expect(sql).toContain('Block 0')
  })

  it('does not touch RLS or policies (orthogonal concern)', () => {
    expect(sql).not.toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).not.toContain('CREATE POLICY')
  })
})
