import { Link } from 'react-router-dom'
import type { OperationalHealthSummary, RiskFlag, RiskSeverity } from '../../lib/finance/types'

type Props = {
  health: OperationalHealthSummary
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function getSeverityChipStyle(severity: RiskSeverity): string {
  if (severity === 'critical') return 'bg-rose-100 text-rose-700 ring-rose-200'
  if (severity === 'elevated') return 'bg-amber-100 text-amber-700 ring-amber-200'
  return 'bg-slate-100 text-slate-600 ring-slate-200'
}

function getSeverityLabel(severity: RiskSeverity): string {
  if (severity === 'critical') return 'Kritisch'
  if (severity === 'elevated') return 'Erhöht'
  return 'Hinweis'
}

function getSeverityDot(severity: RiskSeverity): string {
  if (severity === 'critical') return 'bg-rose-500'
  if (severity === 'elevated') return 'bg-amber-400'
  return 'bg-slate-400'
}

function getCategoryIcon(category: RiskFlag['category']): string {
  if (category === 'payment') return '💳'
  if (category === 'dispute') return '⚖️'
  if (category === 'job') return '🔨'
  return '⚠️'
}

function getOverallBadgeStyle(status: OperationalHealthSummary['overallStatus']): {
  card: string
  eyebrow: string
  badge: string
  badgeText: string
} {
  if (status === 'critical') {
    return {
      card: 'ring-rose-200/80',
      eyebrow: 'text-rose-600',
      badge: 'bg-rose-50 text-rose-600 ring-rose-200',
      badgeText: 'KRITISCH',
    }
  }
  if (status === 'warning') {
    return {
      card: 'ring-amber-200/70',
      eyebrow: 'text-amber-600',
      badge: 'bg-amber-50 text-amber-600 ring-amber-200',
      badgeText: 'WARNUNG',
    }
  }
  return {
    card: 'ring-emerald-200/70',
    eyebrow: 'text-emerald-600',
    badge: 'bg-emerald-50 text-emerald-600 ring-emerald-200',
    badgeText: 'OK',
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CountBadge({
  count,
  label,
  colorClass,
}: {
  count: number
  label: string
  colorClass: string
}) {
  if (count === 0) return null
  return (
    <div className={`flex-1 rounded-[18px] px-3 py-2.5 text-center ring-1 ${colorClass}`}>
      <div className="text-[20px] font-semibold leading-none">{count}</div>
      <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.1em] opacity-70">
        {label}
      </div>
    </div>
  )
}

function FlagRow({ flag }: { flag: RiskFlag }) {
  const dest = flag.linkTo ?? (flag.jobId ? `/craftsman/jobs/${flag.jobId}` : undefined)
  const content = (
    <div className="flex items-start gap-3 py-2">
      <div className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${getSeverityDot(flag.severity)}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold text-slate-900">{flag.label}</span>
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold tracking-[0.1em] ring-1 ${getSeverityChipStyle(flag.severity)}`}>
            {getSeverityLabel(flag.severity)}
          </span>
        </div>
        <div className="mt-0.5 text-[12px] text-slate-500">{flag.detail}</div>
        {flag.actionHint && (
          <div className="mt-1 text-[11px] font-medium text-slate-400">
            → {flag.actionHint}
          </div>
        )}
      </div>
      <span className="shrink-0 text-[14px] leading-none">
        {getCategoryIcon(flag.category)}
      </span>
    </div>
  )

  if (dest) {
    return (
      <Link
        to={dest}
        className="-mx-1 block rounded-[12px] px-1 transition hover:bg-slate-50/80"
      >
        {content}
      </Link>
    )
  }

  return <div>{content}</div>
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function OperationalHealthCard({ health }: Props) {
  const styles = getOverallBadgeStyle(health.overallStatus)

  const isHealthy = health.overallStatus === 'healthy'

  return (
    <section
      className={`rounded-[28px] bg-white p-5 ring-1 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.22)] ${styles.card}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className={`text-[12px] font-semibold uppercase tracking-[0.18em] ${styles.eyebrow}`}>
          Pilot Health
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] ring-1 ${styles.badge}`}
        >
          {styles.badgeText}
        </span>
      </div>

      <div className="mt-1.5 text-[16px] font-semibold text-slate-900">
        {isHealthy
          ? 'Keine kritischen Probleme erkannt'
          : `${health.totalIssueCount} ${health.totalIssueCount === 1 ? 'Problem' : 'Probleme'} erkannt`}
      </div>

      {/* Count badges */}
      {!isHealthy && (
        <div className="mt-4 flex gap-2">
          <CountBadge
            count={health.criticalCount}
            label="Kritisch"
            colorClass="bg-rose-50 text-rose-700 ring-rose-200/70"
          />
          <CountBadge
            count={health.elevatedCount}
            label="Erhöht"
            colorClass="bg-amber-50 text-amber-700 ring-amber-200/70"
          />
          <CountBadge
            count={health.warningCount}
            label="Hinweis"
            colorClass="bg-slate-50 text-slate-600 ring-slate-200/70"
          />
        </div>
      )}

      {/* Flag list */}
      {health.flags.length > 0 ? (
        <div className="mt-4 divide-y divide-slate-100">
          {health.flags.map((flag) => (
            <FlagRow key={flag.id} flag={flag} />
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-[18px] bg-emerald-50 px-4 py-3 ring-1 ring-emerald-100">
          <div className="text-[13px] font-semibold text-emerald-700">
            ✓ Alle Zahlungen, Konflikte und Jobs sind in Ordnung
          </div>
          <div className="mt-0.5 text-[12px] text-emerald-600">
            Kein sofortiger Handlungsbedarf im aktuellen Datenstand.
          </div>
        </div>
      )}

      {/* Dispute Center shortcut */}
      {health.flags.some((f) => f.category === 'dispute') && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <Link
            to="/craftsman/disputes"
            className="flex items-center gap-2 rounded-[14px] bg-slate-50 px-3 py-2 text-[13px] font-semibold text-slate-600 ring-1 ring-slate-200/70 transition hover:bg-slate-100"
          >
            <span className="text-[15px] leading-none">⚖️</span>
            <span>Dispute Center öffnen</span>
            <span className="ml-auto text-slate-400">→</span>
          </Link>
        </div>
      )}
    </section>
  )
}
