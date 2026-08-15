/**
 * Work Entry Selectors
 *
 * Derives the ATTENTION SUMMARY for the craftsman home work-entry card.
 *
 * The work-entry card is NOT a status summary for individual jobs.
 * It answers: "Does work need my attention right now? How many tasks
 * need me? What kinds of open steps are relevant?"
 *
 * The card aggregates attention types (assignment needed, dispute open,
 * request review, waiting context, coming-up work) into a single
 * human-readable summary with a stable CTA routing to the work queue.
 *
 * Visual urgency levels (for styling only):
 *   critical — active disputes
 *   high     — unassigned jobs
 *   normal   — passive but relevant work
 *   none     — true clean slate
 */

import type { Job } from '../jobs/types'
import type { Dispute } from '../disputes/types'
import { ACTIVE_DISPUTE_STATUSES } from '../disputes/stateMachine'
import type { OnboardingProgress } from '../onboarding/selectors'

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkEntryUrgency = 'critical' | 'high' | 'normal' | 'none'

export type WorkEntrySummary = {
  /** Total items the craftsman can meaningfully act on right now */
  totalActionable: number
  /** Total items visible in the work queue (all groups) */
  totalRemaining: number
  /** Active disputes requiring response */
  disputeCount: number
  /** Jobs in waiting_payment status */
  paymentWaitingCount: number
  /** Booked/scheduled jobs with no assigned member */
  unassignedCount: number
  /** New incoming requests (status: new, no proposal sent yet) */
  newRequestCount: number
  /** Jobs actively in progress */
  inProgressCount: number
  /** Booked/scheduled jobs that are assigned (coming up / appointment pending),
   *  excluding future-scheduled jobs which belong to planning surfaces only */
  comingUpCount: number
  /** New jobs where a proposal has been sent (waiting for customer response) */
  proposalSentCount: number
  /** Attention-mode eyebrow label */
  eyebrow: string
  /** Derived headline for the card */
  headline: string
  /** Short context line explaining why attention is needed */
  subtitle: string
  /** Visual urgency (drives color styling only) */
  urgency: WorkEntryUrgency
  /** Emoji icon */
  icon: string
  /**
   * Navigation target for the work-entry card CTA.
   * Normally '/craftsman/jobs?focus=handlungsbedarf' — the unified owner work
   * surface scoped to the Handlungsbedarf section.
   * Routes to '/craftsman/operations' when the action queue is empty but
   * future-scheduled work exists — the user belongs in the planner, not the queue.
   */
  ctaRoute: string
  /** Human-readable CTA label (e.g. "Aufgaben öffnen →" or "Planung öffnen →") */
  ctaLabel: string
}

// ── Derivation ───────────────────────────────────────────────────────────────

