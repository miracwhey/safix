/**
 * Action Queue Selectors
 *
 * Derives the action-oriented job queue for the craftsman work screen.
 *
 * Jobs are grouped by action urgency, not raw status:
 *   1. Needs action now  — disputes, unassigned, overdue schedules, payout setup, new requests
 *   2. In progress       — actively being worked
 *   3. Waiting           — waiting for customer or external event
 *   4. Coming up         — scheduled/booked, not yet started and not overdue
 *
 * Each job entry includes:
 *   - a clean user-facing action label (not internal status)
 *   - a "what is needed next" line
 *   - up to 1 primary + 1 secondary quick action
 *   - (for coming_up) schedule proximity badge and days-until value
 *
 * ── ACTION MATRIX ──────────────────────────────────────────────────────────
 *
 * State Family              │ Group         │ Primary Action         │ Type       │ Secondary       │ Type
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 1. Assignment needed      │ needs_action  │ assign_worker          │ DIRECT     │ take_job        │ DIRECT
 *    (unassigned booked/    │               │ "Mitarbeiter zuweisen" │            │ "Selbst         │
 *    unassigned scheduled)  │               │                        │            │  übernehmen"    │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 2. Appointment needed     │ needs_action  │ plan_appointment       │ DIRECT     │ —               │ —
 *    (assigned booked,      │               │ "Termin planen"        │            │                 │
 *    no funding in flight)  │               │                        │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 3. New request            │ needs_action  │ open_request           │ CONTEXTUAL │ —               │ —
 *    (status new, no offer) │               │ "Anfrage öffnen"       │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 4. Offer sent / waiting   │ waiting       │ view_proposal          │ CONTEXTUAL │ —               │ —
 *    (status new, proposal) │               │ "Angebot ansehen"      │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 5a. In-progress unassigned │ needs_action  │ assign_worker          │ DIRECT     │ take_job        │ DIRECT
 *     (in_progress +        │               │ "Mitarbeiter zuweisen" │            │ "Selbst         │
 *     no assignee)          │               │                        │            │  übernehmen"    │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 5b. In progress assigned  │ in_progress   │ open_job               │ CONTEXTUAL │ —               │ —
 *    (status in_progress)   │               │ "Auftrag öffnen"       │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 6. Scheduled & ready      │ coming_up     │ view_schedule          │ CONTEXTUAL │ —               │ —
 *    (scheduled + assigned, │               │ "Termin öffnen"        │            │                 │
 *    not overdue)           │               │                        │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 7. Payment waiting        │ waiting       │ view_payment           │ CONTEXTUAL │ —               │ —
 *    (waiting_payment)      │               │ "Zahlung ansehen"      │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 8. Dispute open           │ needs_action  │ open_dispute           │ CONTEXTUAL │ —               │ —
 *    (any status + dispute) │               │ "Streitfall ansehen"   │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 9. Fallback / unknown     │ waiting       │ open_job               │ CONTEXTUAL │ —               │ —
 *    (unknown status)       │               │ "Auftrag öffnen"       │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 10. Schedule overdue      │ needs_action  │ open_job               │ CONTEXTUAL │ —               │ —
 *     (scheduled + overdue) │               │ "Auftrag öffnen"       │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 11. Payout setup required │ needs_action  │ view_payout_setup      │ CONTEXTUAL │ —               │ —
 *     (completed + payout   │               │ "Konto-Setup öffnen"   │            │                 │
 *     not ready)            │               │                        │            │                 │
 * ──────────────────────────┼───────────────┼────────────────────────┼────────────┼─────────────────┼──────────
 * 12. Funding in processing │ waiting       │ view_payment           │ CONTEXTUAL │ —               │ —
 *     (booked + funding     │               │ "Zahlung ansehen"      │            │                 │
 *     started/initiated)    │               │                        │            │                 │
 *
 * DIRECT = resolved inline via action panel, imperative label
 * CONTEXTUAL = navigates to detail screen, "öffnen"/"ansehen" label
 *
 * DIRECT-RESOLUTION VERDICT:
 *   Only assignment (assign_worker, take_job) and appointment scheduling
 *   (plan_appointment) use direct queue resolution. All other states require
 *   full detail context and remain honest contextual deep-links.
 *
 * NON-DIRECT VERDICT:
 *   Disputes, payment waiting, offer sent, in-progress, scheduled+assigned,
 *   new requests, overdue schedules, payout setup, and fallback states remain
 *   contextual because they require full detail context to resolve correctly.
 */

