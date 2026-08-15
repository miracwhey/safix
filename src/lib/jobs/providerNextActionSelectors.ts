import type { Job } from './types'
import type { ProviderJobPhase } from './providerJobPhaseSelectors'
import { deriveProviderJobPhase } from './providerJobPhaseSelectors'
import type { FundingRequestStatus } from '../payments/fundingRequest/types'
import type { EscrowPlanStatus } from '../payments/escrow/escrowTypes'
import type { PayoutReadinessStatus } from '../payout/types'

// ---------------------------------------------------------------------------
// Provider Next Action
// ---------------------------------------------------------------------------

/**
 * Describes the single most important action a provider should take
 * on a job, derived from its operational phase.
 *
 * `actionId` is a machine-readable key that UI components can use
 * to wire buttons/CTAs.
 */
export type ProviderNextAction = {
  /** Machine-readable action identifier for UI wiring */
  actionId: ProviderActionId
  /** Short German label for the CTA button */
  label: string
  /** One-sentence German description of what the action does */
  description: string
  /** Whether this action can be triggered by the provider right now */
  enabled: boolean
  /** Optional reason why the action is disabled */
  disabledReason?: string
}

export type ProviderActionId =
  | 'request_funding'
  | 'start_work'
  | 'complete_work'
  | 'wait_for_acceptance'
  | 'wait_for_funding'
  | 'wait_for_release'
  | 'view_dispute'
  | 'complete_payout_setup'
  | 'none'

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derives the next action for a provider on a job.
 *
 * Pure function — no mutations, no side effects.
 *
 * Diagnosis jobs (job.jobKind === 'diagnosis') follow their own execution
 * path.  They do NOT enter the standard escrow/funding corridor.
 * Phase-to-action mapping is overridden accordingly:
 *   funding_not_requested / quote_accepted  → start_work directly (no escrow)
 *   work_started                            → complete_work with diagnosis label
 *   work_completed / awaiting_release       → none (document findings, no release)
 *
 * @param job                   The job entity
 * @param fundingStatus         FundingRequestStatus (from getFundingRequestByJobId)
 * @param escrowStatus          EscrowPlanStatus (from getEscrowPlanByJobId)
 * @param payoutReadinessStatus PayoutReadinessStatus (from derivePayoutReadinessStatus)
 */
export function deriveProviderNextAction(
  job: Job,
  fundingStatus?: FundingRequestStatus | string,
  escrowStatus?: EscrowPlanStatus | string,
  payoutReadinessStatus?: PayoutReadinessStatus
): ProviderNextAction {
  const { phase } = deriveProviderJobPhase(job, fundingStatus, escrowStatus)
  const isDiagnosis = job.jobKind === 'diagnosis'

  // ── Diagnosis path override ──────────────────────────────────────────────
  // Diagnosis jobs bypass the escrow/funding corridor entirely.
  // Map phases to diagnosis-appropriate actions without standard payment steps.
  if (isDiagnosis) {
    const diagnosisAction = getDiagnosisActionForPhase(phase)
    if (diagnosisAction) return diagnosisAction
  }

  const action = getNextActionForPhase(phase)

  // Payout-readiness override: payment was released but provider cannot
  // receive funds yet because their Stripe Connect account is not ready.
  if (
    action.actionId === 'none' &&
    phase === 'payment_released' &&
    payoutReadinessStatus != null &&
    payoutReadinessStatus !== 'payout_ready'
  ) {
    if (payoutReadinessStatus === 'pending_verification') {
      return {
        actionId: 'complete_payout_setup',
        label: 'Verifizierung läuft',
        description:
          'Die Zahlung wurde freigegeben. Dein Konto wird gerade verifiziert — die Auszahlung erfolgt nach Abschluss der Prüfung.',
        enabled: true,
      }
    }
    return {
      actionId: 'complete_payout_setup',
      label: 'Auszahlungs-Konto einrichten',
      description:
        'Die Zahlung wurde freigegeben, aber dein Auszahlungs-Konto ist noch nicht bereit. Vervollständige das Setup, um die Zahlung zu erhalten.',
      enabled: true,
    }
  }

  return action
}

// ---------------------------------------------------------------------------
// Diagnosis-specific phase → action mapping
// ---------------------------------------------------------------------------

/**
 * Returns a diagnosis-specific next action for phases where the standard
 * escrow/funding semantics must not apply.
 *
 * Returns null for phases that are already correctly handled by the standard
 * path (e.g. cancelled, disputed).
 */
