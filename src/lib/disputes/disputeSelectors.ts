import type {
  Dispute,
  DisputeDecision,
  DisputeReason,
  DisputeStatus,
  ResolutionType,
  SettlementStatus,
} from './types'
import { ACTIVE_DISPUTE_STATUSES, isTerminalDisputeStatus } from './stateMachine'
import type { PaymentState } from '../shared/coreTypes'

export type DisputeRole = 'admin' | 'craftsman' | 'customer'

export type DisputeCenterItem = {
  id: string
  jobId: string
  title: string
  reasonLabel: string
  statusLabel: string
  description: string
  canRelease: boolean
  canRefund: boolean
  isResolved: boolean
  /** ISO 8601 timestamptz — set when the dispute reached a terminal status. */
  resolvedAt?: string
  dispute: Dispute
  ageDays: number
  ageLabel: string
  urgencyLevel: 'critical' | 'elevated' | 'normal'
}

export function getDisputeReasonLabel(reason: DisputeReason): string {
  if (reason === 'work_quality') return 'Arbeitsqualität'
  if (reason === 'scope_conflict') return 'Leistungsumfang'
  if (reason === 'delay') return 'Verzögerung'
  if (reason === 'payment_conflict') return 'Zahlungskonflikt'
  return 'Sonstiges'
}

/**
 * Central, γ-aware status label. Reads the lifecycle status plus the operator
 * decision and booking outcome to produce the user-facing string. Use this
 * everywhere — never inline status → label mappings.
 */
export function getDisputeStatusLabel(
  status: DisputeStatus,
  decision?: DisputeDecision,
  resolutionType?: ResolutionType,
  settlementStatus?: SettlementStatus,
): string {
  if (status === 'open') return 'Offen'
  if (status === 'under_review') return 'In Prüfung'
  if (status === 'customer_waiting') return 'Warte auf Kundenbeleg'
  if (status === 'provider_waiting') return 'Warte auf Anbieterbeleg'
  if (status === 'closed') return 'Geschlossen'
  if (status === 'cancelled') return 'Storniert'

  // status === 'resolved' — disambiguate via decision
  const settled = settlementStatus === 'settled'
  if (decision === 'release') {
    if (resolutionType === 'release_partial') {
      return settled ? 'Teilfreigabe abgeschlossen' : 'Teilfreigabe entschieden'
    }
    return settled ? 'Freigabe abgeschlossen' : 'Freigabe entschieden'
  }
  if (decision === 'refund') {
    if (resolutionType === 'refund_partial') {
      return settled ? 'Teilrückerstattung abgeschlossen' : 'Teilrückerstattung entschieden'
    }
    return settled ? 'Rückerstattung abgeschlossen' : 'Rückerstattung entschieden'
  }
  if (decision === 'split') {
    return settled ? 'Teilung abgeschlossen' : 'Teilung entschieden'
  }
  if (decision === 'reject') {
    return settled ? 'Abgelehnt – abgeschlossen' : 'Abgelehnt'
  }
  // Resolved without decision token — should not happen post-Block 5.5a, but
  // surface a neutral label rather than 'undefined'.
  return settled ? 'Abgeschlossen' : 'Entschieden'
}

/**
 * Convenience overload that pulls all the disambiguation fields off a Dispute.
 * Prefer this in UI code so future schema additions land in one place.
 */
export function getDisputeStatusLabelFor(dispute: Dispute): string {
  return getDisputeStatusLabel(
    dispute.status,
    dispute.decision,
    dispute.resolutionType,
    dispute.settlementStatus,
  )
}

/** Semantic tone for the customer-facing dispute display chip. */
export type CustomerDisputeDisplayTone =
  | 'none'
  | 'open'
  | 'waiting'
  | 'review'
  | 'settling'
  | 'resolved'
  | 'cancelled'

export type CustomerDisputeDisplay = {
  label: string
  tone: CustomerDisputeDisplayTone
}

