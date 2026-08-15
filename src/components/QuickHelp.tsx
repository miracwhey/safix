// @deprecated — remove from operative screens; belongs in Konto only
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getExploreProviderCards } from '../lib/explore/exploreProfileService'
import type { ExploreProviderCard } from '../lib/explore/exploreTypes'

export const QuickHelp = () => {
  const navigate = useNavigate()
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

  const hasData = cards.length > 0

  return (
    <div className="px-4 py-6 animate-fade-in">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-gray-900">Schnelle Hilfe</h2>
        <p className="text-sm text-gray-600 mt-1">Handwerker in deiner Nähe jetzt verfügbar</p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded-2xl bg-slate-100 animate-pulse" />
          ))}
        </div>
      ) : hasData ? (
        <div className="space-y-3">
          {cards.map((card) => (
            <div
              key={card.craftsmanId}
              className="rounded-2xl bg-white p-4 ring-1 ring-slate-200/70 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-slate-900">
                    {card.craftsmanName}
                  </div>
                  <div className="text-[12px] text-slate-500">{card.location}</div>
                  {card.tradeCategories.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {card.tradeCategories.slice(0, 2).map((cat) => (
                        <span
                          key={cat}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                        >
                          {cat}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {(card.completedJobsCount ?? 0) > 0 && (
                  <div className="shrink-0 text-right">
                    <div className="text-[13px] font-bold text-slate-800">
                      {card.completedJobsCount}
                    </div>
                    <div className="text-[11px] text-slate-400">Jobs</div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => navigate(`/explore/craftsman/${card.craftsmanId}`)}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white transition active:scale-[0.97]"
              >
                Jetzt anfragen
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl bg-slate-50 p-4 text-center ring-1 ring-slate-200/70">
          <p className="text-[14px] text-slate-500">
            Derzeit keine Handwerker in deiner Nähe verfügbar.
          </p>
          <Link
            to="/explore"
            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition active:scale-[0.97]"
          >
            Alle Handwerker entdecken →
          </Link>
        </div>
      )}
    </div>
  )
}
