import { useCallback, useEffect, useState } from 'react'
import { Navigate, Link, useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { Ban, CreditCard, Scale, Receipt, MessageCircle } from 'lucide-react'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import InlineFeedback from '../components/system/InlineFeedback'
import { useAsyncAction } from '../hooks/useAsyncAction'
import CorridorAction from '../components/system/CorridorAction'

import AppShell from '../components/AppShell'
import { Icon } from '../components/primitives'
import AdminGate from '../components/AdminGate'
import CorridorNotFound from '../components/system/CorridorNotFound'
import CorridorTerminalBanner from '../components/system/CorridorTerminalBanner'

import JobHeader from '../components/jobs/JobHeader'
import JobDetailsCard from '../components/jobs/JobDetailsCard'
import { SpatialDetailSection } from '../components/spatial/SpatialDetailSection'
import { useStartRoomScan } from '../hooks/useStartRoomScan'
import JobIntakeContextCard from '../components/jobs/JobIntakeContextCard'
import ProposalDraftCard from '../components/jobs/ProposalDraftCard'
import ProposalReadinessCard from '../components/jobs/ProposalReadinessCard'
import JobLifecycleFlow from '../components/jobs/JobLifecycleFlow'
import JobOperationsCard from '../components/jobs/JobOperationsCard'
import CraftsmanJobSectionDivider from '../components/jobs/CraftsmanJobSectionDivider'
import DisputeStatusCard from '../components/jobs/DisputeStatusCard'
import ReconciliationCenterLink from '../components/jobs/ReconciliationCenterLink'

import PaymentPrepCard from '../components/jobs/PaymentPrepCard'
import JobStatusSection from '../components/jobs/JobStatusSection'
import ExecutionProgressCard from '../components/jobs/ExecutionProgressCard'
import JobCompletionSummaryCard from '../components/jobs/JobCompletionSummaryCard'
import JobRatingCard from '../components/jobs/JobRatingCard'
import JobOutcomeBanner from '../components/jobs/JobOutcomeBanner'
import NewJobArrivalBanner from '../components/jobs/NewJobArrivalBanner'
import CraftsmanJobOperationsCard from '../components/jobs/CraftsmanJobOperationsCard'
import ChangeOrderSectionCard from '../components/jobs/ChangeOrderSectionCard'
import JobTeamSection from '../components/jobs/JobTeamSection'
import JobActivitySection from '../components/jobs/JobActivitySection'
import JobDocumentationSection from '../components/jobs/JobDocumentationSection'
import JobMediaSection from '../components/jobs/JobMediaSection'
import ProjectHealthSummaryCard from '../components/jobs/ProjectHealthSummaryCard'
import MoneyFlowSummaryCard from '../components/jobs/MoneyFlowSummaryCard'

import {
  getJobById,
  getTeamMembers,
  subscribeJobs,
  isJobRepositoryHydrated,
  deriveProposalState,
  type Job,
  type ProposalStateView,
  type TeamMember,
} from '../lib/jobs'
import { subscribeTeamMembers } from '../lib/team'
import { getConversationByProjectId } from '../lib/messages'
import { getThreadByLegacyConversationId } from '../lib/chat'
import { getFollowUpOfferForDiagnosis, subscribeOffers, isOfferRepositoryHydrated } from '../lib/offers'
import { getCalendarEntryByJobId } from '../lib/calendar'
import { getInvoiceByJobId } from '../lib/invoices'
import { buildProjectTimeline } from '../lib/timeline'
import {
  cancelSchedule,
  closeCaseWorkflow,
  confirmSchedule,
  createInvoiceWorkflow,
  ensureOperationalArtifacts,
  markDepositPaidForJobWorkflow,
  markExecutionCompleted,
  markExecutionStarted,
  markScheduleRescheduled,
  setJobStatusWorkflow,
  setWaitingPaymentWorkflow,
  startJobWorkflow,
  toggleAssignedMemberWorkflow,
  getPaymentForJobWorkflow,
} from '../lib/workflow'
import { subscribeOwnerNotesForJob } from '../lib/owner/ownerNotesLive'
import { addOwnerNoteWorkflow } from '../lib/owner/ownerNotesWorkflow'
import type { OwnerNote } from '../lib/owner/types'
import { useCorridorAction } from '../hooks/useCorridorAction'
import { performCanonicalScheduleSave, getDefaultScheduleTimes } from '../lib/scheduling'
import {
  getScheduleForJob,
  subscribeOperations,
  type JobSchedule,
} from '../lib/operations'
import { getProjectByJobId } from '../lib/projects'
import { getDisputeByJobId, subscribeDisputes } from '../lib/disputes'
import { useStoreSubscriptions } from '../lib/reactive'
import { useSession } from '../hooks/useSession'
import type { ProviderPayoutAccount } from '../lib/payout/types'
import { resolveMoneyFlowProjection } from '../lib/payments/moneyFlowProjection'
import { fetchPayoutAccountForOnboarding } from '../lib/payout/client'
import { isFundingConfirmedForJob, subscribeFundingRequests, isFundingRequestRepositoryHydrated } from '../lib/payments/fundingRequest'
import { subscribeEscrowPlans, isEscrowPlanRepositoryHydrated } from '../lib/payments/escrow'
import { subscribePayments, isPaymentRepositoryHydrated } from '../lib/payments'

// Focus → section-id mapping is owned by `lib/notifications/focusAnchors`.
// Imported here only for the scroll-on-mount effect below; defensive lookup
// via `resolveSectionId` keeps unknown values a no-op.
import { resolveSectionId } from '../lib/notifications/focusAnchors'

/**
 * Block D Slice 2 M2 — Thread link resolution for craftsman job detail.
 *
 * Resolution chain:
 *   1. Legacy conversation id (sourceConversationId or projectId → conversation lookup)
 *   2. Chat thread id matched via `legacyThreadId`
 *   3. Fallback: legacy conversation id (push-deeplink + unmigrated thread safety)
 *
 * Returns undefined only when no thread anchor exists at all — the caller
 * falls back to `/craftsman/messages` (inbox).
 */
function resolveThreadLinkForJob(
  sourceConversationId: string | undefined | null,
  projectId: string | undefined | null,
): string | undefined {
  const legacyId =
    sourceConversationId ??
    (projectId ? getConversationByProjectId(projectId)?.id : undefined)
  if (!legacyId) return undefined
  return getThreadByLegacyConversationId(legacyId)?.id ?? legacyId
}

export default function CraftsmanJobDetailScreen() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const session = useSession()
  const { user } = session
  const [searchParams] = useSearchParams()
  const focus = searchParams.get('focus')

  const [job, setJob] = useState<Job | undefined>(
    jobId ? getJobById(jobId) : undefined
  )
  // Deterministic loaded decision:
  //   - job found → loaded
  //   - job not found AND repo hydrated → loaded (will redirect)
  //   - job not found AND repo NOT hydrated → stay loading
  const [loaded, setLoaded] = useState(() => {
    if (jobId && getJobById(jobId)) return true
    return isJobRepositoryHydrated()
  })
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>(getTeamMembers())
  const [noteInput, setNoteInput] = useState('')
  const [schedule, setSchedule] = useState<JobSchedule | undefined>(
    jobId ? getScheduleForJob(jobId) : undefined
  )
  const [hasDispute, setHasDispute] = useState<boolean>(
    jobId ? !!getDisputeByJobId(jobId) : false
  )
  const [payoutAccount, setPayoutAccount] = useState<ProviderPayoutAccount | null>(null)
  const [fundingConfirmed, setFundingConfirmed] = useState(() =>
    jobId ? isFundingConfirmedForJob(jobId) : false
  )
  const [ownerNotes, setOwnerNotes] = useState<OwnerNote[]>([])
  const [spatialRefreshTick, setSpatialRefreshTick] = useState(0)
  const { startScan: startRoomScan, busy: scanBusy } = useStartRoomScan()
  const handleStartSpatialScan = useCallback(() => {
    if (!jobId || scanBusy) return
    void startRoomScan({
      jobId,
      onSuccess: () => setSpatialRefreshTick((t) => t + 1),
    })
  }, [jobId, scanBusy, startRoomScan])

  useEffect(() => {
    if (!jobId) return
    return subscribeOwnerNotesForJob(jobId, setOwnerNotes)
  }, [jobId])

  // Follow-up offer for diagnosis jobs — used to gate "Folgeangebot erstellen" CTA
  const [followUpOffer, setFollowUpOffer] = useState(() => {
    const j = jobId ? getJobById(jobId) : undefined
    if (!j?.sourceOfferId || j.jobKind !== 'diagnosis') return undefined
    return getFollowUpOfferForDiagnosis(j.sourceOfferId)
  })
  // Track whether offers repo has hydrated — guards the followUpOffer CTA against
  // a false "not found" state while deferred repo is still loading. Until hydrated,
  // the CTA is shown as loading so the craftsman can't accidentally trigger
  // duplicate follow-up creation in the pre-hydration window.
  const [offersHydrated, setOffersHydrated] = useState(() => isOfferRepositoryHydrated())
  // Render-tick so payment Realtime updates re-read getPaymentForJobWorkflow at render time
  const [, setPaymentTick] = useState(0)
  // Monotonic hydration tick for the funding/escrow buses. Their onChange handlers
  // call setFundingConfirmed(isFundingConfirmedForJob(jobId)), which React bails on
  // when the value is unchanged. If escrow is the LAST payment-side repo to hydrate
  // and fundingConfirmed is already at its final value, that bail would leave the
  // MoneyFlowSummaryCard hydration gate (payment+funding+escrow) stuck. This
  // always-new tick guarantees exactly one re-render per funding/escrow emit so the
  // last repo to hydrate always lifts the gate.
  const [, setHydrationTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetchPayoutAccountForOnboarding().then(account => {
      if (!cancelled && account) setPayoutAccount(account)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!jobId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync from store on mount
    setJob(getJobById(jobId))
    setTeamMembers(getTeamMembers())
    setSchedule(getScheduleForJob(jobId))
    void ensureOperationalArtifacts(jobId)
  }, [jobId])

  // ── Focus-anchor scroll ────────────────────────────────────────────────────
  // ActionQueue items can deep-link with `?focus=payment|dispute|documents|
  // timeline|offer` so the user lands on the relevant sub-section instead
  // of the screen top. Unknown values are silently ignored.
  // The scroll fires on a microtask delay to give conditional sections time
  // to mount; if the target id is not present (e.g. payment block hidden
  // because proposal not yet accepted) the scroll is a harmless no-op.
  useEffect(() => {
    if (!focus || !job) return
    const sectionId = resolveSectionId(focus)
    if (!sectionId) return
    const handle = window.setTimeout(() => {
      const el = document.getElementById(sectionId)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
    return () => window.clearTimeout(handle)
  }, [focus, job])

  useStoreSubscriptions([
    {
      subscribe: subscribeJobs,
      onChange: () => {
        if (!jobId) return
        const found = getJobById(jobId)
        setJob(found)
        if (found || isJobRepositoryHydrated()) {
          setLoaded(true)
        }
      },
    },
    {
      subscribe: subscribeTeamMembers,
      onChange: () => {
        setTeamMembers(getTeamMembers())
      },
    },
    {
      subscribe: subscribeOperations,
      onChange: () => {
        if (!jobId) return
        setSchedule(getScheduleForJob(jobId))
      },
    },
    {
      subscribe: subscribeDisputes,
      onChange: () => {
        if (!jobId) return
        setHasDispute(!!getDisputeByJobId(jobId))
      },
    },
    {
      subscribe: subscribeOffers,
      onChange: () => {
        setOffersHydrated(isOfferRepositoryHydrated())
        if (!jobId) return
        const j = getJobById(jobId)
        if (!j?.sourceOfferId || j.jobKind !== 'diagnosis') {
          setFollowUpOffer(undefined)
          return
        }
        setFollowUpOffer(getFollowUpOfferForDiagnosis(j.sourceOfferId))
      },
    },
    {
      subscribe: subscribePayments,
      onChange: () => {
        setPaymentTick((v) => v + 1)
      },
    },
    {
      subscribe: subscribeFundingRequests,
      onChange: () => {
        setHydrationTick((v) => v + 1)
        if (!jobId) return
        setFundingConfirmed(isFundingConfirmedForJob(jobId))
      },
    },
    {
      subscribe: subscribeEscrowPlans,
      onChange: () => {
        setHydrationTick((v) => v + 1)
        if (!jobId) return
        setFundingConfirmed(isFundingConfirmedForJob(jobId))
      },
    },
  ])

  // ── Async-wrapped admin operations (error feedback boundary:
  //    only the explicitly listed handlers in this slice).
  //    Hooks must be called unconditionally — before early returns. ──
  const startJobAction = useAsyncAction(
    useCallback(async () => {
      if (!job) return
      await startJobWorkflow(job.id)
      setJob(getJobById(job.id))
      setSchedule(getScheduleForJob(job.id))
    }, [job])
  )

  const waitingPaymentAction = useAsyncAction(
    useCallback(async () => {
      if (!job) return
      await setWaitingPaymentWorkflow(job.id)
      setJob(getJobById(job.id))
      setSchedule(getScheduleForJob(job.id))
    }, [job])
  )

  const createInvoiceAction = useAsyncAction(
    useCallback(async () => {
      if (!job) return
      await createInvoiceWorkflow(job.id)
      setJob(getJobById(job.id))
    }, [job])
  )

  const closeCaseAction = useAsyncAction(
    useCallback(async () => {
      if (!job) return
      const project = getProjectByJobId(job.id)
      if (!project) throw new Error('Projekt nicht gefunden')
      const closed = await closeCaseWorkflow(project.id, user?.id)
      if (!closed) throw new Error('Fall konnte nicht geschlossen werden. Bitte erneut versuchen.')
      navigate('/craftsman/jobs')
    }, [job, user?.id, navigate])
  )

  const markDepositPaidAction = useCorridorAction(
    useCallback(async () => {
      if (!job) return
      await markDepositPaidForJobWorkflow(job.id)
      setJob(getJobById(job.id))
    }, [job]),
    { successMessage: 'Einzahlung bestätigt' }
  )

  const scheduleJobAction = useCorridorAction(
    useCallback(async () => {
      if (!job) return
      const { scheduledStart, scheduledEnd } = getDefaultScheduleTimes()
      const result = await performCanonicalScheduleSave({ jobId: job.id, scheduledStart, scheduledEnd })
      if (!result.success) throw new Error(result.error ?? 'Termin konnte nicht gespeichert werden')
      setSchedule(getScheduleForJob(job.id))
    }, [job]),
    { successMessage: 'Termin geplant' }
  )

  const rescheduleAction = useCorridorAction(
    useCallback(async () => {
      if (!job) return
      const now = Date.now()
      const oneDayMs = 24 * 60 * 60 * 1000
      const twoHoursMs = 2 * 60 * 60 * 1000
      // Route through the canonical save so the CalendarEntry moves with the
      // JobSchedule — a direct rescheduleJob() left the planning grid /
      // Operations board on the old day (appointment shown on two days at once).
      // suppressUpdateEvent: this is a reschedule, signalled by the dedicated
      // schedule_rescheduled event below — not a minor schedule_updated.
      const result = await performCanonicalScheduleSave({
        jobId: job.id,
        scheduledStart: now + oneDayMs,
        scheduledEnd: now + oneDayMs + twoHoursMs,
        suppressUpdateEvent: true,
      })
      if (!result.success) throw new Error(result.error ?? 'Termin konnte nicht verschoben werden')
      markScheduleRescheduled(job.id)
      setSchedule(getScheduleForJob(job.id))
    }, [job]),
    { successMessage: 'Termin verschoben' }
  )

  // No jobId in URL — redirect to job list
  if (!jobId) {
    return <Navigate to="/craftsman/jobs" replace />
  }

  // Job not found after hydration — show explicit not-found
  if (!job && loaded) {
    return (
      <AppShell>
        <CorridorNotFound
          entityLabel="Auftrag"
          backTo="/craftsman/jobs"
          backLabel="Zur Auftragsliste"
          subtitle="Dieser Auftrag existiert nicht mehr oder ist nicht verfügbar."
        />
      </AppShell>
    )
  }

  // Still loading — show skeleton
  if (!job) {
    return (
      <AppShell>
        <ScreenSkeleton eyebrow="Auftrag" lines={4} />
      </AppShell>
    )
  }

  const calendarEntry = getCalendarEntryByJobId(job.id)
  const invoice = getInvoiceByJobId(job.id)
  const payment = getPaymentForJobWorkflow(job.id)
  const proposalState = deriveProposalState(job)
  const proposalToneStyles: Record<
    ProposalStateView['tone'],
    { pill: string; dot: string }
  > = {
    slate: { pill: 'bg-slate-100 text-slate-700 ring-slate-200', dot: 'bg-slate-400' },
    amber: { pill: 'bg-amber-50 text-amber-700 ring-amber-100', dot: 'bg-amber-400' },
    green: { pill: 'bg-emerald-50 text-emerald-700 ring-emerald-100', dot: 'bg-emerald-400' },
    blue: { pill: 'bg-blue-50 text-blue-700 ring-blue-100', dot: 'bg-blue-400' },
    red: { pill: 'bg-red-50 text-red-700 ring-red-100', dot: 'bg-red-400' },
  }
  const proposalStateHint =
    proposalState.state === 'draft_blocked'
      ? 'Entwurf gespeichert, aber noch nicht versandbereit.'
      : proposalState.state === 'ready_to_send'
        ? 'Alle Voraussetzungen erfüllt. Angebot kann gesendet werden.'
        : proposalState.state === 'sent'
          ? 'Angebot gesendet – wartet auf Kundenentscheidung.'
          : proposalState.state === 'accepted'
            ? 'Angebot angenommen – Auftrag in Arbeit.'
            : proposalState.state === 'invalid'
              ? 'Ungültiger Angebotsstatus: Annahme gespeichert, aber Versandzeitpunkt fehlt.'
              : 'Noch kein Angebot erstellt.'

  const timelineEvents = buildProjectTimeline({
    job,
    calendarEntry,
    invoice,
    payment,
  })

  const handleAddNote = async () => {
    const trimmed = noteInput.trim()
    if (!trimmed) return
    await addOwnerNoteWorkflow({ job, body: trimmed }, session)
    setNoteInput('')
  }

  const handleStartJob = () => void startJobAction.execute()
  const handleSetWaitingPayment = () => void waitingPaymentAction.execute()



  const handleCreateInvoice = () => void createInvoiceAction.execute()

  const handleMarkDepositPaid = () => void markDepositPaidAction.execute()

  const handleScheduleJob = () => void scheduleJobAction.execute()

  const handleConfirmSchedule = () => {
    confirmSchedule(job.id)
  }

  const handleRescheduleSchedule = () => void rescheduleAction.execute()

  const handleCancelSchedule = () => {
    cancelSchedule(job.id)
    setSchedule(getScheduleForJob(job.id))
  }

  const handleMarkExecutionStarted = () => {
    markExecutionStarted(job.id)
    setSchedule(getScheduleForJob(job.id))
  }

  const handleMarkExecutionCompleted = () => {
    markExecutionCompleted(job.id)
    setSchedule(getScheduleForJob(job.id))
  }

  const CANCEL_BLOCKING_PAYMENT_STATES = new Set([
    'deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending', 'disputed',
  ])
  const canClose =
    job.status !== 'completed' &&
    job.status !== 'cancelled' &&
    !CANCEL_BLOCKING_PAYMENT_STATES.has(payment?.state ?? '') &&
    !fundingConfirmed

  return (
    <AppShell active="verwaltung">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">

          {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
           *  ZONE 1 — Kopf: Status, Terminal-Banner, kanonische Nächste Aktion
           *  Alles was jetzt handlungsrelevant ist.
           * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}

          <JobHeader job={job} />

          {job.status === 'cancelled' && (
            <CorridorTerminalBanner
              icon={<Icon icon={Ban} size="lg" />}
              title="Auftrag storniert"
              subtitle="Dieser Auftrag wurde beendet und ist nicht mehr aktiv."
              tone="cancelled"
            />
          )}

          <JobOutcomeBanner jobId={job.id} />
          <NewJobArrivalBanner jobId={job.id} />

          {/* Proposal state pill — only shown for pre-acceptance states */}
          {!job.proposalAcceptedAt && job.status === 'new' ? (
            <div className="mt-3 flex items-center gap-2 rounded-card bg-surface px-3 py-2 ring-1 ring-edge shadow-subtle">
              <span
                className={[
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1',
                  proposalToneStyles[proposalState.tone].pill,
                ].join(' ')}
              >
                <span
                  className={[
                    'h-1.5 w-1.5 rounded-full',
                    proposalToneStyles[proposalState.tone].dot,
                  ].join(' ')}
                />
                {proposalState.label}
              </span>
              {proposalStateHint ? (
                <span className="text-[12px] text-slate-500">
                  {proposalStateHint}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Kanonische Nächste Aktion — einziges CTA-System */}
          <CraftsmanJobOperationsCard
            job={job}
            onOperationComplete={() => {
              setJob(getJobById(job.id))
              setSchedule(getScheduleForJob(job.id))
            }}
            providerPayoutAccount={payoutAccount}
            followUpOfferExists={!!followUpOffer}
            followUpOfferLoading={job.jobKind === 'diagnosis' && !!job.sourceOfferId && !offersHydrated}
            onCreateFollowUpOffer={job.jobKind === 'diagnosis' && job.sourceOfferId ? () => {
              // If follow-up already exists, navigate to it; else open the composer
              if (followUpOffer) {
                navigate(`/craftsman/quotes/${followUpOffer.id}`)
                return
              }
              const threadLinkId = resolveThreadLinkForJob(
                job.sourceConversationId,
                job.projectId,
              )
              if (!threadLinkId) return
              navigate(
                `/craftsman/messages/${threadLinkId}?followUpDiagnosis=${job.sourceOfferId}`
              )
            } : undefined}
          />

          {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
           *  ZONE 2 — Operative Bearbeitung: Zahlung, Ausführung, Nachweise, Health
           * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}

          {job.status === 'new' ? (
            <JobIntakeContextCard job={job} />
          ) : null}

          {job.status === 'new' && !job.proposalSentAt && !job.proposalAcceptedAt ? (
            <div id="job-section-offer">
              <ProposalDraftCard jobId={job.id} />
            </div>
          ) : null}

          {job.status === 'new' ? (
            <ProposalReadinessCard jobId={job.id} />
          ) : null}

          {job.proposalAcceptedAt && job.status !== 'completed' && job.status !== 'cancelled' ? (
            <div id="job-section-payment">
              <CraftsmanJobSectionDivider label="Zahlungsvorbereitung" />
              <PaymentPrepCard jobId={job.id} />
            </div>
          ) : null}

          {/* ── Geldfluss-Übersicht — kanonische Money-Flow-Projektion ── */}
          {(() => {
            // Hydration gate (Z.125): resolveMoneyFlowProjection has no hydration
            // checks of its own — on cold load the payment/funding/escrow repos
            // are still empty and it would render "Kundenzahlung ausstehend" on an
            // already-funded job. Wait for all three payment-side repos first.
            if (
              !isPaymentRepositoryHydrated() ||
              !isFundingRequestRepositoryHydrated() ||
              !isEscrowPlanRepositoryHydrated()
            ) {
              return null
            }
            const moneyFlow = resolveMoneyFlowProjection(job.id, payoutAccount)
            if (!moneyFlow || !moneyFlow.hasEscrowPlan) return null
            return (
              <>
                <CraftsmanJobSectionDivider label="Geldfluss" />
                <MoneyFlowSummaryCard projection={moneyFlow} />
              </>
            )
          })()}

          {(() => {
            const isActiveExecution =
              job.status === 'in_progress' ||
              job.status === 'waiting_payment' ||
              (!!job.workCompletedAt && job.status !== 'completed' && job.status !== 'cancelled')
            return isActiveExecution ? (
              <>
                <CraftsmanJobSectionDivider label="Ausführungsfortschritt" />
                <ExecutionProgressCard jobId={job.id} role="craftsman" />
              </>
            ) : null
          })()}

          {/* ── Nachtrag-Sektion
           *  ChangeOrderSectionCard renders null + its own divider when nothing
           *  to show.  No separate CraftsmanJobSectionDivider needed here.
           * ── */}
          {job.craftsmanUserId ? (
            <ChangeOrderSectionCard
              jobId={job.id}
              craftsmanUserId={job.craftsmanUserId}
              isCraftsman
            />
          ) : null}

          {job.status === 'completed' ? (
            <>
              <CraftsmanJobSectionDivider label="Abschluss & Auszahlung" />
              <JobCompletionSummaryCard jobId={job.id} />
              {job.customerUserId && job.craftsmanUserId ? (
                <JobRatingCard
                  jobId={job.id}
                  providerUserId={job.craftsmanUserId}
                  customerUserId={job.customerUserId}
                />
              ) : null}
            </>
          ) : null}

          {hasDispute ? (
            <div id="job-section-dispute" className="space-y-3">
              <CraftsmanJobSectionDivider label="Konfliktfall" />
              <ReconciliationCenterLink jobId={job.id} variant="owner" />
              <DisputeStatusCard jobId={job.id} />
            </div>
          ) : null}

          <ProjectHealthSummaryCard jobId={job.id} />

          {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
           *  ZONE 3 — Kontext: Details, Verlauf, Dokumentation, Links, Admin
           * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}

          <CraftsmanJobSectionDivider label="Auftragsübersicht" />
          <JobDetailsCard job={job} />

          <SpatialDetailSection
            key={spatialRefreshTick}
            scope={{ jobId: job.id }}
            role="craftsman"
            onStartScan={handleStartSpatialScan}
          />

          <div id="job-section-timeline">
            <CraftsmanJobSectionDivider label="Auftragsverlauf" />
            <JobLifecycleFlow
              jobId={job.id}
              schedule={schedule}
              timelineEvents={timelineEvents}
              onSchedule={handleScheduleJob}
              onConfirmSchedule={handleConfirmSchedule}
              onReschedule={handleRescheduleSchedule}
              onCancelSchedule={handleCancelSchedule}
              onMarkExecutionStarted={handleMarkExecutionStarted}
              onMarkExecutionCompleted={handleMarkExecutionCompleted}
            />
          </div>

          <div id="job-section-documents">
            <CraftsmanJobSectionDivider label="Dokumentation" />
            {user?.id ? (
              <div className="rounded-container bg-surface p-4 ring-1 ring-edge shadow-subtle">
                <JobMediaSection jobId={job.id} ownerUserId={user.id} />
              </div>
            ) : null}
            <JobDocumentationSection
              documentationStatus={job.documentationStatus}
              photoCount={job.photoCount}
              ownerNotes={ownerNotes}
              noteInput={noteInput}
              onNoteInputChange={setNoteInput}
              onAddNote={() => { void handleAddNote() }}
            />
          </div>

          <JobActivitySection activities={job.activities} />

          <CraftsmanJobSectionDivider label="Verknüpfte Bereiche" />
          <div className="flex flex-wrap gap-2">
            <Link
              to="/craftsman/finance"
              className="inline-flex items-center gap-1.5 rounded-chip bg-surface px-3 py-1.5 text-[11px] font-medium text-ink-sub ring-1 ring-edge transition active:scale-[0.97]"
            >
              <CreditCard size={12} className="text-ink-muted" aria-hidden />
              <span>Finanzen</span>
            </Link>
            <Link
              to="/craftsman/disputes"
              className="inline-flex items-center gap-1.5 rounded-chip bg-surface px-3 py-1.5 text-[11px] font-medium text-ink-sub ring-1 ring-edge transition active:scale-[0.97]"
            >
              <Scale size={12} className="text-ink-muted" aria-hidden />
              <span>Streitfälle</span>
            </Link>
            {invoice && (
              <Link
                to="/craftsman/invoices"
                className="inline-flex items-center gap-1.5 rounded-chip bg-surface px-3 py-1.5 text-[11px] font-medium text-ink-sub ring-1 ring-edge transition active:scale-[0.97]"
              >
                <Receipt size={12} className="text-ink-muted" aria-hidden />
                <span>Rechnung</span>
              </Link>
            )}
            <Link
              to={(() => {
                const threadLinkId = resolveThreadLinkForJob(
                  job.sourceConversationId,
                  job.projectId,
                )
                return threadLinkId
                  ? `/craftsman/messages/${threadLinkId}`
                  : '/craftsman/messages'
              })()}
              className="inline-flex items-center gap-1.5 rounded-chip bg-surface px-3 py-1.5 text-[11px] font-medium text-ink-sub ring-1 ring-edge transition active:scale-[0.97]"
            >
              <MessageCircle size={12} className="text-ink-muted" aria-hidden />
              <span>Nachrichten</span>
            </Link>
          </div>

          <AdminGate>
            <div className="space-y-4">
              <InlineFeedback
                error={startJobAction.error ?? waitingPaymentAction.error ?? createInvoiceAction.error ?? markDepositPaidAction.error ?? scheduleJobAction.error}
                onDismiss={() => { startJobAction.clearError(); waitingPaymentAction.clearError(); createInvoiceAction.clearError(); markDepositPaidAction.clearError(); scheduleJobAction.clearError() }}
              />
              <JobOperationsCard
                isLoading={startJobAction.isLoading || waitingPaymentAction.isLoading || createInvoiceAction.isLoading || markDepositPaidAction.isLoading}
                onStartJob={handleStartJob}
                onSetWaitingPayment={handleSetWaitingPayment}

                onCreateInvoice={handleCreateInvoice}
                onMarkDepositPaid={handleMarkDepositPaid}
              />

              <JobStatusSection
                currentStatus={job.status}
                onChange={(status: Job['status']) => {
                  void setJobStatusWorkflow(job.id, status).then(() => setJob(getJobById(job.id)))
                }}
              />

              <div id="job-section-assignment">
                <JobTeamSection
                  teamMembers={teamMembers}
                  assignedMemberIds={job.assignedMemberIds}
                  onToggleMember={(memberId: string) =>
                    toggleAssignedMemberWorkflow(job.id, memberId)
                  }
                />
              </div>
            </div>
          </AdminGate>

          {canClose && (
            <div className="rounded-container bg-surface p-4 ring-1 ring-edge shadow-subtle">
              <InlineFeedback error={closeCaseAction.error} onDismiss={closeCaseAction.clearError} className="mb-3" />
              <CorridorAction
                variant="destructive"
                onClick={() => void closeCaseAction.execute()}
                loading={closeCaseAction.isLoading}
              >
                {closeCaseAction.isLoading
                  ? 'Wird geschlossen…'
                  : job.status === 'new' && !job.proposalAcceptedAt
                    ? 'Anfrage ablehnen'
                    : 'Fall schließen'}
              </CorridorAction>
            </div>
          )}
        </div>
      </section>
    </AppShell>
  )
}
