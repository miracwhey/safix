/**
 * Home State ViewModel — Block 1
 *
 * Pure functions that map canonical domain data to home/dashboard presentation
 * states for all three roles: customer, owner (craftsman), employee (worker).
 *
 * DESIGN CONTRACT
 * ---------------
 * - No mutations, no side effects, no store reads.
 * - All inputs are passed explicitly so these functions are fully unit-testable.
 * - All hydration guards live here — callers do not re-implement them.
 * - Fee logic is NOT surfaced here. No import from feeRate.ts.
 * - Gate logic (TOS, role, profile routing) lives in HomeGate / AuthGate — not here.
 * - Presentation copy lives in UI components — not here.
 *   Only machine-readable IDs and route strings are returned.
 *
 * PRIORITY INVARIANTS (must not be violated by callers)
 * ------------------------------------------------------
 * Customer:
 *   dispute_open > release_required > funding_required > active > waiting > discovery
 *
 * Owner:
 *   dispute > payout_blocked > payout_failed > release_overdue > funding_awaited
 *   > requests_pending > onboarding_incomplete > busy > calm
 *
 * Employee:
 *   onsite > between > dayOff
 *
 * USAGE
 * -----
 * Block 2 wraps these in React hooks that subscribe to the relevant stores
 * and re-call these functions on any store notification.  Do NOT read from
 * stores directly in this module.
 */

import type { Job } from '../jobs/types.js'
import type { Dispute } from '../disputes/types.js'
import type { CalendarEntry } from '../calendar/calendarTypes.js'
import type { PayoutReadinessStatus } from '../payout/types.js'
import type { OnboardingProgress } from '../onboarding/selectors.js'
import type { PayoutFailureAlert } from '../payments/payoutFailureAlert.js'
import { isDisputeBlocking } from '../disputes/stateMachine.js'
import { buildFundingEntryPath } from '../funding/canonicalFundingTarget.js'
// Leaf import (not the barrel) — keeps this pure viewmodel free of the
// fundingRequest persistence/service modules.
import { isFundingRequestTerminalDead } from '../payments/fundingRequest/fundingRequestStatus.js'

// ── Shared primitives ────────────────────────────────────────────────────────

/** A single actionable CTA the UI should render as the primary button. */
export type HomeAction = {
  /** Machine-readable action ID — used for testing and deep-link resolution. */
  actionId: string
  /** Short German CTA label. Used as button text by Block 2. */
  label: string
  /** Route to navigate to when this action is tapped. */
  route: string
}

/**
 * A secondary follow-up item displayed below the hero card.
 * Ordered by severity: urgent items first.
 */
export type HomeFollowUp = {
  /** Unique, stable ID — composed from domain entity IDs. */
  id: string
  severity: 'urgent' | 'action' | 'info'
  /** Short title — used as the primary text line. */
  title: string
  /** Supporting meta text — secondary line. */
  meta: string
  /** Route to navigate to when this item is tapped. */
  route: string
}

// ── Customer ─────────────────────────────────────────────────────────────────

/**
 * Machine-readable reason for the most urgent customer priority state.
 * null = no urgent condition; normal state applies.
 */
export type CustomerPriorityReason =
  | 'dispute_open'       // dispute is blocking payment
  | 'release_required'   // customer must release the final payment
  | 'funding_required'   // customer must fund escrow to proceed
  | null

/** Presentation state for the customer home screen. */
export type CustomerHomeStateKind = 'loading' | 'discovery' | 'waiting' | 'active'

export type CustomerHomeState = {
  kind: CustomerHomeStateKind
  /** Urgent condition driving this state — null when kind is 'loading' or 'discovery'. */
  priorityReason: CustomerPriorityReason
  /** Aggregate severity of the current priority reason. */
  severity: 'urgent' | 'action' | null
  /** Primary CTA — null when no action is required from the customer. */
  primaryAction: HomeAction | null
  /** Ordered follow-up items (most urgent first). Max 3. */
  followUps: HomeFollowUp[]
  /** True when the notification bell should show a dot. */
  notificationDot: boolean
}

