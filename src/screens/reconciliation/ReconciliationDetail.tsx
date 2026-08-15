/**
 * `ReconciliationDetail` — single source of UI truth for the user-facing
 * dispute detail surface (N13.2). Renders the same blocks in two layouts:
 *
 *   - standalone (`embed=false`): full-bleed screen with screen header,
 *     scrollable body, sticky bottom action bar.
 *   - embed (`embed=true`): tightened spacing for the job-detail "Klärung"
 *     tab. No screen header, no sticky bar.
 *
 * Both consume the same `useReconciliationView` hook and the same block
 * components — there is no parallel component tree.
 */

import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  MessageSquare,
  ScaleIcon,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useSession } from '../../hooks/useSession'
import { getOrCreateChatDisputeThread } from '../../lib/chat/service'
import { useReconciliationView } from '../../lib/reconciliation/useReconciliationView'
import { getJobById } from '../../lib/jobs/jobsStore'
import { getPaymentForJob } from '../../lib/payments/paymentsStore'
import { isTerminalDisputeStatus } from '../../lib/disputes/stateMachine'
import { getDisputeProgressStep } from '../../lib/disputes/disputeSelectors'
import { formatEuro } from '../../lib/shared/formatters'
import { StatementBlock } from './blocks/StatementBlock'
import { EvidenceBlock } from './blocks/EvidenceBlock'
import type {
  ReconciliationRole,
  ReconciliationStripeEvent,
  ReconciliationTimelineItem,
  ReconciliationView,
} from '../../lib/reconciliation'

type Props = {
  disputeId: string
  role: ReconciliationRole
  /** Render the embedded variant used inside the job-detail tab. */
  embed?: boolean
  /** Optional href used by the embedded variant to link out to the full center. */
  centerHref?: string
}

export function ReconciliationDetail({
  disputeId,
  role,
  embed = false,
  centerHref,
}: Props) {
  const session = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const result = useReconciliationView({ disputeId, role })

  if (result.status === 'loading') {
    return <DetailSkeleton embed={embed} />
  }
  if (result.status === 'not-found' || !result.view) {
    return <DetailMissing embed={embed} />
  }

  const view = result.view
  const job = getJobById(view.jobId) ?? null
  const payment = getPaymentForJob(view.jobId) ?? null
  const stepIndex = getDisputeProgressStep(view.status)

  return (
    <div
      className={
        embed
          ? 'flex flex-col gap-3'
          : 'flex min-h-full flex-col bg-canvas pb-[120px]'
      }
    >
      <DetailHeader view={view} embed={embed} centerHref={centerHref} />
      <StepperCard stepIndex={stepIndex} embed={embed} />
      <StatusBanner view={view} embed={embed} />
      <SnapshotCard view={view} payment={payment} embed={embed} />
      <TimelineCard timeline={view.timeline} embed={embed} />
      <EvidenceBlock
        view={view}
        viewerUserId={session.user?.id ?? null}
        jobId={view.jobId}
        canUpload={!isTerminalDisputeStatus(view.status)}
        compact={embed}
      />
      <StatementBlock
        view={view}
        job={job}
        session={{
          userId: session.user?.id ?? '',
          role: session.role,
          craftsmanRole: session.craftsmanRole,
        }}
        onSubmitted={result.refetch}
        compact={embed}
      />
      <DisputeChatSection
        disputeId={disputeId}
        role={role}
        embed={embed}
        currentPath={location.pathname}
        navigate={navigate}
      />
      <DecisionCard view={view} embed={embed} />
      <StripeTraceCard events={view.stripeTimeline} embed={embed} />
      <RechtsmittelCard view={view} embed={embed} />

      {!embed && view.deadline && view.deadline.urgency !== 'later' && view.availableActions.includes('submit_statement') ? (
        <DeadlineStickyBar view={view} />
      ) : null}
    </div>
  )
}

// ─── header ──────────────────────────────────────────────────────────────

