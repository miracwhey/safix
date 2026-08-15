import type { LedgerEntry } from './ledgerTypes.js'

export type FinanceKPIs = {
  gmv: number
  revenue: number
  payouts: number
  refunds: number
  openEscrow: number
  disputeSettlementsCount: number
  disputeHoldCount: number
}

export function getGMV(entries: LedgerEntry[]): number {
  return entries
    .filter((entry) => entry.type === 'escrow_created' || entry.type === 'supplementary_funded')
    .reduce((sum, entry) => sum + entry.amount, 0)
}

export function getRevenue(entries: LedgerEntry[]): number {
  return entries
    .filter((entry) => entry.type === 'platform_fee' || entry.type === 'supplementary_platform_fee')
    .reduce((sum, entry) => sum + entry.amount, 0)
}

export function getPayouts(entries: LedgerEntry[]): number {
  return entries
    .filter(
      (entry) =>
        entry.type === 'payout' ||
        entry.type === 'transfer_reversal' ||
        entry.type === 'dispute_resolved_release' ||
        entry.type === 'supplementary_payout'
    )
    .reduce((sum, entry) => sum + entry.amount, 0)
}

export function getRefunds(entries: LedgerEntry[]): number {
  return entries
    .filter(
      (entry) =>
        entry.type === 'refund' ||
        entry.type === 'dispute_resolved_refund'
    )
    .reduce((sum, entry) => sum + entry.amount, 0)
}

export function getOpenEscrow(entries: LedgerEntry[]): number {
  const escrowCreated = entries
    .filter((entry) => entry.type === 'escrow_created' || entry.type === 'supplementary_funded')
    .reduce((sum, entry) => sum + entry.amount, 0)

  const paidOut = entries
    .filter(
      (entry) =>
        entry.type === 'payout' ||
        entry.type === 'transfer_reversal' ||
        entry.type === 'refund' ||
        entry.type === 'platform_fee' ||
        entry.type === 'dispute_resolved_release' ||
        entry.type === 'dispute_resolved_refund' ||
        entry.type === 'supplementary_payout' ||
        entry.type === 'supplementary_platform_fee'
    )
    .reduce((sum, entry) => sum + entry.amount, 0)

  return Math.max(escrowCreated - paidOut, 0)
}

export function getDisputeSettlementsCount(entries: LedgerEntry[]): number {
  return entries.filter(
    (entry) =>
      entry.type === 'dispute_resolved_release' ||
      entry.type === 'dispute_resolved_refund'
  ).length
}

export function getDisputeHoldCount(entries: LedgerEntry[]): number {
  return entries.filter((entry) => entry.type === 'dispute_hold').length
}

export function getFinanceKPIs(entries: LedgerEntry[]): FinanceKPIs {
  return {
    gmv: getGMV(entries),
    revenue: getRevenue(entries),
    payouts: getPayouts(entries),
    refunds: getRefunds(entries),
    openEscrow: getOpenEscrow(entries),
    disputeSettlementsCount: getDisputeSettlementsCount(entries),
    disputeHoldCount: getDisputeHoldCount(entries),
  }
}
