/**
 * portfolioCommentService — Source-Contract
 *
 * The service is a thin SQL wrapper; running it would need a Supabase
 * test harness. We freeze the wire shape in source so future refactors
 * keep the contract stable: table name, column projection, ordering,
 * trim/length guards, and structured error codes the hook depends on.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const source = fs.readFileSync(
  path.resolve(repoRoot, 'src/lib/providerMedia/portfolioCommentService.ts'),
  'utf-8',
)

describe('portfolioCommentService: exports', () => {
  it('exports the body-length cap as a constant', () => {
    expect(source).toContain('export const COMMENT_BODY_MAX_LEN = 500')
  })

  it('exports the canonical comment type', () => {
    expect(source).toMatch(/export type PortfolioComment/)
  })

  it('exports fetch / post / edit / delete', () => {
    // Block 2: fetchCommentsForMedia bleibt als Backwards-Compat-Alias
    // erhalten. fetchTopLevelComments + fetchReplies + RPC-Summaries
    // sind die kanonische Surface.
    expect(source).toMatch(/export async function fetchCommentsForMedia/)
    expect(source).toMatch(/export async function fetchTopLevelComments/)
    expect(source).toMatch(/export async function fetchReplies/)
    expect(source).toMatch(/export async function fetchThreadSummary/)
    expect(source).toMatch(/export async function fetchReplyLikeSummary/)
    expect(source).toMatch(/export async function postComment/)
    expect(source).toMatch(/export async function editComment/)
    expect(source).toMatch(/export async function deleteComment/)
    expect(source).toMatch(/export async function toggleCommentLike/)
  })
})

describe('portfolioCommentService: SQL shape', () => {
  it('reads the right table', () => {
    expect(source).toContain("from('provider_media_comments')")
  })

  it('orders top-level comments newest-first (replies are loaded chronologically)', () => {
    expect(source).toMatch(/order\('created_at',\s*\{\s*ascending:\s*false\s*\}\)/)
    expect(source).toMatch(/order\('created_at',\s*\{\s*ascending:\s*true\s*\}\)/)
  })

  it('isolates top-level comments via parent_comment_id IS NULL filter (Block 2 threading)', () => {
    expect(source).toMatch(/\.is\('parent_comment_id',\s*null\)/)
  })

  it('selects the author display_name only (live profiles schema, no handle/avatar)', () => {
    expect(source).toContain('author:profiles(display_name)')
    // Defensive: do NOT request fields that do not exist in the live schema.
    expect(source).not.toContain('author:profiles(handle')
    // The `avatar_url` token MAY appear in the explanatory comment that
    // documents the schema-drift; what we forbid is requesting it from
    // PostgREST. The Supabase JS client embeds the columns inside the
    // `select(...)` call as a comma-joined list, so we look for that shape.
    expect(source).not.toMatch(/select\([^)]*avatar_url/s)
  })
})

describe('portfolioCommentService: write guards', () => {
  it('trims the body before insert (postComment uses an input-object signature)', () => {
    // Block 2: postComment({ mediaId, body, parentCommentId? }) → trim auf
    // input.body.
    expect(source).toMatch(/input\.body\.trim\(\)|body\.trim\(\)/)
  })

  it('rejects empty bodies with COMMENT_EMPTY', () => {
    expect(source).toContain("throw new Error('COMMENT_EMPTY')")
  })

  it('rejects oversize bodies with COMMENT_TOO_LONG and uses the constant', () => {
    expect(source).toContain("throw new Error('COMMENT_TOO_LONG')")
    expect(source).toContain('body.length > COMMENT_BODY_MAX_LEN')
  })

  it('throws NOT_AUTHENTICATED when no session', () => {
    expect(source).toContain("throw new Error('NOT_AUTHENTICATED')")
  })

  it('returns the inserted comment so callers can prepend optimistically', () => {
    expect(source).toMatch(/insert\(\{[\s\S]*\}\)\s*\.select\([\s\S]*\)\s*\.single\(\)/)
  })
})

describe('portfolioCommentService: delete', () => {
  it('does not re-check ownership in the service (RLS authoritative)', () => {
    // No `auth.uid` parsing or user-id comparison in deleteComment — the
    // policy is the gate. We just match-by-id and let RLS decide.
    // Slice bounded to the deleteComment function only (Block 2 introduced
    // additional functions like toggleCommentLike that DO compare user_id).
    const start = source.indexOf('export async function deleteComment')
    const after = source.indexOf('export async function ', start + 1)
    const fn = after === -1 ? source.slice(start) : source.slice(start, after)
    expect(fn).toContain(".eq('id', commentId)")
    expect(fn).not.toContain('auth.uid')
    expect(fn).not.toContain('user_id')
  })

  it('logs + rethrows so callers can surface inline errors', () => {
    expect(source).toContain('portfolio_comment.delete_failed')
    const start = source.indexOf('export async function deleteComment')
    const after = source.indexOf('export async function ', start + 1)
    const fn = after === -1 ? source.slice(start) : source.slice(start, after)
    expect(fn).toMatch(/throw error/)
  })
})

describe('portfolioCommentService: threading + likes (Block 2)', () => {
  it('reads comment-likes from provider_media_comment_likes', () => {
    expect(source).toContain("from('provider_media_comment_likes')")
  })

  it('uses the bulk thread-summary RPC (no N+1 per top-level comment)', () => {
    expect(source).toContain("supabase.rpc('comment_thread_summary'")
    expect(source).toContain("supabase.rpc('comment_reply_summary'")
  })

  it('blocks reply-on-reply via the COMMENT_NESTING_TOO_DEEP error code', () => {
    expect(source).toContain('COMMENT_NESTING_TOO_DEEP')
  })

  it('stamps edited_at on edit-paths', () => {
    expect(source).toMatch(/edited_at:\s*new Date\(\)\.toISOString\(\)/)
  })
})
