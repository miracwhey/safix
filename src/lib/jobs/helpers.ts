import type { JobStatus } from '../shared/coreTypes'
import type { Job, PaymentState } from './types'
import type { Payment } from '../payments/types'

export type ProposalLifecycleStage = 'none' | 'sent' | 'accepted' | 'invalid'

export function deriveProposalLifecycle(
  proposalSentAt?: number,
  proposalAcceptedAt?: number
): { stage: ProposalLifecycleStage; proposalSentAt?: number; proposalAcceptedAt?: number } {
  if (proposalAcceptedAt && !proposalSentAt) {
    return { stage: 'invalid', proposalAcceptedAt }
  }
  if (proposalSentAt && proposalAcceptedAt) {
    return { stage: 'accepted', proposalSentAt, proposalAcceptedAt }
  }
  if (proposalSentAt) {
    return { stage: 'sent', proposalSentAt }
  }
  return { stage: 'none' }
}

export function getNextStep(status: JobStatus): string {
  if (status === 'new') {
    return 'Anfrage prüfen, Rückfragen klären und Termin vorschlagen.'
  }

  if (status === 'scheduled') {
    return 'Termin bestätigen, Team sauber einplanen und Vorbereitung abschließen.'
  }

  if (status === 'in_progress') {
    return 'Fortschritt dokumentieren und den Auftrag operativ weiterführen.'
  }

  if (status === 'waiting_payment') {
    return 'Arbeit abgeschlossen. Zahlungsfreigabe durch den Kunden abwarten und Abschluss dokumentieren.'
  }

  return 'Auftrag ist abgeschlossen und bleibt für Historie, Nachweise und Auswertung verfügbar.'
}

export function getJobStatusLabel(status: JobStatus): string {
  if (status === 'new') return 'Neu'
  if (status === 'scheduled') return 'Geplant'
  if (status === 'in_progress') return 'In Arbeit'
  if (status === 'waiting_payment') return 'Wartet auf Zahlung'
  if (status === 'cancelled') return 'Storniert'
  return 'Abgeschlossen'
}

// Canonical payment-state labels live in payments/selectors (exhaustive switch
// over every PaymentState incl. none/refunded/diagnosis_payment_pending/
// diagnosis_payment_completed). Re-export so this jobs-domain helper can never
// diverge again: the old local copy fell through to 'Erstattet' for
// none/diagnosis_* (a live mislabel in the job activity feed via
// jobs/service.ts) and carried a grammatically broken in_escrow string.
export { getPaymentStateLabel } from '../payments/selectors'

/**
 * Returns a payment state only when the workflow is actually in a
 * payment-ready phase. Suppresses early `deposit_required` defaults for
 * new/unsigned inquiries so UI surfaces do not show payment pills before
 * an offer is accepted or work has started.
 */
export function isJobOperational(
  job: Pick<Job, 'status' | 'proposalSentAt' | 'proposalAcceptedAt'>
): boolean {
  const lifecycle = deriveProposalLifecycle(job.proposalSentAt, job.proposalAcceptedAt)
  const isAccepted = lifecycle.stage === 'accepted'
  return job.status !== 'new' || isAccepted
}

export function getActionablePaymentState(
  job: Pick<Job, 'status' | 'paymentState' | 'proposalSentAt' | 'proposalAcceptedAt'>,
  payment?: Payment
): PaymentState | undefined {
  const candidate = payment?.state ?? job.paymentState
  if (!isJobOperational(job)) return undefined
  return candidate
}

export function getDerivedDocumentationStatus(
  status: JobStatus,
  initial: string,
  photoCount: number,
  noteCount: number
): string {
  const hasDocumentation = photoCount > 0 || noteCount > 0

  if (status === 'completed') return 'Vollständig dokumentiert'
  if (status === 'cancelled') return 'Storniert'
  if (status === 'waiting_payment') return 'Abschluss dokumentiert'

  if (status === 'in_progress') {
    if (photoCount > 0 && noteCount > 0) return 'Dokumentation läuft'
    if (photoCount > 0) return `${photoCount} Fotos vorhanden`
    if (noteCount > 0) return `${noteCount} Notizen vorhanden`
    return initial === '2 Fotos vorhanden' ? initial : 'Dokumentation läuft'
  }

  if (status === 'scheduled') {
    return hasDocumentation ? 'Vorbereitung dokumentiert' : 'Vorbereitung offen'
  }

  if (status === 'new') {
    if (hasDocumentation) return 'Erste Dokumentation vorhanden'
    return 'Noch keine Dokumentation'
  }

  return initial
}
