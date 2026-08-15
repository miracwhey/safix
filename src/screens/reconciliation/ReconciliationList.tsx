/**
 * `ReconciliationList` — renders the active and resolved buckets of a user's
 * reconciliation cases. Pure presentation: the parent (Profil-Center wrapper)
 * resolves disputes via `selectReconciliationList` and passes the buckets in.
 *
 * Used by the standalone profile center; the embedded job-tab does not
 * surface the list — it surfaces a single Detail.
 */

import { Link } from 'react-router-dom'
import { AlertCircle, CheckCircle2, ChevronRight, Clock, ScaleIcon, XCircle } from 'lucide-react'
import { aktenzeichenToUrlSlug } from '../../lib/reconciliation/aktenzeichen'
import { formatEuro } from '../../lib/shared/formatters'
import type {
  ReconciliationListBuckets,
  ReconciliationListItem,
} from '../../lib/reconciliation'

type Props = {
  buckets: ReconciliationListBuckets
  /** Path prefix used to build per-item links. Excludes trailing slash. */
  detailRoutePrefix: string
}

export function ReconciliationList({ buckets, detailRoutePrefix }: Props) {
  const total = buckets.counts.active + buckets.counts.resolved
  if (total === 0) {
    return <EmptyState />
  }
  return (
    <div className="flex flex-col gap-6 pb-8">
      {buckets.active.length > 0 ? (
        <Bucket
          title="Aktive Verfahren"
          subtitle={
            buckets.counts.awaitingViewer > 0
              ? `${buckets.counts.awaitingViewer} warten auf dich`
              : 'Sortiert nach Dringlichkeit'
          }
          items={buckets.active}
          detailRoutePrefix={detailRoutePrefix}
        />
      ) : null}
      {buckets.resolved.length > 0 ? (
        <Bucket
          title="Abgeschlossen"
          subtitle="Aufbewahrung 10 Jahre"
          items={buckets.resolved}
          detailRoutePrefix={detailRoutePrefix}
        />
      ) : null}
    </div>
  )
}

