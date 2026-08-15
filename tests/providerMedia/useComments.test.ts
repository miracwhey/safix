/**
 * useComments — Source-Contract (Block 2: TikTok-Parity)
 *
 * Lockt die neue Hook-Struktur:
 *  - Top-Level + Replies (1-Level Threading) mit lazy expandReplies
 *  - Bulk-Summary über `comment_thread_summary` + `comment_reply_summary`
 *  - Realtime auf provider_media_comments + provider_media_comment_likes
 *    (`event: '*'` für beide → refetch-on-anything statt INSERT/DELETE
 *    getrennt, weil Edits + Reply-Counter sonst aus dem UI driften)
 *  - Sort: 'top' | 'new'
 *  - Edit / Toggle-Like / Reply-Composer-Path
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const source = fs.readFileSync(
  path.resolve(repoRoot, 'src/lib/providerMedia/useComments.ts'),
  'utf-8',
)

describe('useComments: hook shape', () => {
  it('exports the hook + result type + sort order', () => {
    expect(source).toMatch(/export function useComments\(/)
    expect(source).toMatch(/export type UseCommentsResult/)
    expect(source).toMatch(/export type SortOrder/)
  })

  it('reuses the service helpers (no parallel SQL path)', () => {
    expect(source).toContain('fetchTopLevelComments')
    expect(source).toContain('fetchReplies')
    expect(source).toContain('fetchThreadSummary')
    expect(source).toContain('fetchReplyLikeSummary')
    expect(source).toContain('postComment')
    expect(source).toContain('editComment')
    expect(source).toContain('deleteComment')
    expect(source).toContain('toggleCommentLike')
    expect(source).toContain("from './portfolioCommentService'")
  })

  it('returns a no-op shape when mediaId is null/undefined', () => {
    expect(source).toMatch(/if \(!mediaId\)/)
  })
})

describe('useComments: Realtime contract', () => {
  it('scopes the comments channel to the media id', () => {
    expect(source).toMatch(/\.channel\(`portfolio-comments-\$\{mediaId\}`\)/)
  })

  it('subscribes to ANY mutation on provider_media_comments scoped to the media id', () => {
    expect(source).toContain("event: '*'")
    expect(source).toContain("table: 'provider_media_comments'")
    expect(source).toMatch(/filter: `media_id=eq\.\$\{mediaId\}`/)
  })

  it('listens to comment-likes broadly (FK is comment_id, not media_id)', () => {
    expect(source).toMatch(/\.channel\(`comment-likes-\$\{mediaId\}`\)/)
    expect(source).toContain("table: 'provider_media_comment_likes'")
  })

  it('removes the channels on unmount / id change', () => {
    expect(source).toContain('supabase.removeChannel(commentsChannel)')
    expect(source).toContain('supabase.removeChannel(likesChannel)')
  })

  it('refetches on any mutation (top-level + summary in one pass)', () => {
    expect(source).toContain('refreshTopLevel(mediaId, generation)')
  })
})

describe('useComments: generation guarding + cancellation', () => {
  it('uses a generation counter to drop stale fetches', () => {
    expect(source).toContain('generationRef')
    expect(source).toMatch(/generation\s*!==\s*generationRef\.current/)
  })

  it('uses a cancelled flag for the in-flight refresh', () => {
    expect(source).toMatch(/let cancelled = false/)
    expect(source).toContain('cancelled = true')
  })

  it('tracks the current mediaId via ref so post/remove ignore stale results', () => {
    expect(source).toContain('currentMediaIdRef')
  })
})

describe('useComments: threading + sort', () => {
  it('exposes Top / Neueste via setSort', () => {
    expect(source).toMatch(/setSort:/)
    expect(source).toContain("sort: 'top'")
  })

  it('lazy-loads replies via expandReplies(parentId)', () => {
    expect(source).toContain('expandReplies')
    expect(source).toContain('collapseReplies')
  })

  it('passes parentCommentId to postComment so replies land in the thread', () => {
    expect(source).toMatch(/parentCommentId/)
  })
})

describe('useComments: write paths', () => {
  it('post() de-dupes the optimistic prepend against a Realtime echo', () => {
    expect(source).toMatch(/s\.topLevel\.some\(\(c\) => c\.id === inserted\.id\)/)
  })

  it('remove() snapshots the list and rolls back on failure', () => {
    expect(source).toContain("topLevel: snapshot!.topLevel")
    expect(source).toContain("repliesByParent: snapshot!.replies")
  })

  it('toggleLike() optimistically updates the per-comment summary', () => {
    expect(source).toContain('toggleLike')
    expect(source).toContain('likedByMe')
  })

  it('formats German error messages incl. auth + length + nesting cases', () => {
    expect(source).toContain('Bitte logge dich ein, um zu kommentieren.')
    expect(source).toContain('Kommentar darf nicht leer sein.')
    expect(source).toContain('Antworten auf Antworten sind nicht möglich.')
    expect(source).toContain('COMMENT_EMPTY')
    expect(source).toContain('COMMENT_TOO_LONG')
    expect(source).toContain('COMMENT_NESTING_TOO_DEEP')
  })
})