function DetailHeader({
  view,
  embed,
  centerHref,
}: {
  view: ReconciliationView
  embed: boolean
  centerHref?: string
}) {
  const pillTone = pillToneFor(view)
  return (
    <header
      className={
        embed
          ? 'rounded-card bg-surface ring-1 ring-edge p-4'
          : 'bg-canvas px-5 pt-3 pb-4 border-b border-edge'
      }
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10.5px] font-semibold tracking-[.18em] uppercase text-ink-muted tabular-nums">
          {view.aktenzeichen}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-chip px-2.5 py-0.5 text-[11.5px] font-semibold border ${pillTone.classes}`}
        >
          {pillTone.icon}
          {view.statusLabel}
        </span>
      </div>
      <h1
        className={
          embed
            ? 'mt-2 text-[18px] font-semibold leading-tight text-ink'
            : 'mt-2 text-[24px] font-bold leading-tight text-ink'
        }
      >
        {view.snapshot?.jobTitle ?? view.dispute.title}
      </h1>
      {view.dispute.description ? (
        <p className="mt-2 text-[14px] leading-snug text-ink-sub">
          {view.dispute.description}
        </p>
      ) : null}
      {view.deadline ? (
        <DeadlineRow view={view} embed={embed} />
      ) : null}
      {embed && centerHref ? (
        <a
          href={centerHref}
          className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-brand"
        >
          Im Klärungscenter öffnen
          <ArrowUpRight className="w-3.5 h-3.5" />
        </a>
      ) : null}
    </header>
  )
}

function DeadlineRow({
  view,
  embed,
}: {
  view: ReconciliationView
  embed: boolean
}) {
  if (!view.deadline) return null
  const tone =
    view.deadline.urgency === 'overdue' || view.deadline.urgency === 'today'
      ? 'text-danger'
      : view.deadline.urgency === 'soon'
        ? 'text-warn'
        : 'text-ink-sub'
  const label = formatDateOnly(view.deadline.dueAt)
  const lifecycleLabel = isTerminalDisputeStatus(view.status)
    ? 'Final'
    : view.deadline.urgency === 'overdue'
      ? 'Frist abgelaufen'
      : 'Frist'
  return (
    <div
      className={`mt-3 flex items-center justify-between rounded-card bg-surface px-3 py-2 border border-edge shadow-subtle ${
        embed ? '' : ''
      }`}
    >
      <div>
        <p className="text-[10.5px] font-semibold tracking-[.06em] uppercase text-ink-muted">
          {lifecycleLabel}
        </p>
        <p className={`text-[14px] font-semibold tabular-nums ${tone}`}>{label}</p>
      </div>
      {!isTerminalDisputeStatus(view.status) ? (
        <Clock className={`w-5 h-5 ${tone}`} />
      ) : (
        <CheckCircle2 className="w-5 h-5 text-ok" />
      )}
    </div>
  )
}

// ─── stepper ─────────────────────────────────────────────────────────────

function StepperCard({
  stepIndex,
  embed,
}: {
  stepIndex: number
  embed: boolean
}) {
  const labels = ['Eröffnet', 'Prüfung', 'Entscheid']
  return (
    <section
      className={
        embed
          ? 'rounded-card bg-surface ring-1 ring-edge p-3'
          : 'rounded-card bg-surface ring-1 ring-edge shadow-subtle p-3 mx-4 mt-3 mb-3'
      }
    >
      <ol className="flex items-center gap-1">
        {labels.map((label, idx) => {
          const done = idx < stepIndex
          const active = idx === stepIndex
          return (
            <li key={label} className="flex flex-1 items-center gap-1">
              <div
                className={`flex flex-1 flex-col items-center gap-1`}
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold tabular-nums ${
                    done
                      ? 'bg-ok text-white'
                      : active
                        ? 'bg-brand text-white ring-4 ring-brand/20'
                        : 'bg-edge text-ink-muted'
                  }`}
                >
                  {done ? '✓' : idx + 1}
                </span>
                <span
                  className={`text-[10px] font-semibold tracking-[.04em] ${
                    active
                      ? 'text-brand'
                      : done
                        ? 'text-ok'
                        : 'text-ink-muted'
                  }`}
                >
                  {label}
                </span>
              </div>
              {idx < labels.length - 1 ? (
                <span
                  className={`mt-3 h-[2px] flex-1 ${
                    idx < stepIndex ? 'bg-ok' : 'bg-edge'
                  }`}
                />
              ) : null}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

