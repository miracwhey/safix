import { Link } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, FolderOpen } from 'lucide-react'
import AppShell from '../components/AppShell'
import PullToRefresh from '../components/system/PullToRefresh'
import { syncAllProjectsFromJobs } from '../lib/projects/projectJobSyncBridge'
import ContentSection from '../components/primitives/ContentSection'
import ProjectStatusBadge from '../components/ProjectStatusBadge'
import { getProjects, subscribeProjects, isProjectActive } from '../lib/projects'
import { subscribeJobs } from '../lib/jobs'
import { subscribePayments, isPaymentRepositoryHydrated } from '../lib/payments'
import { subscribeFundingRequests, isFundingRequestRepositoryHydrated } from '../lib/payments/fundingRequest'
import { subscribeEscrowPlans, isEscrowPlanRepositoryHydrated } from '../lib/payments/escrow'
import { subscribeDisputes } from '../lib/disputes'
import { subscribeTimeline } from '../lib/timeline'
import { areRepositoriesHydrated } from '../lib/shared/repositoryReadiness'
import type { Project } from '../lib/projects'
import type { PaymentState } from '../lib/shared/coreTypes'
import type { ProjectCaseStatus } from '../domain/projects/projectCaseTypes'
import { deriveCanonicalProjection } from '../lib/shared/canonicalCustomerLifecycle'
import { resolveCanonicalProjectFacts } from '../lib/shared/canonicalProjectFacts'
import { useSmartBack } from '../hooks/useSmartBack'

// ---------------------------------------------------------------------------
// Operational state chip — derived from project-level payment state + status
// ---------------------------------------------------------------------------

type OperationalChip = {
  label: string
  style: string
} | null

function deriveOperationalChip(
  status: ProjectCaseStatus,
  paymentState: PaymentState,
  fundingConfirmed: boolean | undefined,
  paymentReady: boolean,
): OperationalChip {
  if (status === 'completed' || status === 'cancelled') return null

  // All payment-driven chips wait for payment/funding/escrow/dispute repos
  // to finish their initial load. Otherwise a cold start can flash stale
  // mirror state (deposit_required, release_pending, disputed) for jobs
  // whose canonical truth has already advanced past that point.
  if (paymentReady) {
    // Show "Freigabe erforderlich" only during the 75 % customer approval
    // phase. During the 25 % auto-release Payment.state stays
    // 'work_in_progress', so this branch is naturally bypassed; the status
    // guard is defense-in-depth against stale dispute-rollback transitions
    // that can leave release_pending lingering outside the review phase.
    if (paymentState === 'release_pending' && status === 'review') {
      return {
        label: 'Freigabe erforderlich',
        style: 'bg-amber-50 text-amber-700 ring-amber-200',
      }
    }
    if (paymentState === 'disputed') {
      return {
        label: 'Streitfall aktiv',
        style: 'bg-rose-50 text-rose-700 ring-rose-200',
      }
    }
    if (paymentState === 'deposit_required' && !fundingConfirmed) {
      return {
        label: 'Zahlung ausstehend',
        style: 'bg-blue-50 text-blue-700 ring-blue-200',
      }
    }
    // Calm "gesichert" chip once the customer has funded and no release or
    // dispute is active yet. Makes the 25/75 mechanic visible on the list
    // before the detail screen is opened.
    if (
      fundingConfirmed &&
      (paymentState === 'deposit_paid' ||
        paymentState === 'in_escrow' ||
        paymentState === 'work_in_progress')
    ) {
      return {
        label: 'Zahlung abgesichert',
        style: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
      }
    }
  }
  if (status === 'in_progress') {
    return {
      label: 'In Durchführung',
      style: 'bg-slate-50 text-ink-sub ring-edge',
    }
  }
  if (status === 'scheduled') {
    return {
      label: 'Termin geplant',
      style: 'bg-blue-50 text-blue-700 ring-blue-200',
    }
  }
  return null
}

function ProjectListItem({ project, paymentReady }: { project: Project; paymentReady: boolean }) {
  const canonical = deriveCanonicalProjection(project)
  const chip = deriveOperationalChip(
    canonical.status,
    canonical.paymentState,
    canonical.fundingConfirmed,
    paymentReady,
  )

  const facts = project.sourceJobId
    ? resolveCanonicalProjectFacts(project.sourceJobId)
    : null
  const displayTitle = facts?.title ?? project.title
  const displayLocation = facts?.location ?? project.location
  const displayDateLabel = facts?.dateLabel ?? project.dateLabel
  const displayPrice = facts?.canonicalAmount?.formatted || project.price

  const isPaymentChip = chip && project.sourceJobId && (
    canonical.paymentState === 'deposit_required' ||
    canonical.paymentState === 'release_pending'
  )
  const linkTarget = isPaymentChip
    ? `/projects/${project.id}?focus=payment`
    : `/projects/${project.id}`

  return (
    <Link
      to={linkTarget}
      className="block rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated transition active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[16px] font-semibold text-ink">
            {displayTitle}
          </div>

          <div className="mt-1 text-[14px] text-ink-sub">
            {project.craftsman}
          </div>

          <div className="mt-1 text-[14px] text-ink-muted">
            {displayLocation} · {displayDateLabel}
          </div>
        </div>

        <ProjectStatusBadge status={canonical.status} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="text-[14px] font-semibold text-ink">
            {displayPrice}
          </div>
          {chip && (
            <span
              className={`inline-flex items-center rounded-chip px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${chip.style}`}
            >
              {chip.label}
            </span>
          )}
        </div>
        <div className="shrink-0 text-[14px] font-semibold text-brand">
          Öffnen
        </div>
      </div>
    </Link>
  )
}