import type { Job } from '../jobs/types'
import type { Dispute } from '../disputes/types'

// ── Types ────────────────────────────────────────────────────────────────────

export type ActionQueueGroup = 'needs_action' | 'in_progress' | 'waiting' | 'coming_up'

export type QuickActionType = 'direct' | 'contextual'

/**
 * Exhaustive list of quick action identifiers used by queue cards.
 *
 * DIRECT actions (resolved inline from the queue):
 *   assign_worker     — assign team member to a job
 *   take_job          — craftsman takes the job themselves
 *   plan_appointment  — schedule date/time for a booked job
 *
 * CONTEXTUAL actions (navigate to detail context):
 *   open_dispute      — open dispute detail screen
 *   open_request      — open new request for review / proposal creation
 *   open_job          — open generic job detail (in-progress, overdue, fallback)
 *   view_proposal     — view sent proposal (waiting on customer)
 *   view_payment      — view payment details (waiting on release / funding in progress)
 *   view_schedule     — view scheduled appointment details
 *   view_payout_setup — open payout account setup (payment released, account not ready)
 */
export type QuickActionId =
  | 'assign_worker'
  | 'take_job'
  | 'plan_appointment'
  | 'open_dispute'
  | 'open_request'
  | 'open_job'
  | 'view_proposal'
  | 'view_payment'
  | 'view_schedule'
  | 'view_payout_setup'

export type QuickAction = {
  id: QuickActionId
  label: string
  icon: string
  /** Whether this action resolves directly from the queue or opens a detail context */
  actionType: QuickActionType
}

/**
 * Machine-readable proximity badge for `coming_up` items.
 *
 * Thresholds (calendar days from today to the scheduled date):
 *   imminent — 0–1 days  (today or tomorrow — start soon)
 *   soon     — 2–7 days  (within the week)
 *   later    — 8+ days   (further out)
 *
 * Only present when a schedule date (dateKey) is available for the job.
 */
export type ScheduleProximity = 'imminent' | 'soon' | 'later'

export type ActionQueueItem = {
  job: Job
  /** User-facing action-driven phase label */
  phaseLabel: string
  /** One-line "what is needed next" */
  nextStepLabel: string
  /** Group this item belongs to */
  group: ActionQueueGroup
  /** Primary quick action (max 1) */
  primaryAction: QuickAction | null
  /** Optional secondary quick action (max 1) */
  secondaryAction: QuickAction | null
  /** True if there is an active dispute on this job */
  hasDispute: boolean
  /**
   * Schedule proximity badge. Only set for `coming_up` items when the caller
   * provides a schedule date via `comingUpScheduleDates`.
   */
  scheduleProximity?: ScheduleProximity
  /**
   * Calendar days from today to the scheduled date (0 = today, 1 = tomorrow, …).
   * Only set for `coming_up` items when the caller provides a schedule date.
   */
  daysUntil?: number
}

export type ActionQueueResult = {
  needsAction: ActionQueueItem[]
  inProgress: ActionQueueItem[]
  waiting: ActionQueueItem[]
  comingUp: ActionQueueItem[]
  totalItems: number
}

// ── Action derivation per job ────────────────────────────────────────────────

/**
 * Quick Action labeling rules:
 *
 * Actions are classified as either DIRECT or CONTEXTUAL:
 *
 * DIRECT QUEUE ACTIONS (actionType: 'direct'):
 *   Resolve the bottleneck directly from the queue via inline action panel.
 *   Labels use imperative wording: "Mitarbeiter zuweisen", "Termin planen"
 *   IDs: assign_worker, take_job, plan_appointment
 *
 * HONEST CONTEXTUAL OPENS (actionType: 'contextual'):
 *   Navigate to the appropriate detail context. No pretend in-place action.
 *   Labels use "öffnen" / "ansehen" to honestly frame the deep-link.
 *   IDs: open_dispute, open_request, open_job, view_proposal, view_payment,
 *        view_schedule, view_payout_setup
 */

