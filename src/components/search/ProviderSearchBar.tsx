/**
 * ProviderSearchBar – filter panel for provider search.
 *
 * Renders a text input, trade-category picker, minimum-rating selector, and
 * sort-order selector.  Calls `onSearch(params)` whenever any filter changes.
 *
 * Design follows the existing Explore surface: Tailwind utility classes,
 * white/translucent cards, slate colour palette.
 */

import { useState } from 'react'
import type { ProviderSearchParams, SortBy } from '../../lib/search/types'

// ---------------------------------------------------------------------------
// Static configuration
// ---------------------------------------------------------------------------

const TRADE_CATEGORIES = [
  'Sanitär',
  'Elektrik',
  'Fliesen',
  'Malerei',
  'Schreiner',
  'Dach',
  'Heizung',
  'Böden',
  'Garten',
  'Trockenbau',
  'Fenster & Türen',
  'Abbruch',
]

const RATING_OPTIONS: { label: string; value: number }[] = [
  { label: 'Alle', value: 0 },
  { label: '3+', value: 3 },
  { label: '4+', value: 4 },
  { label: '4,5+', value: 4.5 },
]

const SORT_OPTIONS: { label: string; value: SortBy }[] = [
  { label: 'Relevanz', value: 'relevance' },
  { label: 'Bewertung', value: 'rating' },
  { label: 'Neu', value: 'recency' },
]

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  /** Called whenever any filter value changes with the updated params. */
  onSearch: (params: ProviderSearchParams) => void
  /** Optional initial values; useful when restoring from URL state. */
  initialParams?: ProviderSearchParams
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProviderSearchBar({ onSearch, initialParams }: Props) {
  const [query, setQuery] = useState(initialParams?.query ?? '')
  const [tradeCategory, setTradeCategory] = useState(initialParams?.tradeCategory ?? '')
  const [minimumRating, setMinimumRating] = useState(initialParams?.minimumRating ?? 0)
  const [sortBy, setSortBy] = useState<SortBy>(initialParams?.sortBy ?? 'relevance')

  function emit(overrides: Partial<ProviderSearchParams>) {
    const params: ProviderSearchParams = {
      query: query || undefined,
      tradeCategory: tradeCategory || undefined,
      minimumRating: minimumRating > 0 ? minimumRating : undefined,
      sortBy,
      ...overrides,
    }
    onSearch(params)
  }

  function handleQueryChange(value: string) {
    setQuery(value)
    emit({ query: value || undefined })
  }

  function handleCategoryChange(value: string) {
    setTradeCategory(value)
    emit({ tradeCategory: value || undefined })
  }

  function handleRatingChange(value: number) {
    setMinimumRating(value)
    emit({ minimumRating: value > 0 ? value : undefined })
  }

  function handleSortChange(value: SortBy) {
    setSortBy(value)
    emit({ sortBy: value })
  }

  return (
    <div className="space-y-3">
      {/* Text search -------------------------------------------------------- */}
      <div className="flex items-center gap-2 rounded-full border border-white/50 bg-white/56 px-4 py-3 shadow-[0_12px_24px_-20px_rgba(2,6,23,0.22)] backdrop-blur-xl">
        <span className="text-[16px] text-slate-500">🔎</span>
        <input
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Handwerker, Gewerk oder Ort …"
          className="flex-1 bg-transparent text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
        />
        {query && (
          <button
            type="button"
            onClick={() => handleQueryChange('')}
            className="text-[14px] text-slate-400 hover:text-slate-700"
          >
            ✕
          </button>
        )}
      </div>

      {/* Filters row -------------------------------------------------------- */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {/* Trade category */}
        <div className="relative flex-shrink-0">
          <select
            value={tradeCategory}
            onChange={(e) => handleCategoryChange(e.target.value)}
            className={`appearance-none rounded-full border px-3 py-2 pr-7 text-[13px] font-medium outline-none transition ${
              tradeCategory
                ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                : 'border-slate-200 bg-white text-slate-600'
            } cursor-pointer shadow-[0_6px_16px_-10px_rgba(2,6,23,0.14)]`}
          >
            <option value="">Gewerk wählen</option>
            {TRADE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">
            ▾
          </span>
        </div>

        {/* Minimum rating pills */}
        {RATING_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => handleRatingChange(opt.value)}
            className={`flex-shrink-0 rounded-full border px-3 py-2 text-[13px] font-medium transition ${
              minimumRating === opt.value
                ? 'border-[#FACC15] bg-[#FACC15] text-slate-900 shadow-[0_6px_16px_-10px_rgba(250,204,21,0.60)]'
                : 'border-slate-200 bg-white text-slate-600'
            }`}
          >
            {opt.value > 0 && <span className="mr-1 text-amber-400">★</span>}
            {opt.label}
          </button>
        ))}

        {/* Sort selector */}
        <div className="relative flex-shrink-0">
          <select
            value={sortBy}
            onChange={(e) => handleSortChange(e.target.value as SortBy)}
            className="appearance-none rounded-full border border-slate-200 bg-white px-3 py-2 pr-7 text-[13px] font-medium text-slate-600 outline-none shadow-[0_6px_16px_-10px_rgba(2,6,23,0.14)] cursor-pointer"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">
            ▾
          </span>
        </div>
      </div>
    </div>
  )
}
