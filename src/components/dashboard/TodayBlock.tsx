import { Link } from 'react-router-dom'
import { Calendar } from 'lucide-react'
import type { TodayBlockSummary } from '../../lib/dashboard/todayBlockSelectors'

type Props = {
  summary: TodayBlockSummary
}

// Clear, non-contradictory empty-state copy (replaces ambiguous "Heute nichts geplant" variants)
const EMPTY_SUBTITLE = 'Heute sind keine Termine geplant.'

export default function TodayBlock({ summary }: Props) {
  if (!summary.visible) return null

  const today = new Date()
  const formattedDate = today.toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })

  return (
    <div className="rounded-3xl bg-white ring-1 ring-slate-200/70 shadow-subtle p-4">
      {/* ── Planner Header — always present, calendar identity + CTA ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-brand-50 text-brand shrink-0">
            <Calendar size={15} aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-[16px] font-semibold text-ink leading-tight">
              Heute
            </p>
            <p className="text-[13px] font-medium text-ink-muted leading-tight mt-0.5">
              {formattedDate}
            </p>
          </div>
        </div>
        <Link
          to={summary.ctaRoute}
          className="shrink-0 text-[15px] font-semibold text-blue-600 hover:text-blue-800 active:opacity-70 transition"
        >
          {summary.ctaRoute === '/craftsman/operations' ? 'Kalender öffnen →' : summary.ctaLabel}
        </Link>
      </div>

      {/* ── Header separator — always present ── */}
      <div className="border-t border-slate-100 mt-3 mb-3" />

      {/* ── Planner Body — bounded planner area, content varies by mode ── */}
      <div className="planner-body rounded-2xl bg-brand-50/20 p-3 min-h-[80px] max-h-[228px] overflow-y-auto">
        {summary.mode === 'today_has_items' && (
          <div className="flex flex-col gap-2">
            {summary.items.map((item) => (
              <Link
                key={item.id}
                to={`/craftsman/jobs/${item.jobId}`}
                className="flex items-start gap-3 rounded-xl bg-white p-3 min-h-[64px] ring-1 ring-slate-200/70 hover:ring-slate-200 hover:shadow-sm active:scale-[0.97] transition"
              >
                {/* Time rail */}
                <div className="w-[54px] shrink-0 pt-0.5">
                  {item.hasRealTime ? (
                    <span className="text-[14px] font-semibold tabular-nums text-brand">
                      {item.timeLabel}
                    </span>
                  ) : (
                    <span className="text-[11px] font-medium text-ink-muted">
                      Uhrzeit offen
                    </span>
                  )}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-ink leading-snug">
                    {item.title}
                  </p>
                  {(item.customerName || item.location) && (
                    <p className="truncate text-[13px] text-ink-muted mt-0.5">
                      {[item.customerName, item.location].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>

                {/* Status chip */}
                <span className="shrink-0 mt-0.5 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                  {item.statusLabel}
                </span>
              </Link>
            ))}
          </div>
        )}

        {summary.mode === 'today_empty_but_upcoming' && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-ink-muted">{EMPTY_SUBTITLE}</p>
            {summary.upcomingItem && (
              <div>
                <p className="text-[11px] font-semibold text-ink-sub uppercase tracking-wide mb-1.5">
                  {summary.upcomingHint}
                </p>
                <Link
                  to={`/craftsman/jobs/${summary.upcomingItem.jobId}`}
                  className="flex items-start gap-3 rounded-xl bg-white p-3 min-h-[64px] ring-1 ring-slate-200/70 hover:ring-slate-200 hover:shadow-sm active:scale-[0.97] transition"
                >
                  <div className="w-[54px] shrink-0 pt-0.5">
                    {summary.upcomingItem.hasRealTime ? (
                      <span className="text-[14px] font-semibold tabular-nums text-brand">
                        {summary.upcomingItem.timeLabel}
                      </span>
                    ) : (
                      <span className="text-[11px] font-medium text-ink-muted">
                        Uhrzeit offen
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-ink-sub leading-snug">
                      {summary.upcomingItem.title}
                    </p>
                    {(summary.upcomingItem.customerName || summary.upcomingItem.location) && (
                      <p className="truncate text-[13px] text-ink-muted mt-0.5">
                        {[summary.upcomingItem.customerName, summary.upcomingItem.location].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 mt-0.5 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                    {summary.upcomingItem.statusLabel}
                  </span>
                </Link>
              </div>
            )}
          </div>
        )}

        {summary.mode === 'only_pending_exists' && (
          <div className="flex flex-col items-center justify-center min-h-[48px] py-2 text-center">
            <p className="text-[13px] font-medium text-ink-sub">{EMPTY_SUBTITLE}</p>
            {summary.secondarySubtitle && (
              <p className="text-[12px] text-ink-muted mt-1">{summary.secondarySubtitle}</p>
            )}
          </div>
        )}

        {summary.mode === 'no_relevant_work' && (
          <div className="flex flex-col items-center justify-center min-h-[48px] py-2 text-center">
            <p className="text-[13px] font-medium text-ink-sub">{EMPTY_SUBTITLE}</p>
            {summary.secondarySubtitle && (
              <p className="text-[12px] text-ink-muted mt-1">{summary.secondarySubtitle}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