function deriveActionQueueItem(
  job: Job,
  disputeJobIds: Set<string>,
  unassignedJobIds: Set<string>,
  scheduledJobIds: Set<string>,
  overdueScheduledJobIds: Set<string>,
  payoutBlockedJobIds: Set<string>,
  fundingInProgressJobIds: Set<string>,
): ActionQueueItem {
  const hasDispute = disputeJobIds.has(job.id)

  // ── 8. Dispute overlay — always takes priority ─────────────────────────
  // Classification: HONEST CONTEXTUAL OPEN
  // Reason: dispute resolution needs full case context, cannot be done inline
  if (hasDispute) {
    return {
      job,
      phaseLabel: 'Streitfall offen',
      nextStepLabel: 'Streitfall prüfen und reagieren',
      group: 'needs_action',
      primaryAction: { id: 'open_dispute', label: 'Streitfall ansehen', icon: '⚖️', actionType: 'contextual' },
      secondaryAction: null,
      hasDispute: true,
    }
  }

  // ── 11. Payout setup required ──────────────────────────────────────────
  // Payment was released but craftsman cannot receive funds yet.
  // Derived from: job.status === 'completed' AND in payoutBlockedJobIds.
  // Classification: HONEST CONTEXTUAL OPEN
  // Reason: payout account setup requires full onboarding context
  if (payoutBlockedJobIds.has(job.id)) {
    return {
      job,
      phaseLabel: 'Auszahlung einrichten',
      nextStepLabel: 'Auszahlungs-Konto vervollständigen um Zahlung zu erhalten',
      group: 'needs_action',
      primaryAction: { id: 'view_payout_setup', label: 'Konto-Setup öffnen', icon: '🏦', actionType: 'contextual' },
      secondaryAction: null,
      hasDispute: false,
    }
  }

  // ── Status-based derivation ────────────────────────────────────────────
  switch (job.status) {

    // ── 3. New request / 4. Offer sent ─────────────────────────────────
    case 'new': {
      if (job.proposalSentAt) {
        // 4. Offer sent — passive waiting, customer must respond
        // Classification: HONEST CONTEXTUAL OPEN
        // Reason: craftsman is waiting, can only review the sent proposal
        return {
          job,
          phaseLabel: 'Angebot gesendet',
          nextStepLabel: 'Warte auf Kundenantwort',
          group: 'waiting',
          primaryAction: { id: 'view_proposal', label: 'Angebot ansehen', icon: '📄', actionType: 'contextual' },
          secondaryAction: null,
          hasDispute: false,
        }
      }
      // 3. New request — needs review and proposal creation
      // Classification: HONEST CONTEXTUAL OPEN
      // Reason: proposal creation needs full detail context, cannot be inline
      return {
        job,
        phaseLabel: 'Neue Anfrage',
        nextStepLabel: 'Prüfen und Angebot erstellen',
        group: 'needs_action',
        primaryAction: { id: 'open_request', label: 'Anfrage öffnen', icon: '📋', actionType: 'contextual' },
        secondaryAction: null,
        hasDispute: false,
      }
    }

    // ── 1. Assignment needed / 2. Appointment needed / 2b. Already scheduled ─
    case 'booked': {
      const isUnassigned = unassignedJobIds.has(job.id)
      if (isUnassigned) {
        // 1. Assignment needed — unassigned booked
        // Classification: DIRECT QUEUE ACTION
        // Reason: assigning a worker is compact and common; can be done inline
        return {
          job,
          phaseLabel: 'Zuteilung nötig',
          nextStepLabel: 'Mitarbeiter zuweisen oder selbst übernehmen',
          group: 'needs_action',
          primaryAction: { id: 'assign_worker', label: 'Mitarbeiter zuweisen', icon: '👷', actionType: 'direct' },
          secondaryAction: { id: 'take_job', label: 'Selbst übernehmen', icon: '🙋', actionType: 'direct' },
          hasDispute: false,
        }
      }

      // 12. Funding in processing — customer has started paying, craftsman waits.
      // Cannot and should not plan appointment until funding is confirmed.
      // Classification: HONEST CONTEXTUAL OPEN
      // Reason: craftsman is waiting for payment to process; only viewing is possible
      if (fundingInProgressJobIds.has(job.id)) {
        return {
          job,
          phaseLabel: 'Zahlung wird verarbeitet',
          nextStepLabel: 'Warte auf Bestätigung der Einzahlung',
          group: 'waiting',
          primaryAction: { id: 'view_payment', label: 'Zahlung ansehen', icon: '⏳', actionType: 'contextual' },
          secondaryAction: null,
          hasDispute: false,
        }
      }

      // 2b. Booked but already scheduled — schedule exists via canonical save
      // Classification: HONEST CONTEXTUAL OPEN
      // Job status is still 'booked' but a schedule already exists.
      if (scheduledJobIds.has(job.id)) {
        return {
          job,
          phaseLabel: 'Geplant',
          nextStepLabel: 'Einsatz starten wenn vor Ort',
          group: 'coming_up',
          primaryAction: { id: 'view_schedule', label: 'Termin öffnen', icon: '📅', actionType: 'contextual' },
          secondaryAction: null,
          hasDispute: false,
        }
      }
      // 2. Appointment needed — assigned but missing schedule
      // Classification: DIRECT QUEUE ACTION
      // Reason: compact date/time picking fits inline panel
      return {
        job,
        phaseLabel: 'Termin offen',
        nextStepLabel: 'Termin mit Kunden abstimmen',
        group: 'coming_up',
        primaryAction: { id: 'plan_appointment', label: 'Termin planen', icon: '📅', actionType: 'direct' },
        secondaryAction: null,
        hasDispute: false,
      }
    }

    // ── 1. Assignment needed (scheduled) / 9. Scheduled & ready / 10. Overdue ─
    case 'scheduled': {
      const isUnassigned = unassignedJobIds.has(job.id)
      if (isUnassigned) {
        // 1. Assignment needed — unassigned scheduled
        // Classification: DIRECT QUEUE ACTION
        // Reason: same compact assignment flow as booked
        return {
          job,
          phaseLabel: 'Zuteilung nötig',
          nextStepLabel: 'Geplanter Auftrag ohne Mitarbeiter',
          group: 'needs_action',
          primaryAction: { id: 'assign_worker', label: 'Mitarbeiter zuweisen', icon: '👷', actionType: 'direct' },
          secondaryAction: { id: 'take_job', label: 'Selbst übernehmen', icon: '🙋', actionType: 'direct' },
          hasDispute: false,
        }
      }

      // 10. Schedule overdue — appointment window has passed without execution start.
      // The 7.1 truth layer classifies this as urgent. The queue must mirror it.
      // Classification: HONEST CONTEXTUAL OPEN
      // Reason: reschedule or manual execution start requires detail context
      if (overdueScheduledJobIds.has(job.id)) {
        return {
          job,
          phaseLabel: 'Termin überfällig',
          nextStepLabel: 'Ausführung starten oder Termin verschieben',
          group: 'needs_action',
          primaryAction: { id: 'open_job', label: 'Auftrag öffnen', icon: '⚠️', actionType: 'contextual' },
          secondaryAction: null,
          hasDispute: false,
        }
      }

      // 9. Scheduled and ready — assigned, appointment exists, not overdue
      // Classification: HONEST CONTEXTUAL OPEN
      // Reason: craftsman may want to review schedule details before starting
      return {
        job,
        phaseLabel: 'Geplant',
        nextStepLabel: 'Einsatz starten wenn vor Ort',
        group: 'coming_up',
        primaryAction: { id: 'view_schedule', label: 'Termin öffnen', icon: '📅', actionType: 'contextual' },
        secondaryAction: null,
        hasDispute: false,
      }
    }

    // ── 5. In progress ─────────────────────────────────────────────────
    case 'in_progress': {
      // 5a. Active work without assigned member — assignment is the primary bottleneck.
      // Classification: DIRECT QUEUE ACTION
      // Reason: same compact assignment flow as booked/scheduled. Work is
      // actively happening without clear ownership — resolve inline.
      if (unassignedJobIds.has(job.id)) {
        return {
          job,
          phaseLabel: 'Zuteilung nötig',
          nextStepLabel: 'Aktiver Auftrag ohne zugewiesenen Mitarbeiter',
          group: 'needs_action',
          primaryAction: { id: 'assign_worker', label: 'Mitarbeiter zuweisen', icon: '👷', actionType: 'direct' },
          secondaryAction: { id: 'take_job', label: 'Selbst übernehmen', icon: '🙋', actionType: 'direct' },
          hasDispute: false,
        }
      }
      // 5b. Assigned in-progress — standard contextual open.
      // Classification: HONEST CONTEXTUAL OPEN
      // Reason: "mark complete" requires documentation review and full detail
      // context. Cannot be safely done from a compact queue card.
      return {
        job,
        phaseLabel: 'In Arbeit',
        nextStepLabel: 'Arbeit dokumentieren und abschließen',
        group: 'in_progress',
        primaryAction: { id: 'open_job', label: 'Auftrag öffnen', icon: '🔨', actionType: 'contextual' },
        secondaryAction: null,
        hasDispute: false,
      }
    }

    // ── 7. Payment-related waiting ─────────────────────────────────────
    // Classification: HONEST CONTEXTUAL OPEN
    // Reason: craftsman cannot act — customer must release payment.
    // Only viewing payment details is possible.
    case 'waiting_payment':
      return {
        job,
        phaseLabel: 'Warte auf Freigabe',
        nextStepLabel: 'Kunde muss Arbeit bestätigen & Betrag freigeben',
        group: 'waiting',
        primaryAction: { id: 'view_payment', label: 'Zahlung ansehen', icon: '💰', actionType: 'contextual' },
        secondaryAction: null,
        hasDispute: false,
      }

    // ── 10. Fallback / unknown state ───────────────────────────────────
    // Classification: HONEST CONTEXTUAL OPEN
    // Reason: unknown state still needs a safe escape to detail view
    default:
      return {
        job,
        phaseLabel: job.status,
        nextStepLabel: 'Auftrag prüfen',
        group: 'waiting',
        primaryAction: { id: 'open_job', label: 'Auftrag öffnen', icon: '🔨', actionType: 'contextual' },
        secondaryAction: null,
        hasDispute: false,
      }
  }
}