export default function CustomerProjectsScreen() {
  const goBack = useSmartBack('/')
  const [projects, setProjects] = useState(() => getProjects())
  const [paymentReady, setPaymentReady] = useState(() =>
    areRepositoriesHydrated([
      isPaymentRepositoryHydrated,
      isFundingRequestRepositoryHydrated,
      isEscrowPlanRepositoryHydrated,
    ])
  )
  // Tick-counter forces chip recomputation when payment/funding/escrow
  // truth changes even though the project list is stable. Without this
  // the chip row would show stale payment state after realtime updates.
  const [, setPaymentTick] = useState(0)

  useEffect(() => {
    const refreshProjects = () => setProjects(getProjects())
    const bumpPayment = () => {
      setPaymentTick((t) => t + 1)
      setPaymentReady(areRepositoriesHydrated([
        isPaymentRepositoryHydrated,
        isFundingRequestRepositoryHydrated,
        isEscrowPlanRepositoryHydrated,
      ]))
    }
    const unsubProjects = subscribeProjects(refreshProjects)
    const unsubJobs = subscribeJobs(() => {
      refreshProjects()
      bumpPayment()
    })
    const unsubPayments = subscribePayments(bumpPayment)
    const unsubFunding = subscribeFundingRequests(bumpPayment)
    const unsubEscrow = subscribeEscrowPlans(bumpPayment)
    const unsubDisputes = subscribeDisputes(bumpPayment)
    const unsubTimeline = subscribeTimeline(bumpPayment)
    return () => {
      unsubProjects()
      unsubJobs()
      unsubPayments()
      unsubFunding()
      unsubEscrow()
      unsubDisputes()
      unsubTimeline()
    }
  }, [])

  // Pull-to-refresh: reconcile every project from its source job (server truth)
  // and re-read the projection. A guaranteed minimum so the spinner reads as a
  // deliberate refresh rather than a flicker even when the sync is instant.
  const handleRefresh = useCallback(async () => {
    await Promise.all([
      syncAllProjectsFromJobs().catch(() => {}),
      new Promise((r) => setTimeout(r, 500)),
    ])
    setProjects(getProjects())
    setPaymentTick((t) => t + 1)
    setPaymentReady(
      areRepositoriesHydrated([
        isPaymentRepositoryHydrated,
        isFundingRequestRepositoryHydrated,
        isEscrowPlanRepositoryHydrated,
      ])
    )
  }, [])

  return (
    <AppShell active="home">
      <PullToRefresh onRefresh={handleRefresh}>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <button
            type="button"
            onClick={goBack}
            aria-label="Zurück"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
          >
            <ArrowLeft size={18} className="text-ink" aria-hidden />
          </button>
          {/* ── Summary stats ── */}
          <ContentSection eyebrow="SaFix" title="Meine Projekte">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-container bg-brand p-4 text-white shadow-elevated">
                <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/75">
                  Gesamt
                </div>
                <div className="mt-3 text-[24px] font-semibold leading-none">
                  {projects.length}
                </div>
                <div className="mt-2 text-[13px] text-white/80">
                  Projekte im Überblick
                </div>
              </div>

              <div className="rounded-container bg-surface p-4 ring-1 ring-edge shadow-subtle">
                <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                  Aktiv
                </div>
                <div className="mt-3 text-[24px] font-semibold leading-none text-ink">
                  {projects.filter(isProjectActive).length}
                </div>
                <div className="mt-2 text-[13px] text-ink-muted">
                  Noch nicht abgeschlossen
                </div>
              </div>
            </div>
          </ContentSection>

          <div className="space-y-3">
            {projects.map((project) => (
              <ProjectListItem key={project.id} project={project} paymentReady={paymentReady} />
            ))}
            {projects.length === 0 && (
              <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated text-center">
                <div className="flex justify-center">
                  <FolderOpen size={28} className="text-ink-muted" aria-hidden />
                </div>
                <div className="mt-2 text-[15px] font-semibold text-ink">
                  Keine Projekte vorhanden
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                  Sie haben noch keine Projekte erstellt.
                </p>
                <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
                  Wenn Sie Projekte erstellt haben und diese hier nicht erscheinen, kann dies auf ein Problem mit der Kontozuordnung hinweisen.
                </p>
              </div>
            )}
          </div>

          {/* ── New project CTA ── */}
          <Link
            to="/projects/new"
            className="flex w-full items-center justify-center gap-2 rounded-container bg-brand py-4 text-[15px] font-semibold text-white shadow-elevated transition active:scale-[0.99]"
          >
            <span className="text-[18px] leading-none">+</span>
            Neues Projekt erstellen
          </Link>
        </div>
      </section>
      </PullToRefresh>
    </AppShell>
  )
}
