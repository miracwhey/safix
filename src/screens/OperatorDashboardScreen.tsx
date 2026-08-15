import React, { useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'
import { canAccessOperatorTools } from '../lib/access'
import {
  Search, Hammer, CreditCard, Settings, Scale, BarChart2, Shield,
  Satellite, AlertTriangle, CheckCircle2, ClipboardList, FileText,
  Calendar, X, ArrowLeft,
} from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  getJobs,
  subscribeJobs,
  deriveOperatorPriorityCases,
  type OperatorPriorityCase,
  type OperatorPrioritySeverity,
} from '../lib/jobs'
import { getAllPayments, subscribePayments } from '../lib/payments'
import { getDisputes, subscribeDisputes, isDisputeRepositoryHydrated } from '../lib/disputes'
import { getSchedules, subscribeOperations, isScheduleRepositoryHydrated } from '../lib/operations/operationsStore'
import { getTimelineSignals, subscribeTimeline, isTimelineRepositoryHydrated } from '../lib/timeline'
import { useStoreSync } from '../lib/reactive'
import {
  deriveOperatorCases,
  type OperatorCase,
  type OperatorCaseSeverity,
} from '../lib/operators/operatorCaseSelectors'
import { derivePilotDiagnosticsSummary, type PilotDiagnosticsSummary, formatAgeHours } from '../lib/pilot'
import PilotDiagnosticsBanner from '../components/pilot/PilotDiagnosticsBanner'
import {
  searchOperatorPriorityCases,
  searchOperatorPilotCases,
  filterOperatorPriorityCases,
  filterOperatorPilotCases,
} from '../lib/operators/searchSelectors'
import {
  getAnalyticsEvents,
  subscribeAnalyticsEvents,
  deriveMarketplaceMetrics,
  filterEventsSince,
  type MarketplaceMetrics,
} from '../lib/analytics'
import MarketplaceMetricsPanel from '../components/analytics/MarketplaceMetricsPanel'
import { getRatings, subscribeRatings } from '../lib/ratings'
import OperatorTrustPanel from '../components/trust/OperatorTrustPanel'
import {
  deriveOperatorIssueGroups,
  hasUrgentIssues,
  type OperatorIssueGroup,
} from '../lib/operators/operatorIssueGroups'
import OperatorIssueSummaryBar from '../components/operator/OperatorIssueSummaryBar'
import OperatorReportsPanel from '../components/operator/OperatorReportsPanel'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import { useSmartBack } from '../hooks/useSmartBack'

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

type SeverityStyle = {
  container: string
  badge: string
  icon: React.ReactNode
  badgeLabel: string
}

function getSeverityStyle(severity: OperatorPrioritySeverity): SeverityStyle {
  if (severity === 'high') {
    return {
      container: 'bg-white ring-rose-200/80',
      badge: 'bg-rose-50 text-rose-700 ring-rose-200',
      icon: <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />,
      badgeLabel: 'HIGH',
    }
  }
  if (severity === 'medium') {
    return {
      container: 'bg-white ring-amber-200/70',
      badge: 'bg-amber-50 text-amber-700 ring-amber-200',
      icon: <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />,
      badgeLabel: 'MEDIUM',
    }
  }
  return {
    container: 'bg-white ring-slate-200/70',
    badge: 'bg-slate-50 text-slate-600 ring-slate-200',
    icon: <span className="inline-block h-2 w-2 rounded-full bg-slate-300" />,
    badgeLabel: 'LOW',
  }
}

type TypeIcon = {
  icon: React.ReactNode
  label: string
}

function getTypeDisplay(type: OperatorPriorityCase['type']): TypeIcon {
  if (type === 'dispute') return { icon: <Scale size={18} aria-hidden />, label: 'Dispute' }
  if (type === 'stale_payment') return { icon: <CreditCard size={18} aria-hidden />, label: 'Payment' }
  return { icon: <Calendar size={18} aria-hidden />, label: 'Scheduling' }
}

// ---------------------------------------------------------------------------
// Priority case card
// ---------------------------------------------------------------------------