export type CustomerHomeStateParams = {
  /** All customer jobs — completed/cancelled are filtered internally. */
  jobs: Job[]
  /** Disputes associated with any of the customer's jobs. */
  disputes: Dispute[]
  /** True once the jobs repository has finished its initial load. */
  jobsHydrated: boolean
  /**
   * True once all payment-related repositories (payments, fundingRequests,
   * escrowPlans) have finished their initial loads.
   * Must be true before payment-state priority items can be trusted.
   */
  paymentHydrated: boolean
  /**
   * Optional pure lookup: jobId → canonical fundingRequestId.
   *
   * When supplied and resolves for the funding-required job, the
   * `fund_escrow` primary action routes directly to FundingEntryScreen
   * via `buildFundingEntryPath()`. Without it (or when the lookup returns
   * undefined for that job) the action falls back to the project detail
   * route. Always optional — the selector stays pure-function with no
   * store reads of its own.
   */
  fundingRequestLookup?: (jobId: string) => string | undefined
  /**
   * Optional pure lookup: jobId → raw `FundingRequestStatus`.
   *
   * Used to suppress the payable funding hero / follow-up for a
   * terminal-dead request (`expired` | `cancelled`): such a request can
   * never be paid (a pay attempt 409s `FUNDING_REQUEST_EXPIRED`), so it must
   * not be presented as payable/pending — mirroring the patched read
   * selectors. Optional so the selector stays a pure function; when absent
   * (or it returns undefined) the legacy non-gated behaviour applies.
   */
  fundingStatusLookup?: (jobId: string) => string | undefined
}

// ── Owner ────────────────────────────────────────────────────────────────────

/**
 * Machine-readable reason for the most urgent owner priority state.
 * null = no urgent condition; busy/calm applies based on job volume.
 */
export type OwnerPriorityReason =
  | 'dispute_open'       // at least one blocking dispute
  | 'payout_blocked'     // Stripe Connect is blocked; payouts cannot be received
  | 'payout_failed'      // a concrete bank payout was rejected — bank data must be checked
  | 'release_overdue'    // customer has not released the final payment
  | 'funding_awaited'    // customer has not funded escrow
  | 'requests_pending'   // new jobs awaiting owner response
  | null

/** Presentation state for the owner (craftsman) home/dashboard screen. */
export type OwnerHomeStateKind =
  | 'loading'
  | 'onboarding_incomplete'
  | 'dispute'
  | 'busy'
  | 'calm'

export type OwnerHomeState = {
  kind: OwnerHomeStateKind
  priorityReason: OwnerPriorityReason
  severity: 'urgent' | 'action' | null
  primaryAction: HomeAction | null
  followUps: HomeFollowUp[]
  notificationDot: boolean
}

