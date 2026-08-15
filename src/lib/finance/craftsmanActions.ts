import type { LucideIcon } from 'lucide-react'
import { CreditCard, Scale, ReceiptText, Send } from 'lucide-react'
import type { Job } from '../jobs/types'
import type { Invoice } from '../invoices/types'
import type { Payment } from '../payments/types'
import type { PayoutReadinessStatus } from '../payout/types'
import type { DisputeWithContext } from './types'
import { isJobWithoutInvoice } from '../invoices/invoiceSelectors'

export type CraftsmanActionPriority = 'high' | 'medium' | 'low'

export type CraftsmanAction = {
  id: string
  priority: CraftsmanActionPriority
  icon: LucideIcon
  label: string
  cta: string
  navigateTo: string
  color: string // Tailwind ring color class
}

/**
 * Derives a prioritised list of actions the craftsman should take right now.
 * Pure function — no side effects.
 */
export function deriveCraftsmanFinanceActions(opts: {
  payoutReadiness: PayoutReadinessStatus
  disputesWithContext: DisputeWithContext[]
  jobs: Job[]
  invoices: Invoice[]
  getInvoiceByJobId: (jobId: string) => Invoice | undefined
  getPaymentForJob: (jobId: string) => Payment | undefined
}): CraftsmanAction[] {
  const actions: CraftsmanAction[] = []

  // 1. Payout account not ready
  if (
    opts.payoutReadiness === 'no_account' ||
    opts.payoutReadiness === 'onboarding_required' ||
    opts.payoutReadiness === 'onboarding_in_progress'
  ) {
    actions.push({
      id: 'payout-setup',
      priority: 'high',
      icon: CreditCard,
      label: 'Auszahlungskonto einrichten',
      cta: 'Jetzt einrichten',
      navigateTo: '/craftsman/payout-setup',
      color: 'ring-rose-300',
    })
  } else if (opts.payoutReadiness === 'payout_blocked') {
    actions.push({
      id: 'payout-blocked',
      priority: 'high',
      icon: CreditCard,
      label: 'Auszahlungen gesperrt',
      cta: 'Anforderungen prüfen',
      navigateTo: '/craftsman/payout-setup',
      color: 'ring-rose-300',
    })
  } else if (opts.payoutReadiness === 'pending_verification') {
    actions.push({
      id: 'payout-verification',
      priority: 'medium',
      icon: CreditCard,
      label: 'Verifizierung läuft',
      cta: 'Status prüfen',
      navigateTo: '/craftsman/payout-setup',
      color: 'ring-indigo-300',
    })
  }

  // 2. Critical disputes needing response
  const criticalDisputes = opts.disputesWithContext.filter(
    (d) => d.urgencyLevel === 'critical'
  )
  for (const d of criticalDisputes) {
    actions.push({
      id: `dispute-${d.dispute.id}`,
      priority: 'high',
      icon: Scale,
      label: `Konflikt: Antwort erforderlich`,
      cta: 'Antworten',
      navigateTo: `/craftsman/jobs/${d.dispute.jobId}`,
      color: 'ring-orange-300',
    })
  }

  // 3. Jobs without invoices
  const jobsMissing = opts.jobs.filter((j) =>
    isJobWithoutInvoice(j, opts.getPaymentForJob(j.id), opts.getInvoiceByJobId)
  )
  if (jobsMissing.length > 0) {
    actions.push({
      id: 'invoices-missing',
      priority: 'medium',
      icon: ReceiptText,
      label: `${jobsMissing.length} Job${jobsMissing.length === 1 ? '' : 's'} ohne Rechnung`,
      cta: 'Rechnungen erstellen',
      navigateTo: '/craftsman/invoices',
      color: 'ring-amber-300',
    })
  }

  // 4. Invoices issued but not sent
  const unsent = opts.invoices.filter(
    (inv) => inv.status === 'issued' && !inv.sentAt
  )
  if (unsent.length > 0) {
    actions.push({
      id: 'invoices-unsent',
      priority: 'low',
      icon: Send,
      label: `${unsent.length} Rechnung${unsent.length === 1 ? '' : 'en'} noch nicht versandt`,
      cta: 'Versenden',
      navigateTo: '/craftsman/invoices',
      color: 'ring-slate-300',
    })
  }

  return actions
}
