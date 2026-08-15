import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabase'
import {
  COMMENT_BODY_MAX_LEN,
  deleteComment,
  editComment,
  fetchReplies,
  fetchReplyLikeSummary,
  fetchThreadSummary,
  fetchTopLevelComments,
  postComment,
  toggleCommentLike,
  type CommentSummary,
  type PortfolioComment,
} from './portfolioCommentService'

export type SortOrder = 'top' | 'new'

type State = {
  /** Top-Level-Kommentare, sortiert nach `sort`. */
  topLevel: PortfolioComment[]
  /** Replies pro Top-Level-Comment-id (lazy gefetcht via expandReplies). */
  repliesByParent: Map<string, PortfolioComment[]>
  /** Summary pro Comment-id (Top-Level UND Reply). */
  summaryById: Map<string, CommentSummary>
  /** Welche Top-Level expanded sind (Replies sichtbar). */
  expandedSet: Set<string>
  loading: boolean
  error: string | null
  sort: SortOrder
}

const INITIAL: State = {
  topLevel: [],
  repliesByParent: new Map(),
  summaryById: new Map(),
  expandedSet: new Set(),
  loading: false,
  error: null,
  sort: 'top',
}

export type UseCommentsResult = State & {
  /** Total visible comments (Top + alle bekannten Replies). */
  count: number
  /** Total Top-Level (= Sortier-Anker). */
  topLevelCount: number
  setSort: (sort: SortOrder) => void
  expandReplies: (parentId: string) => Promise<void>
  collapseReplies: (parentId: string) => void
  post: (body: string, parentCommentId?: string | null) => Promise<void>
  edit: (commentId: string, body: string) => Promise<void>
  remove: (commentId: string) => Promise<void>
  toggleLike: (commentId: string) => Promise<void>
}

/**
 * React hook for the threaded comment thread of a single portfolio item.
 *
 * Strategy:
 *  - Fetch + Realtime channel scoped to one mediaId.
 *  - Top-Level + Summary (replyCount, likeCount, likedByMe) in einem
 *    Pass via `comment_thread_summary`-RPC.
 *  - Replies werden lazy via `expandReplies(parentId)` geholt + per-
 *    Reply-Like-Summary mitgenommen.
 *  - Realtime: ein Channel auf `provider_media_comments` filtert per
 *    `media_id=eq.<X>` (Insert/Update/Delete), ein zweiter auf
 *    `provider_media_comment_likes` ohne Filter (wir refetchen den
 *    Summary, also reicht ein "anything happened"-Trigger).
 *  - Optimistic-Path: post() prepend, toggleLike() ±1, edit/remove
 *    in-place. Realtime-Echo refresht authoritativ.
 *
 * Auth: post/edit/remove/toggleLike werfen NOT_AUTHENTICATED weiter
 * an den Aufrufer; der UI-Layer rendert eine Login-Hinweis.
 */
