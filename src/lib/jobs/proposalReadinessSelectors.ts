import type { Job } from './types'
import { deriveIntakeReadiness } from './intakeSelectors'
import { deriveProposalLifecycle } from './helpers'

/**
 * Describes where a new job stands in the intake-to-proposal path.
 *
 * 'needs_clarification' – Key intake fields are missing; the craftsman should
 *                          gather more details before preparing an offer.
 * 'ready_for_proposal'  – All key intake fields are present and an amount is
 *                          set; the craftsman can now send a formal proposal.
 * 'proposal_sent'       – A proposal has been submitted; awaiting customer response.
 * 'proposal_accepted'   – The customer has explicitly accepted the proposal.
 */
export type ProposalReadiness =
  | 'needs_clarification'
  | 'ready_for_proposal'
  | 'proposal_sent'
  | 'proposal_accepted'
  | 'proposal_invalid'

/**
 * A specific prerequisite that must be satisfied before a proposal can be sent.
 */
export type ProposalPrerequisite = {
  id: string
  /** Short human-readable label shown in the UI */
  label: string
  /** Whether this prerequisite is currently satisfied */
  satisfied: boolean
}

/**
 * Suggested initial values for the proposal draft form, derived from the job's
 * intake context and any previously saved draft fields.
 * Used to pre-populate the `ProposalDraftCard` without requiring the craftsman
 * to retype information that was already captured at intake time.
 */
export type ProposalDraftPrefill = {
  /** Suggested amount, sourced from intake budget or existing job amount */
  amount: string
  /** Suggested scope description, sourced from intake description or job description */
  description: string
  /** Suggested timing note, sourced from saved proposalTimingNote or intake duration */
  timingNote: string
}

/**
 * Derives suggested pre-fill values for the proposal draft form.
 *
 * Priority order for each field:
 * - `amount`:      existing job amount → intake requestBudget → empty
 * - `description`: existing job description → intake requestDescription → empty
 * - `timingNote`:  saved proposalTimingNote → intake requestDuration → empty
 *
 * This is a pure read helper — it performs no state mutations.
 */
export function derivePrefillFromIntake(job: Job): ProposalDraftPrefill {
  const ctx = job.intakeContext
  return {
    amount: job.amount?.trim() || ctx?.requestBudget?.trim() || '',
    description: job.description?.trim() || ctx?.requestDescription?.trim() || '',
    timingNote: job.proposalTimingNote?.trim() || ctx?.requestDuration?.trim() || '',
  }
}

