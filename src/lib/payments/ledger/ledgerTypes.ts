export type LedgerEntryType =
  | 'escrow_created'
  | 'deposit_paid'
  | 'final_paid'
  | 'platform_fee'
  | 'payout'
  | 'transfer_reversal'
  | 'refund'
  | 'dispute_hold'
  | 'dispute_resolved_release'
  | 'dispute_resolved_refund'
  | 'supplementary_created'
  | 'supplementary_funded'
  | 'supplementary_platform_fee'
  | 'supplementary_payout'

export type LedgerEntry = {
  id: string
  paymentId: string
  jobId: string
  type: LedgerEntryType
  amount: number
  currency: 'EUR'
  createdAt: number
  note?: string
  disputeId?: string
}