export type OwnerHomeStateParams = {
  /** Owner's jobs — completed/cancelled are filtered internally. */
  jobs: Job[]
  /** Disputes associated with any of the owner's jobs. */
  disputes: Dispute[]
  /**
   * Current Stripe Connect payout readiness status.
   *
   * SOURCE CONTRACT (Block 2.1):
   *   Derive via: `derivePayoutReadinessStatus(account)` from `lib/payout/selectors.ts`
   *   where `account` comes from `fetchPayoutAccountForOnboarding()` in `lib/payout/client.ts`.
   *   While the fetch is in-flight or on error: pass `'no_account'` (conservative — never
   *   surfaces payout_blocked from a failed network call).
   *   `payout_blocked` only fires when the Stripe account explicitly returns that status.
   */
  payoutReadiness: PayoutReadinessStatus
  /**
   * Aggregated craftsman-facing payout-failure alert.
   *
   * SOURCE CONTRACT (Block 7.1D):
   *   Derive via: `derivePayoutFailureAlert(notificationSignals)` from
   *   `lib/payments/payoutFailureAlert.ts` where `notificationSignals` are the
   *   craftsman-scoped notification signals from the notification store. While
   *   the notification repo is in-flight or empty: pass `getEmptyPayoutFailureAlert()`
   *   so the home state never produces a phantom payout_failed reason.
   *
   *   `payout_failed` is the per-event signal (a concrete Stripe payout was
   *   rejected) — orthogonal to `payoutReadiness`, which describes the Stripe
   *   account state. Both can fire in parallel; account state wins.
   */
  payoutFailureAlert: PayoutFailureAlert
  /**
   * Current onboarding progress (derived from profile + payout).
   *
   * SOURCE CONTRACT (Block 2.1):
   *   Derive via: `deriveOnboardingProgress(profile, payoutAccount)` from `lib/onboarding/selectors.ts`
   *   where `profile` comes from `getMyCraftsmanBusinessProfile()` in `lib/craftsman/craftsmanProfileService.ts`.
   *   `getMyCraftsmanBusinessProfile()` reads the canonical `providers` table first, then enriches
   *   with `craftsman_profiles` (best-effort). While either fetch is in-flight: pass a default
   *   `OnboardingProgress` with `isProfileReady: false` so the loading guard fires correctly.
   *   Do NOT read from `craftsman_profiles` directly — use `getMyCraftsmanBusinessProfile()`.
   */
  onboardingProgress: OnboardingProgress
  jobsHydrated: boolean
  /**
   * True once all three payment repositories have finished their initial loads:
   *   isPaymentRepositoryHydrated() && isFundingRequestRepositoryHydrated() && isEscrowPlanRepositoryHydrated()
   * Block 2.1 must compose these three flags — no single helper exists yet.
   */
  paymentHydrated: boolean
  /**
   * Optional pure lookup: jobId → raw `FundingRequestStatus`.
   *
   * Used to suppress the `funding_awaited` hero / follow-up for a
   * terminal-dead request (`expired` | `cancelled`): the customer can no
   * longer pay it, so the craftsman home must not imply "the customer must
   * pay" — the provider has to send a NEW request (mirrors the patched
   * operationalSummary / nextAction selectors). Optional; legacy non-gated
   * behaviour applies when absent or it returns undefined.
   */
  fundingStatusLookup?: (jobId: string) => string | undefined
}

// ── Employee ─────────────────────────────────────────────────────────────────

/** Presentation state for the employee (worker) home screen. */
export type EmployeeHomeStateKind = 'loading' | 'onsite' | 'between' | 'dayOff'

export type EmployeeHomeState = {
  kind: EmployeeHomeStateKind
  primaryAction: HomeAction | null
  followUps: HomeFollowUp[]
  /** True when there are open items (pending corrections, missing docs). */
  notificationDot: boolean
}

export type EmployeeHomeStateParams = {
  /**
   * Calendar entries for today, already scoped to this worker's assignments
   * and company.  Callers must pre-filter using getEntriesForUser().
   */
  todayEntries: CalendarEntry[]
  /**
   * Today's date as a YYYY-MM-DD dateKey string.
   * Pass as a parameter so the function stays deterministic in tests.
   */
  todayKey: string
  calendarHydrated: boolean
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Active job = not completed and not cancelled. */
function isActiveJob(job: Job): boolean {
  return job.status !== 'completed' && job.status !== 'cancelled'
}

/**
 * Jobs that are operationally running — offer accepted, work underway or
 * awaiting payment.  Excludes `new` (no accepted offer yet).
 */
function isRunningJob(job: Job): boolean {
  return (
    job.status === 'booked' ||
    job.status === 'scheduled' ||
    job.status === 'in_progress' ||
    job.status === 'waiting_payment'
  )
}

function firstBlockingDispute(
  disputes: Dispute[],
  jobIds: Set<string>
): Dispute | undefined {
  return disputes.find((d) => jobIds.has(d.jobId) && isDisputeBlocking(d.status))
}

function loading(): { kind: 'loading'; priorityReason: null; severity: null; primaryAction: null; followUps: []; notificationDot: false } {
  return { kind: 'loading', priorityReason: null, severity: null, primaryAction: null, followUps: [], notificationDot: false }
}

const SEVERITY_ORDER: Record<'urgent' | 'action' | 'info', number> = {
  urgent: 0,
  action: 1,
  info: 2,
}

function sortFollowUps(items: HomeFollowUp[]): HomeFollowUp[] {
  return [...items].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  )
}