function getDiagnosisActionForPhase(phase: ProviderJobPhase): ProviderNextAction | null {
  switch (phase) {
    case 'quote_sent':
      return {
        actionId: 'wait_for_acceptance',
        label: 'Auf Freigabe warten',
        description: 'Die Diagnose-Anfrage wurde gesendet. Warten Sie auf die Freigabe des Kunden.',
        enabled: false,
        disabledReason: 'Diagnose-Anfrage wurde noch nicht freigegeben',
      }

    // Diagnosis jobs are approved and ready to execute — no funding step
    case 'quote_accepted':
    case 'funding_not_requested':
      return {
        actionId: 'start_work',
        label: 'Diagnoseeinsatz starten',
        description: 'Die Diagnose wurde freigegeben. Sie können den Diagnoseeinsatz jetzt durchführen.',
        enabled: true,
      }

    // Should not occur for diagnosis (no escrow), but guard defensively
    case 'funding_requested':
    case 'funding_pending':
    case 'funded_in_escrow':
      return {
        actionId: 'start_work',
        label: 'Diagnoseeinsatz starten',
        description: 'Die Diagnose wurde freigegeben. Sie können den Diagnoseeinsatz jetzt durchführen.',
        enabled: true,
      }

    case 'work_started':
      return {
        actionId: 'complete_work',
        label: 'Diagnoseeinsatz abschließen',
        description: 'Markieren Sie den Diagnoseeinsatz als abgeschlossen, sobald die Diagnose durchgeführt wurde.',
        enabled: true,
      }

    case 'work_completed':
    case 'awaiting_release':
      return {
        actionId: 'none',
        label: 'Diagnose abgeschlossen',
        description: 'Der Diagnoseeinsatz ist abgeschlossen. Besprechen Sie die Befunde mit dem Kunden. Falls weitere Arbeiten nötig sind, erstellen Sie ein neues Angebot.',
        enabled: false,
      }

    case 'payment_released':
    case 'partially_released':
    case 'closed':
    case 'cancelled':
      return {
        actionId: 'none',
        label: 'Diagnoseeinsatz abgeschlossen',
        description: 'Der Diagnoseeinsatz ist abgeschlossen.',
        enabled: false,
      }

    // Dispute and other phases: fall through to standard handling
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Standard phase → action mapping (binding_offer / estimate_tracking)
// ---------------------------------------------------------------------------

function getNextActionForPhase(phase: ProviderJobPhase): ProviderNextAction {
  switch (phase) {
    case 'quote_sent':
      return {
        actionId: 'wait_for_acceptance',
        label: 'Auf Annahme warten',
        description: 'Das Angebot wurde gesendet. Warten Sie auf die Antwort des Kunden.',
        enabled: false,
        disabledReason: 'Angebot wurde noch nicht angenommen',
      }

    case 'quote_accepted':
    case 'funding_not_requested':
      return {
        actionId: 'request_funding',
        label: 'Zahlung anfordern',
        description: 'Fordern Sie die Zahlung vom Kunden an, um mit der Arbeit beginnen zu können.',
        enabled: true,
      }

    case 'funding_requested':
      return {
        actionId: 'wait_for_funding',
        label: 'Auf Kundeneinzahlung warten',
        description: 'Die Zahlungsaufforderung wurde gesendet. Warten Sie auf die Einzahlung des Kunden.',
        enabled: false,
        disabledReason: 'Kundeneinzahlung steht noch aus',
      }

    case 'funding_pending':
      return {
        actionId: 'wait_for_funding',
        label: 'Einzahlung wird verarbeitet',
        description: 'Der Kunde hat die Einzahlung gestartet. Verarbeitung läuft.',
        enabled: false,
        disabledReason: 'Einzahlung wird gerade verarbeitet',
      }

    case 'funded_in_escrow':
      return {
        actionId: 'start_work',
        label: 'Arbeit starten',
        description: 'Die Zahlung ist bestätigt. Sie können jetzt mit der Arbeit beginnen.',
        enabled: true,
      }

    case 'work_started':
      return {
        actionId: 'complete_work',
        label: 'Arbeit abschließen',
        description: 'Markieren Sie die Arbeit als abgeschlossen, wenn alle Arbeiten erledigt sind.',
        enabled: true,
      }

    case 'work_completed':
    case 'awaiting_release':
      return {
        actionId: 'wait_for_release',
        label: 'Auf Freigabe warten',
        description: 'Die Arbeit ist abgeschlossen. Warten Sie auf die Zahlungsfreigabe durch den Kunden.',
        enabled: false,
        disabledReason: 'Zahlungsfreigabe steht noch aus',
      }

    case 'partially_released':
      return {
        actionId: 'wait_for_release',
        label: '25% freigegeben — Warte auf Restfreigabe',
        description: 'Die erste Tranche wurde freigegeben. Warten Sie auf die Freigabe der Restzahlung.',
        enabled: false,
        disabledReason: 'Restfreigabe steht noch aus',
      }

    case 'payment_released':
      return {
        actionId: 'none',
        label: 'Zahlung freigegeben',
        description: 'Die gesamte Zahlung wurde freigegeben. Der Auftrag ist abgeschlossen.',
        enabled: false,
      }

    case 'disputed':
      return {
        actionId: 'view_dispute',
        label: 'Streitfall prüfen',
        description: 'Ein Streitfall ist offen. Prüfen Sie den Status und reagieren Sie gegebenenfalls.',
        enabled: false,
        disabledReason: 'Streitfall in Bearbeitung',
      }

    case 'closed':
      return {
        actionId: 'none',
        label: 'Abgeschlossen',
        description: 'Dieser Auftrag ist abgeschlossen.',
        enabled: false,
      }

    case 'cancelled':
      return {
        actionId: 'none',
        label: 'Storniert',
        description: 'Dieser Auftrag wurde storniert und ist nicht mehr aktiv.',
        enabled: false,
      }
  }
}