export function deriveWorkEntrySummary(
  jobs: Job[],
  disputes: Dispute[],
  unassignedJobs: Job[],
  scheduledJobIds?: Set<string>,
  futureScheduledJobIds?: Set<string>,
): WorkEntrySummary {
  const activeDisputes = disputes.filter((d) => ACTIVE_DISPUTE_STATUSES.has(d.status))
  const paymentWaiting = jobs.filter((j) => j.status === 'waiting_payment')
  // Split 'new' jobs: actual new requests vs. proposal already sent (waiting on customer)
  const newRequests = jobs.filter((j) => j.status === 'new' && !j.proposalSentAt)
  const proposalSent = jobs.filter((j) => j.status === 'new' && !!j.proposalSentAt)
  const inProgress = jobs.filter((j) => j.status === 'in_progress')

  // Coming-up: booked/scheduled jobs that ARE assigned (not in the unassigned set)
  // AND are NOT future-scheduled (those belong to planning surfaces, not the action queue).
  const unassignedIds = new Set(unassignedJobs.map((j) => j.id))
  const resolvedFutureScheduledIds = futureScheduledJobIds ?? new Set<string>()
  const comingUp = jobs.filter(
    (j) =>
      (j.status === 'booked' || j.status === 'scheduled') &&
      !unassignedIds.has(j.id) &&
      !resolvedFutureScheduledIds.has(j.id),
  )

  // Whether any future-scheduled work exists (drives routing decision).
  const hasFutureScheduled = resolvedFutureScheduledIds.size > 0

  const disputeCount = activeDisputes.length
  const paymentWaitingCount = paymentWaiting.length
  const unassignedCount = unassignedJobs.length
  const newRequestCount = newRequests.length
  const proposalSentCount = proposalSent.length
  const inProgressCount = inProgress.length
  const comingUpCount = comingUp.length

  // totalActionable = items the craftsman can meaningfully act on RIGHT NOW.
  // Matches the queue's needs_action group:
  //   - disputes, unassigned jobs, new requests (no proposal sent).
  // Excluded from totalActionable (but still tracked):
  //   - waiting_payment (customer must release)
  //   - proposalSent (customer must respond)
  //   - comingUp (scheduled/booked assigned — no immediate action)
  //   - inProgress (ongoing work, not a new action)
  const totalActionable =
    disputeCount + unassignedCount + newRequestCount

  // ── Total remaining: all queue-visible work across every group ─────────
  // Used for clean-slate determination — "Alles erledigt" is only allowed
  // when this is zero. This matches the queue's totalItems exactly.
  const totalRemaining =
    totalActionable + inProgressCount + paymentWaitingCount + comingUpCount + proposalSentCount

  // ── Urgency resolution ─────────────────────────────────────────────────
  // Payment waiting still elevates urgency (it is important to know about)
  // even though the craftsman cannot directly act on it.
  let urgency: WorkEntryUrgency = 'none'
  if (disputeCount > 0) {
    urgency = 'critical'
  } else if (unassignedCount > 0) {
    urgency = 'high'
  } else if (paymentWaitingCount > 0) {
    urgency = 'normal'
  } else if (newRequestCount > 0 || inProgressCount > 0) {
    urgency = 'normal'
  } else if (comingUpCount > 0 || proposalSentCount > 0) {
    urgency = 'normal'
  }

  // ── Eyebrow: attention mode ──────────────────────────────────────────
  // The eyebrow describes the MODE of attention, not a technical status.
  const eyebrow: string =
    totalActionable > 0
      ? 'Aufmerksamkeit nötig'
      : totalRemaining > 0
        ? 'Im Blick behalten'
        : 'Überblick'

  // ── Headline / subtitle / icon — ATTENTION SUMMARY ─────────────────
  // The card aggregates attention need, not raw job status.
  let headline: string
  let subtitle: string
  let icon: string

  // ── CTA domain: planning vs. work-queue ──────────────────────────────
  // When the ONLY remaining work is effectively-scheduled jobs (status=scheduled,
  // or status=booked with a schedule record in scheduledJobIds) with no
  // actionable items, no in-progress, no payment-waiting, and no proposals
  // pending, routing to the work queue would land the user on an empty list.
  // Instead, send them to the planner.
  //
  // Booked jobs WITHOUT a schedule record are NOT treated as future-scheduled —
  // they still need planning action and belong in the work queue.
  const resolvedScheduled = scheduledJobIds ?? new Set<string>()
  const isEffectivelyScheduledJob = (j: Job) =>
    j.status === 'scheduled' || (j.status === 'booked' && resolvedScheduled.has(j.id))
  const isOnlyFutureScheduled =
    totalActionable === 0 &&
    inProgressCount === 0 &&
    paymentWaitingCount === 0 &&
    proposalSentCount === 0 &&
    comingUpCount > 0 &&
    comingUp.every(isEffectivelyScheduledJob)

  const ctaLabel = isOnlyFutureScheduled ? 'Planung öffnen →' : 'Aufgaben öffnen →'
  const ctaRoute = isOnlyFutureScheduled
    ? '/craftsman/operations'
    : '/craftsman/jobs?focus=handlungsbedarf'

  if (totalRemaining === 0) {
    // ── TRUE CLEAN SLATE ──────────────────────────────────────────────
    // Only when ALL queue groups are empty. Setup is a separate concern.
    //
    // If future-scheduled work exists, route to the planner so the user can
    // review upcoming appointments — the action queue has nothing to show.
    const cleanCtaRoute = hasFutureScheduled
      ? '/craftsman/operations'
      : '/craftsman/jobs?focus=handlungsbedarf'
    const cleanCtaLabel = hasFutureScheduled ? 'Planung öffnen →' : 'Aufgaben öffnen →'
    return {
      totalActionable: 0,
      totalRemaining: 0,
      disputeCount: 0,
      paymentWaitingCount: 0,
      unassignedCount: 0,
      newRequestCount: 0,
      inProgressCount: 0,
      comingUpCount: 0,
      proposalSentCount: 0,
      eyebrow,
      headline: hasFutureScheduled ? 'Alles geplant' : 'Gerade ist nichts offen',
      subtitle: hasFutureScheduled
        ? 'Deine nächsten Einsätze findest du im Kalender.'
        : 'Keine dringenden Aufgaben in deiner Arbeitsliste.',
      urgency: 'none',
      icon: hasFutureScheduled ? '📅' : '✅',
      ctaRoute: cleanCtaRoute,
      ctaLabel: cleanCtaLabel,
    }
  }

  if (totalActionable > 1) {
    // ── MULTI-ISSUE ATTENTION ─────────────────────────────────────────
    // Multiple items need action — aggregate into one attention headline.
    headline = `${totalActionable} Aufgaben brauchen dich`
    const parts: string[] = []
    if (disputeCount > 0)
      parts.push(disputeCount === 1 ? '1 Streitfall offen' : `${disputeCount} Streitfälle offen`)
    if (unassignedCount > 0)
      parts.push(unassignedCount === 1 ? '1 Zuteilung fehlt' : `${unassignedCount} Zuteilungen fehlen`)
    if (newRequestCount > 0)
      parts.push(newRequestCount === 1 ? '1 Anfrage offen' : `${newRequestCount} Anfragen offen`)
    subtitle = parts.join(', ') + '.'
    icon = disputeCount > 0 ? '⚖️' : '📋'
  } else if (totalActionable === 1) {
    // ── SINGLE CLEAR ACTION ───────────────────────────────────────────
    // Exactly one actionable item — the title can be more specific,
    // but always framed as attention need, not raw status.
    if (disputeCount === 1) {
      headline = '1 Streitfall braucht Aufmerksamkeit'
      subtitle = 'Prüfen und Stellung nehmen.'
      icon = '⚖️'
    } else if (unassignedCount === 1) {
      headline = '1 Auftrag braucht Zuteilung'
      subtitle = 'Ein Auftrag ist noch niemandem zugewiesen.'
      icon = '👷'
    } else {
      headline = '1 Anfrage braucht Prüfung'
      subtitle = 'Eine neue Anfrage wartet auf dein Angebot.'
      icon = '📥'
    }
  } else {
    // ── PASSIVE BUT RELEVANT ──────────────────────────────────────────
    // No direct action needed, but there is relevant work to keep in view.
    // Softer attention framing — no false urgent action pressure.
    const passiveParts: string[] = []
    if (inProgressCount > 0)
      passiveParts.push(inProgressCount === 1 ? '1 Auftrag in Arbeit' : `${inProgressCount} Aufträge in Arbeit`)
    if (comingUpCount > 0) {
      // Split coming-up into needs-scheduling (booked without schedule) vs truly-scheduled
      const isAwaitingSchedule = (j: Job) => j.status === 'booked' && !resolvedScheduled.has(j.id)
      const bookedUpcomingCount = comingUp.filter(isAwaitingSchedule).length
      const scheduledUpcomingCount = comingUp.filter(isEffectivelyScheduledJob).length
      if (bookedUpcomingCount > 0)
        passiveParts.push(bookedUpcomingCount === 1 ? '1 Auftrag wartet auf Terminplanung' : `${bookedUpcomingCount} Aufträge warten auf Terminplanung`)
      if (scheduledUpcomingCount > 0)
        passiveParts.push(scheduledUpcomingCount === 1 ? '1 Einsatz terminiert' : `${scheduledUpcomingCount} Einsätze terminiert`)
    }
    if (paymentWaitingCount > 0)
      passiveParts.push(paymentWaitingCount === 1 ? '1 Zahlung ausstehend' : `${paymentWaitingCount} Zahlungen ausstehend`)
    if (proposalSentCount > 0)
      passiveParts.push(proposalSentCount === 1 ? '1 Angebot wartet auf Rückmeldung' : `${proposalSentCount} Angebote warten auf Rückmeldung`)

    headline = totalRemaining === 1
      ? '1 Auftrag im Blick'
      : `${totalRemaining} Aufträge im Blick`
    subtitle = passiveParts.length > 0
      ? passiveParts.join(', ') + '.'
      : 'Keine dringenden Aufgaben.'
    icon = comingUpCount > 0 ? '📅' : inProgressCount > 0 ? '🔨' : paymentWaitingCount > 0 ? '💰' : '📄'
  }

  return {
    totalActionable,
    totalRemaining,
    disputeCount,
    paymentWaitingCount,
    unassignedCount,
    newRequestCount,
    inProgressCount,
    comingUpCount,
    proposalSentCount,
    eyebrow,
    headline,
    subtitle,
    urgency,
    icon,
    ctaLabel,
    ctaRoute,
  }
}