// ── Customer derivation ───────────────────────────────────────────────────────

/**
 * Derives the customer home state from canonical domain data.
 *
 * Priority: dispute_open > release_required > funding_required > active > waiting > discovery
 */
export function deriveCustomerHomeState(
  params: CustomerHomeStateParams
): CustomerHomeState {
  const { jobs, disputes, jobsHydrated, paymentHydrated, fundingRequestLookup, fundingStatusLookup } = params

  if (!jobsHydrated) return loading()

  const activeJobs = jobs.filter(isActiveJob)

  if (activeJobs.length === 0) {
    return {
      kind: 'discovery',
      priorityReason: null,
      severity: null,
      primaryAction: {
        actionId: 'browse_craftsmen',
        label: 'Handwerker finden',
        route: '/explore',
      },
      followUps: [],
      notificationDot: false,
    }
  }

  const activeJobIds = new Set(activeJobs.map((j) => j.id))

  // Payment-critical states require payment repos to be hydrated.
  if (paymentHydrated) {
    // 1. Dispute (highest priority) — payment frozen
    const blockingDispute = firstBlockingDispute(disputes, activeJobIds)
    if (blockingDispute) {
      const job = activeJobs.find((j) => j.id === blockingDispute.jobId)
      const followUps = buildCustomerFollowUps(activeJobs, disputes, activeJobIds, paymentHydrated, blockingDispute.jobId, fundingStatusLookup)
      return {
        kind: 'active',
        priorityReason: 'dispute_open',
        severity: 'urgent',
        primaryAction: {
          actionId: 'open_dispute',
          label: 'Streitfall ansehen',
          route: job ? `/projects/${job.projectId}` : '/projects',
        },
        followUps,
        notificationDot: true,
      }
    }

    // 2. Release required — customer must approve final payment
    const releaseJob = activeJobs.find(
      (j) => j.paymentState === 'release_pending' && j.status === 'waiting_payment'
    )
    if (releaseJob) {
      const followUps = buildCustomerFollowUps(activeJobs, disputes, activeJobIds, paymentHydrated, releaseJob.id, fundingStatusLookup)
      return {
        kind: 'active',
        priorityReason: 'release_required',
        severity: 'urgent',
        primaryAction: {
          actionId: 'release_payment',
          label: 'Bestätigen & freigeben',
          route: `/projects/${releaseJob.projectId}`,
        },
        followUps,
        notificationDot: true,
      }
    }

    // 3. Funded running job — escrow confirmed, work is active or scheduled.
    //    Must precede the deposit_required check so a project with cleared
    //    escrow is never hidden behind a separate unfunded job.
    const fundedRunningJob = activeJobs.find(
      (j) => isRunningJob(j) && j.paymentState !== 'deposit_required'
    )
    if (fundedRunningJob) {
      const followUps = buildCustomerFollowUps(activeJobs, disputes, activeJobIds, paymentHydrated, fundedRunningJob.id, fundingStatusLookup)
      return {
        kind: 'active',
        priorityReason: null,
        severity: null,
        primaryAction: {
          actionId: 'view_project',
          label: 'Projekt ansehen',
          route: `/projects/${fundedRunningJob.projectId}`,
        },
        followUps,
        notificationDot: followUps.length > 0,
      }
    }

    // 4. Funding required — no funded running job; customer must fund before work begins.
    //    Terminal-dead funding (expired / cancelled) is excluded: such a request
    //    can never be paid (a pay attempt 409s), so it must NOT surface the
    //    payable "Auftrag bezahlen" hero. Mirrors the patched read selectors.
    const fundingJob = activeJobs.find(
      (j) =>
        j.paymentState === 'deposit_required' &&
        !isFundingRequestTerminalDead(fundingStatusLookup?.(j.id))
    )
    if (fundingJob) {
      const followUps = buildCustomerFollowUps(activeJobs, disputes, activeJobIds, paymentHydrated, fundingJob.id, fundingStatusLookup)
      // Direct route to FundingEntryScreen when canonical fundingRequestId is
      // resolvable. Falls back to project detail when the lookup is absent or
      // the job has no funding request yet (e.g. cold-start race window).
      const fundingRequestId = fundingRequestLookup?.(fundingJob.id)
      const route = fundingRequestId
        ? buildFundingEntryPath(fundingRequestId)
        : `/projects/${fundingJob.projectId}`
      return {
        kind: 'waiting',
        priorityReason: 'funding_required',
        severity: 'action',
        primaryAction: {
          actionId: 'fund_escrow',
          label: 'Auftrag bezahlen',
          route,
        },
        followUps,
        notificationDot: true,
      }
    }
  }

  // 5. Running job — payment truth not yet hydrated; show active conservatively.
  const runningJob = activeJobs.find(isRunningJob)
  if (runningJob) {
    const followUps = buildCustomerFollowUps(activeJobs, disputes, activeJobIds, paymentHydrated, undefined, fundingStatusLookup)
    return {
      kind: 'active',
      priorityReason: null,
      severity: null,
      primaryAction: {
        actionId: 'view_project',
        label: 'Projekt ansehen',
        route: `/projects/${runningJob.projectId}`,
      },
      followUps,
      notificationDot: followUps.length > 0,
    }
  }

  // 6. All active jobs are new (waiting for craftsman)
  return {
    kind: 'waiting',
    priorityReason: null,
    severity: null,
    primaryAction: {
      actionId: 'view_request',
      label: 'Anfrage ansehen',
      route: `/projects/${activeJobs[0].projectId}`,
    },
    followUps: [],
    notificationDot: false,
  }
}

