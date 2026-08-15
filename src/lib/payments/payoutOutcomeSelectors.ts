/**
 * Payout bank-outcome selector — tranche-scoped.
 *
 * Derives bank-arrival truth per released tranche from webhook-emitted
 * timeline signals (`payout_completed`, `payout_failed`). The server-side
 * Stripe webhook (`api/stripe-webhook.ts`) writes one signal row per
 * tranche (`external_release_ref`) that belonged to the payout, using a
 * deterministic signal id of the form
 *
 *   timeline_payout_completed__<transferId>
 *   timeline_payout_failed__<transferId>
 *
 * The `__<transferId>` suffix lets the projection match an outcome to the
 * specific tranche that carries that Stripe Transfer ID, so a multi-tranche
 * job cannot report "Auf deinem Konto" while a later tranche is still on
 * its way to the bank.
 */

import type { ProjectTimelineSignal } from '../timeline'
import type { PayoutBankOutcome } from './moneyFlowProjection'

type TrancheBankOutcome = Extract<PayoutBankOutcome, 'completed' | 'failed'>

const TRANSFER_REF_DELIMITER = '__'

/**
 * Parses the `transferId` suffix (Stripe Transfer ID, `tr_...`) out of a
 * payout-outcome signal id. Returns null for legacy signal ids that do
 * not encode a transfer ref.
 */
export function extractTransferRefFromPayoutSignal(signalId: string): string | null {
  const idx = signalId.indexOf(TRANSFER_REF_DELIMITER)
  if (idx < 0) return null
  const ref = signalId.slice(idx + TRANSFER_REF_DELIMITER.length)
  return ref.length > 0 ? ref : null
}

/**
 * Builds a deterministic signal id for a payout-outcome timeline event.
 * Must stay in sync with `api/stripe-webhook.ts` — the id is the idempotency
 * key used by the `timeline_signals` upsert on the server side.
 */
export function buildPayoutOutcomeSignalId(
  outcomeType: 'payout_completed' | 'payout_failed',
  transferId: string,
): string {
  return `timeline_${outcomeType}${TRANSFER_REF_DELIMITER}${transferId}`
}

/**
 * For a given job, returns a map `transferRef → latest-outcome` derived
 * from the timeline signals. Signals for other jobs are ignored; signals
 * without a transfer suffix (legacy or non-payout entries) are skipped.
 * On conflict the more recent signal wins.
 */
export function derivePayoutOutcomesByTransfer(
  signals: ProjectTimelineSignal[],
  jobId: string,
): Map<string, TrancheBankOutcome> {
  const latest = new Map<string, { outcome: TrancheBankOutcome; at: number }>()

  for (const signal of signals) {
    if (signal.jobId !== jobId) continue
    if (signal.type !== 'payout_completed' && signal.type !== 'payout_failed') continue
    const ref = extractTransferRefFromPayoutSignal(signal.id)
    if (!ref) continue
    const outcome: TrancheBankOutcome = signal.type === 'payout_completed' ? 'completed' : 'failed'
    const prior = latest.get(ref)
    if (!prior || signal.occurredAt > prior.at) {
      latest.set(ref, { outcome, at: signal.occurredAt })
    }
  }

  const result = new Map<string, TrancheBankOutcome>()
  for (const [ref, entry] of latest.entries()) {
    result.set(ref, entry.outcome)
  }
  return result
}

/**
 * Monotonic merge guard for payout outcomes — used by UI surfaces that
 * consume realtime timeline signals and occasionally see a transient
 * empty snapshot (e.g. repo reset during reconnect). A transfer that
 * was previously known to be `completed` or `failed` keeps its outcome
 * even if the current snapshot omits its signal; a fresh outcome from
 * the current snapshot always replaces the previous one.
 *
 * Rules:
 *   - current `failed`    ⇢ always wins (customer/craftsman must see failures fast)
 *   - current `completed` ⇢ replaces previous `completed`; replaces stale `failed` only when the caller chooses to retry (decide upstream)
 *   - missing in current  ⇢ retain previous (anti-flicker)
 */
export function mergeMonotonicPayoutOutcomes(
  previous: ReadonlyMap<string, 'completed' | 'failed'> | null | undefined,
  current: ReadonlyMap<string, 'completed' | 'failed'>,
): Map<string, 'completed' | 'failed'> {
  const merged = new Map<string, 'completed' | 'failed'>()
  if (previous) {
    for (const [ref, outcome] of previous) merged.set(ref, outcome)
  }
  for (const [ref, outcome] of current) merged.set(ref, outcome)
  return merged
}
