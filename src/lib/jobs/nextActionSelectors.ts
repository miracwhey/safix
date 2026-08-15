import type { JobStatus, PaymentState } from '../shared/coreTypes'
import type { DisputeStatus } from '../disputes/types'
import type { ScheduleReadiness } from '../operations/schedulingSelectors'
import type { PayoutReadinessStatus } from '../payout/types'
import { deriveProposalLifecycle } from './helpers'
import { isFundingRequestTerminalDead } from '../payments/fundingRequest/fundingRequestStatus'

export type NextActionPriority = 'urgent' | 'active' | 'idle'

export type NextActionDomain = 'dispute' | 'payment' | 'job'

export type NextActionViewModel = {
  priority: NextActionPriority
  icon: string
  label: string
  text: string
  domain: NextActionDomain
}

/**
 * Derives the single most-important next action from the combined context of
 * job status, payment state, and dispute status.
 *
 * Priority order: active dispute → urgent payment → job lifecycle
 * This is a pure read-helper — no transitions or mutations occur here.
 */
export function deriveNextAction(
  jobStatus: JobStatus,
  paymentState: PaymentState | undefined,
  disputeStatus: DisputeStatus | undefined,
  proposalSentAt?: number,
  proposalAcceptedAt?: number,
  fundingStatus?: string,
  scheduleReadiness?: ScheduleReadiness,
  payoutReadinessStatus?: PayoutReadinessStatus
): NextActionViewModel {
  const lifecycle = deriveProposalLifecycle(proposalSentAt, proposalAcceptedAt)
  if (lifecycle.stage === 'invalid') {
    return {
      priority: 'active',
      icon: '⚠️',
      label: 'Ungültiger Angebotsstatus',
      text: 'Annahme ist gespeichert, aber Versandzeitpunkt fehlt. Bitte Workflow prüfen und erneut senden.',
      domain: 'job',
    }
  }
  const isAccepted = lifecycle.stage === 'accepted'
  const isSent = lifecycle.stage === 'sent' || lifecycle.stage === 'accepted'
  const paymentReady = jobStatus !== 'new' || isAccepted
  const actionablePaymentState = paymentReady ? paymentState : undefined

  // 1. Active dispute takes highest priority
  if (disputeStatus === 'open') {
    return {
      priority: 'urgent',
      icon: '⚖️',
      label: 'Konflikt offen',
      text: 'Ein Konfliktfall wurde eröffnet. SaFix nimmt den Fall zur Prüfung auf. Weitere Beweismittel können noch hinzugefügt werden.',
      domain: 'dispute',
    }
  }

  if (disputeStatus === 'provider_waiting') {
    return {
      priority: 'urgent',
      icon: '⚖️',
      label: 'Belege angefordert',
      text: 'SaFix hat weitere Unterlagen oder Belege von dir angefordert. Bitte reiche die erforderlichen Dokumente ein, damit der Fall weiterbearbeitet werden kann.',
      domain: 'dispute',
    }
  }

  if (disputeStatus === 'customer_waiting') {
    return {
      priority: 'active',
      icon: '⚖️',
      label: 'Belege angefordert (Kunde)',
      text: 'SaFix hat weitere Unterlagen vom Kunden angefordert. Sobald die Belege vorliegen, geht der Fall in die Prüfung.',
      domain: 'dispute',
    }
  }

  if (disputeStatus === 'under_review') {
    return {
      priority: 'active',
      icon: '⚖️',
      label: 'Konflikt in Prüfung',
      text: 'SaFix prüft den Fall anhand von Beschreibung, Dokumentation und Zahlungsstatus. Eine Entscheidung folgt in Kürze.',
      domain: 'dispute',
    }
  }

  // 2. Urgent payment states
  if (actionablePaymentState === 'release_pending') {
    return {
      priority: 'urgent',
      icon: '💳',
      label: 'Freigabe ausstehend',
      text: 'Die Freigabe der Zahlung wurde angefordert. Auf Kundenbestätigung warten oder offene Rückfragen klären.',
      domain: 'payment',
    }
  }

  // 3. Active payment states (before falling through to job status)

  // Funding in progress: customer already started the payment flow — do not
  // show "Einzahlung ausstehend" which implies no action was taken yet.
  if (
    actionablePaymentState === 'deposit_required' &&
    (fundingStatus === 'funding_started' || fundingStatus === 'funding_initiated')
  ) {
    return {
      priority: 'active',
      icon: '⏳',
      label: 'Zahlung wird verarbeitet',
      text: 'Der Kunde hat die Einzahlung gestartet. Der Betrag wird gerade verarbeitet und über Stripe abgesichert.',
      domain: 'payment',
    }
  }

  // Terminal-dead funding (expired / cancelled): the existing request can no
  // longer be paid. Do NOT tell the craftsman "der Kunde muss zahlen" — this
  // next-action co-resides with the operational blocker on the same thread
  // surface, so it must mirror it: the craftsman has to send a NEW request.
  if (
    actionablePaymentState === 'deposit_required' &&
    isFundingRequestTerminalDead(fundingStatus)
  ) {
    return {
      priority: 'active',
      icon: '⌛',
      label: 'Zahlungsanfrage abgelaufen',
      text: 'Die Zahlungsanfrage ist abgelaufen. Sende dem Kunden eine neue Zahlungsanfrage, damit der Auftrag finanziert werden kann.',
      domain: 'payment',
    }
  }

  // Funded truth dominates: skip deposit_required CTA when funding is confirmed
  if (actionablePaymentState === 'deposit_required' && fundingStatus !== 'funded') {
    return {
      priority: 'active',
      icon: '💳',
      label: 'Zahlung ausstehend',
      text: 'Der Kunde muss den vollständigen Betrag über Stripe absichern, bevor der Auftrag starten kann.',
      domain: 'payment',
    }
  }

  // Funded dominance: when FundingRequest confirms funded but downstream
  // payment state hasn't caught up yet, show the canonical funded truth
  // instead of falling through to stale job lifecycle branches.
  // Only applies to stale pre-funded states — terminal or post-work states
  // (released, refunded, etc.) must pass through normally.
  if (
    fundingStatus === 'funded' &&
    (!actionablePaymentState || actionablePaymentState === 'none' || actionablePaymentState === 'deposit_required')
  ) {
    return {
      priority: 'active',
      icon: '🔒',
      label: 'Zahlung abgesichert',
      text: 'Die Zahlung ist bestätigt. Der Betrag ist über Stripe abgesichert — Arbeit kann beginnen.',
      domain: 'payment',
    }
  }

  if (actionablePaymentState === 'deposit_paid') {
    return {
      priority: 'active',
      icon: '💳',
      label: 'Zahlung bestätigt',
      text: 'Die Einzahlung ist bestätigt. Der Betrag ist über Stripe abgesichert.',
      domain: 'payment',
    }
  }

  // 4. Fall back to job lifecycle status
  if (jobStatus === 'new') {
    if (isAccepted) {
      return {
        priority: 'active',
        icon: '💳',
        label: 'Zahlungskarte vorbereiten',
        text: 'Das Angebot wurde angenommen. Zahlungskarte initialisieren — der Kunde zahlt den vollständigen Betrag vorab in das Stripe-Absicherung ein.',
        domain: 'payment',
      }
    }
    if (isSent) {
      return {
        priority: 'active',
        icon: '📤',
        label: 'Angebot gesendet',
        text: 'Das Angebot wurde dem Kunden übermittelt. Auf Rückmeldung warten oder offene Fragen klären.',
        domain: 'job',
      }
    }
    return {
      priority: 'active',
      icon: '📋',
      label: 'Neue Anfrage',
      text: 'Anfrage prüfen, Rückfragen klären und Angebot vorbereiten.',
      domain: 'job',
    }
  }

  if (jobStatus === 'scheduled') {
    // Schedule readiness overrides: fachlich korrekte Priorisierung wenn
    // Terminzustand eine andere Aktion erfordert als "Termin bestätigen".
    if (scheduleReadiness === 'overdue') {
      return {
        priority: 'urgent',
        icon: '⚠️',
        label: 'Termin überfällig',
        text: 'Der geplante Termin ist abgelaufen und die Ausführung wurde noch nicht gestartet. Status klären oder Termin verschieben.',
        domain: 'job',
      }
    }
    if (scheduleReadiness === 'starting_soon') {
      return {
        priority: 'active',
        icon: '⏰',
        label: 'Termin beginnt bald',
        text: 'Der Termin beginnt in Kürze. Team einplanen und Vorbereitung abschließen.',
        domain: 'job',
      }
    }
    return {
      priority: 'active',
      icon: '📅',
      label: 'Termin geplant',
      text: 'Termin bestätigen, Team sauber einplanen und Vorbereitung abschließen.',
      domain: 'job',
    }
  }

  if (jobStatus === 'in_progress') {
    return {
      priority: 'active',
      icon: '🔨',
      label: 'In Durchführung',
      text: 'Fortschritt dokumentieren und den Auftrag operativ weiterführen.',
      domain: 'job',
    }
  }

  if (jobStatus === 'waiting_payment') {
    return {
      priority: 'active',
      icon: '💰',
      label: 'Zahlung ausstehend',
      text: 'Arbeit ist abgeschlossen. Zahlungsfreigabe durch den Kunden abwarten und alle offenen Belege für den Abschluss bereithalten.',
      domain: 'job',
    }
  }

  // Payment terminal states — shown when job is still not marked completed
  if (actionablePaymentState === 'released') {
    // Payout-readiness override: payment released but craftsman cannot receive
    // the funds yet because their payout account is not fully set up.
    if (
      payoutReadinessStatus != null &&
      payoutReadinessStatus !== 'payout_ready'
    ) {
      return {
        priority: 'active',
        icon: '🏦',
        label: 'Auszahlungs-Konto einrichten',
        text: 'Die Zahlung wurde freigegeben, aber dein Auszahlungs-Konto ist noch nicht bereit. Schließe das Setup ab, um die Zahlung zu erhalten.',
        domain: 'payment',
      }
    }
    return {
      priority: 'idle',
      icon: '🎉',
      label: 'Zahlung ausgezahlt',
      text: 'Die Zahlung wurde freigegeben und ausgezahlt. Der Auftrag kann nun als vollständig abgeschlossen markiert werden.',
      domain: 'payment',
    }
  }

  if (paymentState === 'refunded') {
    return {
      priority: 'idle',
      icon: '↩️',
      label: 'Betrag erstattet',
      text: 'Der Betrag wurde im Rahmen der Streitbeilegung erstattet. Der Auftrag ist damit abgeschlossen.',
      domain: 'payment',
    }
  }

  // completed — all terminal states
  return {
    priority: 'idle',
    icon: '✅',
    label: 'Abgeschlossen',
    text: 'Auftrag ist abgeschlossen und bleibt für Historie, Nachweise und Auswertung verfügbar.',
    domain: 'job',
  }
}
