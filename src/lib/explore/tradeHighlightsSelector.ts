/**
 * Trade Highlights Selector — Block 2 (Customer-Discovery Profile-Detail)
 *
 * Builds the Werkbereich-Bubbles row for the Insta-style profile header.
 *
 * MVP: distinct trade categories the provider has self-declared, paired with
 * the cover image of the first published portfolio item that lists this trade
 * in its `tradeTagsSnapshot` (preferred) or `tradeTags`. Trades without a
 * matching portfolio cover fall back to `coverPublicUrl: null` — the UI shows
 * an initial placeholder bubble instead.
 *
 * Pure function: no I/O, no Supabase calls. Run on already-loaded items.
 */

import type { PortfolioItem } from '../providerMedia'

export type TradeHighlight = {
  trade: string
  coverPublicUrl: string | null
}

export function deriveTradeHighlights(
  tradeCategories: string[],
  portfolioItems: PortfolioItem[]
): TradeHighlight[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const trade of tradeCategories) {
    const trimmed = trade.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    ordered.push(trimmed)
  }

  return ordered.map((trade) => ({
    trade,
    coverPublicUrl: pickCoverForTrade(trade, portfolioItems),
  }))
}

function pickCoverForTrade(
  trade: string,
  items: PortfolioItem[]
): string | null {
  const target = trade.toLowerCase()
  for (const item of items) {
    if (!item.publicUrl) continue
    const tags = [
      ...(item.tradeTagsSnapshot ?? []),
      ...(item.tradeTags ?? []),
    ].map((t) => t.toLowerCase())
    if (tags.includes(target)) return item.publicUrl
  }
  return null
}