// ── Schedule proximity helpers ───────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Computes calendar days from the start of today (in local time) to the
 * start of the day described by `dateKey` ('YYYY-MM-DD').
 *
 * Returns 0 when the date is today or in the past (clamped at 0).
 */
function computeDaysUntil(dateKey: string, nowMs: number): number {
  const [yearStr, monthStr, dayStr] = dateKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return 0

  const scheduleMs = new Date(year, month - 1, day).getTime()

  // Truncate nowMs to local midnight
  const nowDate = new Date(nowMs)
  const nowMidnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime()

  const diff = scheduleMs - nowMidnight
  return Math.max(0, Math.floor(diff / MS_PER_DAY))
}

/**
 * Derives the schedule proximity badge from `daysUntil`.
 *
 * Thresholds:
 *   imminent — 0–1 days  (today or tomorrow)
 *   soon     — 2–7 days  (within the week)
 *   later    — 8+ days
 */
function deriveScheduleProximity(daysUntil: number): ScheduleProximity {
  if (daysUntil <= 1) return 'imminent'
  if (daysUntil <= 7) return 'soon'
  return 'later'
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Derives the action-oriented queue from the current job list.
 *
 * Excludes completed and cancelled jobs, with the following exceptions:
 *   - Completed jobs in `payoutBlockedJobIds` are kept: payment was released
 *     but the provider cannot receive funds yet due to missing payout setup.
 *
 * Excludes future-scheduled jobs (dateKey > todayKey) that have no active
 * dispute — those belong only to planning surfaces (Kalender, TodayBlock).
 * Groups items by action urgency, with "needs action" first.
 *
 * `comingUp` is sorted deterministically by scheduled date (ascending, nearest
 * first). Jobs without a known schedule date sort last within the group.
 * Schedule proximity info (`scheduleProximity`, `daysUntil`) is derived for
 * items that have an entry in `comingUpScheduleDates`.
 *
 * Pure function — no mutations, no side effects.
 *
 * @param scheduledJobIds         IDs of jobs that have a saved schedule entry.
 * @param futureScheduledJobIds   IDs of jobs whose CalendarEntry has a dateKey
 *   strictly after today and status === 'scheduled'. Removed from queue unless
 *   they carry an active dispute.
 * @param overdueScheduledJobIds  IDs of scheduled jobs whose schedule window
 *   has passed without execution starting (ScheduleReadiness === 'overdue').
 *   These are surfaced as needs_action instead of coming_up.
 * @param payoutBlockedJobIds     IDs of completed jobs where payment is
 *   released but the provider's payout account is not ready. These are kept
 *   in the queue and surfaced as needs_action.
 * @param fundingInProgressJobIds IDs of booked/assigned jobs where the customer
 *   has started funding (funding_started / funding_initiated) but confirmation
 *   is not yet received. These go to waiting instead of coming_up.
 * @param comingUpScheduleDates   Map of job ID → dateKey ('YYYY-MM-DD') for
 *   coming_up jobs. Used to sort comingUp by proximity and derive
 *   `scheduleProximity` / `daysUntil` on each item.
 * @param nowMs                   Current time in milliseconds. Defaults to
 *   Date.now(). Pass explicitly in tests for determinism.
 */
export function deriveActionQueue(
  jobs: Job[],
  disputes: Dispute[],
  unassignedJobs: Job[],
  scheduledJobIds?: Set<string>,
  futureScheduledJobIds?: Set<string>,
  overdueScheduledJobIds?: Set<string>,
  payoutBlockedJobIds?: Set<string>,
  fundingInProgressJobIds?: Set<string>,
  comingUpScheduleDates?: Map<string, string>,
  nowMs?: number,
): ActionQueueResult {
  const disputeJobIds = new Set(
    disputes
      .filter((d) => d.status === 'open' || d.status === 'under_review')
      .map((d) => d.jobId),
  )

  const unassignedJobIds = new Set(unassignedJobs.map((j) => j.id))
  const resolvedScheduledJobIds = scheduledJobIds ?? new Set<string>()
  const resolvedFutureScheduledIds = futureScheduledJobIds ?? new Set<string>()
  const resolvedOverdueIds = overdueScheduledJobIds ?? new Set<string>()
  const resolvedPayoutBlockedIds = payoutBlockedJobIds ?? new Set<string>()
  const resolvedFundingInProgressIds = fundingInProgressJobIds ?? new Set<string>()
  const resolvedScheduleDates = comingUpScheduleDates ?? new Map<string, string>()
  const resolvedNowMs = nowMs ?? Date.now()

  const activeJobs = jobs.filter((j) => {
    if (j.status === 'cancelled') return false
    if (j.status === 'completed') {
      // Exception: completed jobs needing payout setup are surfaced in the queue.
      // All other completed jobs are excluded.
      return resolvedPayoutBlockedIds.has(j.id)
    }
    // Future-scheduled jobs (no active issue) belong only to planning surfaces.
    // Exception: keep them in the queue if there is an active dispute.
    if (resolvedFutureScheduledIds.has(j.id) && !disputeJobIds.has(j.id)) return false
    return true
  })

  const needsAction: ActionQueueItem[] = []
  const inProgress: ActionQueueItem[] = []
  const waiting: ActionQueueItem[] = []
  const comingUp: ActionQueueItem[] = []

  for (const job of activeJobs) {
    const item = deriveActionQueueItem(
      job,
      disputeJobIds,
      unassignedJobIds,
      resolvedScheduledJobIds,
      resolvedOverdueIds,
      resolvedPayoutBlockedIds,
      resolvedFundingInProgressIds,
    )

    switch (item.group) {
      case 'needs_action':
        needsAction.push(item)
        break
      case 'in_progress':
        inProgress.push(item)
        break
      case 'waiting':
        waiting.push(item)
        break
      case 'coming_up':
        comingUp.push(item)
        break
    }
  }

  // Sort needs_action by urgency:
  // disputes (0) > assignment needed (1) > overdue schedule (2) > payout setup (3) > new requests (4)
  needsAction.sort((a, b) => {
    const urgencyOrder = (item: ActionQueueItem) => {
      if (item.hasDispute) return 0
      if (item.phaseLabel === 'Zuteilung nötig') return 1
      if (item.phaseLabel === 'Termin überfällig') return 2
      if (item.phaseLabel === 'Auszahlung einrichten') return 3
      return 4
    }
    return urgencyOrder(a) - urgencyOrder(b)
  })

  // ── coming_up: sort by schedule date (nearest first), enrich proximity ──
  //
  // Jobs with a known dateKey sort ascending by ISO date string comparison
  // ('YYYY-MM-DD' lexicographic order == chronological order).
  // Jobs without a known dateKey are sorted last (stable relative to each other).
  comingUp.sort((a, b) => {
    const dateA = resolvedScheduleDates.get(a.job.id)
    const dateB = resolvedScheduleDates.get(b.job.id)
    if (dateA == null && dateB == null) return 0
    if (dateA == null) return 1   // a has no date → goes last
    if (dateB == null) return -1  // b has no date → b goes last
    return dateA < dateB ? -1 : dateA > dateB ? 1 : 0
  })

  // Enrich coming_up items with proximity info where a schedule date is known.
  for (const item of comingUp) {
    const dateKey = resolvedScheduleDates.get(item.job.id)
    if (dateKey != null) {
      const days = computeDaysUntil(dateKey, resolvedNowMs)
      item.daysUntil = days
      item.scheduleProximity = deriveScheduleProximity(days)
    }
  }

  return {
    needsAction,
    inProgress,
    waiting,
    comingUp,
    totalItems: needsAction.length + inProgress.length + waiting.length + comingUp.length,
  }
}
