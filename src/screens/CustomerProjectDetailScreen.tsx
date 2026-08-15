import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import ScreenNotFound from '../components/system/ScreenNotFound'
import InlineFeedback from '../components/system/InlineFeedback'
import { useAsyncAction } from '../hooks/useAsyncAction'
import AppShell from '../components/AppShell'
import { SpatialDetailSection } from '../components/spatial/SpatialDetailSection'
import ProjectStatusBadge from '../components/ProjectStatusBadge'
import CustomerProjectProgressTimeline from '../components/projects/CustomerProjectProgressTimeline'
import CustomerDisputeStatusCard from '../components/projects/CustomerDisputeStatusCard'
import CustomerOpenDisputeCard from '../components/projects/CustomerOpenDisputeCard'
import ReconciliationCenterLink from '../components/jobs/ReconciliationCenterLink'
import CustomerEscrowFundingCard, { type CustomerEscrowFundingCardHandle } from '../components/projects/CustomerEscrowFundingCard'
import CustomerReleaseProgressCard from '../components/projects/CustomerReleaseProgressCard'
import CustomerJobCompletionCard from '../components/projects/CustomerJobCompletionCard'
import CustomerInvoiceCard from '../components/projects/CustomerInvoiceCard'
import CustomerProposalStatusCard from '../components/projects/CustomerProposalStatusCard'
import CustomerProjectStateBlock from '../components/projects/CustomerProjectStateBlock'
import ExecutionProgressCard from '../components/jobs/ExecutionProgressCard'
import CustomerProjectSectionDivider from '../components/projects/CustomerProjectSectionDivider'
import CustomerProjectContextCard from '../components/projects/CustomerProjectContextCard'
import RequestDetailView from '../components/projects/RequestDetailView'
import CustomerSchedulingCard from '../components/projects/CustomerSchedulingCard'
import CustomerProjectSummaryCard from '../components/projects/CustomerProjectSummaryCard'
import ProjectOutboundRequestsCard from '../components/projects/ProjectOutboundRequestsCard'
import CustomerWorkProofSummaryCard from '../components/projects/CustomerWorkProofSummaryCard'
import CustomerPaymentSummaryCard from '../components/projects/CustomerPaymentSummaryCard'
import CustomerAwaitingScheduleCard from '../components/projects/CustomerAwaitingScheduleCard'
import ProjectMediaGrid from '../components/projects/ProjectMediaGrid'
import ProjectMediaUpload from '../components/projects/ProjectMediaUpload'
import CorridorTerminalBanner from '../components/system/CorridorTerminalBanner'
import { ContentSection, Icon } from '../components/primitives'
import { Star, CheckCircle2, Ban } from 'lucide-react'
import { useSmartBack } from '../hooks/useSmartBack'
import { useSession } from '../hooks/useSession'
import {
  getProjectHauptprojektStatus,
  subscribeThreadArtifacts,
} from '../lib/messages'
import {
  useChatHydrated,
  useChatThreads,
} from '../lib/chat'

import { setActiveThreadProjectWorkflow } from '../lib/workflow'
import { subscribeProjects, getProjectById, isProjectOperational, isProjectRepositoryHydrated } from '../lib/projects'
import { getJobById, subscribeJobs, isJobRepositoryHydrated } from '../lib/jobs'
import { resolveCanonicalProjectFacts } from '../lib/shared/canonicalProjectFacts'
import { deriveCanonicalProjection } from '../lib/shared/canonicalCustomerLifecycle'
import {
  getProjectConversationMessageCount,
  cancelProjectWorkflow,
  cancelAcceptedProjectWorkflow,
} from '../lib/workflow'
import { getDisputeByJobId, subscribeDisputes, isDisputeRepositoryHydrated } from '../lib/disputes'
import { getPaymentForJob, subscribePayments, isPaymentRepositoryHydrated } from '../lib/payments'
import { isFundingConfirmedForJob, subscribeFundingRequests, isFundingRequestRepositoryHydrated } from '../lib/payments/fundingRequest'
import { subscribeEscrowPlans, isEscrowPlanRepositoryHydrated } from '../lib/payments/escrow'
import { areRepositoriesHydrated } from '../lib/shared/repositoryReadiness'
import { canOpenDisputeForPaymentState } from '../lib/disputes/disputeSelectors'
import {
  getSupplementaryPaymentsByJobId,
  subscribeSupplementaryPayments,
  reconcileSupplementaryTimelineEvents,
} from '../lib/payments/supplementary'
import type { SupplementaryPaymentRequest } from '../lib/payments/supplementary'
import {
  getChangeOrdersByJobId,
  subscribeChangeOrders,
} from '../lib/changeOrders'
import type { ChangeOrder } from '../lib/changeOrders/types'
import { formatCents } from '../lib/shared/formatters'
import { startBuilderInquirySelection } from './customerProjectNavigation'
import CorridorAction from '../components/system/CorridorAction'
import { useToast } from '../hooks/useToast'