function buildCustomerFollowUps(
  activeJobs: Job[],
  disputes: Dispute[],
  activeJobIds: Set<string>,
  paymentHydrated: boolean,
  excludeJobId: string | undefined,
  fundingStatusLookup?: (jobId: string) => string | undefined
): HomeFollowUp[] {
  const items: HomeFollowUp[] = []

  if (!paymentHydrated) return items

  // Other jobs with blocking disputes
  for (const dispute of disputes) {
    if (!activeJobIds.has(dispute.jobId)) continue
    if (dispute.jobId === excludeJobId) continue
    if (!isDisputeBlocking(dispute.status)) continue
    const job = activeJobs.find((j) => j.id === dispute.jobId)
    items.push({
      id: `followup-dispute-${dispute.id}`,
      severity: 'urgent',
      title: 'Streitfall',
      meta: job?.title ?? dispute.title,
      route: job ? `/projects/${job.projectId}` : '/projects',
    })
  }

  // Other jobs requiring release
  for (const job of activeJobs) {
    if (job.id === excludeJobId) continue
    if (job.paymentState === 'release_pending' && job.status === 'waiting_payment') {
      items.push({
        id: `followup-release-${job.id}`,
        severity: 'urgent',
        title: 'Bestätigen & freigeben',
        meta: job.title,
        route: `/projects/${job.projectId}`,
      })
    }
  }

  // Other jobs requiring funding.
  // Terminal-dead funding (expired / cancelled) is skipped — the request can
  // no longer be paid, so it must not appear as a pending "Einzahlung ausstehend".
  for (const job of activeJobs) {
    if (job.id === excludeJobId) continue
    if (
      job.paymentState === 'deposit_required' &&
      !isFundingRequestTerminalDead(fundingStatusLookup?.(job.id))
    ) {
      items.push({
        id: `followup-funding-${job.id}`,
        severity: 'action',
        title: 'Einzahlung ausstehend',
        meta: job.title,
        route: `/projects/${job.projectId}`,
      })
    }
  }

  return sortFollowUps(items).slice(0, 3)
}

