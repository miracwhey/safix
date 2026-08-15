/**
 * Portfolio Like Service
 *
 * Manages likes on published provider_media items (kind='portfolio').
 * Likes are stored in provider_media_likes(media_id, user_id) with a
 * UNIQUE constraint — one like per user per item.
 *
 * Rules:
 *  - Only authenticated users can like.
 *  - Only published portfolio items should be liked (enforced by callers).
 *  - Second tap removes the like (toggle semantics).
 *  - fetchLikeStatus is safe to call for unauthenticated users (isLikedByCurrentUser = false).
 */

import { supabase } from '../supabase'
import { logError } from '../observability'

export type LikeStatus = {
  likeCount: number
  isLikedByCurrentUser: boolean
}

/**
 * Returns the current like count and whether the current user has liked
 * the given media item. Safe to call when not authenticated.
 */
export async function fetchLikeStatus(mediaId: string): Promise<LikeStatus> {
  const [countResult, sessionResult] = await Promise.all([
    supabase
      .from('provider_media_likes')
      .select('id', { count: 'exact', head: true })
      .eq('media_id', mediaId),
    supabase.auth.getSession(),
  ])

  const likeCount = countResult.count ?? 0
  const userId = sessionResult.data.session?.user?.id

  if (!userId) {
    return { likeCount, isLikedByCurrentUser: false }
  }

  const { data: existing } = await supabase
    .from('provider_media_likes')
    .select('id')
    .eq('media_id', mediaId)
    .eq('user_id', userId)
    .maybeSingle()

  return {
    likeCount,
    isLikedByCurrentUser: !!existing,
  }
}

/**
 * Toggles the current user's like on a media item.
 *
 * Throws 'NOT_AUTHENTICATED' when called without an active session.
 * Throws on DB errors so callers can roll back optimistic UI.
 *
 * Returns the updated LikeStatus after the toggle.
 */
export async function toggleLike(mediaId: string): Promise<LikeStatus> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id

  if (!userId) {
    throw new Error('NOT_AUTHENTICATED')
  }

  // Check whether the user already liked this item
  const { data: existing, error: checkError } = await supabase
    .from('provider_media_likes')
    .select('id')
    .eq('media_id', mediaId)
    .eq('user_id', userId)
    .maybeSingle()

  if (checkError) {
    logError('portfolio_like.check_failed', checkError, { mediaId, userId })
    throw checkError
  }

  if (existing) {
    // Unlike: remove the row
    const { error } = await supabase
      .from('provider_media_likes')
      .delete()
      .eq('media_id', mediaId)
      .eq('user_id', userId)

    if (error) {
      logError('portfolio_like.unlike_failed', error, { mediaId, userId })
      throw error
    }
  } else {
    // Like: insert a row
    const { error } = await supabase
      .from('provider_media_likes')
      .insert({ media_id: mediaId, user_id: userId })

    if (error) {
      logError('portfolio_like.like_failed', error, { mediaId, userId })
      throw error
    }
  }

  return fetchLikeStatus(mediaId)
}
