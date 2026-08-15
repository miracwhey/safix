import { useState } from 'react'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments } from '../../lib/payments'
import { getDisputeByJobId, subscribeDisputes } from '../../lib/disputes'
import { getScheduleForJob, subscribeOperations } from '../../lib/operations'
import { getArtifactsByJobId, subscribeMedia } from '../../lib/media'
import { getTimelineSignalsForJob, subscribeTimeline } from '../../lib/timeline'
import { useStoreSync } from '../../lib/reactive'
import { getActionablePaymentState } from '../../lib/jobs/helpers'
import {
  deriveJobOperationalSummary,
  type JobOperationalSummary,
  type OperationalBlockerReason,
  type OperationalPhase,
} from '../../lib/jobs/operationalSummarySelectors'
import type { NextActionPriority } from '../../lib/jobs/customerNextActionSelectors'
import { getFundingRequestByJobId } from '../../lib/payments/fundingRequest'

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

type PhaseStyles = {
  phase: string
  dot: string
}

function getPhaseStyles(phase: OperationalPhase): PhaseStyles {
  switch (phase) {
    case 'intake':
    case 'scheduling':
      return { phase: 'text-blue-600', dot: 'bg-blue-400' }
    case 'active':
      return { phase: 'text-slate-700', dot: 'bg-emerald-400' }
    case 'awaiting_release':
      return { phase: 'text-amber-700', dot: 'bg-amber-400' }
    case 'in_dispute':
      return { phase: 'text-rose-600', dot: 'bg-rose-500' }
    case 'complete':
      return { phase: 'text-emerald-700', dot: 'bg-emerald-400' }
  }
}

type BlockerStyles = {
  pill: string
  text: string
}

function getBlockerStyles(reason: OperationalBlockerReason): BlockerStyles {
  switch (reason) {
    case 'awaiting_deposit':
    case 'awaiting_customer_approval':
      return { pill: 'bg-amber-100 ring-amber-200', text: 'text-amber-700' }
    case 'dispute_open':
    case 'dispute_evidence_required':
    case 'payment_frozen':
      return { pill: 'bg-rose-100 ring-rose-200', text: 'text-rose-700' }
    case 'dispute_under_review':
      return { pill: 'bg-violet-100 ring-violet-200', text: 'text-violet-700' }
    case 'workflow_complete':
      return { pill: 'bg-emerald-100 ring-emerald-200', text: 'text-emerald-700' }
    default:
      return { pill: 'bg-slate-100 ring-slate-200', text: 'text-slate-500' }
  }
}

type PriorityStyles = {
  card: string
  accentBar: string
  eyebrow: string
  iconBg: string
  badge: string | null
}

function getPriorityStyles(priority: NextActionPriority): PriorityStyles {
  if (priority === 'urgent') {
    return {
      card: 'bg-white ring-amber-200/80',
      accentBar: 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300',
      eyebrow: 'text-amber-600',
      iconBg: 'bg-amber-500',
      badge: 'HANDLUNG ERFORDERLICH',
    }
  }
  if (priority === 'active') {
    return {
      card: 'bg-white ring-slate-200/70',
      accentBar: 'bg-gradient-to-b from-blue-500 via-blue-400 to-blue-300',
      eyebrow: 'text-blue-500',
      iconBg: 'bg-blue-600',
      badge: null,
    }
  }
  // idle
  return {
    card: 'bg-white ring-slate-200/70',
    accentBar: 'bg-gradient-to-b from-emerald-400 via-emerald-300 to-emerald-200',
    eyebrow: 'text-slate-400',
    iconBg: 'bg-emerald-500',
    badge: null,
  }
}

// ---------------------------------------------------------------------------
// Operational fallback — shown when nextAction.domain === 'payment'
// ---------------------------------------------------------------------------

type OperationalContent = {
  icon: string
  label: string
  text: string
}

