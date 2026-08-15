import { supabase } from '../supabase'
import type { ProviderMediaItem, ProviderMediaRow } from './providerMediaTypes'

function rowToMediaItem(row: ProviderMediaRow): ProviderMediaItem {
  return {
    id: row.id,
    providerId: row.provider_id,
    kind: row.kind as ProviderMediaItem['kind'],
    storagePath: row.storage_path,
    publicUrl: row.public_url,
    caption: row.caption,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : 0,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  }
}

/**
 * Fetches all provider_media rows for a given provider (by providers.id).
 *
 * Returns an empty array on error so callers remain stable.
 */
export async function fetchProviderMedia(
  providerId: string
): Promise<ProviderMediaItem[]> {
  const { data, error } = await supabase
    .from('provider_media')
    .select('id, provider_id, kind, storage_path, public_url, caption, sort_order, created_at, updated_at')
    .eq('provider_id', providerId)
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('fetchProviderMedia error:', error)
    return []
  }

  return (data as unknown as ProviderMediaRow[] ?? []).map(rowToMediaItem)
}

/**
 * Fetches the first avatar media item for a provider (kind='avatar').
 *
 * Returns null when no avatar is found or on error.
 */
export async function fetchProviderAvatar(
  providerId: string
): Promise<ProviderMediaItem | null> {
  const { data, error } = await supabase
    .from('provider_media')
    .select('id, provider_id, kind, storage_path, public_url, caption, sort_order, created_at, updated_at')
    .eq('provider_id', providerId)
    .eq('kind', 'avatar')
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('fetchProviderAvatar error:', error)
    return null
  }

  if (!data) return null
  return rowToMediaItem(data as unknown as ProviderMediaRow)
}

/**
 * Fetches all portfolio media items for a provider (kind='portfolio'),
 * sorted by sort_order ascending.
 *
 * Returns an empty array on error or when no portfolio exists.
 */
export async function fetchProviderPortfolio(
  providerId: string
): Promise<ProviderMediaItem[]> {
  const { data, error } = await supabase
    .from('provider_media')
    .select('id, provider_id, kind, storage_path, public_url, caption, sort_order, created_at, updated_at')
    .eq('provider_id', providerId)
    .eq('kind', 'portfolio')
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('fetchProviderPortfolio error:', error)
    return []
  }

  return (data as unknown as ProviderMediaRow[] ?? []).map(rowToMediaItem)
}

/**
 * Batch-fetches the first avatar public_url for each of the given provider IDs
 * (providers.id values, NOT profile_ids).
 *
 * Returns a Map from providers.id → public_url string.
 * Providers with no avatar entry are absent from the map.
 *
 * Uses a single Supabase query, so it is safe to call for feeds with many
 * providers without triggering N+1 issues.
 */
export async function fetchProviderAvatarsBatch(
  providerIds: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>()

  if (providerIds.length === 0) return result

  const { data, error } = await supabase
    .from('provider_media')
    .select('provider_id, public_url, sort_order')
    .in('provider_id', providerIds)
    .eq('kind', 'avatar')
    .not('public_url', 'is', null)
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('fetchProviderAvatarsBatch error:', error)
    return result
  }

  // Keep only the first (lowest sort_order) avatar per provider
  for (const row of (data as Array<{ provider_id: string; public_url: string | null; sort_order: number | null }> ?? [])) {
    if (row.public_url && !result.has(row.provider_id)) {
      result.set(row.provider_id, row.public_url)
    }
  }

  return result
}