export default function CustomerProjectDetailScreen() {
  const { projectId } = useParams()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const goBack = useSmartBack('/projects')
  const [project, setProject] = useState(() => projectId ? getProjectById(projectId) : undefined)
  const { user } = useSession()
  const paymentSectionRef = useRef<HTMLDivElement>(null)
  const escrowCardRef = useRef<CustomerEscrowFundingCardHandle>(null)
  const hasScrolledRef = useRef(false)

  // Deterministic loaded decision:
  //   - project found → loaded
  //   - project not found AND repos hydrated → loaded (will render "not found")
  //   - project not found AND repos NOT hydrated → stay loading (subscription re-checks)
  const [loaded, setLoaded] = useState(() => {
    if (project) return true
    return isProjectRepositoryHydrated() && isJobRepositoryHydrated()
  })

  // True once payment, funding-request, and escrow-plan repos have all completed
  // their initial load. Payment-critical UI (cancel button, hero card placement,
  // open-dispute CTA) must not render based on stale/empty store data before this.
  const [paymentReady, setPaymentReady] = useState(() =>
    areRepositoriesHydrated([
      isPaymentRepositoryHydrated,
      isFundingRequestRepositoryHydrated,
      isEscrowPlanRepositoryHydrated,
      isDisputeRepositoryHydrated,
    ])
  )

  // True when the customer must fund escrow — used to hoist CustomerEscrowFundingCard
  // to the hero position so the user never has to scroll to start payment.
  // Declared before focusPayment so the scroll guard can reference it.
  // Guard on paymentReady: if repos not hydrated yet, default false (safe — card
  // renders in lower position). Subscriptions correct this after hydration.
  const [isDepositRequired, setIsDepositRequired] = useState(() => {
    if (!project?.sourceJobId) return false
    if (!isPaymentRepositoryHydrated() || !isFundingRequestRepositoryHydrated()) return false
    const payment = getPaymentForJob(project.sourceJobId)
    return payment?.state === 'deposit_required' && !isFundingConfirmedForJob(project.sourceJobId)
  })

  const [paymentState, setPaymentState] = useState<string | undefined>(() => {
    if (!project?.sourceJobId) return undefined
    if (!isPaymentRepositoryHydrated()) return undefined
    return getPaymentForJob(project.sourceJobId)?.state
  })

  const [fundingConfirmed, setFundingConfirmed] = useState(() => {
    if (!project?.sourceJobId) return false
    if (!isFundingRequestRepositoryHydrated() || !isEscrowPlanRepositoryHydrated()) return false
    return isFundingConfirmedForJob(project.sourceJobId)
  })

  // Auto-scroll to payment section when navigated with ?focus=payment.
  // Only activate when the project has a real job backing (sourceJobId)
  // and is NOT in deposit_required — when deposit is required, CustomerEscrowFundingCard
  // is hoisted to the hero position so the user can act without scrolling at all.
  const focusPayment = searchParams.get('focus') === 'payment'
    && !!project?.sourceJobId
    && !isDepositRequired
  useEffect(() => {
    if (focusPayment && paymentSectionRef.current && !hasScrolledRef.current) {
      hasScrolledRef.current = true
      paymentSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [focusPayment, project])

  // ?focus=dispute deep-links from AttentionItem CTAs and notifications.
  // Customers do not have a profile-side reconciliation center, so the
  // project page is the canonical landing surface — scroll the dispute
  // section into view once the project is loaded.
  const focusDispute = searchParams.get('focus') === 'dispute' && !!project?.sourceJobId
  useEffect(() => {
    if (!focusDispute || hasScrolledRef.current) return
    const el = document.getElementById('job-section-dispute')
    if (el) {
      hasScrolledRef.current = true
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [focusDispute, project])

  // Keep project in sync with store changes (e.g. when craftsman accepts and
  // convertInquiryToProjectWorkflow sets sourceJobId on this project).
  // Also re-evaluate loaded state after hydration completion.
  useEffect(() => {
    if (!projectId) return
    function refresh() {
      const found = getProjectById(projectId!)
      setProject(found)
      if (found || (isProjectRepositoryHydrated() && isJobRepositoryHydrated())) {
        setLoaded(true)
      }
    }
    refresh()
    const unsubProjects = subscribeProjects(refresh)
    const unsubJobs = subscribeJobs(refresh)
    return () => { unsubProjects(); unsubJobs() }
  }, [projectId])

  // Whether this is a builder-created project that hasn't been linked to a job yet
  const isBuilderProject = project?.source === 'builder' && !project.sourceJobId

  // ── Canonical lifecycle projection ────────────────────────────────
  // Uses the shared canonical resolver so the same dominance hierarchy
  // (job truth > stale project fields) applies everywhere.
  const canonical = project ? deriveCanonicalProjection(project) : undefined
  const canonicalStatus = canonical?.status ?? project?.status

  // ── Canonical eyebrow: show "Auftrag" for accepted jobs ─────────────
  const headerEyebrow = canonicalStatus === 'accepted' || canonicalStatus === 'scheduled'
    || canonicalStatus === 'in_progress' || canonicalStatus === 'review'
    ? 'Auftrag'
    : 'Projekt'

  const [messageCount, setMessageCount] = useState(() => {
    if (!project) return 0
    // For job-linked (non-builder) projects the conversation is keyed by
    // job.projectId (the synthetic ID shared with conversation.projectId),
    // not by project.id (which is the UI-facing project identifier).
    // For builder-origin projects without a backing job yet, fall back to
    // project.id; it won't match a conversation, so project.messageCount is
    // used as the denormalized fallback.
    // sourceConversationId provides the canonical conversation lookup path
    // and prevents 0-message fallback when linkJobToProject has changed
    // job.projectId away from the original synthetic conversation key.
    const job = project.sourceJobId ? getJobById(project.sourceJobId) : undefined
    return getProjectConversationMessageCount(
      job?.projectId ?? project.id,
      project.messageCount,
      job?.sourceConversationId
    )
  })
  // Slice 2 M2: chat-domain hydration drives the messages-ready gate; the
  // legacy `isMessageRepositoryHydrated()` initial check stays for the
  // auxiliary `loaded` flag in the broader readiness chain (it is now
  // mirror-equivalent for migrated threads).
  const messagesHydrated = useChatHydrated()
  // Chat-domain mutation signal — used as a useEffect dep so that the
  // subscription callbacks below (syncMessageCount + Hauptprojekt refresh)
  // re-run on any chat-domain change without keeping legacy `subscribeMessages`
  // attached. Per-thread filtering is not required: refresh closures already
  // read project-scoped state from the legacy stores.
  const chatThreadsTick = useChatThreads()
  // Dispute truth is unknown until the dispute repo has hydrated — fail closed
  // to "no dispute" (the status card stays hidden) rather than reading an empty
  // pre-hydration store. subscribeDisputes re-runs syncDisputeState on hydrate.
  const [hasDispute, setHasDispute] = useState(
    project && isDisputeRepositoryHydrated() ? !!getDisputeByJobId(project.sourceJobId) : false
  )
  const [jobIsCompleted, setJobIsCompleted] = useState(() => {
    if (!project?.sourceJobId) return false
    const job = getJobById(project.sourceJobId)
    return job?.status === 'completed' || job?.status === 'cancelled'
  })
  const [canOpenDispute, setCanOpenDispute] = useState(() => {
    if (!project) return false
    // Gate on BOTH payment and dispute hydration: without the dispute guard a
    // resolved/rejected dispute on a job whose payment resumed a non-terminal
    // state would surface the "Konflikt öffnen" CTA on cold reload until
    // subscribeDisputes notifies.
    if (!isPaymentRepositoryHydrated() || !isDisputeRepositoryHydrated()) return false
    const dispute = getDisputeByJobId(project.sourceJobId)
    if (dispute) return false
    const payment = getPaymentForJob(project.sourceJobId)
    return payment ? canOpenDisputeForPaymentState(payment.state) : false
  })

  // Pending supplementary payment requests for this job — shown as a banner
  const [pendingSupplementaryPayments, setPendingSupplementaryPayments] = useState<SupplementaryPaymentRequest[]>(() => {
    if (!project?.sourceJobId) return []
    return getSupplementaryPaymentsByJobId(project.sourceJobId).filter(
      (r) => r.status === 'pending' || r.status === 'acknowledged' || r.status === 'funding_initiated'
    )
  })

  // ChangeOrders visible to the customer: pending (needs decision) and accepted
  const [customerChangeOrders, setCustomerChangeOrders] = useState<ChangeOrder[]>(() => {
    if (!project?.sourceJobId) return []
    return getChangeOrdersByJobId(project.sourceJobId).filter(
      (co) => co.status === 'pending' || co.status === 'accepted'
    )
  })

  // Track whether this project is the active Hauptprojekt for any thread.
  const [hauptprojektStatus, setHauptprojektStatus] = useState<
    { isActive: boolean; threadId: string } | null
  >(() => (projectId ? getProjectHauptprojektStatus(projectId) : null))

  // Keep Hauptprojekt state in sync with BOTH the chat-domain bus
  // (`chatThreadsTick` dep) and the legacy messages bus (`subscribeMessages`
  // + `subscribeThreadArtifacts`). `getProjectHauptprojektStatus` reads from
  // the legacy conversations + thread_artifacts stores, whose `notify()` bus
  // is separate from the chat repo's. A `conversations.sourceProjectId`
  // mutation emitted only on the legacy bus would otherwise leave the
  // Hauptprojekt badge stale (Plan §11 R6 — semantic equivalence). The
  // queueMicrotask defers the initial setState past the effect body to
  // satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    const refresh = () => {
      if (cancelled) return
      setHauptprojektStatus(getProjectHauptprojektStatus(projectId))
    }
    queueMicrotask(refresh)
    const unsubArtifacts = subscribeThreadArtifacts(refresh)
    return () => {
      cancelled = true
      unsubArtifacts()
    }
  }, [projectId, chatThreadsTick, messagesHydrated])

  function handleSetAsHauptprojekt() {
    if (!projectId || !hauptprojektStatus) return
    try {
      setActiveThreadProjectWorkflow(hauptprojektStatus.threadId, projectId)
      setHauptprojektStatus(getProjectHauptprojektStatus(projectId))
      toast.success('Hauptprojekt gesetzt')
    } catch {
      toast.error('Hauptprojekt konnte nicht gesetzt werden')
    }
  }


  useEffect(() => {
    if (!project) return

    const syncMessageCount = () => {
      const job = project.sourceJobId ? getJobById(project.sourceJobId) : undefined
      setMessageCount(
        getProjectConversationMessageCount(
          job?.projectId ?? project.id,
          project.messageCount,
          job?.sourceConversationId
        )
      )
      // Hydration is now sourced from `useChatHydrated()` (component scope);
      // no per-tick setter needed — React keeps `messagesHydrated` in sync
      // via the hook subscription.
    }

    const syncDisputeState = () => {
      const ready = areRepositoriesHydrated([
        isPaymentRepositoryHydrated,
        isFundingRequestRepositoryHydrated,
        isEscrowPlanRepositoryHydrated,
        isDisputeRepositoryHydrated,
      ])
      setPaymentReady(ready)
      // Fail closed on dispute truth until the dispute repo has hydrated: never
      // show the "Konflikt öffnen" CTA nor hide the status card based on an empty
      // pre-hydration store.
      const disputeHydrated = isDisputeRepositoryHydrated()
      const dispute = disputeHydrated ? getDisputeByJobId(project.sourceJobId) : undefined
      setHasDispute(disputeHydrated && !!dispute)
      const payment = getPaymentForJob(project.sourceJobId)
      if (!disputeHydrated) {
        setCanOpenDispute(false)
      } else if (!dispute) {
        setCanOpenDispute(payment ? canOpenDisputeForPaymentState(payment.state) : false)
      } else {
        setCanOpenDispute(false)
      }
      const confirmed = isFundingConfirmedForJob(project.sourceJobId)
      setFundingConfirmed(confirmed)
      setIsDepositRequired(payment?.state === 'deposit_required' && !confirmed)
      setPaymentState(payment?.state)
    }

    syncMessageCount()
    syncDisputeState()

    const syncJobCompletion = () => {
      if (!project.sourceJobId) return
      const job = getJobById(project.sourceJobId)
      setJobIsCompleted(job?.status === 'completed' || job?.status === 'cancelled')
    }
    syncJobCompletion()

    // Slice 2 M2: chat-domain mutation signal drives syncMessageCount via the
    // useEffect dep `chatThreadsTick` (see hook at component top). The initial
    // call already happens at line 344 above; the effect re-runs on dep change.
    // No legacy subscribeMessages handle here — the Hauptprojekt useEffect now
    // owns that subscription for state that depends on the legacy bus.

    const unsubscribeJobs = subscribeJobs(() => {
      syncJobCompletion()
    })

    const unsubscribeDisputes = subscribeDisputes(() => {
      syncDisputeState()
    })

    const unsubscribePayments = subscribePayments(() => {
      syncDisputeState()
    })

    const syncFundingConfirmed = () => {
      setPaymentReady(areRepositoriesHydrated([
        isPaymentRepositoryHydrated,
        isFundingRequestRepositoryHydrated,
        isEscrowPlanRepositoryHydrated,
        isDisputeRepositoryHydrated,
      ]))
      const confirmed = isFundingConfirmedForJob(project.sourceJobId)
      setFundingConfirmed(confirmed)
      const payment = getPaymentForJob(project.sourceJobId)
      setIsDepositRequired(payment?.state === 'deposit_required' && !confirmed)
    }
    const unsubscribeFundingRequests = subscribeFundingRequests(syncFundingConfirmed)
    const unsubscribeEscrowPlans = subscribeEscrowPlans(syncFundingConfirmed)

    const syncSupplementaryPayments = () => {
      if (!project.sourceJobId) return
      const allSpr = getSupplementaryPaymentsByJobId(project.sourceJobId)
      for (const spr of allSpr) reconcileSupplementaryTimelineEvents(spr)
      setPendingSupplementaryPayments(
        allSpr.filter(
          (r) => r.status === 'pending' || r.status === 'acknowledged' || r.status === 'funding_initiated'
        )
      )
    }
    syncSupplementaryPayments()
    const unsubscribeSupplementary = subscribeSupplementaryPayments(syncSupplementaryPayments)

    const syncChangeOrders = () => {
      if (!project.sourceJobId) return
      setCustomerChangeOrders(
        getChangeOrdersByJobId(project.sourceJobId).filter(
          (co) => co.status === 'pending' || co.status === 'accepted'
        )
      )
    }
    syncChangeOrders()
    const unsubscribeChangeOrders = subscribeChangeOrders(syncChangeOrders)

    return () => {
      unsubscribeJobs()
      unsubscribeDisputes()
      unsubscribePayments()
      unsubscribeSupplementary()
      unsubscribeChangeOrders()
      unsubscribeFundingRequests()
      unsubscribeEscrowPlans()
    }
    // chatThreadsTick + messagesHydrated added so a new chat-domain emit
    // (artifact_card or text message) re-runs the effect — covers the
    // refresh trigger previously delivered by legacy subscribeMessages.
  }, [project, chatThreadsTick, messagesHydrated])

  function handleBuilderInquiry() {
    if (!project) return
    startBuilderInquirySelection(project.id, navigate)
  }

  // Direct payment trigger — calls the EscrowFundingCard's imperative handle
  // so the payment flow starts immediately, then scrolls the card into view.
  function handlePaymentAction() {
    escrowCardRef.current?.startPayment()
    // When deposit_required, EscrowFundingCard is at hero position — no scroll needed
    if (!isDepositRequired) {
      paymentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const cancelAction = useAsyncAction(
    useCallback(async () => {
      if (!project) throw new Error('Kein Projekt geladen')
      const result = isProjectOperational(project)
        ? await cancelAcceptedProjectWorkflow(project.id)
        : await cancelProjectWorkflow(project.id)
      if (!result) throw new Error('Projekt konnte nicht storniert werden. Bitte erneut versuchen.')
      navigate('/projects')
      return result
    }, [project, navigate])
  )

  const CANCEL_BLOCKING_PAYMENT_STATES = new Set([
    'deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending', 'disputed',
  ])
  // Gate on paymentReady: never show cancel while payment state is unknown.
  // Without this, paymentState=undefined on cold start passes the blocking check
  // (!CANCEL_BLOCKING_PAYMENT_STATES.has('') === true), exposing the cancel button
  // to customers who have already paid the deposit.
  const canCancel =
    paymentReady &&
    project != null &&
    canonicalStatus !== 'completed' &&
    canonicalStatus !== 'cancelled' &&
    !CANCEL_BLOCKING_PAYMENT_STATES.has(paymentState ?? '') &&
    !fundingConfirmed

  if (!project && !loaded) {
    return (
      <AppShell active="home">
        <ScreenSkeleton eyebrow="Projekt" lines={4} />
      </AppShell>
    )
  }

  if (!project) {
    return (
      <AppShell active="home">
        <ScreenNotFound
          title="Projekt nicht gefunden"
          subtitle="Das Projekt konnte nicht geladen werden oder existiert nicht mehr."
          backTo="/projects"
          backLabel="Zu meinen Projekten"
        />
      </AppShell>
    )
  }

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center rounded-chip bg-surface px-4 py-2 text-[14px] font-medium text-ink-sub ring-1 ring-edge shadow-subtle"
          >
            ← Zurück
          </button>

          {/* ── Project header ── */}
          {(() => {
            const facts = project.sourceJobId
              ? resolveCanonicalProjectFacts(project.sourceJobId)
              : null
            const displayTitle = facts?.title ?? project.title
            const displayLocation = facts?.location ?? project.location
            const displayDateLabel = facts?.dateLabel ?? project.dateLabel

            return (
              <ContentSection
                eyebrow={headerEyebrow}
                title={displayTitle}
                headerRight={<ProjectStatusBadge status={canonicalStatus!} />}
              >
                <p className="text-[12px] text-ink-muted">{displayLocation} · {displayDateLabel}</p>
                <p className="mt-1.5 text-[14px] text-ink-sub">
                  {(() => {
                    if (project.craftsman) return project.craftsman
                    const linkedJob = project.sourceJobId ? getJobById(project.sourceJobId) : undefined
                    if (linkedJob?.proposalAcceptedAt) return linkedJob.jobKind === 'diagnosis' ? 'Diagnoseeinsatz freigegeben' : 'Handwerker beauftragt'
                    if (linkedJob?.proposalSentAt) return linkedJob.jobKind === 'diagnosis' ? 'Handwerker hat Diagnose-Anfrage gesendet' : 'Handwerker hat Angebot gesendet'
                    if (linkedJob) return 'Handwerker prüft Anfrage'
                    return 'Noch kein Handwerker zugewiesen'
                  })()}
                </p>
              </ContentSection>
            )
          })()}

          {projectId ? (
            <SpatialDetailSection scope={{ projectId }} role="customer" />
          ) : null}

          {/* ── Terminal state banners (prominent, near top) ── */}
          {canonicalStatus === 'completed' && (
            <CorridorTerminalBanner
              icon={<Icon icon={CheckCircle2} size="lg" />}
              title="Projekt abgeschlossen"
              subtitle="Alle Arbeiten sind erledigt. Der Auftrag wurde erfolgreich abgeschlossen."
              tone="completed"
            />
          )}
          {canonicalStatus === 'cancelled' && (
            <CorridorTerminalBanner
              icon={<Icon icon={Ban} size="lg" />}
              title="Projekt storniert"
              subtitle="Dieses Projekt wurde beendet und ist nicht mehr aktiv."
              tone="cancelled"
            />
          )}

          {/* ── Builder project: structured summary + inquiry CTA ── */}
          {isBuilderProject && (
            <>
              <CustomerProjectSectionDivider label="Projektbeschreibung" />
              <CustomerProjectSummaryCard
                project={project}
                onStartInquiry={handleBuilderInquiry}
              />

              {/* Full request detail view (Level 2) — trade-specific answers, etc. */}
              <RequestDetailView project={project} />

              {/* Project media — persisted photos from Supabase (reload-safe) */}
              <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-subtle">
                <ProjectMediaGrid
                  projectId={project.id}
                  viewerUserId={user?.id}
                  showEmptyState
                />
                {user?.id ? (
                  <div className="mt-3">
                    <ProjectMediaUpload
                      projectId={project.id}
                      ownerUserId={user.id}
                    />
                  </div>
                ) : null}
              </div>

              <ProjectOutboundRequestsCard projectId={project.id} />
            </>
          )}

          {/* ── Cancelled takeover — decisive, not disorienting ── */}
          {canonicalStatus === 'cancelled' && (
            <div className="rounded-[20px] bg-rose-50 px-4 py-4 ring-1 ring-rose-200">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-[18px]">🚫</span>
                <div>
                  <p className="text-[14px] font-semibold text-rose-800">
                    Dieses Projekt wurde storniert.
                  </p>
                  <p className="mt-1 text-[13px] leading-snug text-rose-700">
                    Es werden keine weiteren Aktionen ausgeführt.
                  </p>
                  <Link
                    to="/projects"
                    className="mt-3 inline-flex items-center rounded-full bg-white px-3 py-1.5 text-[13px] font-semibold text-rose-700 ring-1 ring-rose-200 transition active:scale-[0.98]"
                  >
                    ← Zu meinen Projekten
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* ── Job-linked project: operational sections (hidden when cancelled) ── */}
          {!isBuilderProject && canonicalStatus !== 'cancelled' && (
            <>
              {/* ── Central state + action block ── */}
              <CustomerProjectStateBlock
                jobId={project.sourceJobId}
                onPaymentAction={handlePaymentAction}
              />

              {/* ── Active-only sections (hidden for terminal states) ── */}
              {!jobIsCompleted && (
                <>
                  {/* ── Deposit: hero payment surface ──────────────────────────────────────
                      When deposit_required, CustomerEscrowFundingCard renders here — directly
                      below CustomerProjectStateBlock — so the customer can act in 1 tap without
                      any scroll. The ref is attached here; the lower section suppresses the card.
                  ── */}
                  {isDepositRequired && (
                    <CustomerEscrowFundingCard ref={escrowCardRef} jobId={project.sourceJobId} />
                  )}

                  {/* Proposal card: only relevant while offer is pending or just accepted.
                      Once execution has started it becomes a historical milestone. */}
                  {(canonicalStatus === 'request' || canonicalStatus === 'accepted') && (
                    <CustomerProposalStatusCard jobId={project.sourceJobId} />
                  )}

                  {/* ── Section: Scheduling — only during pre-execution phases ── */}
                  {(canonicalStatus === 'accepted' || canonicalStatus === 'scheduled') && (
                    <>
                      <CustomerProjectSectionDivider label="Termin" />
                      <CustomerSchedulingCard jobId={project.sourceJobId} />
                      <CustomerAwaitingScheduleCard jobId={project.sourceJobId} />
                    </>
                  )}
                </>
              )}

              {/* ── Section: Progress timeline ── */}
              <CustomerProjectSectionDivider label="Projektverlauf" />

              <CustomerProjectProgressTimeline jobId={project.sourceJobId} />

              {/* ── Section: Payment & dispute — hidden during initial request phase ── */}
              {canonicalStatus !== 'request' && (
              <div ref={paymentSectionRef}>
                <CustomerProjectSectionDivider label="Zahlung" />

                {/* ── At-a-glance financial summary (secondary to action card).
                    onCtaClick scrolls to this section for non-escrow CTAs
                    (e.g. release_pending → "Freigabe prüfen →"). ── */}
                <CustomerPaymentSummaryCard
                  jobId={project.sourceJobId}
                  onCtaClick={() => paymentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                />

                {/* ── Supplementary payment banner —
                    Shown when an accepted Nachtrag created an additional payment obligation
                    after the original escrow was already locked.  The customer sees the
                    amount, the status, and a link to the ChangeOrder detail for action.
                ── */}
                {pendingSupplementaryPayments.length > 0 && (
                  <div className="space-y-2">
                    {pendingSupplementaryPayments.map((req) => (
                      <div
                        key={req.id}
                        className="rounded-card bg-amber-50 px-4 py-3 ring-1 ring-amber-200/60 space-y-2"
                        data-testid="supplementary-payment-banner"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[14px]">
                            {req.status === 'funding_initiated' ? '⏳' : '⚠️'}
                          </span>
                          <p className="text-[13px] font-semibold text-amber-900">
                            {req.status === 'funding_initiated'
                              ? `Nachzahlung ${formatCents(req.amountCents)} wird verarbeitet`
                              : `Nachzahlung erforderlich: ${formatCents(req.amountCents)}`}
                          </p>
                        </div>
                        <p className="text-[12px] text-amber-800">
                          {req.status === 'funding_initiated'
                            ? 'Die Zahlung wurde gestartet und wird verarbeitet.'
                            : 'Ein angenommener Nachtrag erzeugt einen zusätzlichen Zahlungsbedarf.'}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Link
                            to={`/supplementary-funding/${req.id}`}
                            className="inline-flex items-center rounded-card bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                            data-testid="supplementary-pay-now-banner"
                          >
                            {formatCents(req.amountCents)} jetzt bezahlen
                          </Link>
                          <Link
                            to={`/nachtrag/${req.changeOrderId}`}
                            className="inline-flex items-center text-[12px] font-semibold text-amber-700 underline underline-offset-2 hover:text-amber-900"
                          >
                            Nachtrag ansehen →
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Customer ChangeOrder section ──
                    Shows pending COs the customer needs to decide on, and
                    accepted COs for reference. Deep-links to
                    ChangeOrderDetailScreen (/nachtrag/:id) for action.
                    Suppressed when the supplementary banner already links
                    to the CO — but we still show the compact list so the
                    customer has the full picture.
                ── */}
                {customerChangeOrders.length > 0 && (
                  <div
                    className="space-y-2"
                    data-testid="customer-change-orders-section"
                  >
                    {customerChangeOrders.map((co) => {
                      const isPending = co.status === 'pending'
                      const deltaLabel = co.grossTotal != null
                        ? (co.grossTotal >= 0 ? '+' : '') + formatCents(co.grossTotal)
                        : co.price
                      return (
                        <div
                          key={co.id}
                          className={[
                            'rounded-card px-4 py-3 ring-1 space-y-1',
                            isPending
                              ? 'bg-amber-50 ring-amber-200/60'
                              : 'bg-slate-50 ring-edge',
                          ].join(' ')}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-[14px]">
                              {isPending ? '📝' : '✅'}
                            </span>
                            <p className={[
                              'text-[13px] font-semibold',
                              isPending ? 'text-amber-900' : 'text-slate-800',
                            ].join(' ')}>
                              {isPending ? 'Nachtrag ausstehend' : 'Nachtrag angenommen'}: {deltaLabel}
                            </p>
                          </div>
                          <p className={[
                            'text-[12px]',
                            isPending ? 'text-amber-800' : 'text-slate-600',
                          ].join(' ')}>
                            {co.description}
                          </p>
                          <Link
                            to={`/nachtrag/${co.id}`}
                            className={[
                              'mt-1 inline-flex items-center text-[12px] font-semibold underline underline-offset-2',
                              isPending
                                ? 'text-amber-700 hover:text-amber-900'
                                : 'text-slate-600 hover:text-slate-800',
                            ].join(' ')}
                          >
                            {isPending ? 'Nachtrag prüfen →' : 'Nachtrag ansehen →'}
                          </Link>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Only show execution progress when work is done and payment pending —
                    execution_active state is already covered by the primary state block above. */}
                {canonicalStatus === 'review' && (
                  <ExecutionProgressCard jobId={project.sourceJobId} role="customer" />
                )}

                <CustomerWorkProofSummaryCard jobId={project.sourceJobId} />

                {/* Customer invoice and payment release surface */}
                <CustomerInvoiceCard jobId={project.sourceJobId} />

                {/* Suppressed when deposit_required — card is hoisted to hero position with ref */}
                {!isDepositRequired && (
                  <CustomerEscrowFundingCard ref={escrowCardRef} jobId={project.sourceJobId} />
                )}
                {/* ── Release progress — per-tranche visibility ── */}
                <CustomerReleaseProgressCard jobId={project.sourceJobId} />

                {hasDispute ? (
                  <div id="job-section-dispute" className="space-y-3">
                    <ReconciliationCenterLink jobId={project.sourceJobId} variant="customer" />
                    <CustomerDisputeStatusCard jobId={project.sourceJobId} />
                  </div>
                ) : null}

                {canOpenDispute && !hasDispute ? (
                  <CustomerOpenDisputeCard
                    jobId={project.sourceJobId}
                    onDisputeOpened={() => setCanOpenDispute(false)}
                  />
                ) : null}

                <CustomerJobCompletionCard jobId={project.sourceJobId} />
              </div>
              )}

              <CustomerProjectContextCard
                price={project.sourceJobId
                  ? (resolveCanonicalProjectFacts(project.sourceJobId)?.canonicalAmount.formatted || project.price)
                  : project.price}
                photoCount={project.photoCount}
                noteCount={project.noteCount}
                messageCount={messageCount}
                messagesLoading={!messagesHydrated && messageCount === 0}
              />
            </>
          )}

          {/* ── Hauptprojekt status (hidden when cancelled) ── */}
          {hauptprojektStatus && canonicalStatus !== 'cancelled' && (
            <div
              className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-subtle"
              data-testid="hauptprojekt-status-section"
            >
              {hauptprojektStatus.isActive ? (
                <div
                  className="flex items-center gap-2 rounded-card bg-warn/5 px-4 py-3 ring-1 ring-warn/20"
                  data-testid="hauptprojekt-active-badge"
                >
                  <Icon icon={Star} size="sm" className="shrink-0 text-warn" />
                  <span className="text-[14px] font-medium text-ink">
                    Dieses Projekt ist aktuell dein Hauptprojekt
                  </span>
                </div>
              ) : (
                <CorridorAction
                  variant="secondary"
                  onClick={handleSetAsHauptprojekt}
                  aria-label="Als Hauptprojekt setzen"
                  data-testid="set-hauptprojekt-cta"
                >
                  ★ Als Hauptprojekt setzen
                </CorridorAction>
              )}
            </div>
          )}

          {/* ── Cancel / Close action ── */}
          {canCancel && (
            <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-subtle">
              <InlineFeedback error={cancelAction.error} onDismiss={cancelAction.clearError} className="mb-3" />
              <CorridorAction
                variant="destructive"
                onClick={() => void cancelAction.execute()}
                loading={cancelAction.isLoading}
              >
                {cancelAction.isLoading
                  ? 'Wird storniert…'
                  : canonicalStatus === 'request'
                    ? 'Anfrage zurückziehen'
                    : 'Projekt stornieren'}
              </CorridorAction>
            </div>
          )}
        </div>
      </section>
    </AppShell>
  )
}
