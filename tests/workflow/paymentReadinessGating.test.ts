import React from 'react'
import { describe, beforeEach, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'

import { setupCleanRepositories } from '../helpers/setupRepositories'

import JobLifecycleFlow from '../../src/components/jobs/JobLifecycleFlow'

import { addConversation } from '../../src/lib/messages'
import { addJob, getJobs, getJobById, getJobsWaitingPayment } from '../../src/lib/jobs'
import {
  createPaymentForJob,
  getPaymentForJob,
} from '../../src/lib/payments'
import type { JobSchedule } from '../../src/lib/operations'
import type { ProjectTimelineEvent } from '../../src/lib/timeline'
import { getBackofficeKPIs } from '../../src/lib/backoffice'
import { getJobContextForThread, getJobConversations } from '../../src/lib/workflow'
import { deriveNextAction } from '../../src/lib/jobs/nextActionSelectors'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import { deriveCustomerJobStage } from '../../src/lib/jobs/customerJobStageSelectors'
import { getActionablePaymentState } from '../../src/lib/jobs/helpers'

const THREAD_ID = 'thread-gating'

function seedConversation(overrides: Partial<Parameters<typeof addConversation>[0]> = {}) {
  return addConversation({
    id: THREAD_ID,
    projectId: 'conv-project',
    sourceProjectId: 'source-project',
    customerName: 'Kunde',
    customerAvatarUrl: 'https://example.com/cust.jpg',
    craftsmanName: 'Betrieb',
    craftsmanHandle: '@betrieb',
    craftsmanAvatarUrl: 'https://example.com/craft.jpg',
    projectTitle: 'Badrenovierung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    ...overrides,
  })
}

function seedJob(overrides: Partial<Parameters<typeof addJob>[0]> = {}) {
  return addJob({
    id: 'job-gate',
    projectId: 'conv-project',
    title: 'Badrenovierung',
    customer: 'Kunde',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'new',
    amount: '2.500 €',
    description: 'Anfrage',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    sourceConversationId: THREAD_ID,
    ...overrides,
  })
}

describe('Payment readiness gating & dashboard alignment', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('suppresses payment-required cues before an offer is accepted', async () => {
    await seedConversation()
    await seedJob()

    const context = getJobContextForThread(THREAD_ID)
    expect(context?.paymentState).toBeUndefined()
    expect(context?.nextAction.label).toContain('Neue Anfrage')

    const job = getJobById('job-gate')!
    const customerAction = deriveCustomerNextAction(
      job.status,
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(customerAction.label).not.toContain('Einzahlung')

    const customerStep = deriveCustomerNextStep(job)
    expect(customerStep.hint).not.toContain('Einzahlung')
  })

  it('surfaces payment-required state after acceptance when deposit is actionable', async () => {
    await seedConversation()
    const sentAt = Date.now() - 1000
    await seedJob({ proposalSentAt: sentAt, proposalAcceptedAt: Date.now() })
    await createPaymentForJob('job-gate', 1800)

    const context = getJobContextForThread(THREAD_ID)
    expect(context?.paymentState).toBe('deposit_required')
    expect(context?.paymentStateLabel).toContain('Zahlung')

    const nextAction = deriveNextAction(
      'new',
      'deposit_required',
      undefined,
      sentAt,
      Date.now()
    )
    expect(nextAction.label).toContain('Zahlung')
  })

  it('keeps inquiry cases out of payment/timeline surfaces even when a payment record exists', async () => {
    await seedConversation()
    await seedJob({ paymentState: 'release_pending' })
    await createPaymentForJob('job-gate', 2000)

    const jobs = getJobs()
    const kpis = getBackofficeKPIs(jobs, [])
    expect(kpis.activeJobs).toBe(0)
    expect(kpis.waitingPayment).toBe(0)
    expect(getJobsWaitingPayment(jobs)).toHaveLength(0)

    const job = getJobById('job-gate')!
    const payment = getPaymentForJob('job-gate')
    expect(getActionablePaymentState(job, payment)).toBeUndefined()

    const stage = deriveCustomerJobStage(
      job.status,
      job.paymentState,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(stage.stage).toBe('inquiry_sent')

    const nextAction = deriveNextAction(
      job.status,
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(nextAction.label).toContain('Neue Anfrage')
  })

  it('promotes payment/deposit surfaces only after an accepted offer', async () => {
    const acceptedAt = Date.now()
    await seedConversation()
    await seedJob({ proposalSentAt: acceptedAt - 500, proposalAcceptedAt: acceptedAt, paymentState: 'deposit_required' })
    await createPaymentForJob('job-gate', 2500)

    const job = getJobById('job-gate')!

    const nextAction = deriveNextAction(
      job.status,
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(nextAction.label).toContain('Zahlung')

    const customerAction = deriveCustomerNextAction(
      job.status,
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(customerAction.label).toContain('Zahlung')

    const customerStage = deriveCustomerJobStage(
      job.status,
      job.paymentState,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(customerStage.stage).toBe('offer_accepted')
  })

  it('hides schedule/payment/timeline modules while the job is still an inquiry', async () => {
    await seedConversation()
    await seedJob({ paymentState: 'release_pending' })
    await createPaymentForJob('job-gate', 2000)

    const now = Date.now()
    const schedule: JobSchedule = {
      id: 'sched-1',
      jobId: 'job-gate',
      scheduledStart: now + 60_000,
      scheduledEnd: now + 3_600_000,
      executionWindow: 120,
      schedulingStatus: 'scheduled',
      createdAt: now,
      updatedAt: now,
    }

    const timelineEvents: ProjectTimelineEvent[] = [
      {
        id: 'evt-1',
        jobId: 'job-gate',
        type: 'release_requested',
        title: 'Freigabe',
        description: 'Freigabe angefragt',
        label: 'Freigabe',
        accent: 'amber',
        dateLabel: 'Heute',
        createdAt: now,
      },
    ]

    const html = renderToString(
      React.createElement(JobLifecycleFlow, {
        jobId: 'job-gate',
        schedule,
        timelineEvents,
        artifacts: [],
        onSchedule: () => {},
        onConfirmSchedule: () => {},
        onReschedule: () => {},
        onCancelSchedule: () => {},
        onMarkExecutionStarted: () => {},
        onMarkExecutionCompleted: () => {},
        onAttachProgressPhoto: () => {},
        onAttachCompletionPhoto: () => {},
      })
    )

    expect(html).toContain('Noch in Anfragephase')
    expect(html).not.toContain('Ausführungsfenster')
    expect(html).not.toContain('Zahlungsverlauf')
    expect(html).not.toContain('Freigabe')
  })

  it('surfaces operational modules after an accepted offer', async () => {
    const acceptedAt = Date.now()
    await seedConversation()
    await seedJob({ proposalSentAt: acceptedAt - 500, proposalAcceptedAt: acceptedAt, paymentState: 'deposit_required' })
    await createPaymentForJob('job-gate', 1800)

    const now = Date.now()
    const schedule: JobSchedule = {
      id: 'sched-2',
      jobId: 'job-gate',
      scheduledStart: now + 120_000,
      scheduledEnd: now + 4_200_000,
      executionWindow: 180,
      schedulingStatus: 'scheduled',
      createdAt: now,
      updatedAt: now,
    }

    const html = renderToString(
      React.createElement(JobLifecycleFlow, {
        jobId: 'job-gate',
        schedule,
        timelineEvents: [],
        onSchedule: () => {},
        onConfirmSchedule: () => {},
        onReschedule: () => {},
        onCancelSchedule: () => {},
        onMarkExecutionStarted: () => {},
        onMarkExecutionCompleted: () => {},
      })
    )

    // JobLifecycleFlow renders scheduling module when operational.
    // Payment modules (Zahlungsverlauf, Einzahlung) now live in the parent screen.
    expect(html).toContain('Ausführungsfenster')
    expect(html).not.toContain('Noch in Anfragephase')
  })

  it('links conversations via sourceConversationId/sourceProjectId for dashboard + detail consistency', async () => {
    await seedConversation({ projectId: 'conv-project', sourceProjectId: 'source-project' })
    await seedJob({ projectId: 'source-project' })

    const conversations = getJobConversations()
    expect(conversations).toHaveLength(1)
    expect(conversations[0].jobId).toBe('job-gate')

    const kpis = getBackofficeKPIs(getJobs(), conversations)
    expect(kpis.openChats).toBe(1)
  })

})