/**
 * Money-movement–aware dispute display for the customer payment summary card.
 *
 * A resolved/closed dispute only collapses to the terminal "Konflikt gelöst"
 * once `settlementStatus === 'settled'`. While the operator decision is
 * recorded but the required money action has NOT completed
 * (`settlementStatus !== 'settled'`), an in-progress money state is shown —
 * "Erstattung wird verarbeitet" (refund/split → money back to the customer) or
 * "Auszahlung wird verarbeitet" (release/reject → money to the craftsman) — so
 * the customer never sees a terminal "resolved" state while funds are still
 * moving.
 *
 * This mirrors the `settled = settlementStatus === 'settled'` convention used
 * by getDisputeStatusLabel / getDisputeNextStep so every dispute surface on the
 * customer's screen agrees. `cancelled` is handled before the settlement check,
 * so a withdrawn dispute is never shown as "settling".
 */
export function deriveCustomerDisputeDisplay(
  dispute: Pick<Dispute, 'status' | 'decision' | 'settlementStatus'> | undefined,
): CustomerDisputeDisplay {
  if (!dispute) return { label: 'Kein Konflikt', tone: 'none' }
  const { status, decision, settlementStatus } = dispute
  if (status === 'open') return { label: 'Konflikt offen', tone: 'open' }
  if (status === 'customer_waiting' || status === 'provider_waiting') {
    return { label: 'Belege angefordert', tone: 'waiting' }
  }
  if (status === 'under_review') return { label: 'Konflikt in Prüfung', tone: 'review' }
  if (status === 'cancelled') return { label: 'Konflikt storniert', tone: 'cancelled' }
  if (status === 'resolved' || status === 'closed') {
    const settled = settlementStatus === 'settled'
    if (!settled) {
      // Decision recorded, money not yet moved — show the real money state.
      if (decision === 'refund' || decision === 'split') {
        return { label: 'Erstattung wird verarbeitet', tone: 'settling' }
      }
      // release / reject (or a missing decision) → funds flow to the craftsman.
      return { label: 'Auszahlung wird verarbeitet', tone: 'settling' }
    }
    return { label: 'Konflikt gelöst', tone: 'resolved' }
  }
  return { label: 'Kein Konflikt', tone: 'none' }
}

/**
 * Returns the zero-based progress step index for the dispute lifecycle:
 * 0 = open / customer_waiting / provider_waiting, 1 = under_review, 2 = terminal
 */
export function getDisputeProgressStep(status: DisputeStatus): number {
  if (status === 'open' || status === 'customer_waiting' || status === 'provider_waiting') return 0
  if (status === 'under_review') return 1
  return 2
}

/**
 * Returns a concise next-step guidance string for users based on the current
 * dispute status + decision context.
 */
