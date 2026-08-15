/**
 * Portfolio Save (Bookmark) Service
 *
 * Manages saves (bookmarks) on published provider_media items
 * (kind='portfolio'). Saves are stored in
 * `provider_media_saves(media_id, user_id, folder_id)` with a UNIQUE
 * constraint on (media_id, user_id) — one save per user per item.
 * Counter is computed live via count(*).
 *
 * `folder_id` (nullable) groups saves into user-defined folders. NULL
 * represents the virtual default folder ("Alle gespeicherten").
 *
 * Rules:
 *  - Only authenticated users can save.
 *  - Only published portfolio items should be saved (enforced by callers).
 *  - Second tap on bookmark removes the save (toggle semantics).
 *  - Long-press routes through `setSaveFolder` to assign or move folder.
 *  - fetchSaveStatus is safe to call when unauthenticated
 *    (isSavedByCurrentUser = false, folderId = null).
 */

import { supabase } from '../supabase'
import { logError } from '../observability'

export type SaveStatus = {
  saveCount: number
  isSavedByCurrentUser: boolean
  /** null = default-folder OR not saved. Caller distinguishes via isSavedByCurrentUser. */
  folderId: string | null
}

/**
 * Returns the current save count and whether the current user has saved
 * the given media item, plus the folder it sits in. Safe to call when
 * not authenticated.
 */
export async function fetchSaveStatus(mediaId: string): Promise<SaveStatus> {
  const [countResult, sessionResult] = await Promise.all([
    supabase
      .from('provider_media_saves')
      .select('id', { count: 'exact', head: true })
      .eq('media_id', mediaId),
    supabase.auth.getSession(),
  ])

  const saveCount = countResult.count ?? 0
  const userId = sessionResult.data.session?.user?.id

  if (!userId) {
    return { saveCount, isSavedByCurrentUser: false, folderId: null }
  }

  const { data: existing } = await supabase
    .from('provider_media_saves')
    .select('id, folder_id')
    .eq('media_id', mediaId)
    .eq('user_id', userId)
    .maybeSingle()

  return {
    saveCount,
    isSavedByCurrentUser: !!existing,
    folderId: (existing?.folder_id as string | null | undefined) ?? null,
  }
}

/**
 * Toggles the current user's save on a media item.
 *
 * Throws 'NOT_AUTHENTICATED' when called without an active session.
 * Throws on DB errors so callers can roll back optimistic UI.
 *
 * Optional `folderId` is applied on INSERT only (toggle-on into a
 * specific folder). When `null` (default), the save lands in the virtual
 * default folder. To move an existing save into a different folder use
 * `setSaveFolder` instead — toggling does NOT relocate.
 *
 * Returns the updated SaveStatus after the toggle.
 */
export async function toggleSave(
  mediaId: string,
  folderId: string | null = null,
): Promise<SaveStatus> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id

  if (!userId) {
    throw new Error('NOT_AUTHENTICATED')
  }

  const { data: existing, error: checkError } = await supabase
    .from('provider_media_saves')
    .select('id')
    .eq('media_id', mediaId)
    .eq('user_id', userId)
    .maybeSingle()

  if (checkError) {
    logError('portfolio_save.check_failed', checkError, { mediaId, userId })
    throw checkError
  }

  if (existing) {
    const { error } = await supabase
      .from('provider_media_saves')
      .delete()
      .eq('media_id', mediaId)
      .eq('user_id', userId)

    if (error) {
      logError('portfolio_save.unsave_failed', error, { mediaId, userId })
      throw error
    }
  } else {
    const { error } = await supabase
      .from('provider_media_saves')
      .insert({ media_id: mediaId, user_id: userId, folder_id: folderId })

    if (error) {
      logError('portfolio_save.save_failed', error, { mediaId, userId, folderId })
      throw error
    }
  }

  return fetchSaveStatus(mediaId)
}

/**
 * Assigns / moves the current user's save on a media item to a specific
 * folder. INSERTs the save if it does not yet exist, UPDATEs the
 * folder_id if it does. `null` folderId = virtual default folder.
 *
 * Throws 'NOT_AUTHENTICATED' when called without an active session.
 * Returns the updated SaveStatus.
 */
export async function setSaveFolder(
  mediaId: string,
  folderId: string | null,
): Promise<SaveStatus> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id

  if (!userId) {
    throw new Error('NOT_AUTHENTICATED')
  }

  const { data: existing, error: checkError } = await supabase
    .from('provider_media_saves')
    .select('id')
    .eq('media_id', mediaId)
    .eq('user_id', userId)
    .maybeSingle()

  if (checkError) {
    logError('portfolio_save.check_failed', checkError, { mediaId, userId })
    throw checkError
  }

  if (existing) {
    const { error } = await supabase
      .from('provider_media_saves')
      .update({ folder_id: folderId })
      .eq('id', existing.id)

    if (error) {
      logError('portfolio_save.move_failed', error, { mediaId, userId, folderId })
      throw error
    }
  } else {
    const { error } = await supabase
      .from('provider_media_saves')
      .insert({ media_id: mediaId, user_id: userId, folder_id: folderId })

    if (error) {
      logError('portfolio_save.save_failed', error, { mediaId, userId, folderId })
      throw error
    }
  }

  return fetchSaveStatus(mediaId)
}

/**
 * Removes the current user's save unconditionally. No-op if the save
 * does not exist (DELETE returns 0 rows; we don't differentiate).
 */
export async function unsave(mediaId: string): Promise<SaveStatus> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id

  if (!userId) {
    throw new Error('NOT_AUTHENTICATED')
  }

  const { error } = await supabase
    .from('provider_media_saves')
    .delete()
    .eq('media_id', mediaId)
    .eq('user_id', userId)

  if (error) {
    logError('portfolio_save.unsave_failed', error, { mediaId, userId })
    throw error
  }

  return fetchSaveStatus(mediaId)
}
