/**
 * Saved-Reels Folder Service
 *
 * CRUD for `saved_reel_folders` (Block 1) plus the joined "list of saved
 * reels per folder" read path. RLS auto-scopes to auth.uid(); the client
 * never has to inject `user_id` filters explicitly.
 *
 * Default-folder semantics: `folder_id IS NULL` is the virtual default
 * folder ("Alle gespeicherten"). The DB has no row for it. The client
 * uses `null` to address it.
 */

import { supabase } from '../supabase'
import { logError } from '../observability'
import type { PortfolioItem, ProviderMediaRowV2 } from '../providerMedia/providerMediaTypes'

export type SavedFolder = {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type SavedFolderRow = {
  id: string
  user_id: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
}

export type SavedReelEntry = {
  /** UUID of the provider_media row */
  mediaId: string
  /** Folder the save sits in (null = default). */
  folderId: string | null
  /** Time the user saved this reel (ms epoch). */
  savedAt: number
  /** The portfolio item itself, mapped to the canonical UI type. */
  item: PortfolioItem
}

export class FolderNameTakenError extends Error {
  constructor() {
    super('FOLDER_NAME_TAKEN')
    this.name = 'FolderNameTakenError'
  }
}

export class FolderNameInvalidError extends Error {
  constructor() {
    super('FOLDER_NAME_INVALID')
    this.name = 'FolderNameInvalidError'
  }
}

const NAME_MIN = 1
const NAME_MAX = 60

function validateName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) {
    throw new FolderNameInvalidError()
  }
  return trimmed
}

function rowToFolder(row: SavedFolderRow): SavedFolder {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : 0,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  }
}

function isUniqueViolation(err: { code?: string } | null | undefined): boolean {
  return err?.code === '23505'
}

export async function listFolders(): Promise<SavedFolder[]> {
  const { data, error } = await supabase
    .from('saved_reel_folders')
    .select('id, user_id, name, sort_order, created_at, updated_at')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })

  if (error) {
    logError('saved_folders.list_failed', error)
    throw error
  }

  return (data ?? []).map((row) => rowToFolder(row as SavedFolderRow))
}

export async function createFolder(rawName: string): Promise<SavedFolder> {
  const name = validateName(rawName)
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id
  if (!userId) {
    throw new Error('NOT_AUTHENTICATED')
  }

  const { data, error } = await supabase
    .from('saved_reel_folders')
    .insert({ user_id: userId, name })
    .select('id, user_id, name, sort_order, created_at, updated_at')
    .single()

  if (error) {
    if (isUniqueViolation(error)) throw new FolderNameTakenError()
    logError('saved_folders.create_failed', error, { userId })
    throw error
  }

  return rowToFolder(data as SavedFolderRow)
}

export async function renameFolder(
  folderId: string,
  rawName: string,
): Promise<SavedFolder> {
  const name = validateName(rawName)
  const { data, error } = await supabase
    .from('saved_reel_folders')
    .update({ name })
    .eq('id', folderId)
    .select('id, user_id, name, sort_order, created_at, updated_at')
    .single()

  if (error) {
    if (isUniqueViolation(error)) throw new FolderNameTakenError()
    logError('saved_folders.rename_failed', error, { folderId })
    throw error
  }

  return rowToFolder(data as SavedFolderRow)
}

export async function deleteFolder(folderId: string): Promise<void> {
  const { error } = await supabase
    .from('saved_reel_folders')
    .delete()
    .eq('id', folderId)

  if (error) {
    logError('saved_folders.delete_failed', error, { folderId })
    throw error
  }
  // Saves with this folder_id flip to NULL via ON DELETE SET NULL → they
  // automatically reappear in the virtual default folder.
}

/**
 * Returns the count of saves per folder for the current user. Includes
 * an entry with `folder_id = null` for the virtual default folder.
 * Single round-trip via the `saved_reels_count_by_folder()` RPC.
 */
export async function countSavedByFolder(): Promise<Map<string | null, number>> {
  const { data, error } = await supabase.rpc('saved_reels_count_by_folder')

  if (error) {
    logError('saved_folders.count_failed', error)
    throw error
  }

  const out = new Map<string | null, number>()
  for (const row of (data ?? []) as Array<{ folder_id: string | null; save_count: number }>) {
    out.set(row.folder_id, Number(row.save_count) || 0)
  }
  return out
}

/**
 * Lists the saved reels in a specific folder (or the virtual default
 * folder when `folderId === null`). Joins `provider_media` so the
 * caller can render a tile-grid without N+1.
 *
 * Order: most recently saved first.
 */
export async function listSavedReels(folderId: string | null): Promise<SavedReelEntry[]> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id
  if (!userId) {
    return []
  }

  let q = supabase
    .from('provider_media_saves')
    .select(
      `
      media_id,
      folder_id,
      created_at,
      provider_media:media_id (
        id, provider_id, kind, storage_path, public_url, media_type, title, caption,
        description, trade_tags, sort_order, poster_url, h264_url, published,
        show_price, show_duration, source_job_id, project_title_snapshot,
        location_snapshot, duration_snapshot, amount_snapshot, trade_tags_snapshot,
        created_at, updated_at
      )
    `,
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  q = folderId === null ? q.is('folder_id', null) : q.eq('folder_id', folderId)

  const { data, error } = await q

  if (error) {
    logError('saved_reels.list_failed', error, { folderId })
    throw error
  }

  // Supabase-js types embedded FK joins as arrays even when the FK is
  // single-row. We coalesce to a single row for the common case where
  // provider_media.id == provider_media_saves.media_id.
  type EmbeddedRow = {
    media_id: string
    folder_id: string | null
    created_at: string | null
    provider_media: ProviderMediaRowV2 | ProviderMediaRowV2[] | null
  }

  const out: SavedReelEntry[] = []
  for (const row of (data ?? []) as unknown as EmbeddedRow[]) {
    const pm = Array.isArray(row.provider_media) ? row.provider_media[0] ?? null : row.provider_media
    if (!pm) continue
    // Skip un-published reels — saves persist but UI should hide them
    // until/unless the owner re-publishes.
    if (pm.published === false) continue
    out.push({
      mediaId: row.media_id,
      folderId: row.folder_id,
      savedAt: row.created_at ? new Date(row.created_at).getTime() : 0,
      item: {
        id: pm.id,
        providerId: pm.provider_id,
        kind: 'portfolio',
        storagePath: pm.storage_path,
        publicUrl: pm.public_url,
        mediaType: pm.media_type === 'video' ? 'video' : 'image',
        title: pm.title,
        caption: pm.caption,
        description: pm.description,
        tradeTags: pm.trade_tags ?? [],
        sortOrder: pm.sort_order ?? 0,
        posterUrl: pm.poster_url ?? null,
        h264Url: pm.h264_url ?? null,
        published: pm.published ?? true,
        showPrice: pm.show_price ?? false,
        showDuration: pm.show_duration ?? false,
        sourceJobId: pm.source_job_id,
        projectTitleSnapshot: pm.project_title_snapshot,
        locationSnapshot: pm.location_snapshot,
        durationSnapshot: pm.duration_snapshot,
        amountSnapshot: pm.amount_snapshot,
        tradeTagsSnapshot: pm.trade_tags_snapshot ?? [],
        assets: [],
        createdAt: pm.created_at ? new Date(pm.created_at).getTime() : 0,
        updatedAt: pm.updated_at ? new Date(pm.updated_at).getTime() : 0,
      },
    })
  }
  return out
}
