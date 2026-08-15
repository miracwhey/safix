import { describe, expect, it } from 'vitest'

import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import type { Job } from '../../src/lib/jobs'
import type { Payment } from '../../src/lib/payments'

const baseJob: Job = {
  id: 'job-1',
  projectId: 'project-1',
  title: 'Test Job',
  customer: 'Customer',
  location: 'Berlin',
  dateLabel: 'Heute',
  status: 'new',
  amount: '1.000 €',
  description: 'Desc',
  paymentState: 'deposit_required',
  documentationStatus: 'Noch keine Dokumentation',
  assignedMemberIds: [],
  notes: [],
  photoCount: 0,
  activities: [],
  proposalSentAt: 1,
  proposalAcceptedAt: 1,
}

const depositPayment: Payment = {
  id: 'payment-job-1',
  jobId: 'job-1',
  state: 'deposit_required',
  amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
  createdAt: 0,
  updatedAt: 0,
}

describe('deriveCustomerNextStep', () => {
  it('surfaces an escrow funding CTA when a payment requires funding', () => {
    const step = deriveCustomerNextStep(baseJob, depositPayment)
    expect(step.label).toBe('Zahlung einzahlen')
    expect(step.actionRoute).toBe('/projects/project-1?focus=payment')
    expect(step.actionLabel).toBe('Jetzt einzahlen')
  })

  it('acknowledges confirmed escrow funding without showing an action CTA', () => {
    const step = deriveCustomerNextStep(baseJob, {
      ...depositPayment,
      state: 'deposit_paid',
    })
    expect(step.label).toBe('Zahlung abgesichert')
    expect(step.actionLabel).toBeUndefined()
  })
})