export function getDisputeNextStep(
  status: DisputeStatus,
  decision?: DisputeDecision,
  settlementStatus?: SettlementStatus,
  resolutionType?: ResolutionType,
): string {
  if (status === 'open')
    return 'SaFix nimmt den Fall zur Prüfung auf. Weitere Beweismittel können noch hinzugefügt werden.'
  if (status === 'customer_waiting')
    return 'SaFix hat zusätzliche Unterlagen vom Kunden angefordert. Sobald die Belege vorliegen, geht der Fall in die Prüfung.'
  if (status === 'provider_waiting')
    return 'SaFix hat zusätzliche Unterlagen vom Anbieter angefordert. Sobald die Belege vorliegen, geht der Fall in die Prüfung.'
  if (status === 'under_review')
    return 'SaFix prüft den Fall anhand von Beschreibung, Dokumentation und Zahlungsstatus. Eine Entscheidung folgt in Kürze.'
  if (status === 'cancelled') return 'Der Konfliktfall wurde storniert.'
  if (status === 'closed') return 'Der Fall ist abgeschlossen.'

  // status === 'resolved'
  const settled = settlementStatus === 'settled'
  if (decision === 'release') {
    return settled
      ? 'Die Zahlung wurde an den Betrieb freigegeben. Der Fall ist abgeschlossen.'
      : 'Die Freigabe wurde entschieden. Die Zahlungsabwicklung wird durchgeführt.'
  }
  if (decision === 'refund') {
    if (resolutionType === 'refund_partial') {
      return settled
        ? 'Der noch einbehaltene Anteil wurde an den Kunden zurückerstattet; der bereits ausgezahlte Anteil verbleibt beim Betrieb. Der Fall ist abgeschlossen.'
        : 'Die Teilrückerstattung wurde entschieden. Die Zahlungsabwicklung wird durchgeführt.'
    }
    return settled
      ? 'Der Betrag wird vollständig an den Kunden zurückerstattet. Der Fall ist abgeschlossen.'
      : 'Die Rückerstattung wurde entschieden. Die Zahlungsabwicklung wird durchgeführt.'
  }
  if (decision === 'split') {
    return settled
      ? 'Der Betrag wurde anteilig aufgeteilt. Der Fall ist abgeschlossen.'
      : 'Die Teilung wurde entschieden. Die Zahlungsabwicklung wird durchgeführt.'
  }
  if (decision === 'reject') {
    return settled
      ? 'Der Fall wurde abgelehnt und ist geschlossen.'
      : 'Der Fall wurde abgelehnt. Die Zahlungsabwicklung wird durchgeführt.'
  }
  return settled ? 'Fall abgeschlossen.' : 'Eine Entscheidung wurde getroffen.'
}

function getStatusPriority(status: DisputeStatus): number {
  if (status === 'open') return 0
  if (status === 'customer_waiting') return 1
  if (status === 'provider_waiting') return 2
  if (status === 'under_review') return 3
  if (status === 'resolved') return 4
  if (status === 'closed') return 5
  return 6 // cancelled
}

/**
 * Returns number of calendar days since a dispute was created.
 *
 * `createdAt` is the ISO 8601 timestamptz string mirroring `disputes.opened_at`
 * in production (Block 5.5c). The helper parses it once locally so callers
 * never need to convert manually.
 */
export function getDisputeAgeDays(createdAt: string, nowMs = Date.now()): number {
  const createdMs = Date.parse(createdAt)
  if (!Number.isFinite(createdMs)) return 0
  return Math.floor((nowMs - createdMs) / (1000 * 60 * 60 * 24))
}

/**
 * Returns a German-language human-readable label for how long a dispute has been open.
 */
export function getDisputeAgeLabel(createdAt: string, nowMs = Date.now()): string {
  const days = getDisputeAgeDays(createdAt, nowMs)
  if (days === 0) return 'Heute geöffnet'
  if (days === 1) return 'Seit gestern'
  return `Seit ${days} Tagen`
}

/**
 * Returns an urgency level for a dispute based on its status and age.
 * 'critical' = requires immediate action (customer_waiting / provider_waiting)
 * 'elevated' = open dispute that has aged past 3 days without progress
 * 'normal'   = under review or newly opened
 */
export function getDisputeUrgencyLevel(
  status: DisputeStatus,
  ageDays: number
): 'critical' | 'elevated' | 'normal' {
  if (status === 'customer_waiting' || status === 'provider_waiting') return 'critical'
  if (status === 'open' && ageDays >= 3) return 'elevated'
  return 'normal'
}

export function mapToDisputeCenterItem(dispute: Dispute): DisputeCenterItem {
  const isResolved = isTerminalDisputeStatus(dispute.status)
  const isSettled = dispute.settlementStatus === 'settled'
  const ageDays = getDisputeAgeDays(dispute.createdAt)
  const ageLabel = getDisputeAgeLabel(dispute.createdAt)
  const urgencyLevel = getDisputeUrgencyLevel(dispute.status, ageDays)

  return {
    id: dispute.id,
    jobId: dispute.jobId,
    title: dispute.title,
    reasonLabel: getDisputeReasonLabel(dispute.reason),
    statusLabel: getDisputeStatusLabelFor(dispute),
    description: dispute.description,
    // Decision-only (unsettled) disputes still allow retry of the money action
    canRelease: !isResolved || (isResolved && !isSettled),
    canRefund: !isResolved || (isResolved && !isSettled),
    isResolved,
    resolvedAt: dispute.resolvedAt,
    dispute,
    ageDays,
    ageLabel,
    urgencyLevel,
  }
}