// ─── status banner ───────────────────────────────────────────────────────

function StatusBanner({
  view,
  embed,
}: {
  view: ReconciliationView
  embed: boolean
}) {
  if (!view.nextStepLabel) return null
  const tone = view.deadline?.urgency === 'overdue' || view.deadline?.urgency === 'today'
    ? 'danger'
    : view.status === 'under_review'
      ? 'brand'
      : isTerminalDisputeStatus(view.status)
        ? 'ok'
        : 'warn'
  const containerClass =
    tone === 'danger'
      ? 'bg-danger/10 border-danger/40 text-danger'
      : tone === 'warn'
        ? 'bg-warn/10 border-warn/40 text-warn'
        : tone === 'ok'
          ? 'bg-ok/10 border-ok/40 text-ok'
          : 'bg-brand/10 border-brand/40 text-brand'
  return (
    <section
      className={
        embed
          ? `rounded-card border p-3 ${containerClass}`
          : `rounded-card border p-3 mx-4 mb-3 ${containerClass}`
      }
    >
      <div className="flex gap-2">
        {tone === 'ok' ? (
          <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-[1px]" />
        ) : tone === 'brand' ? (
          <Clock className="w-5 h-5 flex-shrink-0 mt-[1px]" />
        ) : (
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-[1px]" />
        )}
        <p className="text-[13px] font-medium leading-snug text-ink-sub">
          {view.nextStepLabel}
        </p>
      </div>
    </section>
  )
}

// ─── snapshot ────────────────────────────────────────────────────────────

function SnapshotCard({
  view,
  payment,
  embed,
}: {
  view: ReconciliationView
  payment: ReturnType<typeof getPaymentForJob> | null
  embed: boolean
}) {
  if (!view.snapshot && !payment) return null
  const totalEur =
    payment?.amounts.totalAmount ?? view.snapshot?.paymentTotalAmount ?? null
  const refundedEur = payment?.refundedAmount ?? null
  return (
    <section
      className={
        embed
          ? 'rounded-card bg-surface ring-1 ring-edge p-4'
          : 'rounded-card bg-surface ring-1 ring-edge shadow-subtle p-4 mx-4 mb-3'
      }
    >
      <h3 className="text-[11px] font-semibold tracking-[.18em] uppercase text-ink-muted">
        § Auftrag · Snapshot
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
        {view.snapshot?.jobTitle ? (
          <>
            <dt className="text-ink-muted">Auftrag</dt>
            <dd className="text-right font-semibold text-ink">
              {view.snapshot.jobTitle}
            </dd>
          </>
        ) : null}
        {totalEur !== null ? (
          <>
            <dt className="text-ink-muted">Vereinbart</dt>
            <dd className="text-right font-semibold tabular-nums text-ink">
              {formatEuro(totalEur)}
            </dd>
          </>
        ) : null}
        {refundedEur !== null ? (
          <>
            <dt className="text-ink-muted">Erstattet</dt>
            <dd className="text-right font-semibold tabular-nums text-ok">
              {formatEuro(refundedEur)}
            </dd>
          </>
        ) : null}
        {view.snapshotMissing ? (
          <>
            <dt className="text-ink-muted col-span-2 text-[11px] italic">
              Snapshot wurde vor Block 6.1 nicht erfasst — Live-Daten.
            </dt>
          </>
        ) : null}
      </dl>
    </section>
  )
}

// ─── timeline ────────────────────────────────────────────────────────────

