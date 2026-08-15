import { supabase } from '../supabase'

export type ProviderHighlight = {
  id: string
  providerUserId: string
  title: string
  position: number
  coverPortfolioItemId: string | null
  coverPublicUrl: string | null
  createdAt: string
  updatedAt: string
  items: HighlightItem[]
}

export type HighlightItem = {
  id: string
  highlightId: string
  portfolioItemId: string
  position: number
  publicUrl: string | null
  mediaType: 'image' | 'video' | null
}

type RawHighlight = {
  id: string
  provider_user_id: string
  title: string
  position: number
  cover_portfolio_item_id: string | null
  created_at: string
  updated_at: string
  cover: { public_url: string | null } | { public_url: string | null }[] | null
  provider_highlight_items: Array<{
    id: string
    highlight_id: string
    portfolio_item_id: string
    position: number
    provider_media: {
      public_url: string | null
      media_type: string | null
    } | null
  }>
}

export async function fetchHighlightsForProvider(
  providerUserId: string,
): Promise<ProviderHighlight[]> {
  const { data, error } = await supabase
    .from('provider_highlights')
    .select(`
      id,
      provider_user_id,
      title,
      position,
      cover_portfolio_item_id,
      created_at,
      updated_at,
      cover:provider_media!cover_portfolio_item_id (public_url),
      provider_highlight_items (
        id,
        highlight_id,
        portfolio_item_id,
        position,
        provider_media (
          public_url,
          media_type
        )
      )
    `)
    .eq('provider_user_id', providerUserId)
    .order('position', { ascending: true })

  if (error) throw error
  if (!data) return []

  return (data as unknown as RawHighlight[]).map(mapHighlight)
}

export async function createHighlight(
  providerUserId: string,
  title: string,
  position: number,
): Promise<string> {
  const { data, error } = await supabase
    .from('provider_highlights')
    .insert({ provider_user_id: providerUserId, title: title.trim(), position })
    .select('id')
    .single()

  if (error) throw error
  if (!data) throw new Error('Highlight-Erstellung hat keine ID zurückgegeben')
  return data.id
}

export async function updateHighlight(
  id: string,
  patch: {
    title?: string
    position?: number
    coverPortfolioItemId?: string | null
  },
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.title !== undefined) row.title = patch.title.trim()
  if (patch.position !== undefined) row.position = patch.position
  if ('coverPortfolioItemId' in patch) row.cover_portfolio_item_id = patch.coverPortfolioItemId

  const { error } = await supabase.from('provider_highlights').update(row).eq('id', id)
  if (error) throw error
}

export async function deleteHighlight(id: string): Promise<void> {
  const { error } = await supabase.from('provider_highlights').delete().eq('id', id)
  if (error) throw error
}

/**
 * Replaces all items for a highlight:
 * delete existing → insert new ordered list.
 * Max 10 items enforced client-side.
 */
export async function replaceHighlightItems(
  highlightId: string,
  portfolioItemIds: string[],
): Promise<void> {
  const ids = portfolioItemIds.slice(0, 10)

  const { error: delErr } = await supabase
    .from('provider_highlight_items')
    .delete()
    .eq('highlight_id', highlightId)
  if (delErr) throw delErr

  if (ids.length === 0) return

  const rows = ids.map((portfolioItemId, position) => ({
    highlight_id: highlightId,
    portfolio_item_id: portfolioItemId,
    position,
  }))

  const { error: insErr } = await supabase.from('provider_highlight_items').insert(rows)
  if (insErr) throw insErr
}

function mapHighlight(raw: RawHighlight): ProviderHighlight {
  const items = (raw.provider_highlight_items ?? [])
    .sort((a, b) => a.position - b.position)
    .map(
      (it): HighlightItem => ({
        id: it.id,
        highlightId: it.highlight_id,
        portfolioItemId: it.portfolio_item_id,
        position: it.position,
        publicUrl: it.provider_media?.public_url ?? null,
        mediaType: (it.provider_media?.media_type ?? null) as HighlightItem['mediaType'],
      }),
    )

  const coverRaw = raw.cover
  const coverPublicUrl = Array.isArray(coverRaw)
    ? (coverRaw[0]?.public_url ?? null)
    : (coverRaw?.public_url ?? null)

  return {
    id: raw.id,
    providerUserId: raw.provider_user_id,
    title: raw.title,
    position: raw.position,
    coverPortfolioItemId: raw.cover_portfolio_item_id,
    coverPublicUrl,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    items,
  }
}