export function getDisputeCenterItems(disputes: Dispute[]): DisputeCenterItem[] {
  return [...disputes]
    .sort((a, b) => {
      const statusDiff = getStatusPriority(a.status) - getStatusPriority(b.status)
      if (statusDiff !== 0) return statusDiff
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    })
    .map(mapToDisputeCenterItem)
}

export function getActiveDisputeCenterItems(
  disputes: Dispute[]
): DisputeCenterItem[] {
  return disputes
    .filter((d) => ACTIVE_DISPUTE_STATUSES.has(d.status))
    .sort((a, b) => {
      const statusDiff = getStatusPriority(a.status) - getStatusPriority(b.status)
      if (statusDiff !== 0) return statusDiff
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    })
    .map(mapToDisputeCenterItem)
}

export function getResolvedDisputeCenterItems(
  disputes: Dispute[]
): DisputeCenterItem[] {
  return disputes
    .filter((d) => isTerminalDisputeStatus(d.status))
    .sort((a, b) => Date.parse(b.resolvedAt ?? b.updatedAt) - Date.parse(a.resolvedAt ?? a.updatedAt))
    .map(mapToDisputeCenterItem)
}

/**
 * Returns role-aware next-step guidance for a dispute status.
 * Customers and craftsmen receive context-appropriate messaging.
 */
