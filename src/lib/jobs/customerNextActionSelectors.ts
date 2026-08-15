import type { JobStatus, PaymentState } from '../shared/coreTypes'
import type { DisputeStatus } from '../disputes/types'
import type { NextActionPriority, NextActionDomain, NextActionViewModel } from './nextActionSelectors'
import { deriveProposalLifecycle } from './helpers'
import { isFundingRequestTerminalDead } from '../payments/fundingRequest/fundingRequestStatus'

export type { NextActionPriority, NextActionDomain, NextActionViewModel }

/**
 * Derives the single most-important next action from the combined context of
 * job status, payment state, and dispute status — from the customer's perspective.
 *
 * Priority order: active dispute → urgent payment → job lifecycle
 * This is a pure read-helper — no transitions or mutations occur here.
 */
export function deriveCustomerNextAction(
  jobStatus: JobStatus,
  paymentState: PaymentState | undefined,
  disputeStatus: DisputeStatus | undefined,
  proposalSentAt?: number,
  proposalAcceptedAt?: number,
  fundingStatus?: string
): NextActionViewModel {
  const lifecycle = deriveProposalLifecycle(proposalSentAt, proposalAcceptedAt)
  if (lifecycle.stage === 'invalid') {
    return {
      priority: 'active',
      icon: '⚠️',
      label: 'Angebot unklar',
      text: 'Der Angebotsstatus ist inkonsistent. Bitte kontaktiere deinen Handwerker, um ein korrektes Angebot zu erhalten.',
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
      label: 'Streitfall offen',
      text: 'Ein Streitfall wurde eröffnet. Du kannst weitere Informationen hinzufügen. SaFix nimmt den Fall zur Prüfung auf.',
      domain: 'dispute',
    }
  }

  if (disputeStatus === 'customer_waiting') {
    return {
      priority: 'urgent',
      icon: '⚖️',
      label: 'Belege angefordert',
      text: 'SaFix hat weitere Unterlagen oder Belege von dir angefordert. Bitte reiche die angeforderten Dokumente ein.',
      domain: 'dispute',
    }
  }

  if (disputeStatus === 'provider_waiting') {
    return {
      priority: 'active',
      icon: '⚖️',
      label: 'Belege angefordert (Anbieter)',
      text: 'SaFix hat weitere Unterlagen vom Anbieter angefordert. Sobald die Belege vorliegen, geht der Fall in die Prüfung.',
      domain: 'dispute',
    }
  }

  if (disputeStatus === 'under_review') {
    return {
      priority: 'active',
      icon: '⚖️',
      label: 'Streitfall in Prüfung',
      text: 'SaFix prüft den Fall anhand aller vorliegenden Informationen. Eine Entscheidung folgt in Kürze.',
      domain: 'dispute',
    }
  }

  // 2. Urgent payment states — customer must act
  if (actionablePaymentState === 'release_pending') {
    return {
      priority: 'urgent',
      icon: '✅',
      label: 'Bestätigen & freigeben',
      text: 'Die Arbeiten sind abgeschlossen. Bitte prüfe die Dokumentation und bestätige die Fertigstellung. Der Betrag ist bereits über Stripe abgesichert.',
      domain: 'payment',
    }
  }

  // 3. Active payment states

  // Funding in progress: customer already started the payment flow — do not
  // show "Auftrag freigeben" which implies no action was taken yet.
  if (
    actionablePaymentState === 'deposit_required' &&
    (fundingStatus === 'funding_started' || fundingStatus === 'funding_initiated')
  ) {
    return {
      priority: 'active',
      icon: '⏳',
      label: 'Zahlung wird verarbeitet',
      text: 'Die Vorbereitungen laufen. Der Handwerker kann in Kürze mit der Arbeit beginnen.',
      domain: 'payment',
    }
  }

  // Terminal-dead funding (expired / cancelled): the request can never be paid
  // — a payment attempt returns HTTP 409 FUNDING_REQUEST_EXPIRED. Do NOT show
  // the urgent "Zahlung leisten" CTA; the provider must send a NEW request.
  if (
    actionablePaymentState === 'deposit_required' &&
    isFundingRequestTerminalDead(fundingStatus)
  ) {
    return {
      priority: 'active',
      icon: '⌛',
      label: 'Zahlungsanfrage abgelaufen',
      text: 'Die Zahlungsanfrage ist abgelaufen. Bitte wende dich an deinen Handwerker für eine neue Zahlungsanfrage.',
      domain: 'payment',
    }
  }

  // Funded truth dominates: skip deposit_required CTA when funding is confirmed.
  // priority: 'urgent' — customer must act to unblock the entire workflow.
  if (actionablePaymentState === 'deposit_required' && fundingStatus !== 'funded') {
    return {
      priority: 'urgent',
      icon: '💳',
      label: 'Zahlung leisten',
      text: 'Leiste die Zahlung, damit der Handwerker mit der Arbeit beginnen kann.',
      domain: 'payment',
    }
  }

  // Funded dominance: when FundingRequest confirms funded but downstream
  // payment state hasn't caught up yet (still deposit_required / none),
  // show the canonical funded truth instead of falling through to stale
  // job lifecycle branches.  Only applies to stale pre-funded states —
  // terminal or post-work states (released, refunded, etc.) must pass through.
  if (
    fundingStatus === 'funded' &&
    (!actionablePaymentState || actionablePaymentState === 'none' || actionablePaymentState === 'deposit_required')
  ) {
    return {
      priority: 'active',
      icon: '🔒',
      label: 'Zahlung gesichert',
      text: 'Dein Auftrag ist freigegeben. Der Handwerker kann mit der Arbeit beginnen.',
      domain: 'payment',
    }
  }

  if (actionablePaymentState === 'deposit_paid') {
    return {
      priority: 'active',
      icon: '✅',
      label: 'Zahlung bestätigt',
      text: 'Deine Einzahlung ist bestätigt. Der Handwerker startet in Kürze.',
      domain: 'payment',
    }
  }

  if (actionablePaymentState === 'in_escrow') {
    return {
      priority: 'active',
      icon: '🔨',
      label: 'Auftrag gesichert',
      text: 'Dein Auftrag ist gesichert und bereit. Der Handwerker startet in Kürze.',
      domain: 'payment',
    }
  }

  // 4. Fall back to job lifecycle status
  if (jobStatus === 'new') {
    if (isAccepted) {
      return {
        priority: 'active',
        icon: '✅',
        label: 'Angebot angenommen',
        text: 'Du hast das Angebot angenommen. Der Handwerker wird sich in Kürze bezüglich des nächsten Schritts melden.',
        domain: 'job',
      }
    }
    if (isSent) {
      return {
        priority: 'urgent',
        icon: '📋',
        label: 'Angebot liegt vor',
        text: 'Der Handwerker hat ein Angebot für dein Projekt eingereicht. Bitte prüfe die Details und antworte dem Handwerker.',
        domain: 'job',
      }
    }
    return {
      priority: 'active',
      icon: '📋',
      label: 'Anfrage in Prüfung',
      text: 'Deine Anfrage wird aktuell geprüft. Du erhältst bald eine Rückmeldung vom Handwerker.',
      domain: 'job',
    }
  }

  if (jobStatus === 'scheduled') {
    return {
      priority: 'active',
      icon: '📅',
      label: 'Termin vorbereiten',
      text: 'Der Termin steht. Bitte stelle sicher, dass der Zugang zum Objekt gewährleistet ist.',
      domain: 'job',
    }
  }

  if (jobStatus === 'in_progress') {
    return {
      priority: 'active',
      icon: '🔨',
      label: 'Auftrag läuft',
      text: 'Der Auftrag ist in Durchführung. Fortschritt und Dokumentation werden laufend ergänzt.',
      domain: 'job',
    }
  }

  if (jobStatus === 'waiting_payment') {
    return {
      priority: 'active',
      icon: '💰',
      label: 'Abnahme steht aus',
      text: 'Die Arbeiten sind abgeschlossen. Überprüfe die Dokumentation und warte auf die Anfrage zur Zahlungsfreigabe.',
      domain: 'job',
    }
  }

  // Payment terminal states — shown when job is still transitioning to completed
  if (actionablePaymentState === 'released') {
    return {
      priority: 'idle',
      icon: '✅',
      label: 'Zahlung freigegeben',
      text: 'Alle Arbeiten wurden erfolgreich abgeschlossen. Vielen Dank für dein Vertrauen.',
      domain: 'job',
    }
  }

  if (actionablePaymentState === 'refunded') {
    return {
      priority: 'idle',
      icon: '↩️',
      label: 'Abgeschlossen',
      text: 'Der Auftrag wurde im Rahmen der Streitbeilegung beendet.',
      domain: 'job',
    }
  }

  // completed — all terminal states
  return {
    priority: 'idle',
    icon: '✅',
    label: 'Abgeschlossen',
    text: 'Der Auftrag ist abgeschlossen. Vielen Dank für dein Vertrauen.',
    domain: 'job',
  }
}