export function useComments(mediaId: string | null | undefined): UseCommentsResult {
  const [state, setState] = useState<State>(INITIAL)
  const generationRef = useRef(0)
  const currentMediaIdRef = useRef<string | null>(null)
  // Set bekannter Comment-IDs (Top-Level + ggf. expanded Replies) für
  // den client-seitigen Filter im comment-likes-Realtime-Channel —
  // ohne Filter würden wir bei JEDEM globalen comment-like-Event
  // refetchen (cross-reel Storm).
  const knownCommentIdsRef = useRef<Set<string>>(new Set())

  const refreshTopLevel = useCallback(async (mediaIdParam: string, generation: number) => {
    try {
      const [topLevel, summary] = await Promise.all([
        fetchTopLevelComments(mediaIdParam),
        fetchThreadSummary(mediaIdParam),
      ])
      if (generation !== generationRef.current) return
      // Sync bekannter Comment-IDs für den Realtime-Filter.
      const known = new Set<string>()
      for (const c of topLevel) known.add(c.id)
      for (const id of summary.keys()) known.add(id)
      knownCommentIdsRef.current = known
      setState((s) => ({
        ...s,
        topLevel,
        summaryById: mergeSummaries(s.summaryById, summary),
        loading: false,
        error: null,
      }))
    } catch {
      if (generation !== generationRef.current) return
      setState((s) => ({
        ...s,
        loading: false,
        error: 'Kommentare konnten nicht geladen werden.',
      }))
    }
  }, [])

  useEffect(() => {
    currentMediaIdRef.current = mediaId ?? null
    if (!mediaId) {
      setState(INITIAL)
      return
    }

    const generation = ++generationRef.current
    let cancelled = false
    let commentsChannel: ReturnType<typeof supabase.channel> | null = null
    let likesChannel: ReturnType<typeof supabase.channel> | null = null

    setState((s) => ({ ...s, loading: true, error: null }))

    void refreshTopLevel(mediaId, generation)

    commentsChannel = supabase
      .channel(`portfolio-comments-${mediaId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'provider_media_comments',
          filter: `media_id=eq.${mediaId}`,
        },
        () => {
          if (cancelled || generation !== generationRef.current) return
          // For ANY mutation we re-fetch the top-level + summary; that
          // covers inserts (new top-level OR new reply → reply_count++),
          // edits (body changed), and deletes (cascades replies).
          void refreshTopLevel(mediaId, generation)
        },
      )
      .subscribe()

    likesChannel = supabase
      .channel(`comment-likes-${mediaId}`)
      .on(
        'postgres_changes',
        {
          // Likes haben keinen direkten media_id-Filter (FK auf
          // comment_id). Realtime postgres_changes filter unterstützt
          // kein IN(...). Wir hören broad und filtern client-seitig
          // gegen `knownCommentIdsRef` — verhindert Refetch-Storm
          // bei Likes auf Comments fremder Reels.
          event: '*',
          schema: 'public',
          table: 'provider_media_comment_likes',
        },
        (payload: { new?: { comment_id?: string }; old?: { comment_id?: string } }) => {
          if (cancelled || generation !== generationRef.current) return
          const cid = payload.new?.comment_id ?? payload.old?.comment_id
          if (!cid) return
          if (!knownCommentIdsRef.current.has(cid)) return
          void refreshTopLevel(mediaId, generation)
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      if (commentsChannel) void supabase.removeChannel(commentsChannel)
      if (likesChannel) void supabase.removeChannel(likesChannel)
    }
  }, [mediaId, refreshTopLevel])

  const setSort = useCallback((sort: SortOrder) => {
    setState((s) => ({ ...s, sort }))
  }, [])

  const sortedTopLevel = useMemo(() => {
    if (state.sort === 'new') {
      return [...state.topLevel].sort((a, b) => b.createdAt - a.createdAt)
    }
    // 'top' = nach likeCount DESC, tie-breaker createdAt DESC
    return [...state.topLevel].sort((a, b) => {
      const la = state.summaryById.get(a.id)?.likeCount ?? 0
      const lb = state.summaryById.get(b.id)?.likeCount ?? 0
      if (la !== lb) return lb - la
      return b.createdAt - a.createdAt
    })
  }, [state.topLevel, state.sort, state.summaryById])

  const expandReplies = useCallback(async (parentId: string) => {
    const id = currentMediaIdRef.current
    if (!id) return
    try {
      const [replies, replySummary] = await Promise.all([
        fetchReplies(parentId),
        fetchReplyLikeSummary(parentId),
      ])
      // Replies zur Known-Set hinzufügen, damit comment-likes-Channel
      // auch Like-Events auf Replies durchlässt.
      for (const r of replies) knownCommentIdsRef.current.add(r.id)
      for (const id of replySummary.keys()) knownCommentIdsRef.current.add(id)
      setState((s) => {
        const nextReplies = new Map(s.repliesByParent)
        nextReplies.set(parentId, replies)
        const nextExpanded = new Set(s.expandedSet)
        nextExpanded.add(parentId)
        return {
          ...s,
          repliesByParent: nextReplies,
          summaryById: mergeSummaries(s.summaryById, replySummary),
          expandedSet: nextExpanded,
        }
      })
    } catch {
      setState((s) => ({ ...s, error: 'Antworten konnten nicht geladen werden.' }))
    }
  }, [])

  const collapseReplies = useCallback((parentId: string) => {
    setState((s) => {
      const next = new Set(s.expandedSet)
      next.delete(parentId)
      return { ...s, expandedSet: next }
    })
  }, [])

  const post = useCallback(
    async (body: string, parentCommentId: string | null = null) => {
      const id = currentMediaIdRef.current
      if (!id) return
      try {
        const inserted = await postComment({
          mediaId: id,
          body,
          parentCommentId,
        })
        if (currentMediaIdRef.current !== id) return
        knownCommentIdsRef.current.add(inserted.id)
        setState((s) => {
          if (parentCommentId === null) {
            // Top-Level prepend (de-dupe gegen Realtime-Echo).
            if (s.topLevel.some((c) => c.id === inserted.id)) return s
            return {
              ...s,
              topLevel: [inserted, ...s.topLevel],
              summaryById: ensureSummary(s.summaryById, inserted.id),
            }
          }
          // Reply: in repliesByParent[parent] anhängen + replyCount ++
          const existing = s.repliesByParent.get(parentCommentId) ?? []
          if (existing.some((c) => c.id === inserted.id)) return s
          const nextReplies = new Map(s.repliesByParent)
          nextReplies.set(parentCommentId, [...existing, inserted])
          const nextExpanded = new Set(s.expandedSet)
          nextExpanded.add(parentCommentId)
          const summaryParent = s.summaryById.get(parentCommentId) ?? {
            replyCount: 0,
            likeCount: 0,
            likedByMe: false,
          }
          const nextSummary = new Map(s.summaryById)
          nextSummary.set(parentCommentId, {
            ...summaryParent,
            replyCount: summaryParent.replyCount + 1,
          })
          nextSummary.set(inserted.id, { replyCount: 0, likeCount: 0, likedByMe: false })
          return {
            ...s,
            repliesByParent: nextReplies,
            expandedSet: nextExpanded,
            summaryById: nextSummary,
          }
        })
      } catch (err) {
        const message = formatPostError(err)
        setState((s) => ({ ...s, error: message }))
        throw err
      }
    },
    [],
  )

  const edit = useCallback(async (commentId: string, body: string) => {
    try {
      const updated = await editComment(commentId, body)
      setState((s) => {
        const nextTop = s.topLevel.map((c) => (c.id === commentId ? updated : c))
        const nextReplies = new Map(s.repliesByParent)
        for (const [parentId, replies] of nextReplies) {
          if (replies.some((r) => r.id === commentId)) {
            nextReplies.set(
              parentId,
              replies.map((r) => (r.id === commentId ? updated : r)),
            )
          }
        }
        return { ...s, topLevel: nextTop, repliesByParent: nextReplies }
      })
    } catch (err) {
      const message = formatPostError(err)
      setState((s) => ({ ...s, error: message }))
      throw err
    }
  }, [])

  const remove = useCallback(async (commentId: string) => {
    let snapshot: { topLevel: PortfolioComment[]; replies: Map<string, PortfolioComment[]> } | null = null
    setState((s) => {
      snapshot = { topLevel: s.topLevel, replies: new Map(s.repliesByParent) }
      const nextTop = s.topLevel.filter((c) => c.id !== commentId)
      const nextReplies = new Map<string, PortfolioComment[]>()
      const nextSummary = new Map(s.summaryById)
      for (const [parentId, replies] of s.repliesByParent) {
        const filtered = replies.filter((r) => r.id !== commentId)
        if (filtered.length !== replies.length) {
          // Reply gelöscht → Parent-replyCount --
          const parentSummary = nextSummary.get(parentId)
          if (parentSummary) {
            nextSummary.set(parentId, {
              ...parentSummary,
              replyCount: Math.max(0, parentSummary.replyCount - 1),
            })
          }
        }
        nextReplies.set(parentId, filtered)
      }
      nextSummary.delete(commentId)
      return {
        ...s,
        topLevel: nextTop,
        repliesByParent: nextReplies,
        summaryById: nextSummary,
        error: null,
      }
    })
    try {
      await deleteComment(commentId)
    } catch {
      if (!snapshot) return
      setState((s) => ({
        ...s,
        topLevel: snapshot!.topLevel,
        repliesByParent: snapshot!.replies,
        error: 'Kommentar konnte nicht gelöscht werden.',
      }))
    }
  }, [])

  const toggleLike = useCallback(async (commentId: string) => {
    let snapshotSummary: CommentSummary | null = null
    setState((s) => {
      const current = s.summaryById.get(commentId) ?? {
        replyCount: 0,
        likeCount: 0,
        likedByMe: false,
      }
      snapshotSummary = current
      const nextLiked = !current.likedByMe
      const next = new Map(s.summaryById)
      next.set(commentId, {
        ...current,
        likedByMe: nextLiked,
        likeCount: nextLiked ? current.likeCount + 1 : Math.max(0, current.likeCount - 1),
      })
      return { ...s, summaryById: next, error: null }
    })
    try {
      const status = await toggleCommentLike(commentId)
      setState((s) => {
        const current = s.summaryById.get(commentId) ?? {
          replyCount: 0,
          likeCount: 0,
          likedByMe: false,
        }
        const next = new Map(s.summaryById)
        next.set(commentId, {
          ...current,
          likeCount: status.likeCount,
          likedByMe: status.likedByMe,
        })
        return { ...s, summaryById: next }
      })
    } catch (err) {
      if (!snapshotSummary) throw err
      setState((s) => {
        const next = new Map(s.summaryById)
        next.set(commentId, snapshotSummary!)
        const message =
          err instanceof Error && err.message === 'NOT_AUTHENTICATED'
            ? 'Bitte logge dich ein, um zu liken.'
            : 'Like konnte nicht gespeichert werden.'
        return { ...s, summaryById: next, error: message }
      })
    }
  }, [])

  const visibleReplies = useMemo(() => {
    let n = 0
    for (const replies of state.repliesByParent.values()) n += replies.length
    return n
  }, [state.repliesByParent])

  return {
    ...state,
    topLevel: sortedTopLevel,
    count: state.topLevel.length + visibleReplies,
    topLevelCount: state.topLevel.length,
    setSort,
    expandReplies,
    collapseReplies,
    post,
    edit,
    remove,
    toggleLike,
  }
}

function mergeSummaries(
  prev: Map<string, CommentSummary>,
  add: Map<string, CommentSummary>,
): Map<string, CommentSummary> {
  const next = new Map(prev)
  for (const [id, s] of add) next.set(id, s)
  return next
}

function ensureSummary(
  prev: Map<string, CommentSummary>,
  id: string,
): Map<string, CommentSummary> {
  if (prev.has(id)) return prev
  const next = new Map(prev)
  next.set(id, { replyCount: 0, likeCount: 0, likedByMe: false })
  return next
}

function formatPostError(err: unknown): string {
  if (!(err instanceof Error)) return 'Kommentar konnte nicht gespeichert werden.'
  if (err.message === 'NOT_AUTHENTICATED') return 'Bitte logge dich ein, um zu kommentieren.'
  if (err.message === 'COMMENT_EMPTY') return 'Kommentar darf nicht leer sein.'
  if (err.message === 'COMMENT_TOO_LONG') {
    return `Kommentar darf höchstens ${COMMENT_BODY_MAX_LEN} Zeichen lang sein.`
  }
  if (err.message === 'COMMENT_NESTING_TOO_DEEP') {
    return 'Antworten auf Antworten sind nicht möglich.'
  }
  return 'Kommentar konnte nicht gespeichert werden.'
}
