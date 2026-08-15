// @deprecated — remove from CustomerHomeScreen; not an operative element
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getExploreProviderCards } from '../lib/explore/exploreProfileService'
import type { ExploreProviderCard } from '../lib/explore/exploreTypes'

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(' ')
  const letters =
    parts.length >= 2
      ? `${parts[0][0]}${parts[parts.length - 1][0]}`
      : name.slice(0, 2)
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[13px] font-bold text-slate-600 uppercase">
      {letters}
    </div>
  )
}

export const TopCraftsmen = () => {
  const [cards, setCards] = useState<ExploreProviderCard[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getExploreProviderCards().then((all) => {
      if (cancelled) return
      const sorted = [...all]
        .sort((a, b) => (b.completedJobsCount ?? 0) - (a.completedJobsCount ?? 0))
        .slice(0, 3)
      setCards(sorted)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const hasData = cards.length > 0 && cards.some((c) => (c.completedJobsCount ?? 0) > 0)

  return (
    <div className="py-6 animate-fade-in">
      <div className="px-4 mb-4">
        <h2 className="text-xl font-bold text-gray-900">Top-Handwerker</h2>
        <p className="text-sm text-gray-600 mt-1">Bestbewertete Profis in deiner Nähe</p>
      </div>

      {loading ? (
        <div className="px-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded-2xl bg-slate-100 animate-pulse" />
          ))}
        </div>
      ) : hasData ? (
        <div className="px-4 space-y-3">
          {cards.map((card) => (
            <Link
              key={card.craftsmanId}
              to="/explore"
              className="flex items-center gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200/70 shadow-sm transition active:scale-[0.98]"
            >
              {card.craftsmanAvatarUrl ? (
                <img
                  src={card.craftsmanAvatarUrl}
                  alt={card.craftsmanName}
                  className="h-10 w-10 shrink-0 rounded-full object-cover"
                />
              ) : (
                <Initials name={card.craftsmanName} />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-slate-900">
                  {card.craftsmanName}
                </div>
                <div className="text-[12px] text-slate-500">{card.location}</div>
              </div>
              {(card.completedJobsCount ?? 0) > 0 && (
                <div className="shrink-0 text-right">
                  <div className="text-[13px] font-bold text-slate-800">
                    {card.completedJobsCount}
                  </div>
                  <div className="text-[11px] text-slate-400">Jobs</div>
                </div>
              )}
            </Link>
          ))}
        </div>
      ) : (
        <div className="px-4">
          <div className="rounded-2xl bg-slate-50 p-4 text-center ring-1 ring-slate-200/70">
            <p className="text-[14px] text-slate-500">Noch keine Handwerker gefunden.</p>
            <Link
              to="/explore"
              className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition active:scale-[0.97]"
            >
              Alle Handwerker entdecken →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
