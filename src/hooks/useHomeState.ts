import { useEffect, useMemo, useState } from 'react'
import { useSession } from './useSession'
import { isNative } from '../lib/platform'
import {
  deriveCustomerHomeState,
  deriveOwnerHomeState,
  deriveEmployeeHomeState,
} from '../lib/viewmodel/homeState'
import type {
  CustomerHomeState,
  OwnerHomeState,
  EmployeeHomeState,
} from '../lib/viewmodel/homeState'
import type { OnboardingProgress } from '../lib/onboarding'
import type { PayoutReadinessStatus } from '../lib/payout'
import type { CalendarEntry } from '../lib/calendar'
import type { TeamMember } from '../lib/jobs'
import {
  getJobs,
  subscribeJobs,
  isJobRepositoryHydrated,
  getTeamMembers,
} from '../lib/jobs'
import {
  getDisputes,
  subscribeDisputes,
  getDisputeByJobId,
  isDisputeRepositoryHydrated,
} from '../lib/disputes'
import {
  getProjects,
  subscribeProjects,
  isProjectActive,
  isProjectRepositoryHydrated,
  type Project,
} from '../lib/projects'
import { deriveCanonicalProjection } from '../lib/shared/canonicalCustomerLifecycle'
import {
  buildCustomerAnswerCardModel,
  type CustomerAnswerCardModel,
} from '../lib/viewmodel/customerAnswerCard'
import {
  subscribePayments,
  isPaymentRepositoryHydrated,
  subscribeEscrowPlans,
  isEscrowPlanRepositoryHydrated,
} from '../lib/payments'
import {
  subscribeFundingRequests,
  isFundingRequestRepositoryHydrated,
  getFundingRequestByJobId,
} from '../lib/payments/fundingRequest'
import {
  getCalendarEntries,
  subscribeCalendar,
  isCalendarRepositoryHydrated,
  formatDateKey,
} from '../lib/calendar'
import { getEntriesForUser, getEntriesForMember } from '../lib/calendar/calendarSelectors'
import { subscribeTeamMembers, isTeamMembersHydrated } from '../lib/team'
import { getMyCraftsmanBusinessProfile } from '../lib/craftsman/craftsmanProfileService'
import { fetchPayoutAccountForOnboarding } from '../lib/payout/client'
import { derivePayoutReadinessStatus } from '../lib/payout'
import { deriveOnboardingProgress } from '../lib/onboarding'
import {
  subscribeNotifications,
  getNotificationSignals,
} from '../lib/notifications'
import {
  derivePayoutFailureAlert,
  getEmptyPayoutFailureAlert,
} from '../lib/payments/payoutFailureAlert'
import type { PayoutFailureAlert } from '../lib/payments/payoutFailureAlert'

const IS_IN_MEMORY = import.meta.env.VITE_DATA_SOURCE !== 'supabase'

// Loading default — isProfileReady: false keeps deriveOwnerHomeState in loading
// state while the async fetch is in-flight or has errored.
const OWNER_LOADING_PROGRESS: OnboardingProgress = {
  steps: [],
  completedCount: 0,
  totalCount: 0,
  completionPercent: 0,
  isComplete: false,
  nextStep: null,
  isDiscoveryBlocked: true,
  isProfileReady: false,
  isPayoutReady: false,
}

/**
 * Resolves today's calendar entries for a worker.
 *
 * Exported as a pure function so it can be unit-tested without renderHook.
 * IS_IN_MEMORY fallback: in non-Supabase mode the logged-in user's UUID never
 * matches mock member IDs (tm-1, tm-2 …), so we fall back to tm-1 so the
 * developer sees realistic data instead of an empty screen.
 */
export function filterTodayEntriesForWorker(
  allEntries: CalendarEntry[],
  teamMembers: TeamMember[],
  userId: string,
  todayKey: string,
  isInMemory: boolean
): CalendarEntry[] {
  const linked = getEntriesForUser(allEntries, teamMembers, userId)
  const userEntries =
    linked.length === 0 && isInMemory
      ? getEntriesForMember(allEntries, 'tm-1')
      : linked
  return userEntries.filter((e) => e.dateKey === todayKey)
}

