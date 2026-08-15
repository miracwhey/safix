/**
 * RequestDetailView — Full Request Detail (Level 2)
 *
 * A structured, handwerker-usable request detail view that shows
 * significantly more information than the compact chat card (Level 1).
 *
 * Renders from the canonical Project entity.  This is a pure presentational
 * component — opening it does NOT mutate thread state, active project
 * state, or any other part of the thread artifact model.
 *
 * Sections:
 *   1. Header — title, status, category
 *   2. Core details — location, budget, timing
 *   3. Description — full work description
 *   4. Trade-specific answers — structured Q&A from the guided builder flow
 *   5. Actions — reply, ask follow-up (contextual based on role)
 */

import {
  REQUEST_QUALITY_TIER_LABEL,
  type RequestQualityScore,
  type RequestQualityTier,
} from '../../lib/requestQuality'

/**
 * Display-only subset of Project fields used by this component.
 *
 * Accepts both full Project entities AND snapshot-derived display objects
 * so the craftsman request detail screen can render from thread artifact
 * snapshot data when the full project entity isn't loaded yet.
 */
export type RequestDetailData = {
  title: string
  status: string
  category?: string
  description?: string
  location?: string
  requestedBudget?: string
  requestedTiming?: string
  tradeSpecificAnswers?: Array<{ key: string; label: string; value: string }>
}

type Props = {
  project: RequestDetailData
  /**
   * Intrinsic quality score for this request. When provided, an internal
   * quality section is rendered. The same score is shown in the inbox tier
   * badge — both come from the shared `getRequestQualityForConversation`.
   */
  qualityScore?: RequestQualityScore
}

const TIER_TEXT: Record<RequestQualityTier, string> = {
  top: 'text-brand',
  solide: 'text-slate-900',
  pruefen: 'text-slate-500',
}

const QUALITY_BARS: { label: string; key: keyof RequestQualityScore['breakdown'] }[] = [
  { label: 'Vollständigkeit', key: 'completeness' },
  { label: 'Intent', key: 'intent' },
  { label: 'Anhänge', key: 'attachments' },
]

const STATUS_LABELS: Record<string, string> = {
  request: 'Anfrage',
  accepted: 'Angenommen',
  scheduled: 'Geplant',
  in_progress: 'In Arbeit',
  review: 'Prüfung',
  completed: 'Abgeschlossen',
  cancelled: 'Storniert',
}

const STATUS_STYLES: Record<string, string> = {
  request: 'bg-blue-50 text-blue-700 ring-blue-100',
  accepted: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  scheduled: 'bg-indigo-50 text-indigo-700 ring-indigo-100',
  in_progress: 'bg-blue-50 text-blue-700 ring-blue-100',
  review: 'bg-amber-50 text-amber-700 ring-amber-100',
  completed: 'bg-slate-50 text-slate-700 ring-slate-200',
  cancelled: 'bg-rose-50 text-rose-700 ring-rose-200',
}

/**
 * Individual detail row for clean key-value display.
 */
function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 text-[15px] leading-none shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-slate-400">{label}</div>
        <div className="mt-0.5 text-[14px] font-medium text-slate-800">{value}</div>
      </div>
    </div>
  )
}

/**
 * Section divider with label.
 */
function SectionLabel({ label }: { label: string }) {
  return (
    <div className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-400">
      {label}
    </div>
  )
}

