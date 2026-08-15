import type { PaymentState } from './types.js'
import { formatEuro } from '../shared/formatters.js'

// Re-export canonical formatEuro so existing consumers keep working
export { formatEuro }

export function getPaymentStateLabel(state: PaymentState): string {
  switch (state) {
    case 'none':
      return 'Keine Zahlung'
    case 'deposit_required':
      return 'Zahlung ausstehend'
    case 'deposit_paid':
      return 'Zahlung bestätigt'
    case 'in_escrow':
      return 'Betrag über Stripe abgesichert'
    case 'work_in_progress':
      return 'Arbeit läuft'
    case 'release_pending':
      return 'Freigabe ausstehend'
    case 'released':
      return 'Freigegeben'
    case 'disputed':
      return 'Konflikt'
    case 'refunded':
      return 'Erstattet'
    case 'diagnosis_payment_pending':
      return 'Diagnose-Zahlung ausstehend'
    case 'diagnosis_payment_completed':
      return 'Diagnose-Zahlung abgeschlossen'
  }
}

export function getPaymentStateDescription(state: PaymentState): string {
  switch (state) {
    case 'none':
      return 'Es ist noch kein Zahlungsvorgang aktiv.'
    case 'deposit_required':
      return 'Zahlung durch den Kunden noch ausstehend. Der vollständige Betrag wird vorab über Stripe abgesichert.'
    case 'deposit_paid':
      return 'Zahlung eingegangen. Betrag wird über Stripe abgesichert.'
    case 'in_escrow':
      return 'Vollständiger Betrag über Stripe abgesichert. Schutz aktiv.'
    case 'work_in_progress':
      return 'Auftrag in Durchführung. Betrag bleibt gesichert und wird nach Fortschritt freigegeben.'
    case 'release_pending':
      return 'Freigabe angefordert. Warte auf Kundenbestätigung.'
    case 'released':
      return 'Betrag freigegeben. Auszahlung an Stripe Connect erfolgt gemäß Auszahlungsplan.'
    case 'disputed':
      return 'Konflikt aktiv. Betrag eingefroren bis zur Klärung.'
    case 'refunded':
      return 'Betrag vollständig an den Kunden zurückerstattet.'
    case 'diagnosis_payment_pending':
      return 'Diagnose-Sofortzahlung ausstehend. Eigenständiger Zahlungspfad, kein Standard-Zahlungskorridor.'
    case 'diagnosis_payment_completed':
      return 'Diagnose-Zahlung abgeschlossen. Der Handwerker hat die Berechtigung zur Durchführung des Diagnoseeinsatzes erhalten.'
  }
}

export function isPaymentEscrowProtected(state: PaymentState): boolean {
  return (
    state === 'in_escrow' ||
    state === 'work_in_progress' ||
    state === 'release_pending' ||
    state === 'disputed'
  )
}

export type PaymentActionAvailability = {
  canRelease: boolean
  canDispute: boolean
  canRefund: boolean
}

export function getPaymentActionAvailability(
  state: PaymentState
): PaymentActionAvailability {
  return {
    canRelease: state === 'release_pending',
    canDispute: state === 'in_escrow' || state === 'work_in_progress' || state === 'release_pending',
    canRefund: state === 'disputed',
  }
}
