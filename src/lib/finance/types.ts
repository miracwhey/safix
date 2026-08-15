import type { JobConversation, Job } from '../jobs'
import type { Payment } from '../payments'
import type { Invoice } from '../invoices'
import type { Dispute } from '../disputes'
import type { LedgerEntry } from '../payments/ledger'

// ---------------------------------------------------------------------------
// Operational Health types
// ---------------------------------------------------------------------------

export type RiskSeverity = 'critical' | 'elevated' | 'warning'

export type RiskFlagCategory = 'payment' | 'dispute' | 'job' | 'integrity'

export type RiskFlag = {
  /** Stable unique id for this flag instance */
  id: string
  /** How urgent/critical this flag is */
  severity: RiskSeverity
  /** Which operational domain this flag belongs to */
  category: RiskFlagCategory
  /** Short human-readable title */
  label: string
  /** Context detail string (job title, amounts, status) */
  detail: string
  /** Associated job id, if applicable */
  jobId?: string
  /** Actionable hint for the operator */
  actionHint?: string
  /** Optional navigation destination for this flag */
  linkTo?: string
}

export type OperationalHealthSummary = {
  /** Overall health status for the operator */
  overallStatus: 'healthy' | 'warning' | 'critical'
  /** Number of critical-severity flags */
  criticalCount: number
  /** Number of elevated-severity flags */
  elevatedCount: number
  /** Number of warning-severity flags */
  warningCount: number
  /** Total number of flags across all severities */
  totalIssueCount: number
  /** All flags, sorted critical → elevated → warning */
  flags: RiskFlag[]
}

export type FinanceOverviewSummary = {
  openPaymentCases: number
  invoiceVolumeLabel: string
  invoiceCount: number
  disputeCount: number
}

export type FinanceLiquiditySummary = {
  revenuePotentialLabel: string
  waitingPaymentCount: number
}

export type FinancePlatformKpiSummary = {
  gmvLabel: string
  revenueLabel: string
  payoutsLabel: string
  refundsLabel: string
  openEscrowLabel: string
  disputeSettlementsLabel: string
  disputeHoldLabel: string
}

export type FinanceStatusSummary = {
  waitingPaymentCount: number
  activeJobsCount: number
  openChatsCount: number
}

export type PaymentWithJobContext = {
  payment: Payment
  jobTitle: string
  jobId: string
}

export type DisputeWithContext = {
  dispute: Dispute
  ageDays: number
  ageLabel: string
  urgencyLevel: 'critical' | 'elevated' | 'normal'
  escrowAmountLabel: string | null
}

export type FinanceDashboardViewModel = {
  jobs: Job[]
  conversations: JobConversation[]
  payments: Payment[]
  activePayments: Payment[]
  invoices: Invoice[]
  disputes: Dispute[]
  ledgerEntries: LedgerEntry[]

  liquidity: FinanceLiquiditySummary
  overview: FinanceOverviewSummary
  platformKpis: FinancePlatformKpiSummary
  status: FinanceStatusSummary

  paymentsWithContext: PaymentWithJobContext[]
  disputesWithContext: DisputeWithContext[]

  operationalHealth: OperationalHealthSummary
}