export default function RequestDetailView({ project, qualityScore }: Props) {
  const statusLabel = STATUS_LABELS[project.status] ?? project.status
  const statusStyle = STATUS_STYLES[project.status] ?? STATUS_STYLES.request

  const tradeAnswers = project.tradeSpecificAnswers ?? []
  const hasDescription = Boolean(project.description?.trim())
  const hasTradeAnswers = tradeAnswers.length > 0
  const hasAnyDetail = Boolean(
    project.location || project.requestedBudget || project.requestedTiming
  )

  return (
    <div data-testid="request-detail-view">
      {/* ── Header: Title + Status + Category ── */}
      <div className="rounded-[20px] bg-white p-5 ring-1 ring-slate-200/60 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.10)]">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[18px] font-semibold text-slate-900 leading-snug">
            {project.title}
          </h2>
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${statusStyle}`}
          >
            {statusLabel}
          </span>
        </div>

        {project.category && (
          <div className="mt-2">
            <span className="inline-flex items-center rounded-full bg-slate-50 px-2.5 py-0.5 text-[12px] font-semibold text-slate-600 ring-1 ring-slate-200/60">
              🔧 {project.category}
            </span>
          </div>
        )}
      </div>

      {/* ── Anfrage-Qualität (internal score) ── */}
      {qualityScore && (
        <div className="mt-3 rounded-[20px] bg-white p-5 ring-1 ring-slate-200/60 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.10)]">
          <div className="flex items-center justify-between">
            <SectionLabel label="Anfrage-Qualität" />
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">
              intern
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span
              className={`text-[34px] font-bold leading-none tabular-nums ${TIER_TEXT[qualityScore.tier]}`}
            >
              {qualityScore.score}
            </span>
            <span className={`text-[15px] font-bold ${TIER_TEXT[qualityScore.tier]}`}>
              {REQUEST_QUALITY_TIER_LABEL[qualityScore.tier]}
            </span>
          </div>
          <div className="mt-4 space-y-2.5">
            {QUALITY_BARS.map(({ label, key }) => {
              const category = qualityScore.breakdown[key]
              const pct =
                category.possible > 0
                  ? Math.round((category.earned / category.possible) * 100)
                  : 0
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="w-[104px] shrink-0 text-[12px] font-semibold text-slate-500">
                    {label}
                  </span>
                  <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-[44px] text-right text-[12px] font-bold tabular-nums text-slate-700">
                    {category.earned}/{category.possible}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Core details ── */}
      {hasAnyDetail && (
        <div className="mt-3 rounded-[20px] bg-white p-5 ring-1 ring-slate-200/60 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.10)]">
          <SectionLabel label="Projektdetails" />
          <div className="divide-y divide-slate-100">
            {project.location && (
              <DetailRow icon="📍" label="Standort / Arbeitsort" value={project.location} />
            )}
            {project.requestedBudget && (
              <DetailRow icon="💶" label="Budgetrahmen" value={project.requestedBudget} />
            )}
            {project.requestedTiming && (
              <DetailRow icon="📅" label="Gewünschter Zeitraum" value={project.requestedTiming} />
            )}
          </div>
        </div>
      )}

      {/* ── Description ── */}
      {hasDescription && (
        <div className="mt-3 rounded-[20px] bg-white p-5 ring-1 ring-slate-200/60 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.10)]">
          <SectionLabel label="Beschreibung" />
          <p className="mt-1 text-[14px] leading-relaxed text-slate-700 whitespace-pre-line">
            {project.description}
          </p>
        </div>
      )}

      {/* ── Trade-specific structured answers ── */}
      {hasTradeAnswers && (
        <div
          className="mt-3 rounded-[20px] bg-white p-5 ring-1 ring-slate-200/60 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.10)]"
          data-testid="trade-specific-answers"
        >
          <SectionLabel label="Weitere Angaben" />
          <div className="divide-y divide-slate-100">
            {tradeAnswers.map((answer) => (
              <DetailRow
                key={answer.key}
                icon="📋"
                label={answer.label}
                value={answer.value}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Missing info indicator ── */}
      {!hasDescription && !hasTradeAnswers && !hasAnyDetail && (
        <div className="mt-3 rounded-[20px] bg-slate-50 px-5 py-4 ring-1 ring-slate-200/60">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-[15px]">ℹ️</span>
            <p className="text-[13px] text-slate-500 leading-snug">
              Für diese Anfrage liegen nur wenige Details vor. Der Kunde hat bisher nur eine Basisanfrage erstellt.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