// ── Owner derivation ──────────────────────────────────────────────────────────

/**
 * Derives the owner (craftsman) home state from canonical domain data.
 *
 * Priority:
 *   dispute > payout_blocked > payout_failed > release_overdue > funding_awaited
 *   > requests_pending > onboarding_incomplete > busy (active work) > calm
 */
export function deriveOwnerHomeState(params: OwnerHomeStateParams): OwnerHomeState {
  const {
    jobs,
    disputes,
    payoutReadiness,
    payoutFailureAlert,
    onboardingProgress,
    jobsHydrated,
    paymentHydrated,
    fundingStatusLookup,
  } = params

  if (!jobsHydrated) return loading()

  const activeJobs = jobs.filter(isActiveJob)
  const activeJobIds = new Set(activeJobs.map((j) => j.id))

  // 1. Dispute — always overrides everything, including onboarding state.
  const blockingDispute = firstBlockingDispute(disputes, activeJobIds)
  if (blockingDispute) {
    const followUps = buildOwnerFollowUps(activeJobs, payoutReadiness, payoutFailureAlert, paymentHydrated, blockingDispute.jobId, fundingStatusLookup)
    return {
      kind: 'dispute',
      priorityReason: 'dispute_open',
      severity: 'urgent',
      primaryAction: {
        actionId: 'open_dispute',
        label: 'Streitfall öffnen',
        route: `/craftsman/jobs/${blockingDispute.jobId}`,
      },
      followUps,
      notificationDot: true,
    }
  }

  // Payment-critical states require payment truth.
  if (paymentHydrated) {
    // 2. Payout blocked — owner cannot receive money.
    if (payoutReadiness === 'payout_blocked') {
      return {
        kind: 'busy',
        priorityReason: 'payout_blocked',
        severity: 'urgent',
        primaryAction: {
          actionId: 'fix_payout',
          label: 'Auszahlung prüfen',
          route: '/craftsman/finance',
        },
        followUps: buildOwnerFollowUps(activeJobs, payoutReadiness, payoutFailureAlert, paymentHydrated, undefined, fundingStatusLookup, { excludePayoutBlockedFollowUp: true }),
        notificationDot: true,
      }
    }

    // 3. Concrete payout failure — Stripe rejected the bank payout.
    //    Lives between payout_blocked (account state) and release_overdue
    //    (customer-side action) because it represents real money the
    //    craftsman did not receive and only the craftsman can resolve.
    if (payoutFailureAlert.hasPayoutFailure) {
      // Suppress the payout-failure follow-up here — the hero card itself
      // already represents the alert. Other follow-ups (release pending,
      // funding awaited) remain visible.
      const followUps = buildOwnerFollowUps(
        activeJobs,
        payoutReadiness,
        payoutFailureAlert,
        paymentHydrated,
        undefined,
        fundingStatusLookup,
        { excludePayoutFailureFollowUp: true },
      )
      return {
        kind: 'busy',
        priorityReason: 'payout_failed',
        severity: 'urgent',
        primaryAction: {
          actionId: 'fix_payout_bank_data',
          label: payoutFailureAlert.ctaLabel,
          route: payoutFailureAlert.actionRoute,
        },
        followUps,
        notificationDot: true,
      }
    }

    // 4. Customer has not released final payment.
    const releaseJobs = activeJobs.filter(
      (j) => j.paymentState === 'release_pending' && j.status === 'waiting_payment'
    )
    if (releaseJobs.length > 0) {
      const followUps = buildOwnerFollowUps(activeJobs, payoutReadiness, payoutFailureAlert, paymentHydrated, releaseJobs[0].id, fundingStatusLookup)
      return {
        kind: 'busy',
        priorityReason: 'release_overdue',
        severity: 'action',
        primaryAction: {
          actionId: 'view_release_pending',
          label: 'Freigabe prüfen',
          route: `/craftsman/jobs/${releaseJobs[0].id}`,
        },
        followUps,
        notificationDot: true,
      }
    }

    // 5. Customer has not yet funded escrow.
    //    Terminal-dead funding (expired / cancelled) is excluded: the customer
    //    can no longer pay it, so the hero must not imply "the customer must
    //    pay" — the provider has to send a new request (mirrors operationalSummary).
    const fundingAwaited = activeJobs.filter(
      (j) =>
        j.paymentState === 'deposit_required' &&
        !isFundingRequestTerminalDead(fundingStatusLookup?.(j.id))
    )
    if (fundingAwaited.length > 0) {
      const followUps = buildOwnerFollowUps(activeJobs, payoutReadiness, payoutFailureAlert, paymentHydrated, fundingAwaited[0].id, fundingStatusLookup)
      return {
        kind: 'busy',
        priorityReason: 'funding_awaited',
        severity: 'action',
        primaryAction: {
          actionId: 'view_funding_pending',
          label: 'Auftrag prüfen',
          route: `/craftsman/jobs/${fundingAwaited[0].id}`,
        },
        followUps,
        notificationDot: false,
      }
    }
  }

  // 6. New incoming requests (unanswered).
  const newRequests = activeJobs.filter((j) => j.status === 'new')
  if (newRequests.length > 0) {
    const followUps = buildOwnerFollowUps(activeJobs, payoutReadiness, payoutFailureAlert, paymentHydrated, undefined, fundingStatusLookup)
    return {
      kind: 'busy',
      priorityReason: 'requests_pending',
      severity: 'action',
      primaryAction: {
        actionId: 'view_requests',
        label: 'Anfragen prüfen',
        route: '/craftsman/requests',
      },
      followUps,
      notificationDot: true,
    }
  }

  // 7. Onboarding not complete — deferred until after financial urgency so
  //    disputes and blocked payouts are never hidden behind a setup state.
  if (!onboardingProgress.isProfileReady) {
    return {
      kind: 'onboarding_incomplete',
      priorityReason: null,
      severity: 'action',
      primaryAction: {
        actionId: 'complete_profile',
        label: 'Profil vervollständigen',
        route: '/onboarding/craftsman-profile',
      },
      followUps: [],
      notificationDot: false,
    }
  }

  // 8. Active work (booked/scheduled/in_progress) — busy but no urgent items.
  const runningJobs = activeJobs.filter(isRunningJob)
  if (runningJobs.length > 0) {
    return {
      kind: 'busy',
      priorityReason: null,
      severity: null,
      primaryAction: {
        actionId: 'view_today',
        label: 'Tagesplan ansehen',
        route: '/craftsman/operations',
      },
      followUps: buildOwnerFollowUps(activeJobs, payoutReadiness, payoutFailureAlert, paymentHydrated, undefined, fundingStatusLookup),
      notificationDot: false,
    }
  }

  // 9. Calm — no active jobs, no urgent items.
  return {
    kind: 'calm',
    priorityReason: null,
    severity: null,
    primaryAction: {
      actionId: 'view_schedule',
      label: 'Tagesplan ansehen',
      route: '/craftsman/operations',
    },
    followUps: buildOwnerFollowUps(activeJobs, payoutReadiness, payoutFailureAlert, paymentHydrated, undefined, fundingStatusLookup),
    notificationDot: false,
  }
}