export function getDisputeNextStepForRole(
  status: DisputeStatus,
  role: DisputeRole,
  decision?: DisputeDecision,
  settlementStatus?: SettlementStatus,
  resolutionType?: ResolutionType,
): string {
  if (role === 'customer') {
    if (status === 'open')
      return 'Ihr Fall wurde aufgenommen. SaFix prüft die eingereichten Informationen und kann bei Bedarf weitere Unterlagen anfragen.'
    if (status === 'customer_waiting')
      return 'SaFix hat zusätzliche Unterlagen von Ihnen angefordert. Bitte reichen Sie Fotos, Rechnungen oder Beschreibungen als Belege ein.'
    if (status === 'provider_waiting')
      return 'SaFix hat zusätzliche Unterlagen vom Anbieter angefordert. Sie werden benachrichtigt, sobald die Prüfung weitergeht.'
    if (status === 'under_review')
      return 'Ihr Fall wird von SaFix geprüft. Sie werden benachrichtigt, sobald eine Entscheidung getroffen wurde.'
    if (status === 'cancelled') return 'Der Konfliktfall wurde storniert.'
    if (status === 'closed') return 'Der Fall ist abgeschlossen.'

    const settled = settlementStatus === 'settled'
    if (decision === 'release') {
      return settled
        ? 'Die Prüfung ist abgeschlossen. Die Zahlung wurde an den Betrieb freigegeben.'
        : 'Die Prüfung ist abgeschlossen. Die Freigabe wird durchgeführt.'
    }
    if (decision === 'refund') {
      if (resolutionType === 'refund_partial') {
        return settled
          ? 'Die Prüfung ist abgeschlossen. Der noch einbehaltene Anteil wird auf Ihr Konto zurückerstattet – Details finden Sie in Ihrer Auftragsübersicht.'
          : 'Die Prüfung ist abgeschlossen. Die Teilrückerstattung wird vorbereitet.'
      }
      return settled
        ? 'Die Prüfung ist abgeschlossen. Der Betrag wird auf Ihr Konto zurückerstattet.'
        : 'Die Prüfung ist abgeschlossen. Die Rückerstattung wird vorbereitet.'
    }
    if (decision === 'split') {
      return settled
        ? 'Die Prüfung ist abgeschlossen. Der Betrag wurde anteilig aufgeteilt. Die Ihnen zustehende Rückerstattung wird auf Ihr Konto überwiesen – Details finden Sie in Ihrer Auftragsübersicht.'
        : 'Die Prüfung ist abgeschlossen. Die Aufteilung wird durchgeführt.'
    }
    if (decision === 'reject') {
      return settled
        ? 'Ihr Einspruch konnte nicht bestätigt werden. Der Fall ist abgeschlossen.'
        : 'Ihr Einspruch konnte nicht bestätigt werden. Die Zahlungsabwicklung wird durchgeführt.'
    }
    return settled ? 'Fall abgeschlossen.' : 'Eine Entscheidung wurde getroffen.'
  }

  if (role === 'craftsman') {
    if (status === 'open')
      return 'Ein Konfliktfall wurde für diesen Auftrag eröffnet. SaFix nimmt den Fall auf und kann Dokumentation anfordern.'
    if (status === 'customer_waiting')
      return 'SaFix hat zusätzliche Unterlagen vom Kunden angefordert. Sobald die Belege vorliegen, geht der Fall in die Prüfung.'
    if (status === 'provider_waiting')
      return 'SaFix hat Nachweise von Ihnen angefordert. Bitte laden Sie relevante Unterlagen (Fotos, Aufmaße, Vereinbarungen) hoch.'
    if (status === 'under_review')
      return 'SaFix prüft den Fall. Stellen Sie sicher, dass alle Nachweise vollständig hochgeladen sind.'
    if (status === 'cancelled') return 'Der Konfliktfall wurde storniert.'
    if (status === 'closed') return 'Der Fall ist abgeschlossen.'

    const settled = settlementStatus === 'settled'
    if (decision === 'release') {
      return settled
        ? 'SaFix hat die Zahlung freigegeben. Der Betrag wird auf Ihr Konto ausgezahlt.'
        : 'SaFix hat die Freigabe entschieden. Die Auszahlung wird durchgeführt.'
    }
    if (decision === 'refund') {
      if (resolutionType === 'refund_partial') {
        return settled
          ? 'SaFix hat eine Teilrückerstattung an den Kunden veranlasst. Der bereits an Sie ausgezahlte Anteil verbleibt bei Ihnen. Der Fall ist abgeschlossen.'
          : 'SaFix hat eine Teilrückerstattung entschieden. Die Abwicklung wird durchgeführt.'
      }
      return settled
        ? 'SaFix hat eine Rückerstattung an den Kunden veranlasst. Der Fall ist abgeschlossen.'
        : 'SaFix hat eine Rückerstattung entschieden. Die Abwicklung wird durchgeführt.'
    }
    if (decision === 'split') {
      return settled
        ? 'SaFix hat eine Teilung des Betrags entschieden. Der Ihnen zustehende Anteil wird ausgezahlt.'
        : 'SaFix hat eine Teilung entschieden. Die Abwicklung wird durchgeführt.'
    }
    if (decision === 'reject') {
      return settled
        ? 'Der Konfliktfall wurde abgelehnt. Die Zahlung wird regulär freigegeben.'
        : 'Der Konfliktfall wurde abgelehnt. Die Zahlungsfreigabe wird durchgeführt.'
    }
    return settled ? 'Fall abgeschlossen.' : 'Eine Entscheidung wurde getroffen.'
  }

  return getDisputeNextStep(status, decision, settlementStatus, resolutionType)
}

/**
 * Returns whether a new dispute can be opened given the current payment state.
 * Disputes are valid when payment is secured in escrow but not yet resolved.
 */
export function canOpenDisputeForPaymentState(state: PaymentState): boolean {
  return (
    state === 'in_escrow' ||
    state === 'work_in_progress' ||
    state === 'release_pending'
  )
}