function getOperationalContent(phase: OperationalPhase): OperationalContent {
  switch (phase) {
    case 'intake':
      return {
        icon: '📋',
        label: 'Anfrage in Prüfung',
        text: 'Deine Anfrage wird geprüft. Du erhältst bald eine Rückmeldung vom Handwerker.',
      }
    case 'scheduling':
      return {
        icon: '📅',
        label: 'Termin vorbereiten',
        text: 'Der Termin steht. Bitte stelle sicher, dass der Zugang zum Objekt gewährleistet ist.',
      }
    case 'active':
      return {
        icon: '🔨',
        label: 'Ausführung läuft',
        text: 'Der Handwerker arbeitet aktuell an deinem Projekt. Fortschritt und Dokumentation werden laufend ergänzt.',
      }
    case 'awaiting_release':
      return {
        icon: '🔍',
        label: 'Leistung prüfen',
        text: 'Die Arbeiten sind abgeschlossen. Bitte prüfe die erbrachte Leistung und die Dokumentation.',
      }
    case 'in_dispute':
      return {
        icon: '⚖️',
        label: 'Streitfall aktiv',
        text: 'Ein Streitfall ist offen. SaFix prüft den Fall anhand aller vorliegenden Informationen.',
      }
    case 'complete':
      return {
        icon: '✅',
        label: 'Abgeschlossen',
        text: 'Der Auftrag ist erfolgreich abgeschlossen.',
      }
  }
}

// ---------------------------------------------------------------------------
// Customer action hint (inline)
// ---------------------------------------------------------------------------