function buildOwnerFollowUps(
  activeJobs: Job[],
  payoutReadiness: PayoutReadinessStatus,
  payoutFailureAlert: PayoutFailureAlert,
  paymentHydrated: boolean,
  excludeJobId: string | undefined,
  fundingStatusLookup?: (jobId: string) => string | undefined,
  options: { excludePayoutFailureFollowUp?: boolean; excludePayoutBlockedFollowUp?: boolean } = {},
): HomeFollowUp[] {
  const items: HomeFollowUp[] = []

  if (!paymentHydrated) return items

  if (payoutReadiness === 'payout_blocked' && !options.excludePayoutBlockedFollowUp) {
    items.push({
      id: 'followup-payout-blocked',
      severity: 'urgent',
      title: 'Auszahlung gesperrt',
      meta: 'Stripe-Konto prüfen',
      route: '/craftsman/finance',
    })
  }

  // Surface the payout-failure alert as a follow-up when it is not the primary
  // hero state (i.e. dispute/payout_blocked already taking precedence).
  if (payoutFailureAlert.hasPayoutFailure && !options.excludePayoutFailureFollowUp) {
    items.push({
      id: 'followup-payout-failed',
      severity: 'urgent',
      title: payoutFailureAlert.title,
      meta: payoutFailureAlert.ctaLabel,
      route: payoutFailureAlert.actionRoute,
    })
  }

  if (
    payoutReadiness === 'onboarding_required' ||
    payoutReadiness === 'onboarding_in_progress'
  ) {
    items.push({
      id: 'followup-payout-setup',
      severity: 'action',
      title: 'Auszahlung einrichten',
      meta: 'Stripe Connect aktivieren',
      route: '/craftsman/payout-setup',
    })
  }

  for (const job of activeJobs) {
    if (job.id === excludeJobId) continue
    if (job.paymentState === 'release_pending' && job.status === 'waiting_payment') {
      items.push({
        id: `followup-release-${job.id}`,
        severity: 'action',
        title: 'Freigabe ausstehend',
        meta: job.title,
        route: `/craftsman/jobs/${job.id}`,
      })
    }
  }

  // Terminal-dead funding (expired / cancelled) is skipped — the customer can
  // no longer pay it, so it must not imply "the customer must pay".
  for (const job of activeJobs) {
    if (job.id === excludeJobId) continue
    if (
      job.paymentState === 'deposit_required' &&
      !isFundingRequestTerminalDead(fundingStatusLookup?.(job.id))
    ) {
      items.push({
        id: `followup-funding-${job.id}`,
        severity: 'info',
        title: 'Einzahlung ausstehend',
        meta: job.title,
        route: `/craftsman/jobs/${job.id}`,
      })
    }
  }

  return sortFollowUps(items).slice(0, 3)
}