export type ProposalReadinessViewModel = {
  /** Current proposal readiness state */
  readiness: ProposalReadiness
  /** Short human-readable summary label */
  readinessLabel: string
  /** Colour token used by the UI */
  readinessColor: 'red' | 'yellow' | 'green' | 'blue'
  /** Individual prerequisites and whether they are met */
  prerequisites: ProposalPrerequisite[]
  /** Count of satisfied prerequisites */
  satisfiedCount: number
  /** Total number of prerequisites */
  totalCount: number
  /**
   * The single most important missing item, or null when all prerequisites
   * are met. Used for compact one-line guidance in smaller UI surfaces.
   */
  primaryGap: string | null
  /**
   * Pre-formatted date string for when the proposal was sent.
   * Only present when readiness === 'proposal_sent' or 'proposal_accepted'.
   */
  proposalSentLabel: string | null
  /**
   * Pre-formatted date string for when the customer accepted the proposal.
   * Only present when readiness === 'proposal_accepted'.
   */
  proposalAcceptedLabel: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPrerequisites(job: Job): ProposalPrerequisite[] {
  const intakeVm = deriveIntakeReadiness(job)
  const intakeReady = intakeVm.readiness === 'ready'

  // Profile-origin inquiries inherently carry minimal intake data because the
  // customer contacted the craftsman directly without a structured intake form.
  // Gating proposal send on intake completeness for these jobs produces a false
  // "project incomplete" blocker.  Skip the intake prerequisite entirely so the
  // craftsman can prepare and send an offer immediately.
  const isProfileOrigin = job.intakeContext?.origin === 'inquiry_profile'

  // Reel-origin inquiries also lack structured intake: the customer tapped
  // "Anfrage senden" from a short-form video, so no detailed intake form was
  // presented.  Like profile-origin, the bypass requires both the offer amount
  // AND description to be present — merely having sourceConversationId is not
  // enough.
  const isReelOrigin = job.intakeContext?.origin === 'inquiry_reel'

  const hasSufficientOfferFields =
    Boolean(job.amount && job.amount.trim().length > 0) &&
    Boolean(job.description && job.description.trim().length > 0)

  // Narrow bypass: only unstructured-intake origins (profile, reel) with
  // valid offer fields can skip the intake prerequisite.  Structured-intake
  // origins (category, project, direct) must satisfy normal intake readiness.
  const isUnstructuredOriginWithOfferFields =
    (isProfileOrigin || isReelOrigin) && hasSufficientOfferFields

  return [
    {
      id: 'intake',
      label: 'Anfrage-Details vollständig',
      // isProfileOrigin is listed separately because profile-origin ALWAYS
      // bypasses intake (even without offer fields filled in), while
      // reel-origin only bypasses when offer fields are present.
      satisfied: isProfileOrigin || isUnstructuredOriginWithOfferFields || intakeReady,
    },
    {
      id: 'amount',
      label: 'Angebotspreis festgelegt',
      satisfied: Boolean(job.amount && job.amount.trim().length > 0),
    },
    {
      id: 'description',
      label: 'Projektbeschreibung vorhanden',
      satisfied: Boolean(
        job.description &&
          job.description.trim().length > 0
      ),
    },
  ]
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------

/**
 * Derives a view-model describing whether a job is ready to receive a formal
 * proposal/offer.
 *
 * Intended for use on jobs in `'new'` status. The returned view-model drives
 * the `ProposalReadinessCard` (craftsman) and `CustomerProposalStatusCard`
 * (customer) components.
 *
 * This is a pure read helper — it performs no state mutations.
 */
export function deriveProposalReadiness(job: Job): ProposalReadinessViewModel {
  const lifecycle = deriveProposalLifecycle(job.proposalSentAt, job.proposalAcceptedAt)

  if (lifecycle.stage === 'invalid') {
    const prerequisites = buildPrerequisites(job)
    return {
      readiness: 'proposal_invalid',
      readinessLabel: 'Ungültiger Angebotsstatus',
      readinessColor: 'red',
      prerequisites,
      satisfiedCount: prerequisites.filter((p) => p.satisfied).length,
      totalCount: prerequisites.length,
      primaryGap: 'Bitte Angebot erneut senden (fehlender Versandzeitpunkt)',
      proposalSentLabel: null,
      proposalAcceptedLabel: lifecycle.proposalAcceptedAt
        ? formatTimestamp(lifecycle.proposalAcceptedAt)
        : null,
    }
  }

  // If the customer has accepted the proposal, return that state immediately
  if (lifecycle.stage === 'accepted' && lifecycle.proposalSentAt && lifecycle.proposalAcceptedAt) {
    const prerequisites = buildPrerequisites(job)
    return {
      readiness: 'proposal_accepted',
      readinessLabel: 'Angebot angenommen',
      readinessColor: 'green',
      prerequisites,
      satisfiedCount: prerequisites.filter((p) => p.satisfied).length,
      totalCount: prerequisites.length,
      primaryGap: null,
      proposalSentLabel: formatTimestamp(lifecycle.proposalSentAt),
      proposalAcceptedLabel: formatTimestamp(lifecycle.proposalAcceptedAt),
    }
  }

  // If a proposal has already been sent, return that state immediately
  if (lifecycle.stage === 'sent' && lifecycle.proposalSentAt) {
    const prerequisites = buildPrerequisites(job)
    return {
      readiness: 'proposal_sent',
      readinessLabel: 'Angebot gesendet',
      readinessColor: 'blue',
      prerequisites,
      satisfiedCount: prerequisites.filter((p) => p.satisfied).length,
      totalCount: prerequisites.length,
      primaryGap: null,
      proposalSentLabel: formatTimestamp(lifecycle.proposalSentAt),
      proposalAcceptedLabel: null,
    }
  }

  const prerequisites = buildPrerequisites(job)
  const satisfiedCount = prerequisites.filter((p) => p.satisfied).length
  const totalCount = prerequisites.length
  const firstUnsatisfied = prerequisites.find((p) => !p.satisfied)

  const allSatisfied = satisfiedCount === totalCount

  if (allSatisfied) {
    return {
      readiness: 'ready_for_proposal',
      readinessLabel: 'Bereit für Angebot',
      readinessColor: 'green',
      prerequisites,
      satisfiedCount,
      totalCount,
      primaryGap: null,
      proposalSentLabel: null,
      proposalAcceptedLabel: null,
    }
  }

  return {
    readiness: 'needs_clarification',
    readinessLabel: 'Klärung erforderlich',
    readinessColor: satisfiedCount >= Math.ceil(totalCount / 2) ? 'yellow' : 'red',
    prerequisites,
    satisfiedCount,
    totalCount,
    primaryGap: firstUnsatisfied?.label ?? null,
    proposalSentLabel: null,
    proposalAcceptedLabel: null,
  }
}

export type ProposalState =
  | 'none'
  | 'draft_blocked'
  | 'ready_to_send'
  | 'sent'
  | 'accepted'
  | 'invalid'

export type ProposalStateView = {
  state: ProposalState
  label: string
  tone: 'slate' | 'amber' | 'green' | 'blue' | 'red'
  hasDraft: boolean
}

/**
 * Derives a compact offer/proposal state for craftsman-facing UIs so the
 * difference between draft, ready-to-send, sent, and accepted is explicit.
 */
export function deriveProposalState(job: Job): ProposalStateView {
  const lifecycle = deriveProposalLifecycle(job.proposalSentAt, job.proposalAcceptedAt)
  const hasDraft =
    Boolean(job.amount && job.amount.trim().length > 0) ||
    Boolean(job.description && job.description.trim().length > 0) ||
    Boolean(job.proposalTimingNote && job.proposalTimingNote.trim().length > 0)

  if (lifecycle.stage === 'invalid') {
    return {
      state: 'invalid',
      label: 'Ungültiger Angebotsstatus',
      tone: 'red',
      hasDraft,
    }
  }

  if (lifecycle.stage === 'accepted' && lifecycle.proposalSentAt && lifecycle.proposalAcceptedAt) {
    return {
      state: 'accepted',
      label: 'Angebot angenommen',
      tone: 'green',
      hasDraft,
    }
  }

  if (lifecycle.stage === 'sent') {
    return {
      state: 'sent',
      label: 'Angebot gesendet',
      tone: 'blue',
      hasDraft,
    }
  }

  const readiness = deriveProposalReadiness(job)
  if (readiness.readiness === 'ready_for_proposal') {
    return {
      state: 'ready_to_send',
      label: 'Versandbereit',
      tone: 'green',
      hasDraft,
    }
  }

  if (hasDraft) {
    return {
      state: 'draft_blocked',
      label: 'Entwurf gespeichert',
      tone: 'amber',
      hasDraft,
    }
  }

  return {
    state: 'none',
    label: 'Kein Angebot erstellt',
    tone: 'slate',
    hasDraft,
  }
}