function CustomerActionHint({
  requiresCustomerAction,
  isComplete,
}: {
  requiresCustomerAction: boolean
  isComplete: boolean
}) {
  if (isComplete) return null

  if (requiresCustomerAction) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
        <span>⚡</span>
        <span>Deine Aktion erforderlich</span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
      <span>⏳</span>
      <span>Warten</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Date formatter
// ---------------------------------------------------------------------------

function formatScheduleDate(ts: number): string {
  return new Date(ts).toLocaleDateString('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

// ---------------------------------------------------------------------------
// Card state
// ---------------------------------------------------------------------------

type CardState = {
  vm: JobOperationalSummary
  scheduleStart: number | null
  artifactCount: number
}

function buildCardState(jobId: string): CardState | null {
  const job = getJobById(jobId)
  if (!job) return null
  const payment = getPaymentForJob(jobId)
  const dispute = getDisputeByJobId(jobId)
  const schedule = getScheduleForJob(jobId)
  const artifacts = getArtifactsByJobId(jobId)
  const timelineSignals = getTimelineSignalsForJob(jobId)
  const effectivePaymentState = getActionablePaymentState(job, payment)
  const vm = deriveJobOperationalSummary({
    jobId,
    jobStatus: job.status,
    paymentState: effectivePaymentState,
    disputeStatus: dispute?.status,
    schedulingStatus: schedule?.schedulingStatus,
    schedule,
    artifactCount: artifacts.length,
    timelineSignals,
    proposalSentAt: job.proposalSentAt,
    proposalAcceptedAt: job.proposalAcceptedAt,
    fundingStatus: getFundingRequestByJobId(jobId)?.status,
  })
  return {
    vm,
    scheduleStart: schedule?.scheduledStart ?? null,
    artifactCount: artifacts.length,
  }
}

// ---------------------------------------------------------------------------
// Card view
// ---------------------------------------------------------------------------

function CustomerStatusAndActionCardView({
  state,
}: {
  state: CardState
}) {
  const { vm, scheduleStart, artifactCount } = state
  const phaseStyles = getPhaseStyles(vm.phase)
  const blockerStyles = getBlockerStyles(vm.blocker.reason)
  const nextAction = vm.customerNextAction

  // When the next action is payment-domain, show operational content instead.
  // Dispute-domain actions stay as-is (operationally relevant).
  const isPaymentDomain = nextAction.domain === 'payment'
  const operationalContent = isPaymentDomain
    ? getOperationalContent(vm.phase)
    : null

  // Card accent: payment-domain → neutral active bar (blue); otherwise follow priority
  const priorityStyles = getPriorityStyles(isPaymentDomain ? 'active' : nextAction.priority)
  const displayContent = operationalContent ?? nextAction

  return (
    <section
      className={`relative overflow-hidden rounded-[28px] p-5 ring-1 shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)] ${priorityStyles.card}`}
    >
      {/* Left accent bar */}
      <div
        className={`pointer-events-none absolute left-0 top-0 h-full w-[2px] rounded-l-[28px] ${priorityStyles.accentBar}`}
      />

      {/* ── Status strip ── */}
      <div
        className="flex flex-wrap items-center gap-2"
        title={vm.blocker.isBlocking ? vm.blocker.description : undefined}
      >
        {/* Phase dot + label */}
        <div className="flex items-center gap-1.5">
          <div className={`h-2 w-2 shrink-0 rounded-full ${phaseStyles.dot}`} />
          <span className={`text-[13px] font-semibold ${phaseStyles.phase}`}>
            {vm.phaseLabel}
          </span>
        </div>

        {/* Customer action hint — only for non-payment domains */}
        {!isPaymentDomain && (
          <CustomerActionHint
            requiresCustomerAction={vm.requiresCustomerAction}
            isComplete={vm.isComplete}
          />
        )}

        {/* Blocker pill */}
        {vm.blocker.isDisplayed && (
          <span
            className={`ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${blockerStyles.pill} ${blockerStyles.text}`}
          >
            {vm.blocker.label}
          </span>
        )}
      </div>

      {/* Timeline context note */}
      {vm.timelineContext && (
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="text-[11px] font-medium text-slate-400">
            {vm.timelineContext.dateLabel}
          </span>
          <span className="text-[12px] text-slate-500">
            {vm.timelineContext.description}
          </span>
        </div>
      )}

      {/* ── Divider ── */}
      <div className="my-3 border-t border-slate-100" />

      {/* ── Main content section ── */}

      {/* Eyebrow */}
      <div className="flex items-center gap-2">
        <div
          className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${priorityStyles.eyebrow}`}
        >
          {isPaymentDomain ? 'Projektstand' : 'Nächster Schritt'}
        </div>
        {!isPaymentDomain && priorityStyles.badge !== null && (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-amber-600 ring-1 ring-amber-200">
            {priorityStyles.badge}
          </span>
        )}
      </div>

      {/* Icon + label row */}
      <div className="mt-3 flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${priorityStyles.iconBg}`}
          style={{ boxShadow: '0 8px 20px -12px rgba(2,6,23,0.4)' }}
        >
          <span className="text-[18px] leading-none">{displayContent.icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-snug text-slate-900">
            {displayContent.label}
          </h2>
        </div>
      </div>

      {/* Main text */}
      <p className="mt-3 text-[14px] leading-relaxed text-slate-500">
        {displayContent.text}
      </p>

      {/* ── Compact info lines (only in payment-domain / operational mode) ── */}
      {isPaymentDomain && (scheduleStart !== null || artifactCount > 0) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {scheduleStart !== null && (
            <div className="flex items-center gap-1">
              <span className="text-[11px] font-medium text-slate-400">Termin</span>
              <span className="text-[12px] text-slate-600">
                {formatScheduleDate(scheduleStart)}
              </span>
            </div>
          )}
          {artifactCount > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-[11px] font-medium text-slate-400">Dokumentation</span>
              <span className="text-[12px] text-slate-600">
                {artifactCount} {artifactCount === 1 ? 'Foto' : 'Fotos'}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Payment section hint (payment-domain only) ── */}
      {isPaymentDomain && !vm.isComplete && (
        <p className="mt-3 text-[12px] text-slate-400">
          Zahlungsdetails & Konflikt weiter unten ↓
        </p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export default function CustomerStatusAndActionCard({ jobId }: { jobId: string }) {
  const [state, setState] = useState<CardState | null>(
    () => buildCardState(jobId)
  )

  useStoreSync(
    [
      subscribeJobs,
      subscribePayments,
      subscribeDisputes,
      subscribeOperations,
      subscribeMedia,
      subscribeTimeline,
    ],
    () => setState(buildCardState(jobId))
  )

  if (!state) return null

  return <CustomerStatusAndActionCardView state={state} />
}