// ── Setup Reminder ──────────────────────────────────────────────────────────
// Separate concern: determines whether a setup/unlock reminder should be
// shown on the home screen. This is NEVER merged into the work-entry card.

export type SetupReminder = {
  /** Whether to show the setup reminder card */
  visible: boolean
  /** Whether setup data is still loading (readiness not yet known) */
  loading: boolean
  /** Headline for the setup reminder */
  headline: string
  /** Short description */
  subtitle: string
  /** Emoji icon */
  icon: string
  /** Navigation target */
  linkTo: string
}

/**
 * Derives the setup reminder state independently from work entry.
 *
 * The setup card is visible when onboarding is incomplete with a pending step.
 * It disappears only when the relevant setup state is truly completed.
 *
 * When `loaded` is false, returns a loading state so the card slot can reserve
 * space (skeleton) instead of being absent and popping in later.
 *
 * This is intentionally separate from deriveWorkEntrySummary —
 * setup and work entry never share a slot.
 */
export function deriveSetupReminder(
  onboarding: OnboardingProgress | null,
  loaded: boolean = true,
): SetupReminder {
  if (!loaded) {
    return {
      visible: false,
      loading: true,
      headline: '',
      subtitle: '',
      icon: '',
      linkTo: '',
    }
  }

  if (!onboarding || onboarding.isComplete || !onboarding.nextStep) {
    return {
      visible: false,
      loading: false,
      headline: '',
      subtitle: '',
      icon: '',
      linkTo: '',
    }
  }

  const next = onboarding.nextStep
  const isPayoutStep = next.id === 'payout_setup'

  return {
    visible: true,
    loading: false,
    headline: next.title,
    subtitle: isPayoutStep
      ? 'Auszahlungen freischalten — du kannst weiter arbeiten.'
      : next.description,
    icon: isPayoutStep ? '💳' : '🚀',
    linkTo: next.navigationPath,
  }
}