function TimelineCard({
  timeline,
  embed,
}: {
  timeline: ReadonlyArray<ReconciliationTimelineItem>
  embed: boolean
}) {
  if (timeline.length === 0) return null
  return (
    <section
      className={
        embed
          ? 'rounded-card bg-surface ring-1 ring-edge p-4'
          : 'rounded-card bg-surface ring-1 ring-edge shadow-subtle p-4 mx-4 mb-3'
      }
    >
      <h3 className="text-[11px] font-semibold tracking-[.18em] uppercase text-ink-muted">
        § Verlauf
      </h3>
      <ol className="mt-3 ml-2 border-l-2 border-edge pl-4">
        {timeline.map((item) => (
          <li key={item.id} className="relative pb-3 last:pb-0">
            <span
              className={`absolute -left-[22px] top-1 h-[10px] w-[10px] rounded-full border-2 ${
                item.source === 'you'
                  ? 'border-brand bg-brand'
                  : item.source === 'operator'
                    ? 'border-ink-sub bg-ink-sub'
                    : item.source === 'stripe'
                      ? 'border-warn bg-warn'
                      : 'border-edge bg-surface'
              }`}
            />
            <p className="text-[10.5px] font-medium text-ink-muted tabular-nums">
              {formatDateTime(item.occurredAt)} · {sourceLabel(item.source)}
            </p>
            <h4 className="mt-[2px] text-[13.5px] font-semibold leading-snug text-ink">
              {item.title}
            </h4>
            {item.body ? (
              <p className="mt-1 text-[12.5px] leading-snug text-ink-sub">
                {item.body}
              </p>
            ) : null}
            {item.quote ? (
              <blockquote className="mt-2 rounded-card bg-canvas px-3 py-2 text-[12.5px] italic leading-snug text-ink border-l-2 border-brand">
                {item.quote}
              </blockquote>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  )
}

// ─── decision ────────────────────────────────────────────────────────────

function DecisionCard({
  view,
  embed,
}: {
  view: ReconciliationView
  embed: boolean
}) {
  if (!view.decision) return null
  const decisionLabel = decisionHeadline(view.decision)
  return (
    <section
      className={
        embed
          ? 'rounded-card border p-4 bg-ok/10 border-ok/40 text-ok'
          : 'rounded-card border p-4 mx-4 mb-3 bg-ok/10 border-ok/40 text-ok'
      }
    >
      <h3 className="text-[11px] font-semibold tracking-[.16em] uppercase">
        § Entscheidung
      </h3>
      <p className="mt-2 text-[16px] font-bold leading-tight">{decisionLabel}</p>
      {view.decision.rationale ? (
        <p className="mt-2 text-[13px] leading-snug text-ink-sub">
          {view.decision.rationale}
        </p>
      ) : null}
    </section>
  )
}

// ─── stripe trace ────────────────────────────────────────────────────────

function StripeTraceCard({
  events,
  embed,
}: {
  events: ReadonlyArray<ReconciliationStripeEvent>
  embed: boolean
}) {
  if (events.length === 0) return null
  return (
    <section
      className={
        embed
          ? 'rounded-card bg-surface ring-1 ring-edge p-4'
          : 'rounded-card bg-surface ring-1 ring-edge shadow-subtle p-4 mx-4 mb-3'
      }
    >
      <h3 className="text-[11px] font-semibold tracking-[.18em] uppercase text-ink-muted">
        § Zahlungsverlauf · Stripe
      </h3>
      <ol className="mt-3 space-y-1 font-mono text-[11.5px] tabular-nums">
        {events.map((event) => (
          <li
            key={event.id}
            className="grid grid-cols-[40px_1fr_auto] gap-2 border-b border-edge/60 py-1.5 last:border-b-0"
          >
            <span className="text-[10.5px] text-ink-muted">
              {formatDateOnly(event.occurredAt)}
            </span>
            <span className="text-[11px] text-ink">{event.type}</span>
            <span
              className={`text-[11px] font-semibold ${
                event.amountEur === null ? 'text-ink-muted' : 'text-warn'
              }`}
            >
              {event.amountEur === null ? '—' : formatEuro(event.amountEur)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

// ─── rechtsmittel (out-of-scope stubs) ───────────────────────────────────

function RechtsmittelCard({
  view,
  embed,
}: {
  view: ReconciliationView
  embed: boolean
}) {
  if (!isTerminalDisputeStatus(view.status)) return null
  return (
    <section
      className={
        embed
          ? 'rounded-card bg-surface ring-1 ring-edge p-4'
          : 'rounded-card bg-surface ring-1 ring-edge shadow-subtle p-4 mx-4 mb-3'
      }
    >
      <h3 className="text-[11px] font-semibold tracking-[.18em] uppercase text-ink-muted">
        § Rechtsmittel
      </h3>
      <p className="mt-2 text-[13px] leading-snug text-ink-sub">
        Du kannst Einspruch einlegen oder die Schlichtungsstelle Bauwesen
        anrufen. Die Entscheidung der SaFix-Klärungsstelle ersetzt keinen
        Rechtsweg.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          disabled
          data-todo="N13.APPEAL"
          aria-disabled="true"
          className="cursor-not-allowed rounded-container border border-dashed border-edge bg-canvas px-4 py-2 text-[14px] font-semibold text-ink-muted opacity-60"
        >
          Einspruch einlegen · folgt mit N13.APPEAL
        </button>
        <button
          type="button"
          disabled
          data-todo="N13.APPEAL"
          aria-disabled="true"
          className="cursor-not-allowed rounded-container border border-dashed border-edge bg-canvas px-4 py-2 text-[14px] font-semibold text-ink-muted opacity-60"
        >
          Schlichtungsstelle finden · folgt mit N13.APPEAL
        </button>
      </div>
    </section>
  )
}

// ─── sticky CTA ──────────────────────────────────────────────────────────

function DeadlineStickyBar({ view }: { view: ReconciliationView }) {
  return (
    <div
      className="fixed bottom-[84px] left-0 right-0 z-40 flex items-center gap-3 border-t border-edge bg-surface/95 backdrop-blur px-4 py-3"
    >
      <div className="flex-1">
        <p className="text-[10.5px] font-bold uppercase text-danger tabular-nums">
          Frist {formatDateOnly(view.deadline!.dueAt)}
        </p>
        <p className="text-[11.5px] text-ink-muted">
          Stellungnahme erforderlich
        </p>
      </div>
      <a
        href="#statement-block"
        className="inline-flex items-center gap-2 rounded-container bg-brand px-4 py-2 text-[14px] font-semibold text-white shadow-elevated"
      >
        <ScaleIcon className="w-4 h-4" />
        Abgeben
      </a>
    </div>
  )
}

// ─── empty / loading ─────────────────────────────────────────────────────

function DetailSkeleton({ embed }: { embed: boolean }) {
  return (
    <div
      className={
        embed
          ? 'flex flex-col gap-3'
          : 'flex flex-col gap-3 px-4 pt-4'
      }
    >
      {[0, 1, 2].map((idx) => (
        <div
          key={idx}
          className="rounded-card bg-surface ring-1 ring-edge p-4 animate-pulse"
        >
          <div className="h-3 w-1/4 rounded bg-edge" />
          <div className="mt-3 h-5 w-3/4 rounded bg-edge" />
          <div className="mt-2 h-3 w-2/3 rounded bg-edge" />
        </div>
      ))}
    </div>
  )
}

function DetailMissing({ embed }: { embed: boolean }) {
  return (
    <div
      className={
        embed
          ? 'rounded-card bg-surface ring-1 ring-edge p-4 text-center'
          : 'flex min-h-full flex-col items-center justify-center bg-canvas px-6 py-16 text-center'
      }
    >
      <ScaleIcon className="w-10 h-10 text-ink-muted" />
      <h2 className="mt-3 text-[18px] font-bold text-ink">Streitfall nicht gefunden</h2>
      <p className="mt-2 text-[13px] text-ink-sub max-w-xs">
        Möglicherweise wurde dieser Fall geschlossen oder du hast keinen
        Zugriff darauf. Versuche es vom Klärungscenter aus erneut.
      </p>
    </div>
  )
}

// ─── dispute chat section ────────────────────────────────────────────────

function DisputeChatSection({
  disputeId,
  role,
  embed,
  currentPath,
  navigate,
}: {
  disputeId: string
  role: ReconciliationRole
  embed: boolean
  currentPath: string
  navigate: ReturnType<typeof useNavigate>
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const messagesBase = role === 'customer' ? '/messages' : '/craftsman/messages'

  const handleOpenChat = async () => {
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      const threadId = await getOrCreateChatDisputeThread(disputeId)
      navigate(`${messagesBase}/${threadId}?backPath=${encodeURIComponent(currentPath)}`)
    } catch {
      setError('Chat konnte nicht geöffnet werden.')
      setLoading(false)
    }
  }

  if (embed) {
    return (
      <div className="rounded-card bg-surface ring-1 ring-edge p-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-brand flex-shrink-0" />
          <span className="text-[13px] font-medium text-ink">Direktnachricht</span>
        </div>
        <button
          type="button"
          onClick={() => void handleOpenChat()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-chip bg-brand px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          {loading ? 'Öffnet…' : 'Chat öffnen'}
        </button>
      </div>
    )
  }

  return (
    <section className="rounded-card bg-surface ring-1 ring-edge shadow-subtle p-4 mx-4 mb-3">
      <h3 className="text-[11px] font-semibold tracking-[.18em] uppercase text-ink-muted">
        § Direktnachricht
      </h3>
      <p className="mt-2 text-[13px] leading-snug text-ink-sub">
        Stell SaFix Fragen zu deinem Streitfall.
      </p>
      <button
        type="button"
        onClick={() => void handleOpenChat()}
        disabled={loading}
        className="mt-3 inline-flex items-center gap-2 rounded-container bg-brand px-4 py-2.5 text-[14px] font-semibold text-white shadow-subtle disabled:opacity-50"
      >
        <MessageSquare className="w-4 h-4" />
        {loading ? 'Öffnet…' : 'Chat öffnen'}
      </button>
      {error ? (
        <p className="mt-2 text-[12px] text-danger">{error}</p>
      ) : null}
    </section>
  )
}

// ─── helpers ─────────────────────────────────────────────────────────────

function pillToneFor(view: ReconciliationView) {
  const cls = 'w-3 h-3'
  if (view.status === 'customer_waiting' || view.status === 'provider_waiting') {
    return {
      classes: 'bg-danger/10 text-danger border-danger/30',
      icon: <AlertCircle className={cls} />,
    }
  }
  if (view.status === 'under_review' || view.status === 'open') {
    return {
      classes: 'bg-warn/10 text-warn border-warn/30',
      icon: <Clock className={cls} />,
    }
  }
  if (isTerminalDisputeStatus(view.status)) {
    return {
      classes: 'bg-ok/10 text-ok border-ok/30',
      icon: <CheckCircle2 className={cls} />,
    }
  }
  return {
    classes: 'bg-canvas text-ink-sub border-edge',
    icon: <Clock className={cls} />,
  }
}

function decisionHeadline(decision: ReconciliationView['decision']): string {
  if (!decision) return ''
  if (decision.decision === 'release') {
    return decision.resolutionType === 'release_partial'
      ? 'Teilfreigabe entschieden'
      : 'Vollständige Freigabe'
  }
  if (decision.decision === 'refund') {
    return decision.resolutionType === 'refund_partial'
      ? 'Teilrückerstattung entschieden'
      : 'Vollständige Rückerstattung'
  }
  if (decision.decision === 'split') {
    if (typeof decision.splitRatio === 'number') {
      const craftsmanPct = Math.round(decision.splitRatio * 100)
      return `Aufteilung ${craftsmanPct} / ${100 - craftsmanPct}`
    }
    return 'Aufteilung entschieden'
  }
  if (decision.decision === 'reject') return 'Streitfall abgelehnt'
  return 'Entscheidung getroffen'
}

function sourceLabel(source: ReconciliationTimelineItem['source']): string {
  if (source === 'you') return 'Du'
  if (source === 'operator') return 'Klärungsstelle'
  if (source === 'stripe') return 'Stripe'
  return 'System'
}

function formatDateTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${date} · ${time}`
}

function formatDateOnly(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}