// ── Employee derivation ───────────────────────────────────────────────────────

/**
 * Derives the employee home state from today's calendar entries.
 *
 * Priority: onsite > between > dayOff
 *
 * @param params.todayEntries  Pre-filtered entries for today and this worker.
 *   Callers must use getEntriesForUser() before passing here.
 * @param params.todayKey  YYYY-MM-DD string, e.g. formatDateKey(new Date()).
 */
export function deriveEmployeeHomeState(
  params: EmployeeHomeStateParams
): EmployeeHomeState {
  const { todayEntries, calendarHydrated } = params

  if (!calendarHydrated) {
    return {
      kind: 'loading',
      primaryAction: null,
      followUps: [],
      notificationDot: false,
    }
  }

  if (todayEntries.length === 0) {
    return {
      kind: 'dayOff',
      primaryAction: null,
      followUps: [],
      notificationDot: false,
    }
  }

  const onsiteEntry = todayEntries.find((e) => e.status === 'in_progress')
  if (onsiteEntry) {
    return {
      kind: 'onsite',
      primaryAction: {
        actionId: 'open_deployment',
        label: 'Einsatz öffnen',
        route: `/worker/einsaetze/${onsiteEntry.id}`,
      },
      followUps: [],
      notificationDot: false,
    }
  }

  // Entries exist today but none are in_progress.
  const nextEntry = todayEntries.find(
    (e) => e.status === 'scheduled' || e.status === 'pending'
  ) ?? todayEntries[0]

  return {
    kind: 'between',
    primaryAction: {
      actionId: 'start_deployment',
      label: 'Anfahrt starten',
      route: `/worker/einsaetze/${nextEntry.id}`,
    },
    followUps: [],
    notificationDot: false,
  }
}
