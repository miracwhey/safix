import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ExploreReel } from '../../lib/explore/exploreTypes'
import type { DiscoveryProvider } from '../../lib/discovery/discoveryTypes'
import { deriveDiscoveryReadiness } from '../../lib/discovery/discoverySelectors'
import type { ProviderSearchParams } from '../../lib/search/types'
import { rankProviders } from '../../lib/search/selectors'
import ProviderSearchBar from '../search/ProviderSearchBar'
import SearchEmptyState from '../search/SearchEmptyState'

type SearchTab = 'reels' | 'providers'

type Props = {
  query: string
  results: ExploreReel[]
  /** All discovery-visible providers; filtered client-side by rankProviders. */
  discoveryProviders?: DiscoveryProvider[]
  onQueryChange: (value: string) => void
  onClose: () => void
  onSelectReel: (reelId: string) => void
}

// ---------------------------------------------------------------------------
// Provider result card – compact list item
// ---------------------------------------------------------------------------

function ProviderResultCard({
  provider,
  onClick,
}: {
  provider: DiscoveryProvider
  onClick: () => void
}) {
  const initial = (provider.companyName ?? provider.displayName ?? '?')[0].toUpperCase()
  const readiness = deriveDiscoveryReadiness(provider)
  const showIncompleteBadge = !readiness.isReady

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[20px] bg-white px-4 py-3.5 text-left ring-1 ring-slate-200/70 shadow-[0_14px_28px_-24px_rgba(2,6,23,0.16)] transition active:scale-[0.98]"
    >
      {/* Avatar */}
      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-100">
        {provider.avatarUrl ? (
          <img
            src={provider.avatarUrl}
            alt={provider.companyName}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-[18px] font-bold text-slate-500">{initial}</span>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-semibold text-slate-900">
            {provider.companyName || provider.displayName || 'Handwerker'}
          </span>
          {provider.verified && (
            <span className="text-[13px] text-blue-500" title="Verifiziert">
              ✓
            </span>
          )}
        </div>

        {showIncompleteBadge && (
          <div className="mt-1 inline-flex items-center gap-1.5">
            <span className="rounded-full bg-amber-50 ring-1 ring-amber-200/60 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              Profil unvollständig
            </span>
            {readiness.missingFields[0] && (
              <span className="text-[11px] text-slate-400">
                {readiness.missingFields[0]}
              </span>
            )}
          </div>
        )}

        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {provider.city && (
            <span className="text-[12px] text-slate-500">📍 {provider.city}</span>
          )}
          {provider.rating !== null && provider.rating > 0 && (
            <span className="text-[12px] font-medium text-amber-500">
              ★ {provider.rating.toFixed(1)}
              {provider.ratingCount > 0 && (
                <span className="ml-0.5 font-normal text-slate-400">
                  ({provider.ratingCount})
                </span>
              )}
            </span>
          )}
        </div>

        {/* Trade category pills */}
        {provider.tradeCategories.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {provider.tradeCategories.slice(0, 3).map((cat) => (
              <span
                key={cat}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
              >
                {cat}
              </span>
            ))}
            {provider.tradeCategories.length > 3 && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-400">
                +{provider.tradeCategories.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      <span className="text-[16px] text-slate-300">›</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main overlay
// ---------------------------------------------------------------------------

export default function ExploreSearchOverlay({
  query,
  results,
  discoveryProviders = [],
  onQueryChange,
  onClose,
  onSelectReel,
}: Props) {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<SearchTab>('reels')
  const [providerParams, setProviderParams] = useState<ProviderSearchParams>({})

  // Apply rankProviders synchronously (pure selector – no async needed)
  const rankedProviders =
    activeTab === 'providers'
      ? rankProviders(discoveryProviders, { ...providerParams, query: query || undefined })
      : []

  const providerEmptyVariant =
    discoveryProviders.length === 0
      ? 'no_results'
      : providerParams.location
        ? 'no_area'
        : 'no_match'

  function handleProviderClick(provider: DiscoveryProvider) {
    navigate(`/explore/craftsman/${provider.profileId}`)
    onClose()
  }

  return (
    <div className="min-h-[100svh] bg-[#F4F6FB]">
      <div className="safe-top" />

      {/* ---- Sticky header ------------------------------------------------ */}
      <div className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/82 px-4 pb-4 pt-3 backdrop-blur-xl">
        <div className="mx-auto w-full max-w-[420px] space-y-3">
          {/* Back + title */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/50 bg-white/50 text-[18px] text-slate-800 shadow-[0_12px_24px_-20px_rgba(2,6,23,0.22)] backdrop-blur-xl"
            >
              ←
            </button>

            <div className="text-[17px] font-semibold text-slate-900">Suche</div>
          </div>

          {/* Tab switcher */}
          <div className="flex rounded-full border border-white/38 bg-white/14 p-1 shadow-[0_14px_28px_-24px_rgba(2,6,23,0.20)] backdrop-blur-2xl">
            <button
              type="button"
              onClick={() => setActiveTab('reels')}
              className={`flex-1 rounded-full py-2 text-[14px] font-semibold transition ${
                activeTab === 'reels'
                  ? 'bg-[#2563EB] text-white shadow-[0_10px_24px_-16px_rgba(37,99,235,0.85)]'
                  : 'bg-transparent text-slate-700'
              }`}
            >
              Reels
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('providers')}
              className={`flex-1 rounded-full py-2 text-[14px] font-semibold transition ${
                activeTab === 'providers'
                  ? 'bg-[#2563EB] text-white shadow-[0_10px_24px_-16px_rgba(37,99,235,0.85)]'
                  : 'bg-transparent text-slate-700'
              }`}
            >
              Handwerker
            </button>
          </div>

          {/* Search input (reels tab) or ProviderSearchBar (providers tab) */}
          {activeTab === 'reels' ? (
            <div className="flex items-center gap-2 rounded-full border border-white/50 bg-white/56 px-4 py-3 shadow-[0_12px_24px_-20px_rgba(2,6,23,0.22)] backdrop-blur-xl">
              <span className="text-[16px] text-slate-500">🔎</span>
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder="Gewerk, Projekt oder Handwerker suchen"
                className="flex-1 bg-transparent text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
              />
            </div>
          ) : (
            <ProviderSearchBar
              onSearch={(params) => {
                setProviderParams(params)
                if (params.query !== undefined) {
                  onQueryChange(params.query)
                }
              }}
              initialParams={providerParams}
            />
          )}
        </div>
      </div>

      {/* ---- Results body ------------------------------------------------- */}
      <div className="px-4 py-4">
        <div className="mx-auto w-full max-w-[420px]">
          {/* ---- Reels tab ---- */}
          {activeTab === 'reels' && (
            <>
              {!query.trim() ? (
                <div className="space-y-4">
                  <div className="rounded-[22px] bg-white px-4 py-4 text-[14px] text-slate-500 ring-1 ring-slate-200/70 shadow-[0_16px_32px_-26px_rgba(2,6,23,0.18)]">
                    Suche nach Begriffen wie{' '}
                    <span className="font-semibold text-slate-700">Bad</span>,{' '}
                    <span className="font-semibold text-slate-700">Fliesen</span>,{' '}
                    <span className="font-semibold text-slate-700">Elektriker</span> oder{' '}
                    <span className="font-semibold text-slate-700">Hannover</span>.
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {['Bad', 'Fliesen', 'Elektriker', 'Sanierung'].map((term) => (
                      <button
                        key={term}
                        type="button"
                        onClick={() => onQueryChange(term)}
                        className="rounded-[20px] bg-white px-4 py-4 text-left ring-1 ring-slate-200/70 shadow-[0_14px_28px_-24px_rgba(2,6,23,0.16)]"
                      >
                        <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                          Trend
                        </div>
                        <div className="mt-2 text-[18px] font-semibold text-slate-900">
                          {term}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : results.length === 0 ? (
                <div className="rounded-[22px] bg-white px-5 py-6 text-center ring-1 ring-slate-200/70 shadow-[0_16px_32px_-26px_rgba(2,6,23,0.18)]">
                  <div className="text-[32px]">🔍</div>
                  <p className="mt-2 text-[14px] font-semibold text-slate-700">
                    Kein Anbieter gefunden
                  </p>
                  <p className="mt-1 text-[13px] text-slate-400">
                    Versuche einen anderen Suchbegriff oder wechsle zur Handwerker-Suche.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {results.map((reel) => (
                    <button
                      key={reel.id}
                      type="button"
                      onClick={() => onSelectReel(reel.id)}
                      className="block w-full overflow-hidden rounded-[24px] bg-white text-left ring-1 ring-slate-200/70 shadow-[0_18px_34px_-24px_rgba(2,6,23,0.22)]"
                    >
                      <div className="relative aspect-[3/4] w-full">
                        <img
                          src={reel.thumbnailUrl}
                          alt={reel.title}
                          className="h-full w-full object-cover"
                        />

                        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(15,23,42,0.04)_0%,rgba(15,23,42,0.18)_50%,rgba(15,23,42,0.88)_100%)]" />

                        <div className="absolute inset-x-0 bottom-0 p-3">
                          <div className="line-clamp-2 text-[14px] font-semibold leading-tight text-white">
                            {reel.title}
                          </div>
                          <div className="mt-1 text-[12px] text-slate-200">
                            {reel.craftsmanName}
                          </div>
                          <div className="mt-1 text-[12px] text-slate-300">
                            {reel.costLabel} · {reel.durationLabel}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ---- Providers tab ---- */}
          {activeTab === 'providers' && (
            <>
              {rankedProviders.length === 0 ? (
                <SearchEmptyState
                  variant={providerEmptyVariant}
                  location={providerParams.location}
                />
              ) : (
                <div className="space-y-2">
                  {/* Result count */}
                  <div className="px-1 text-[12px] font-medium text-slate-400">
                    {rankedProviders.length === 1
                      ? '1 Handwerker gefunden'
                      : `${rankedProviders.length} Handwerker gefunden`}
                  </div>

                  {rankedProviders.map((provider) => (
                    <ProviderResultCard
                      key={provider.id}
                      provider={provider}
                      onClick={() => handleProviderClick(provider)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
