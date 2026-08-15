import { getBackofficeKPIs } from '../backoffice'
import { getDisputes } from '../disputes'
import {
  getDisputeAgeDays,
  getDisputeAgeLabel,
  getDisputeUrgencyLevel,
} from '../disputes/disputeSelectors'
import { getInvoices } from '../invoices'
import { getJobs } from '../jobs'
import { getJobConversations } from '../workflow/messageWorkflow'
import { getAllPayments, isPaymentEscrowProtected } from '../payments'
import { formatEuro } from '../payments/selectors'
import {
  getFinanceKPIs,
  getLedger,
  type LedgerEntry,
} from '../payments/ledger'
import type { Invoice } from '../invoices'
import type { Payment } from '../payments'
import type {
  FinanceDashboardViewModel,
  PaymentWithJobContext,
  DisputeWithContext,
} from './types'
import { deriveOperationalHealthSummary } from './healthSelectors'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'
import { resolveCanonicalProjectFacts } from '../shared/canonicalProjectFacts'

function getRevenuePotential(
  jobs: ReturnType<typeof getJobs>,
  payments: Payment[]
): number {
  // Exclude jobs whose payment is in a terminal loss state — these are not
  // potential revenue and would inflate the pipeline figure.
  const refundedJobIds = new Set(
    payments
      .filter((p) => p.state === 'refunded')
      .map((p) => p.jobId)
  )
  return jobs
    .filter((job) => !refundedJobIds.has(job.id))
    .reduce((sum, job) => sum + (resolveCanonicalAmount(job.id).amount ?? 0), 0)
}

function getActivePayments(payments: Payment[]): Payment[] {
  return payments.filter(
    (payment) =>
      payment.state !== 'released' && payment.state !== 'refunded'
  )
}

function getTotalInvoiceGross(invoices: Invoice[]): number {
  return invoices.reduce((sum, invoice) => sum + invoice.amounts.grossAmount, 0)
}

const DISPUTE_URGENCY_ORDER: Record<DisputeWithContext['urgencyLevel'], number> = {
  critical: 0,
  elevated: 1,
  normal: 2,
}

export function getFinanceDashboardViewModel(): FinanceDashboardViewModel {
  const jobs = getJobs()
  const conversations = getJobConversations()
  const payments = getAllPayments()
  const invoices = getInvoices()
  const disputes = getDisputes()
  // Sort ledger entries newest-first so the most recent financial activity
  // surfaces at the top when the list is rendered or capped.
  const ledgerEntries: LedgerEntry[] = getLedger().sort(
    (a, b) => b.createdAt - a.createdAt,
  )

  const backofficeKpis = getBackofficeKPIs(jobs, conversations)
  const financeKpis = getFinanceKPIs(ledgerEntries)
  const activePayments = getActivePayments(payments)
  const revenuePotential = getRevenuePotential(jobs, payments)
  const totalInvoiceGross = getTotalInvoiceGross(invoices)

  // Build payment lookup by jobId for dispute escrow enrichment
  const paymentByJobId = new Map(payments.map((p) => [p.jobId, p]))

  const paymentsWithContext: PaymentWithJobContext[] = activePayments.map((payment) => {
    const facts = resolveCanonicalProjectFacts(payment.jobId)
    return {
      payment,
      jobTitle: facts?.title ?? payment.jobId,
      jobId: payment.jobId,
    }
  })

  const urgencyOrder = DISPUTE_URGENCY_ORDER

  const disputesWithContext: DisputeWithContext[] = disputes
    .map((dispute): DisputeWithContext => {
      const ageDays = getDisputeAgeDays(dispute.createdAt)
      const ageLabel = getDisputeAgeLabel(dispute.createdAt)
      const urgencyLevel = getDisputeUrgencyLevel(dispute.status, ageDays)
      const payment = paymentByJobId.get(dispute.jobId)
      const escrowAmountLabel =
        payment && isPaymentEscrowProtected(payment.state)
          ? formatEuro(resolveCanonicalAmount(dispute.jobId).amount ?? 0)
          : null
      return { dispute, ageDays, ageLabel, urgencyLevel, escrowAmountLabel }
    })
    .sort((a, b) => urgencyOrder[a.urgencyLevel] - urgencyOrder[b.urgencyLevel])

  return {
    jobs,
    conversations,
    payments,
    activePayments,
    invoices,
    disputes,
    ledgerEntries,

    liquidity: {
      revenuePotentialLabel: formatEuro(revenuePotential),
      waitingPaymentCount: backofficeKpis.waitingPayment,
    },

    overview: {
      openPaymentCases: activePayments.length,
      invoiceVolumeLabel: formatEuro(totalInvoiceGross),
      invoiceCount: invoices.length,
      disputeCount: disputes.length,
    },

    platformKpis: {
      gmvLabel: formatEuro(financeKpis.gmv),
      revenueLabel: formatEuro(financeKpis.revenue),
      payoutsLabel: formatEuro(financeKpis.payouts),
      refundsLabel: formatEuro(financeKpis.refunds),
      openEscrowLabel: formatEuro(financeKpis.openEscrow),
      disputeSettlementsLabel: String(financeKpis.disputeSettlementsCount),
      disputeHoldLabel: String(financeKpis.disputeHoldCount),
    },

    status: {
      waitingPaymentCount: backofficeKpis.waitingPayment,
      activeJobsCount: backofficeKpis.activeJobs,
      openChatsCount: backofficeKpis.openChats,
    },

    paymentsWithContext,
    disputesWithContext,

    operationalHealth: deriveOperationalHealthSummary(payments, jobs, disputes),
  }
}
