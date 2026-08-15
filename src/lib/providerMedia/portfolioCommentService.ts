/**
 * Portfolio Comment Service
 *
 * Reads + writes for comments on published `provider_media` items.
 * Schema (Block 2):
 *   provider_media_comments(id, media_id, user_id, body, created_at,
 *                            parent_comment_id?, edited_at?)
 *   provider_media_comment_likes(id, comment_id, user_id, created_at)
 * RLS:
 *   - SELECT public
 *   - INSERT auth.uid() = user_id
 *   - UPDATE auth.uid() = user_id (Author-only Edit)
 *   - DELETE auth.uid() = user_id OR provider-owner
 *
 * Threading-Tiefe: 1-Level (Top + Replies). Reply-on-Reply wird durch
 * den DB-Trigger `enforce_comment_depth` blockiert.
 *
 * Counts (Replies, Likes) liefert der `comment_thread_summary`-RPC im
 * Bulk pro Top-Level-Kommentar — kein N+1.
 */

import { supabase } from '../supabase'
import { logError } from '../observability'

export const COMMENT_BODY_MAX_LEN = 500

export type PortfolioComment = {
  id: string
  mediaId: string
  userId: string
  body: string
  createdAt: number
  /** null = Top-Level. Sonst id des Top-Level-Comments (1-Level only). */
  parentCommentId: string | null
  /** Gesetzt nach erster erfolgreicher Body-Edit. null = Original. */
  editedAt: number | null
  authorName: string | null
}

export type CommentSummary = {
  /** Anzahl Antworten (nur Top-Level haben replyCount > 0). */
  replyCount: number
  /** Anzahl Likes. */
  likeCount: number
  /** Hat der aktuelle User diesen Kommentar geliked? */
  likedByMe: boolean
}

type CommentRow = {
  id: string
  media_id: string
  user_id: string
  body: string
  created_at: string
  parent_comment_id: string | null
  edited_at: string | null
  author?: { display_name: string | null } | { display_name: string | null }[] | null
}

function rowToComment(row: CommentRow): PortfolioComment {
  const author = Array.isArray(row.author) ? row.author[0] ?? null : row.author ?? null
  const trimmed = author?.display_name?.trim()
  return {
    id: row.id,
    mediaId: row.media_id,
    userId: row.user_id,
    body: row.body,
    createdAt: new Date(row.created_at).getTime(),
    parentCommentId: row.parent_comment_id ?? null,
    editedAt: row.edited_at ? new Date(row.edited_at).getTime() : null,
    authorName: trimmed && trimmed.length > 0 ? trimmed : null,
  }
}

const SELECT_FIELDS =
  'id, media_id, user_id, body, created_at, parent_comment_id, edited_at, author:profiles(display_name)'

/**
 * Returns the Top-Level comments for a media item, newest first.
 * Replies sind separat über `fetchReplies` zu laden.
 */
export async function fetchTopLevelComments(
  mediaId: string,
  opts: { limit?: number } = {},
): Promise<PortfolioComment[]> {
  if (!mediaId) return []
  const limit = opts.limit ?? 100

  const { data, error } = await supabase
    .from('provider_media_comments')
    .select(SELECT_FIELDS)
    .eq('media_id', mediaId)
    .is('parent_comment_id', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    logError('portfolio_comment.fetch_top_failed', error, { mediaId })
    return []
  }

  return ((data ?? []) as unknown as CommentRow[]).map(rowToComment)
}

/**
 * Backwards-compat: fetched alle Top-Level-Comments. Block 2 hat das
 * Threading eingeführt — Replies kommen separat über `fetchReplies`.
 * Bestehender Aufrufer-Code (M2.3-Hook) ist auf `fetchTopLevelComments`
 * umgestellt; dieser Alias bleibt für Test-Surfaces erhalten.
 */
export async function fetchCommentsForMedia(
  mediaId: string,
  opts: { limit?: number } = {},
): Promise<PortfolioComment[]> {
  return fetchTopLevelComments(mediaId, opts)
}

/**
 * Lädt die Replies eines Top-Level-Comments, älteste zuerst (Insta/TikTok-
 * Convention für Reply-Threads).
 */
export async function fetchReplies(parentCommentId: string): Promise<PortfolioComment[]> {
  if (!parentCommentId) return []
  const { data, error } = await supabase
    .from('provider_media_comments')
    .select(SELECT_FIELDS)
    .eq('parent_comment_id', parentCommentId)
    .order('created_at', { ascending: true })

  if (error) {
    logError('portfolio_comment.fetch_replies_failed', error, { parentCommentId })
    return []
  }

  return ((data ?? []) as unknown as CommentRow[]).map(rowToComment)
}

/**
 * RPC: Summary pro Top-Level-Comment für ein Media-Item.
 * Single-Roundtrip statt N+1.
 */
export async function fetchThreadSummary(mediaId: string): Promise<Map<string, CommentSummary>> {
  const out = new Map<string, CommentSummary>()
  if (!mediaId) return out
  const { data, error } = await supabase.rpc('comment_thread_summary', { p_media_id: mediaId })
  if (error) {
    logError('portfolio_comment.summary_failed', error, { mediaId })
    return out
  }
  for (const row of (data ?? []) as Array<{
    comment_id: string
    reply_count: number
    like_count: number
    liked_by_me: boolean
  }>) {
    out.set(row.comment_id, {
      replyCount: Number(row.reply_count) || 0,
      likeCount: Number(row.like_count) || 0,
      likedByMe: !!row.liked_by_me,
    })
  }
  return out
}

