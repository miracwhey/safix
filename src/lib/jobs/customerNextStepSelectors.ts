import type { Job } from './types'
import type { Payment } from '../payments/types'
import { deriveCustomerJobStage } from './customerJobStageSelectors'
import { getActionablePaymentState } from './helpers'
import { resolveCanonicalFundingTarget, buildFundingEntryPath } from '../funding'
import { getFundingRequestByJobId } from '../payments/fundingRequest'

/**
 * A concise, human-readable next-step descriptor from the customer's perspective.
 * Returned by `deriveCustomerNextStep` and consumed by `CustomerJobNextStepBanner`.
 */
export type CustomerNextStep = {
  /** Short headline for the current state (e.g. "Release Payment") */
  label: string
  /** One-sentence explanation of what is happening or what the customer should do */
  hint: string
  /** Optional route the CTA button navigates to */
  actionRoute?: string
  /** Optional label for the CTA button – omit when no navigation is needed */
  actionLabel?: string
}

/**
 * Derives the customer's next step from the combined job + payment context.
 *
 * Pure function — no mutations, no side effects.
 *
 * @param job        The job record (must have at minimum `id`, `projectId`, `status`, `paymentState`)
 * @param payment    Optional payment record for the job (used to refine stage detection)
 * @param fundingStatus   Optional funding request status
 * @param escrowStatus    Optional escrow plan status for partial/full release distinction
 */
export function deriveCustomerNextStep(
  job: Job,
  payment?: Payment,
  fundingStatus?: string,
  escrowStatus?: string
): CustomerNextStep {
  const effectivePaymentState = getActionablePaymentState(job, payment)

  const { stage } = deriveCustomerJobStage(
    job.status,
    effectivePaymentState,
    job.proposalSentAt,
    job.proposalAcceptedAt,
    fundingStatus,
    escrowStatus
  )

  const projectRoute = `/projects/${job.projectId}`

  // Primary: dedicated funding entry route keyed by fundingRequestId (hydration-safe)
  const fundingRequest = getFundingRequestByJobId(job.id)
  const fundingEntryPath = fundingRequest ? buildFundingEntryPath(fundingRequest.id) : null

  // Fallback: resolve canonical payment target via project-based resolver
  const fundingTarget = resolveCanonicalFundingTarget(job.id)
  if (!fundingTarget.ok && !fundingEntryPath) {
    console.warn('[CustomerNextStep] canonical funding target fallback for job', job.id, ':', fundingTarget.code)
  }
  const paymentRoute = fundingEntryPath ?? (fundingTarget.ok ? fundingTarget.path : `${projectRoute}?focus=payment`)

  // When deposit_required is set AND the canonical stage is offer_accepted (accepted
  // but no FundingRequest yet), the customer needs to fund before work starts.
  // For all other stages, the stage-based CTA in the switch below takes priority —
  // earlier stages should not be overridden, and later stages have already moved past payment.
  if (effectivePaymentState === 'deposit_required' && stage === 'offer_accepted') {
    return {
      label: 'Zahlung einzahlen',
      hint: 'Der Handwerker ist bereit. Bitte zahle den Betrag ein, um das Projekt zu starten.',
      actionRoute: paymentRoute,
      actionLabel: 'Jetzt einzahlen',
    }
  }

  if (effectivePaymentState === 'deposit_paid') {
    return {
      label: 'Zahlung abgesichert',
      hint: 'Deine Einzahlung ist bestätigt. Der Gesamtbetrag ist gesichert. Der Handwerker beginnt mit der Arbeit.',
    }
  }

  switch (stage) {
    case 'inquiry_sent':
      return {
        label: 'Antwort ausstehend',
        hint: 'Deine Anfrage wurde gesendet. Der Handwerker prüft sie und sendet dir ein Angebot.',
      }

    case 'offer_received':
      return {
        label: 'Angebot liegt vor',
        hint: 'Der Handwerker hat ein Angebot gesendet. Prüfe es und nehme es an.',
        actionRoute: projectRoute,
        actionLabel: 'Angebot ansehen',
      }

    case 'offer_accepted':
      return {
        label: 'Termin wird koordiniert',
        hint: 'Angebot angenommen. Der Handwerker stimmt den Termin mit dir ab.',
      }

    case 'funding_pending':
      return {
        label: 'Zahlung einzahlen',
        hint: 'Der Handwerker hat vollständige Zahlung angefordert. Zahle den Gesamtbetrag ein, um zu starten.',
        actionRoute: paymentRoute,
        actionLabel: 'Jetzt einzahlen',
      }

    case 'funded_in_escrow':
      return {
        label: 'Zahlung abgesichert',
        hint: 'Deine vollständige Einzahlung ist bestätigt und gesichert. Der Handwerker beginnt mit der Arbeit.',
      }

    case 'work_in_progress':
      return {
        label: 'Arbeit läuft',
        hint: 'Der Handwerker arbeitet an deinem Projekt.',
      }

    case 'work_completed':
      return {
        label: 'Bestätigen & freigeben',
        hint: 'Arbeit abgeschlossen. Prüfe sie und gib den über Stripe abgesicherten Betrag an den Handwerker frei.',
        actionRoute: paymentRoute,
        actionLabel: 'Bestätigen & freigeben',
      }

    case 'partially_released':
      return {
        label: 'Teilfreigabe erfolgt',
        hint: 'Die erste Rate (25 %) wurde freigegeben. Die Restzahlung wird nach Abschluss freigegeben.',
      }

    case 'payment_released':
      return {
        label: 'Auftrag abgeschlossen',
        hint: 'Zahlung wurde freigegeben. Dein Projekt ist abgeschlossen.',
      }
  }
}