function PriorityCaseCard({ item }: { item: OperatorPriorityCase }) {
  const severityStyle = getSeverityStyle(item.severity)
  const typeDisplay = getTypeDisplay(item.type)

  return (
    <div
      className={`relative overflow-hidden rounded-[24px] p-4 ring-1 shadow-[0_12px_28px_-20px_rgba(2,6,23,0.22)] ${severityStyle.container}`}
    >
      {/* Left accent bar */}
      <div
        className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[24px] ${
          item.severity === 'high'
            ? 'bg-gradient-to-b from-rose-500 via-rose-400 to-rose-300'
            : item.severity === 'medium'
              ? 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300'
              : 'bg-gradient-to-b from-slate-400 via-slate-300 to-slate-200'
        }`}
      />

      <div className="flex items-center gap-3">
        {/* Type icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-100 ring-1 ring-slate-200">
          <span className="text-[18px] leading-none">{typeDisplay.icon}</span>
        </div>

        {/* Text */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold tracking-[0.15em] ring-1 ${severityStyle.badge}`}
            >
              {severityStyle.icon} {severityStyle.badgeLabel}
            </span>
            <span className="text-[11px] font-medium text-slate-400">
              {typeDisplay.label}
            </span>
          </div>
          <p className="mt-1 text-[14px] font-semibold leading-snug text-slate-900">
            {item.label}
          </p>
        </div>

        {/* Action links */}
        <div className="flex shrink-0 flex-col gap-1.5">
          <Link
            to={item.actionRoute}
            className="rounded-xl bg-[#0b1220] px-3 py-2 text-center text-[12px] font-bold tracking-[0.12em] text-white ring-1 ring-white/10 transition-transform duration-200 active:scale-[0.97]"
            style={{ boxShadow: '0 8px 18px -14px rgba(2,6,23,0.6)' }}
          >
            View →
          </Link>
          {item.type === 'dispute' && (
            <Link
              to="/craftsman/disputes"
              className="rounded-xl bg-rose-50 px-3 py-1.5 text-center text-[11px] font-bold text-rose-700 ring-1 ring-rose-200 transition-transform duration-200 active:scale-[0.97]"
            >
              Streitfall →
            </Link>
          )}
          {item.type === 'stale_payment' && (
            <Link
              to="/craftsman/finance"
              className="rounded-xl bg-blue-50 px-3 py-1.5 text-center text-[11px] font-bold text-blue-700 ring-1 ring-blue-200 transition-transform duration-200 active:scale-[0.97]"
            >
              Finanzen →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pilot case helpers
// ---------------------------------------------------------------------------

type PilotSeverityStyle = {
  container: string
  badge: string
  icon: React.ReactNode
  badgeLabel: string
}

function getPilotSeverityStyle(severity: OperatorCaseSeverity): PilotSeverityStyle {
  if (severity === 'critical') {
    return {
      container: 'bg-white ring-rose-300/90',
      badge: 'bg-rose-50 text-rose-700 ring-rose-200',
      icon: <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />,
      badgeLabel: 'KRITISCH',
    }
  }
  if (severity === 'high') {
    return {
      container: 'bg-white ring-orange-200/80',
      badge: 'bg-orange-50 text-orange-700 ring-orange-200',
      icon: <span className="inline-block h-2 w-2 rounded-full bg-orange-400" />,
      badgeLabel: 'HOCH',
    }
  }
  return {
    container: 'bg-white ring-amber-200/70',
    badge: 'bg-amber-50 text-amber-700 ring-amber-200',
    icon: <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />,
    badgeLabel: 'MITTEL',
  }
}

type PilotCaseTypeDisplay = { icon: React.ReactNode; label: string }

function getPilotCaseTypeDisplay(type: OperatorCase['type']): PilotCaseTypeDisplay {
  switch (type) {
    case 'stuck_inquiry':       return { icon: <ClipboardList size={18} aria-hidden />, label: 'Anfrage' }
    case 'proposal_pending':    return { icon: <FileText size={18} aria-hidden />, label: 'Angebot' }
    case 'scheduling_stuck':    return { icon: <Calendar size={18} aria-hidden />, label: 'Terminplanung' }
    case 'execution_stuck':     return { icon: <Hammer size={18} aria-hidden />, label: 'Ausführung' }
    case 'execution_overdue':   return { icon: <AlertTriangle size={18} aria-hidden />, label: 'Überfällig' }
    case 'payment_release_pending': return { icon: <CreditCard size={18} aria-hidden />, label: 'Zahlung' }
    case 'open_dispute':        return { icon: <Scale size={18} aria-hidden />, label: 'Streitfall' }
    case 'payout_error':        return { icon: <AlertTriangle size={18} aria-hidden />, label: 'Auszahlung' }
  }
}

function getPilotCaseJobRoute(item: OperatorCase): string {
  return `/craftsman/jobs/${item.jobId}`
}

function getPilotCaseDisputeRoute(): string {
  return '/craftsman/disputes'
}

function getPilotCaseFinanceRoute(): string {
  return '/craftsman/finance'
}

// ---------------------------------------------------------------------------
// Pilot case card
// ---------------------------------------------------------------------------

function PilotCaseCard({ item }: { item: OperatorCase }) {
  const s = getPilotSeverityStyle(item.severity)
  const t = getPilotCaseTypeDisplay(item.type)

  return (
    <div
      className={`relative overflow-hidden rounded-[24px] p-4 ring-1 shadow-[0_12px_28px_-20px_rgba(2,6,23,0.22)] ${s.container}`}
    >
      <div
        className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[24px] ${
          item.severity === 'critical'
            ? 'bg-gradient-to-b from-rose-600 via-rose-400 to-rose-300'
            : item.severity === 'high'
              ? 'bg-gradient-to-b from-orange-500 via-orange-400 to-orange-300'
              : 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300'
        }`}
      />

      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-100 ring-1 ring-slate-200">
          <span className="text-[18px] leading-none">{t.icon}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold tracking-[0.15em] ring-1 ${s.badge}`}
            >
              {s.icon} {s.badgeLabel}
            </span>
            <span className="text-[11px] font-medium text-slate-400">{t.label}</span>
            {item.ageHours > 0 && (
              <span className="text-[11px] text-slate-400">{formatAgeHours(item.ageHours)}</span>
            )}
          </div>
          <p className="mt-1 text-[14px] font-semibold leading-snug text-slate-900">
            {item.title}
          </p>
          <p className="mt-0.5 text-[12px] leading-snug text-slate-500">
            {item.description}
          </p>

          {/* Quick actions */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Link
              to={getPilotCaseJobRoute(item)}
              className="inline-flex items-center gap-1 rounded-xl bg-[#0b1220] px-2.5 py-1.5 text-[11px] font-bold text-white ring-1 ring-white/10 transition-transform duration-200 active:scale-[0.97]"
            >
              Auftrag →
            </Link>
            {(item.type === 'open_dispute') && (
              <Link
                to={getPilotCaseDisputeRoute()}
                className="inline-flex items-center gap-1 rounded-xl bg-rose-50 px-2.5 py-1.5 text-[11px] font-bold text-rose-700 ring-1 ring-rose-200 transition-transform duration-200 active:scale-[0.97]"
              >
                Streitfall →
              </Link>
            )}
            {(item.type === 'payment_release_pending') && (
              <Link
                to={getPilotCaseFinanceRoute()}
                className="inline-flex items-center gap-1 rounded-xl bg-blue-50 px-2.5 py-1.5 text-[11px] font-bold text-blue-700 ring-1 ring-blue-200 transition-transform duration-200 active:scale-[0.97]"
              >
                Finanzen →
              </Link>
            )}
            {(item.type === 'payout_error') && (
              <Link
                to={getPilotCaseFinanceRoute()}
                className="inline-flex items-center gap-1 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[11px] font-bold text-amber-700 ring-1 ring-amber-200 transition-transform duration-200 active:scale-[0.97]"
              >
                Klären →
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data builder
// ---------------------------------------------------------------------------

function buildPriorityCases(): OperatorPriorityCase[] {
  return deriveOperatorPriorityCases(getJobs(), getAllPayments(), getDisputes())
}

function buildPilotCases(): OperatorCase[] {
  return deriveOperatorCases(getJobs(), getAllPayments(), getDisputes(), getSchedules(), Date.now(), getTimelineSignals())
}

function buildDiagnosticsSummary(): PilotDiagnosticsSummary {
  // Provider profiles are not held in a shared store; provider-gap diagnostics
  // are intentionally omitted here until a provider store is available.
  return derivePilotDiagnosticsSummary(getJobs(), getAllPayments(), getDisputes(), [])
}

function buildMarketplaceMetrics(): MarketplaceMetrics {
  const events = getAnalyticsEvents()
  const weekEvents = filterEventsSince(events, 7)
  return deriveMarketplaceMetrics(weekEvents)
}

// Maximum cases shown in each operator section before "show more" appears.
const OPERATOR_CASES_INITIAL = 15

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * Operator dashboard surfacing high-priority cases that need attention.
 *
 * Shows disputes, stale payments, and stuck/overdue jobs ordered by severity
 * so the operator always sees the most urgent items first.
 *
 * Hydration gate: waits for both dispute and schedule repositories before
 * rendering cases — prevents false "all clear" while stores are loading.
 */
export default function OperatorDashboardScreen() {
  const session = useSession()
  const goBack = useSmartBack('/craftsman/dashboard')

  const [cases, setCases] = useState<OperatorPriorityCase[]>(() =>
    buildPriorityCases()
  )
  const [pilotCases, setPilotCases] = useState<OperatorCase[]>(() =>
    buildPilotCases()
  )
  const [diagnostics, setDiagnostics] = useState<PilotDiagnosticsSummary>(() =>
    buildDiagnosticsSummary()
  )
  const [metrics, setMetrics] = useState<MarketplaceMetrics>(() =>
    buildMarketplaceMetrics()
  )
  const [ratings, setRatings] = useState(() => getRatings())
  const [trustJobs, setTrustJobs] = useState(() => getJobs())
  const [trustDisputes, setTrustDisputes] = useState(() => getDisputes())
  const [showAllCases, setShowAllCases] = useState(false)
  const [showAllPilotCases, setShowAllPilotCases] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [prioritySeverityFilter, setPrioritySeverityFilter] = useState<OperatorPrioritySeverity | null>(null)
  const [pilotSeverityFilter, setPilotSeverityFilter] = useState<OperatorCaseSeverity | null>(null)

  // Reset pagination whenever the search query or filters change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowAllCases(false)
    setShowAllPilotCases(false)
  }, [searchQuery, prioritySeverityFilter, pilotSeverityFilter])

  const filteredCases = useMemo(
    () => searchOperatorPriorityCases(searchQuery, filterOperatorPriorityCases(prioritySeverityFilter, cases)),
    [searchQuery, prioritySeverityFilter, cases]
  )
  const filteredPilotCases = useMemo(
    () => searchOperatorPilotCases(searchQuery, filterOperatorPilotCases(pilotSeverityFilter, pilotCases)),
    [searchQuery, pilotSeverityFilter, pilotCases]
  )
  const issueGroups = useMemo<OperatorIssueGroup[]>(
    () => deriveOperatorIssueGroups(pilotCases),
    [pilotCases]
  )

  useStoreSync(
    [subscribeJobs, subscribePayments, subscribeDisputes, subscribeAnalyticsEvents, subscribeRatings, subscribeOperations, subscribeTimeline],
    () => {
      setCases(buildPriorityCases())
      setPilotCases(buildPilotCases())
      setDiagnostics(buildDiagnosticsSummary())
      setMetrics(buildMarketplaceMetrics())
      setRatings(getRatings())
      setTrustJobs(getJobs())
      setTrustDisputes(getDisputes())
    }
  )

  const criticalPilotCases = pilotCases.filter((c) => c.severity === 'critical')
  const highPilotCases = pilotCases.filter((c) => c.severity === 'high')
  const mediumPilotCases = pilotCases.filter((c) => c.severity === 'medium')

  const visibleCases = showAllCases
    ? filteredCases
    : filteredCases.slice(0, OPERATOR_CASES_INITIAL)
  const hiddenCasesCount = filteredCases.length - visibleCases.length

  const visiblePilotCases = showAllPilotCases
    ? filteredPilotCases
    : filteredPilotCases.slice(0, OPERATOR_CASES_INITIAL)
  const hiddenPilotCasesCount = filteredPilotCases.length - visiblePilotCases.length

  const noData = cases.length === 0 && pilotCases.length === 0
  const hasActiveSearch = searchQuery.trim().length > 0
  const hasActivePriorityFilter = prioritySeverityFilter !== null
  const hasActivePilotFilter = pilotSeverityFilter !== null
  const hasActiveFilter = hasActiveSearch || hasActivePriorityFilter || hasActivePilotFilter

  // emptyDashboard: no data at all (independent of search/filter) — used for the
  // "all clear" banner when there are genuinely zero cases to show.
  const emptyDashboard = !hasActiveFilter && noData
  const noActiveResults =
    hasActiveFilter &&
    filteredCases.length === 0 &&
    filteredPilotCases.length === 0

  if (!canAccessOperatorTools(session)) {
    return <Navigate to="/craftsman/dashboard" replace />
  }

  // Wait for all deferred repositories before showing cases — prevents false
  // "all clear" when schedule, dispute, or timeline signal data is still loading.
  // payout_error cases are derived from timeline signals; without this gate the
  // dashboard would show an empty case list while timeline is still bootstrapping.
  if (!isDisputeRepositoryHydrated() || !isScheduleRepositoryHydrated() || !isTimelineRepositoryHydrated()) {
    return (
      <AppShell active="home">
        <ScreenSkeleton variant="list" />
      </AppShell>
    )
  }

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          {/* Header */}
          <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
            <div className="flex items-center gap-3">
              <button type="button" onClick={goBack} aria-label="Zurück" className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"><ArrowLeft size={18} className="text-ink" aria-hidden /></button>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0b1220] ring-1 ring-white/10">
                <Settings size={20} className="text-white" aria-hidden />
              </div>
              <div>
                <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Operator
                </div>
                <h1 className="text-[20px] font-extrabold leading-tight text-slate-900">
                  Priority Dashboard
                </h1>
              </div>
            </div>

            {/* Summary stats — derived from pilot case classifications */}
            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="rounded-2xl bg-rose-50 p-3 ring-1 ring-rose-100 text-center">
                <div className="text-[22px] font-extrabold text-rose-600">
                  {criticalPilotCases.length}
                </div>
                <div className="text-[11px] font-semibold text-rose-500">
                  Kritisch
                </div>
              </div>
              <div className="rounded-2xl bg-orange-50 p-3 ring-1 ring-orange-100 text-center">
                <div className="text-[22px] font-extrabold text-orange-600">
                  {highPilotCases.length}
                </div>
                <div className="text-[11px] font-semibold text-orange-500">
                  Hoch
                </div>
              </div>
              <div className="rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-100 text-center">
                <div className="text-[22px] font-extrabold text-amber-600">
                  {mediumPilotCases.length}
                </div>
                <div className="text-[11px] font-semibold text-amber-500">
                  Mittel
                </div>
              </div>
            </div>
          </div>

          {/* Issue Summary Bar — "act now" categories */}
          {issueGroups.length > 0 && (
            <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
              <div className="mb-3 flex items-center gap-2">
                {hasUrgentIssues(issueGroups)
                  ? <AlertTriangle size={16} className="text-rose-500 shrink-0" aria-hidden />
                  : <ClipboardList size={16} className="text-ink-muted shrink-0" aria-hidden />
                }
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Sofort handeln
                  </div>
                  <h2 className="text-[15px] font-extrabold leading-tight text-slate-900">
                    Aktuelle Handlungsbereiche
                  </h2>
                </div>
              </div>
              <OperatorIssueSummaryBar groups={issueGroups} />
            </div>
          )}

          {/* Pilot Diagnostics Banner */}
          <PilotDiagnosticsBanner summary={diagnostics} />

          {/* Marketplace Metrics */}
          <MarketplaceMetricsPanel metrics={metrics} periodLabel="Letzte 7 Tage" />

          {/* Trust & Safety Panel */}
          <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#0b1220] ring-1 ring-white/10">
                <Shield size={18} className="text-white" aria-hidden />
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Trust &amp; Safety
                </div>
                <h2 className="text-[17px] font-extrabold leading-tight text-slate-900">
                  Anbieter-Risiken
                </h2>
              </div>
            </div>
            <OperatorTrustPanel
              ratings={ratings}
              jobs={trustJobs}
              disputes={trustDisputes}
            />
          </div>

          {/* User Reports — moderation workflow */}
          <OperatorReportsPanel />

          {/* Navigation links to operational areas */}
          <div className="grid grid-cols-2 gap-2">
            <Link
              to="/craftsman/disputes"
              className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-16px_rgba(2,6,23,0.2)] transition active:scale-[0.98]"
            >
              <Scale size={18} className="text-slate-500 shrink-0" aria-hidden />
              <span className="text-[13px] font-semibold text-slate-700">
                Disputes
              </span>
            </Link>
            <Link
              to="/craftsman/jobs"
              className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-16px_rgba(2,6,23,0.2)] transition active:scale-[0.98]"
            >
              <Hammer size={18} className="text-slate-500 shrink-0" aria-hidden />
              <span className="text-[13px] font-semibold text-slate-700">
                All Jobs
              </span>
            </Link>
            <Link
              to="/craftsman/finance"
              className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-16px_rgba(2,6,23,0.2)] transition active:scale-[0.98]"
            >
              <CreditCard size={18} className="text-slate-500 shrink-0" aria-hidden />
              <span className="text-[13px] font-semibold text-slate-700">
                Finance
              </span>
            </Link>
            <Link
              to="/craftsman/dashboard"
              className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-16px_rgba(2,6,23,0.2)] transition active:scale-[0.98]"
            >
              <BarChart2 size={18} className="text-slate-500 shrink-0" aria-hidden />
              <span className="text-[13px] font-semibold text-slate-700">
                Dashboard
              </span>
            </Link>
            <Link
              to="/craftsman/operator/attribution-dlq"
              className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-16px_rgba(2,6,23,0.2)] transition active:scale-[0.98]"
            >
              <AlertTriangle size={18} className="text-amber-500 shrink-0" aria-hidden />
              <span className="text-[13px] font-semibold text-slate-700">
                Attribution DLQ
              </span>
            </Link>
          </div>

          {/* Search bar */}
          <div className="flex items-center gap-3 rounded-[20px] bg-white px-4 py-3 ring-1 ring-slate-200/70 shadow-[0_12px_28px_-24px_rgba(2,6,23,0.14)]">
            <Search size={16} className="shrink-0 text-slate-400" aria-hidden />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Fälle durchsuchen"
              aria-label="Fälle durchsuchen"
              className="flex-1 bg-transparent text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="text-slate-400 transition hover:text-slate-600"
                aria-label="Suche löschen"
              >
                <X size={14} aria-hidden />
              </button>
            )}
          </div>

          {/* No results (search + filter combined) */}
          {noActiveResults && (
            <div className="rounded-[24px] bg-white p-5 text-center ring-1 ring-slate-200/70">
              <div className="flex justify-center"><Search size={28} className="text-slate-400" aria-hidden /></div>
              <div className="mt-2 text-[15px] font-semibold text-slate-700">
                Keine Ergebnisse
              </div>
              <div className="mt-1 text-[13px] text-slate-400">
                {searchQuery
                  ? `Keine Fälle für „${searchQuery}" gefunden.`
                  : 'Keine Fälle mit dem gewählten Filter gefunden.'}
              </div>
            </div>
          )}

          {/* Priority cases – severity quick filters */}
          {!emptyDashboard && cases.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Schweregrad-Filter">
              {([null, 'high', 'medium', 'low'] as const).map((s) => {
                const active = prioritySeverityFilter === s
                const labels: Record<string, string> = { high: 'Hoch', medium: 'Mittel', low: 'Niedrig' }
                const label = s === null ? 'Alle' : labels[s]
                const activeColors: Record<string, string> = {
                  high: 'bg-rose-600 text-white ring-rose-600',
                  medium: 'bg-amber-500 text-white ring-amber-500',
                  low: 'bg-slate-500 text-white ring-slate-500',
                }
                const colorActive = s === null ? 'bg-[#0b1220] text-white ring-[#0b1220]' : (activeColors[s] ?? 'bg-[#0b1220] text-white ring-[#0b1220]')
                const colorIdle = 'bg-white text-slate-600 ring-slate-200/80'
                return (
                  <button
                    key={s ?? 'all'}
                    onClick={() => setPrioritySeverityFilter(s)}
                    className={`rounded-full px-3 py-1 text-[12px] font-semibold ring-1 transition active:scale-[0.97] ${active ? colorActive : colorIdle}`}
                    aria-pressed={active}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}

          {/* Priority cases list */}
          {emptyDashboard ? (
            <div className="rounded-[28px] bg-emerald-50 p-6 ring-1 ring-emerald-200/80 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] text-center">
              <div className="flex justify-center"><CheckCircle2 size={40} className="text-emerald-500" aria-hidden /></div>
              <div className="mt-2 text-[18px] font-extrabold text-emerald-900">
                Keine kritischen Pilotfälle
              </div>
              <div className="mt-1 text-[14px] text-emerald-700">
                Alle aktiven Fälle sind aktuell im grünen Bereich.
              </div>
            </div>
          ) : (
            filteredCases.length === 0 ? (
              <div className="rounded-[28px] bg-white p-6 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] text-center">
                <div className="flex justify-center"><CheckCircle2 size={36} className="text-emerald-500" aria-hidden /></div>
                <div className="mt-2 text-[17px] font-semibold text-slate-900">
                  All Clear
                </div>
                <div className="mt-1 text-[14px] text-slate-500">
                  No cases require immediate attention right now.
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {visibleCases.map((item) => (
                  <PriorityCaseCard key={`${item.type}-${item.jobId}`} item={item} />
                ))}
                {hiddenCasesCount > 0 && (
                  <button
                    onClick={() => setShowAllCases(true)}
                    className="w-full rounded-[24px] bg-white px-4 py-3 text-[13px] font-semibold text-slate-600 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-16px_rgba(2,6,23,0.2)] transition active:bg-slate-50"
                  >
                    Weitere Fälle anzeigen ({hiddenCasesCount} weitere)
                  </button>
                )}
              </div>
            )
          )}

          {/* Pilot Fälle section */}
          <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
            <p className="mb-3 text-[12px] text-slate-500">
              Diese Ansicht zeigt Fälle, die möglicherweise manuelle Aufmerksamkeit benötigen.
            </p>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-900 ring-1 ring-white/10">
                <Satellite size={18} className="text-white" aria-hidden />
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Pilot
                </div>
                <h2 className="text-[17px] font-extrabold leading-tight text-slate-900">
                  Pilot Fälle
                  {filteredPilotCases.length > 0 && (
                    <span className="ml-2 text-[14px] font-semibold text-slate-400">
                      ({filteredPilotCases.length})
                    </span>
                  )}
                </h2>
              </div>
            </div>

            <div className="mt-3">
              {/* Pilot cases – severity quick filters */}
              {pilotCases.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Pilot-Schweregrad-Filter">
                  {([null, 'critical', 'high', 'medium'] as const).map((s) => {
                    const active = pilotSeverityFilter === s
                    const pilotLabels: Record<string, string> = { critical: 'Kritisch', high: 'Hoch', medium: 'Mittel' }
                    const label = s === null ? 'Alle' : pilotLabels[s]
                    const pilotActiveColors: Record<string, string> = {
                      critical: 'bg-rose-600 text-white ring-rose-600',
                      high: 'bg-orange-500 text-white ring-orange-500',
                      medium: 'bg-amber-500 text-white ring-amber-500',
                    }
                    const colorActive = s === null ? 'bg-indigo-900 text-white ring-indigo-900' : (pilotActiveColors[s] ?? 'bg-indigo-900 text-white ring-indigo-900')
                    const colorIdle = 'bg-slate-50 text-slate-600 ring-slate-200/80'
                    return (
                      <button
                        key={s ?? 'all'}
                        onClick={() => setPilotSeverityFilter(s)}
                        className={`rounded-full px-3 py-1 text-[12px] font-semibold ring-1 transition active:scale-[0.97] ${active ? colorActive : colorIdle}`}
                        aria-pressed={active}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              )}

              {filteredPilotCases.length === 0 ? (
                <div className="rounded-2xl bg-slate-50 p-4 text-center ring-1 ring-slate-100">
                  {(searchQuery || pilotSeverityFilter) ? (
                    <>
                      <div className="flex justify-center"><Search size={20} className="text-slate-400" aria-hidden /></div>
                      <div className="mt-1 text-[13px] font-bold text-slate-700">
                        Keine Pilot-Fälle gefunden
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-center"><CheckCircle2 size={24} className="text-emerald-500" aria-hidden /></div>
                      <div className="mt-1 text-[13px] font-bold text-slate-700">
                        Alle Fälle im grünen Bereich
                      </div>
                      <div className="mt-0.5 text-[12px] text-slate-500">
                        Keine kritischen Pilotfälle vorhanden.
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {visiblePilotCases.map((item) => (
                    <PilotCaseCard
                      key={`pilot-${item.type}-${item.jobId}`}
                      item={item}
                    />
                  ))}
                  {hiddenPilotCasesCount > 0 && (
                    <button
                      onClick={() => setShowAllPilotCases(true)}
                      className="w-full rounded-[18px] bg-slate-50 px-4 py-3 text-[13px] font-semibold text-slate-600 ring-1 ring-slate-200/70 transition active:bg-slate-100"
                    >
                      Weitere Pilot-Fälle anzeigen ({hiddenPilotCasesCount} weitere, nach Schweregrad sortiert)
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </AppShell>
  )
}