function Bucket({
  title,
  subtitle,
  items,
  detailRoutePrefix,
}: {
  title: string
  subtitle: string
  items: ReconciliationListItem[]
  detailRoutePrefix: string
}) {
  return (
    <section>
      <div className="px-4 pb-2 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold text-ink tracking-[.04em]">{title}</h2>
        <span className="text-[11px] font-medium text-ink-muted">{subtitle}</span>
      </div>
      <ul className="px-4 space-y-2">
        {items.map((item) => (
          <li key={item.disputeId}>
            <ListCard item={item} detailRoutePrefix={detailRoutePrefix} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function ListCard({
  item,
  detailRoutePrefix,
}: {
  item: ReconciliationListItem
  detailRoutePrefix: string
}) {
  const tone = badgeTone(item)
  const href = `${detailRoutePrefix}/${aktenzeichenToUrlSlug(item.aktenzeichen)}`
  return (
    <Link
      to={href}
      className={`block rounded-card bg-surface ring-1 ring-edge shadow-subtle p-4 transition active:scale-[0.99] ${
        item.requiresAction ? 'border-l-[3px] border-danger' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[10.5px] font-semibold tracking-[.06em] uppercase text-ink-muted tabular-nums">
          {item.aktenzeichen}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-chip px-2.5 py-0.5 text-[11px] font-semibold border whitespace-nowrap ${tone.classes}`}
        >
          {tone.icon}
          {tone.label}
        </span>
      </div>
      <p className="mt-2 text-[16px] font-semibold leading-tight text-ink">
        {item.jobTitle || 'Auftrag ohne Titel'}
      </p>
      {item.summary ? (
        <p className="mt-1 text-[13px] leading-snug text-ink-sub line-clamp-2">
          {item.summary}
        </p>
      ) : null}
      <div className="mt-3 pt-3 border-t border-edge/60 flex items-center justify-between text-[12px] font-medium tabular-nums">
        <span className="text-ink">{describeAmountInfo(item)}</span>
        <span className={item.requiresAction ? 'text-danger' : 'text-ink-muted'}>
          {formatRightLabel(item)}
        </span>
      </div>
    </Link>
  )
}

function EmptyState() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-12 text-center">
      <span className="flex h-20 w-20 items-center justify-center rounded-full bg-canvas text-ink-muted">
        <ScaleIcon className="h-10 w-10" strokeWidth={1.5} />
      </span>
      <h2 className="mt-5 text-[20px] font-bold text-ink tracking-tight">
        Du hast keine Streitfälle
      </h2>
      <p className="mt-2 max-w-[280px] text-[14px] leading-snug text-ink-sub">
        Hier landet alles, was zwischen dir und einem Anbieter zu klären ist
        — der seltene Fall.
      </p>
      <div className="mt-6 w-full max-w-[320px] rounded-card border border-edge bg-surface p-4 text-left shadow-subtle">
        <h3 className="text-[11px] font-semibold tracking-[.1em] uppercase text-ink-muted mb-2">
          Wann öffnet sich ein Streitfall?
        </h3>
        <ul className="space-y-2 text-[13px] leading-snug text-ink-sub">
          <li className="flex gap-2">
            <ChevronRight className="w-4 h-4 text-brand flex-shrink-0 mt-[2px]" />
            <span>Arbeit entspricht nicht der Vereinbarung.</span>
          </li>
          <li className="flex gap-2">
            <ChevronRight className="w-4 h-4 text-brand flex-shrink-0 mt-[2px]" />
            <span>Mangel kann nicht direkt geklärt werden.</span>
          </li>
          <li className="flex gap-2">
            <ChevronRight className="w-4 h-4 text-brand flex-shrink-0 mt-[2px]" />
            <span>Termin ohne Grund nicht eingehalten.</span>
          </li>
        </ul>
      </div>
      <p className="mt-4 text-[11px] tracking-[.04em] text-ink-muted">
        DSGVO Art. 15 · Auskunftsrecht
      </p>
    </div>
  )
}

function badgeTone(item: ReconciliationListItem): {
  classes: string
  icon: React.ReactNode
  label: string
} {
  if (item.requiresAction) {
    return {
      classes: 'bg-danger/10 text-danger border-danger/30',
      icon: <AlertCircle className="w-3 h-3" strokeWidth={2.4} />,
      label: 'Aktion nötig',
    }
  }
  if (item.status === 'under_review' || item.status === 'open') {
    return {
      classes: 'bg-warn/10 text-warn border-warn/30',
      icon: <Clock className="w-3 h-3" strokeWidth={2.4} />,
      label: 'In Prüfung',
    }
  }
  if (item.status === 'cancelled') {
    return {
      classes: 'bg-canvas text-ink-muted border-edge',
      icon: <XCircle className="w-3 h-3" strokeWidth={2.4} />,
      label: 'Zurückgezogen',
    }
  }
  // Resolved buckets
  return {
    classes: 'bg-ok/10 text-ok border-ok/30',
    icon: <CheckCircle2 className="w-3 h-3" strokeWidth={2.4} />,
    label: item.decisionSummary ?? 'Erledigt',
  }
}

function describeAmountInfo(item: ReconciliationListItem): string {
  if (item.refundedAmountEur !== null && item.refundedAmountEur !== undefined) {
    return `${formatEuro(item.refundedAmountEur)} erstattet`
  }
  if (item.amountEur !== null && item.amountEur !== undefined) {
    return formatEuro(item.amountEur)
  }
  return '—'
}

function formatRightLabel(item: ReconciliationListItem): string {
  if (item.requiresAction && item.deadline) {
    return `Frist ${formatDateOnly(item.deadline.dueAt)}`
  }
  if (item.resolvedAt) {
    return formatDateOnly(item.resolvedAt)
  }
  return formatDateOnly(item.updatedAt)
}

function formatDateOnly(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}
