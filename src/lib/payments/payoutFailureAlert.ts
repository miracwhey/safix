/**
 * Payout-Failure-Alert Selector — Block 7.1D
 *
 * Aggregiert alle craftsman-gerichteten `payout_failed` Notification-Signals
 * zu einem einzelnen Handlungs-Item für UI-Surfaces (OwnerHomeHero,
 * CraftsmanFinanceScreen). Source-of-Truth sind die `notification_signals`,
 * die der notificationBridge aus den vom Stripe-Webhook geschriebenen
 * `timeline_signals` (Type `payout_failed`) ableitet.
 *
 * Read-Contract:
 *   - Nur ungelesene Signale eines Craftsman zählen — sobald der Handwerker
 *     die Bell oder ein anderes Surface aufruft, gilt der Alert als verarbeitet.
 *   - Bridge-Output ist tranche-scoped (eine Notification pro fehlgeschlagenem
 *     Stripe-Transfer). Das Aggregat zählt diese Anzahl als `count`.
 *   - `latestFailureAt` ist `Date.now()`-kompatibel (Epoch-ms aus
 *     `notification_signals.occurred_at`).
 *
 * Routing-Contract:
 *   - Ziel `actionRoute` = `/craftsman/profile/tax-bank` (TaxBankScreen verwaltet
 *     Bankdaten + Stripe-Connect-Status). Bewusst kein direkter Stripe-Update-
 *     Link, weil der Handwerker erst die hinterlegten Bankdaten prüfen soll.
 */

import type { NotificationSignal } from '../notifications/types'

export const PAYOUT_FAILURE_ACTION_ROUTE = '/craftsman/profile/tax-bank'

const PAYOUT_FAILURE_TITLE = 'Auszahlung fehlgeschlagen'
const PAYOUT_FAILURE_DESCRIPTION =
  'Stripe konnte deine Auszahlung nicht abschließen. Prüfe deine Bankdaten, damit zukünftige Auszahlungen funktionieren.'
const PAYOUT_FAILURE_CTA_LABEL = 'Bankdaten prüfen'

export type PayoutFailureAlert = {
  hasPayoutFailure: boolean
  count: number
  /** Latest failure timestamp (Epoch-ms) — null if no failures present. */
  latestFailureAt: number | null
  actionRoute: string
  ctaLabel: string
  title: string
  description: string
}

const EMPTY_ALERT: PayoutFailureAlert = {
  hasPayoutFailure: false,
  count: 0,
  latestFailureAt: null,
  actionRoute: PAYOUT_FAILURE_ACTION_ROUTE,
  ctaLabel: PAYOUT_FAILURE_CTA_LABEL,
  title: PAYOUT_FAILURE_TITLE,
  description: PAYOUT_FAILURE_DESCRIPTION,
}

/**
 * Filtert die übergebenen Notification-Signale auf ungelesene
 * `payout_failed`-Events des Craftsman und liefert ein UI-fertiges
 * Alert-Objekt zurück.
 *
 * Pure Funktion: keine Store-Reads, keine Side-Effects.
 */
export function derivePayoutFailureAlert(
  signals: ReadonlyArray<NotificationSignal>,
): PayoutFailureAlert {
  let count = 0
  let latestFailureAt: number | null = null

  for (const signal of signals) {
    if (signal.type !== 'payout_failed') continue
    if (signal.recipientRole !== 'craftsman') continue
    if (signal.read) continue

    count += 1
    if (latestFailureAt === null || signal.occurredAt > latestFailureAt) {
      latestFailureAt = signal.occurredAt
    }
  }

  if (count === 0) return EMPTY_ALERT

  return {
    hasPayoutFailure: true,
    count,
    latestFailureAt,
    actionRoute: PAYOUT_FAILURE_ACTION_ROUTE,
    ctaLabel: PAYOUT_FAILURE_CTA_LABEL,
    title: PAYOUT_FAILURE_TITLE,
    description: PAYOUT_FAILURE_DESCRIPTION,
  }
}

/**
 * Default/empty alert für Loading- oder Pre-Hydration-Zustände.
 * Konsumenten können diese Konstante verwenden, statt `derivePayoutFailureAlert([])`
 * jedes Mal neu aufzurufen.
 */
export function getEmptyPayoutFailureAlert(): PayoutFailureAlert {
  return EMPTY_ALERT
}