// ── Customer ──────────────────────────────────────────────────────────────────

export function useCustomerHomeState(): CustomerHomeState {
  const [jobs, setJobs] = useState(getJobs)
  const [disputes, setDisputes] = useState(getDisputes)
  const [paymentsTick, setPaymentsTick] = useState(0)

  useEffect(() => {
    const bumpPayments = () => setPaymentsTick((t) => t + 1)
    const unsubJobs = subscribeJobs(() => setJobs(getJobs()))
    const unsubDisputes = subscribeDisputes(() => setDisputes(getDisputes()))
    const unsubPayments = subscribePayments(bumpPayments)
    const unsubFunding = subscribeFundingRequests(bumpPayments)
    const unsubEscrow = subscribeEscrowPlans(bumpPayments)
    return () => {
      unsubJobs()
      unsubDisputes()
      unsubPayments()
      unsubFunding()
      unsubEscrow()
    }
  }, [])

  return useMemo(() => {
    const jobsHydrated = isJobRepositoryHydrated()
    const paymentHydrated =
      isPaymentRepositoryHydrated() &&
      isFundingRequestRepositoryHydrated() &&
      isEscrowPlanRepositoryHydrated()
    return deriveCustomerHomeState({
      jobs,
      disputes,
      jobsHydrated,
      paymentHydrated,
      // Direct-route lookup: resolves the canonical fundingRequestId for a
      // job so the funding_required hero CTA can deep-link to FundingEntry.
      // Falls back to project detail in the selector when undefined.
      fundingRequestLookup: (jobId) => getFundingRequestByJobId(jobId)?.id,
      // Terminal-dead funding gate: lets the selector suppress the payable
      // hero / follow-up for an expired/cancelled request.
      fundingStatusLookup: (jobId) => getFundingRequestByJobId(jobId)?.status,
    })
    // paymentsTick forces recomputation once payment/funding/escrow repos hydrate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, disputes, paymentsTick])
}

// ── Customer Answer-Card ────────────────────────────────────────────────────

export type UseCustomerAnswerCard = {
  /** The selected top project, or null when the customer has no active project. */
  topProject: Project | null
  /** The adaptive answer-card model, or null when there is no top project. */
  model: CustomerAnswerCardModel | null
  /** Active-project count — drives the greeting subline + projects-row badge. */
  activeProjectCount: number
  /** False until projects, jobs, payments, funding, escrow AND disputes hydrate. */
  isHydrated: boolean
}

/**
 * Drives the customer-home answer card (Block 1).
 *
 * Mirrors `useCustomerHomeState` plumbing: subscribes to projects, jobs,
 * disputes, payments, funding requests and escrow plans, and bumps a
 * `paymentsTick` so the memo recomputes when the payment/funding/escrow repos
 * change (those have no array state of their own). Without the payment-side
 * subscriptions the tone would freeze on a funding→funded transition and keep
 * showing "Zahlung leisten".
 *
 * The dispute status is wired through `getDisputeByJobId` (hydration-gated) so
 * the loud dispute tone actually fires — previously the home hard-coded
 * `disputeStatus = undefined`, so disputes never surfaced.
 *
 * A single `topProject` predicate selects the active project AND gates the card,
 * closing the gap where project visibility used `projects.length` but the card
 * used `activeProjects → topProject`.
 */
export function useCustomerAnswerCard(): UseCustomerAnswerCard {
  const [projects, setProjects] = useState(getProjects)
  const [jobs, setJobs] = useState(getJobs)
  const [disputes, setDisputes] = useState(getDisputes)
  const [paymentsTick, setPaymentsTick] = useState(0)

  useEffect(() => {
    const bumpPayments = () => setPaymentsTick((t) => t + 1)
    const unsubProjects = subscribeProjects(() => setProjects(getProjects()))
    const unsubJobs = subscribeJobs(() => setJobs(getJobs()))
    const unsubDisputes = subscribeDisputes(() => setDisputes(getDisputes()))
    const unsubPayments = subscribePayments(bumpPayments)
    const unsubFunding = subscribeFundingRequests(bumpPayments)
    const unsubEscrow = subscribeEscrowPlans(bumpPayments)
    // Post-subscribe snapshot: closes the render→subscribe race where a repo
    // hydrates between useState init and this effect installing.
    setProjects(getProjects())
    setJobs(getJobs())
    setDisputes(getDisputes())
    bumpPayments()
    return () => {
      unsubProjects()
      unsubJobs()
      unsubDisputes()
      unsubPayments()
      unsubFunding()
      unsubEscrow()
    }
  }, [])

  return useMemo((): UseCustomerAnswerCard => {
    const isHydrated =
      isProjectRepositoryHydrated() &&
      isJobRepositoryHydrated() &&
      isPaymentRepositoryHydrated() &&
      isFundingRequestRepositoryHydrated() &&
      isEscrowPlanRepositoryHydrated() &&
      isDisputeRepositoryHydrated()

    // Single canonical predicate: in_progress → review → first active project.
    const activeProjects = projects.filter(isProjectActive)
    const withCanonical = activeProjects.map((p) => ({
      project: p,
      canonical: deriveCanonicalProjection(p),
    }))
    const topProject =
      withCanonical.find((e) => e.canonical.status === 'in_progress')?.project ??
      withCanonical.find((e) => e.canonical.status === 'review')?.project ??
      activeProjects[0] ??
      null

    const activeProjectCount = activeProjects.length

    if (!topProject) return { topProject: null, model: null, activeProjectCount, isHydrated }

    const canonical = deriveCanonicalProjection(topProject)
    const sourceJob = topProject.sourceJobId
      ? jobs.find((j) => j.id === topProject.sourceJobId)
      : undefined
    // Hydration-gated: never trust a half-loaded dispute repo with the loud tone.
    const disputeStatus =
      isDisputeRepositoryHydrated() && sourceJob
        ? getDisputeByJobId(sourceJob.id)?.status
        : undefined
    const fundingRequest = sourceJob ? getFundingRequestByJobId(sourceJob.id) : undefined

    const model = buildCustomerAnswerCardModel({
      project: topProject,
      canonical,
      sourceJob,
      disputeStatus,
      fundingStatus: fundingRequest?.status,
      fundingRequestId: fundingRequest?.id,
    })

    return { topProject, model, activeProjectCount, isHydrated }
    // paymentsTick + disputes force recomputation when the payment/funding/
    // escrow/dispute repos change (those reads happen inside this memo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, jobs, disputes, paymentsTick])
}

// ── Owner ─────────────────────────────────────────────────────────────────────

export function useOwnerHomeState(): OwnerHomeState {
  const [jobs, setJobs] = useState(getJobs)
  const [disputes, setDisputes] = useState(getDisputes)
  const [paymentsTick, setPaymentsTick] = useState(0)
  const [payoutReadiness, setPayoutReadiness] = useState<PayoutReadinessStatus>('no_account')
  const [payoutFailureAlert, setPayoutFailureAlert] = useState<PayoutFailureAlert>(
    getEmptyPayoutFailureAlert,
  )
  const [onboardingProgress, setOnboardingProgress] =
    useState<OnboardingProgress>(OWNER_LOADING_PROGRESS)
  // Guards the memo from settling before the async profile fetch completes.
  // Without this, jobs hydrating before the fetch resolves would produce a
  // false onboarding_incomplete state (OWNER_LOADING_PROGRESS.isProfileReady = false).
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [payoutRefreshTick, setPayoutRefreshTick] = useState(0)

  useEffect(() => {
    if (!isNative()) return
    let handle: { remove: () => Promise<void> } | null = null
    let mounted = true
    void (async () => {
      const { App } = await import('@capacitor/app')
      const h = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) setPayoutRefreshTick((t) => t + 1)
      })
      if (!mounted) { void h.remove() } else { handle = h }
    })()
    return () => {
      mounted = false
      if (handle) void handle.remove()
    }
  }, [])

  useEffect(() => {
    const bumpPayments = () => setPaymentsTick((t) => t + 1)
    const refreshPayoutAlert = () =>
      setPayoutFailureAlert(derivePayoutFailureAlert(getNotificationSignals()))
    const unsubJobs = subscribeJobs(() => setJobs(getJobs()))
    const unsubDisputes = subscribeDisputes(() => setDisputes(getDisputes()))
    const unsubPayments = subscribePayments(bumpPayments)
    const unsubFunding = subscribeFundingRequests(bumpPayments)
    const unsubEscrow = subscribeEscrowPlans(bumpPayments)
    const unsubNotifications = subscribeNotifications(refreshPayoutAlert)
    refreshPayoutAlert()
    return () => {
      unsubJobs()
      unsubDisputes()
      unsubPayments()
      unsubFunding()
      unsubEscrow()
      unsubNotifications()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [profile, payoutAccount] = await Promise.all([
          getMyCraftsmanBusinessProfile(),
          fetchPayoutAccountForOnboarding(),
        ])
        if (!cancelled) {
          setPayoutReadiness(derivePayoutReadinessStatus(payoutAccount))
          setOnboardingProgress(deriveOnboardingProgress(profile, payoutAccount))
          setProfileLoaded(true)
        }
      } catch {
        // On error: degrade to safe defaults so the UI never shows payout_blocked
        // or onboarding_incomplete as a result of a failed network call.
        if (!cancelled) {
          setPayoutReadiness('no_account')
          setOnboardingProgress(OWNER_LOADING_PROGRESS)
          setProfileLoaded(true)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [payoutRefreshTick])

  return useMemo((): OwnerHomeState => {
    if (!profileLoaded)
      return {
        kind: 'loading',
        priorityReason: null,
        severity: null,
        primaryAction: null,
        followUps: [],
        notificationDot: false,
      }
    const jobsHydrated = isJobRepositoryHydrated()
    const paymentHydrated =
      isPaymentRepositoryHydrated() &&
      isFundingRequestRepositoryHydrated() &&
      isEscrowPlanRepositoryHydrated()
    return deriveOwnerHomeState({
      jobs,
      disputes,
      payoutReadiness,
      payoutFailureAlert,
      onboardingProgress,
      jobsHydrated,
      paymentHydrated,
      // Terminal-dead funding gate: suppresses the funding_awaited hero /
      // follow-up for an expired/cancelled request so the craftsman home no
      // longer implies "the customer must pay".
      fundingStatusLookup: (jobId) => getFundingRequestByJobId(jobId)?.status,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, disputes, payoutReadiness, payoutFailureAlert, onboardingProgress, paymentsTick, profileLoaded])
}

// ── Employee ──────────────────────────────────────────────────────────────────

export function useEmployeeHomeState(): EmployeeHomeState {
  const { user } = useSession()
  const [allEntries, setAllEntries] = useState<CalendarEntry[]>(getCalendarEntries)
  const [teamMembers, setTeamMembers] = useState(getTeamMembers)
  const [calHydrated, setCalHydrated] = useState(
    () => isCalendarRepositoryHydrated() && isTeamMembersHydrated()
  )

  useEffect(() => {
    const updateHydrated = () =>
      setCalHydrated(isCalendarRepositoryHydrated() && isTeamMembersHydrated())

    const unsubCalendar = subscribeCalendar(() => {
      setAllEntries(getCalendarEntries())
      updateHydrated()
    })
    const unsubJobs = subscribeJobs(() => {
      // Job transitions update calendar entry statuses via the calendar store.
      setAllEntries(getCalendarEntries())
    })
    const unsubTeam = subscribeTeamMembers(() => {
      setTeamMembers(getTeamMembers())
      updateHydrated()
    })
    // Post-subscribe snapshot: closes the render→subscribe race window where
    // team members hydrate between useState init and this effect installing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTeamMembers(getTeamMembers())
    updateHydrated()
    return () => {
      unsubCalendar()
      unsubJobs()
      unsubTeam()
    }
  }, [])

  return useMemo(() => {
    const todayKey = formatDateKey(new Date())
    const todayEntries = user
      ? filterTodayEntriesForWorker(allEntries, teamMembers, user.id, todayKey, IS_IN_MEMORY)
      : []
    return deriveEmployeeHomeState({ todayEntries, todayKey, calendarHydrated: calHydrated })
  }, [allEntries, teamMembers, calHydrated, user])
}
