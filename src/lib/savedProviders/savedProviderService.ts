import { supabase } from '../supabase'
import { logError } from '../observability'

export type SavedProviderEntry = {
  providerId: string
  savedAt: number
}

export type SavedProviderDetail = SavedProviderEntry & {
  name: string
  avatarUrl: string | null
  tradeCategories: string[]
  city: string | null
  handle: string | null
}

/** Toggle: inserts if not saved, deletes if already saved. Returns new saved state. */
export async function toggleSavedProvider(providerId: string): Promise<boolean> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id
  if (!userId) throw new Error('NOT_AUTHENTICATED')

  const { data: existing } = await supabase
    .from('provider_saves')
    .select('id')
    .eq('provider_id', providerId)
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    await unsaveProvider(providerId, userId)
    return false
  }

  const { error } = await supabase
    .from('provider_saves')
    .insert({ provider_id: providerId, user_id: userId })
  if (error) {
    logError('provider_saves.insert_failed', error, { providerId })
    throw error
  }
  return true
}

/**
 * Always deletes — never inserts. Safe to call from a "remove" UI action
 * where the intent is unambiguously to unsave, not toggle.
 * No-ops silently when the row doesn't exist (idempotent).
 */
export async function unsaveProvider(providerId: string, userId?: string): Promise<void> {
  let uid = userId
  if (!uid) {
    const { data: sessionData } = await supabase.auth.getSession()
    uid = sessionData.session?.user?.id
    if (!uid) throw new Error('NOT_AUTHENTICATED')
  }
  const { error } = await supabase
    .from('provider_saves')
    .delete()
    .eq('provider_id', providerId)
    .eq('user_id', uid)
  if (error) {
    logError('provider_saves.delete_failed', error, { providerId })
    throw error
  }
}

/** Returns true when the current user has saved this provider. */
export async function isSavedProvider(providerId: string): Promise<boolean> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id
  if (!userId) return false

  const { data } = await supabase
    .from('provider_saves')
    .select('id')
    .eq('provider_id', providerId)
    .eq('user_id', userId)
    .maybeSingle()

  return Boolean(data)
}

/** Returns all providers saved by the current user, newest first. */
export async function listSavedProviders(): Promise<SavedProviderEntry[]> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id
  if (!userId) return []

  const { data, error } = await supabase
    .from('provider_saves')
    .select('provider_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    logError('provider_saves.list_failed', error)
    throw error
  }

  return (data ?? []).map((row) => ({
    providerId: (row as { provider_id: string; created_at: string }).provider_id,
    savedAt: new Date((row as { created_at: string }).created_at).getTime(),
  }))
}

/**
 * Returns saved providers enriched with display data from
 * `visible_discovery_providers`. Two queries, no N+1.
 * Providers that are no longer discovery-visible are silently dropped.
 */
export async function listSavedProvidersWithDetails(): Promise<SavedProviderDetail[]> {
  const entries = await listSavedProviders()
  if (entries.length === 0) return []

  const providerIds = entries.map((e) => e.providerId)

  const { data, error } = await supabase
    .from('visible_discovery_providers')
    .select('profile_id, company_name, display_name, avatar_url, trade_categories, city, handle')
    .in('profile_id', providerIds)

  if (error) {
    logError('provider_saves.enrich_failed', error)
    return entries.map((e) => ({
      ...e,
      name: e.providerId,
      avatarUrl: null,
      tradeCategories: [],
      city: null,
      handle: null,
    }))
  }

  type Row = {
    profile_id: string
    company_name: string | null
    display_name: string | null
    avatar_url: string | null
    trade_categories: string[] | null
    city: string | null
    handle: string | null
  }

  const byId = new Map<string, Row>()
  for (const row of (data ?? []) as Row[]) {
    byId.set(row.profile_id, row)
  }

  return entries
    .map((e) => {
      const row = byId.get(e.providerId)
      if (!row) return null
      return {
        ...e,
        name: row.company_name || row.display_name || 'Handwerker',
        avatarUrl: row.avatar_url,
        tradeCategories: row.trade_categories ?? [],
        city: row.city,
        handle: row.handle,
      }
    })
    .filter((e): e is SavedProviderDetail => e !== null)
}

/** Total number of saves for a provider (public counter). */
export async function getProviderSaveCount(providerId: string): Promise<number> {
  const { count, error } = await supabase
    .from('provider_saves')
    .select('id', { count: 'exact', head: true })
    .eq('provider_id', providerId)

  if (error) {
    logError('provider_saves.count_failed', error, { providerId })
    return 0
  }
  return count ?? 0
}