/**
 * RPC: Like-Summary pro Reply für einen Top-Level-Parent.
 * (Replies haben keinen `replyCount` — 1-Level-Threading.)
 */
export async function fetchReplyLikeSummary(
  parentCommentId: string,
): Promise<Map<string, CommentSummary>> {
  const out = new Map<string, CommentSummary>()
  if (!parentCommentId) return out
  const { data, error } = await supabase.rpc('comment_reply_summary', {
    p_parent_id: parentCommentId,
  })
  if (error) {
    logError('portfolio_comment.reply_summary_failed', error, { parentCommentId })
    return out
  }
  for (const row of (data ?? []) as Array<{
    comment_id: string
    like_count: number
    liked_by_me: boolean
  }>) {
    out.set(row.comment_id, {
      replyCount: 0,
      likeCount: Number(row.like_count) || 0,
      likedByMe: !!row.liked_by_me,
    })
  }
  return out
}

export type PostCommentInput = {
  mediaId: string
  body: string
  /** null = Top-Level, sonst id des Parents (Reply). */
  parentCommentId?: string | null
}

export async function postComment(input: PostCommentInput): Promise<PortfolioComment> {
  const body = input.body.trim()
  if (body.length === 0) throw new Error('COMMENT_EMPTY')
  if (body.length > COMMENT_BODY_MAX_LEN) throw new Error('COMMENT_TOO_LONG')

  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id
  if (!userId) throw new Error('NOT_AUTHENTICATED')

  const { data, error } = await supabase
    .from('provider_media_comments')
    .insert({
      media_id: input.mediaId,
      user_id: userId,
      body,
      parent_comment_id: input.parentCommentId ?? null,
    })
    .select(SELECT_FIELDS)
    .single()

  if (error) {
    if (error.message === 'COMMENT_NESTING_TOO_DEEP') {
      throw new Error('COMMENT_NESTING_TOO_DEEP')
    }
    logError('portfolio_comment.post_failed', error, {
      mediaId: input.mediaId,
      parentCommentId: input.parentCommentId,
    })
    throw error
  }

  return rowToComment(data as unknown as CommentRow)
}

export async function editComment(commentId: string, rawBody: string): Promise<PortfolioComment> {
  const body = rawBody.trim()
  if (body.length === 0) throw new Error('COMMENT_EMPTY')
  if (body.length > COMMENT_BODY_MAX_LEN) throw new Error('COMMENT_TOO_LONG')

  const { data, error } = await supabase
    .from('provider_media_comments')
    .update({ body, edited_at: new Date().toISOString() })
    .eq('id', commentId)
    .select(SELECT_FIELDS)
    .single()

  if (error) {
    logError('portfolio_comment.edit_failed', error, { commentId })
    throw error
  }

  return rowToComment(data as unknown as CommentRow)
}

export async function deleteComment(commentId: string): Promise<void> {
  // RLS denies via "0 rows affected" silently (kein error). Ohne count-
  // Check würde das UI den optimistic-Remove permanent halten obwohl
  // die Row in der DB weiterlebt — Re-Fetch käme nicht, weil kein
  // Realtime-DELETE-Event feuert. count='exact' macht den Mismatch
  // sichtbar und wir throwen, damit der Hook rolled back.
  const { error, count } = await supabase
    .from('provider_media_comments')
    .delete({ count: 'exact' })
    .eq('id', commentId)

  if (error) {
    logError('portfolio_comment.delete_failed', error, { commentId })
    throw error
  }
  if ((count ?? 0) === 0) {
    logError('portfolio_comment.delete_no_rows', new Error('RLS_OR_NOT_FOUND'), { commentId })
    throw new Error('DELETE_NOT_ALLOWED')
  }
}

/**
 * Toggles a like on a comment. Throws NOT_AUTHENTICATED when anonymous.
 * Returns the post-toggle state (likeCount + likedByMe) — kein extra
 * round-trip nötig, weil die Mutation selbst nur INSERT/DELETE ist und
 * der Aufrufer das Counter-Delta mit ±1 anwenden kann; aber wir lesen
 * den count am Ende einmal authoritativ, damit wir bei Race-Conditions
 * stabil bleiben.
 */
export async function toggleCommentLike(
  commentId: string,
): Promise<{ likeCount: number; likedByMe: boolean }> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id
  if (!userId) throw new Error('NOT_AUTHENTICATED')

  const { data: existing, error: checkError } = await supabase
    .from('provider_media_comment_likes')
    .select('id')
    .eq('comment_id', commentId)
    .eq('user_id', userId)
    .maybeSingle()

  if (checkError) {
    logError('comment_like.check_failed', checkError, { commentId })
    throw checkError
  }

  if (existing) {
    const { error } = await supabase
      .from('provider_media_comment_likes')
      .delete()
      .eq('comment_id', commentId)
      .eq('user_id', userId)
    if (error) {
      logError('comment_like.unlike_failed', error, { commentId })
      throw error
    }
  } else {
    const { error } = await supabase
      .from('provider_media_comment_likes')
      .insert({ comment_id: commentId, user_id: userId })
    if (error) {
      logError('comment_like.like_failed', error, { commentId })
      throw error
    }
  }

  const { count } = await supabase
    .from('provider_media_comment_likes')
    .select('id', { count: 'exact', head: true })
    .eq('comment_id', commentId)

  return { likeCount: count ?? 0, likedByMe: !existing }
}
