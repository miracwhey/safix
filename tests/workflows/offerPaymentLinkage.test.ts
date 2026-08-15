import { describe, expect, it, beforeEach } from 'vitest'

import { setupCleanRepositories } from '../helpers/setupRepositories'

import { addConversation, type Conversation } from '../../src/lib/messages'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  getJobContextForThread,
  confirmDepositWorkflow,
  lockEscrowWorkflow,
} from '../../src/lib/workflow'
import { addJob, getJobById, getJobRepository } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'
import { getAllPayments, getPaymentForJob } from '../../src/lib/payments'
import { addProject, getProjectByJobId } from '../../src/lib/projects'
import { isValidProjectId } from '../../src/lib/projects/projectId'

const THREAD_ID = 'thread-payment'

function seedConversation() {
  return addConversation({
    id: THREAD_ID,
    projectId: 'project-thread-payment',
    customerName: 'Test Customer',
    customerAvatarUrl: 'https://example.com/cust.jpg',
    customerUserId: 'customer-1',
    craftsmanName: 'Test Craftsman',
    craftsmanHandle: '@test',
    craftsmanAvatarUrl: 'https://example.com/craft.jpg',
    craftsmanUserId: 'craftsman-1',
    projectTitle: 'Test Project',
    projectSubtitle: 'Anfrage',
    projectLocation: 'Berlin',
    projectStatusLabel: 'Neu',
  })
}

async function createAndAcceptOffer(price = '1.600 €') {
  const offer = await createOfferWorkflow({
    conversationId: THREAD_ID,
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    price,
  })
  const accepted = await acceptOfferWorkflow(offer.id)
  return accepted
}

describe('Offer acceptance → payment linkage', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('creates a payment with correct linkage and amounts when an offer is accepted', async () => {
    await seedConversation()
    const accepted = await createAndAcceptOffer('2.400 €')
    expect(accepted?.status).toBe('accepted')
    expect(accepted?.createdJobId).toBeTruthy()

    const job = getJobById(accepted!.createdJobId!)
    expect(job?.proposalAcceptedAt).toBeTruthy()

    const payment = getPaymentForJob(accepted!.createdJobId!)
    expect(payment).toBeTruthy()
    expect(payment?.jobId).toBe(accepted!.createdJobId)
    expect(payment?.projectId).toBe(job?.projectId)
    expect(payment?.customerUserId).toBe('customer-1')
    expect(payment?.craftsmanUserId).toBe('craftsman-1')
    expect(payment?.offerId).toBe(accepted?.id)
    expect(payment?.amounts.totalAmount).toBeCloseTo(2400)
    expect(payment?.amounts.depositAmount).toBeCloseTo(600)
    expect(payment?.state).toBe('deposit_required')
  })

  it('is idempotent on re-accept and does not create duplicate payments', async () => {
    await seedConversation()
    const accepted = await createAndAcceptOffer('900 €')
    await acceptOfferWorkflow(accepted!.id) // second call should reuse payment

    const payments = getAllPayments()
    expect(payments.length).toBe(1)
    expect(payments[0].amounts.totalAmount).toBeCloseTo(900)
  })

  it('surfaces payment state in the thread job context', async () => {
    await seedConversation()
    await createAndAcceptOffer('1.000 €')

    const context = getJobContextForThread(THREAD_ID)
    expect(context).toBeTruthy()
    expect(context?.paymentState).toBe('deposit_required')
    expect(context?.paymentStateLabel).toContain('Zahlung')
  })

  it('links the accepted job to an existing project and exposes it in the thread context', async () => {
    await seedConversation()
    const now = Date.now()
    await addProject({
      id: 'project-thread-payment',
      sourceJobId: '',
      title: 'Projekt aus Builder',
      customer: 'Test Customer',
      craftsman: 'Test Craftsman',
      location: 'Berlin',
      dateLabel: 'Termin offen',
      price: '',
      status: 'accepted',
      paymentState: 'deposit_required',
      messageCount: 0,
      noteCount: 0,
      photoCount: 0,
      createdAt: now,
      updatedAt: now,
      customerUserId: 'customer-1',
      craftsmanUserId: 'craftsman-1',
    })

    const accepted = await createAndAcceptOffer('1.250 €')
    const jobId = accepted!.createdJobId!

    const project = getProjectByJobId(jobId)
    expect(project?.id).toBe('project-thread-payment')
    expect(project?.sourceJobId).toBe(jobId)

    const job = getJobById(jobId)
    expect(job?.projectId).toBe('project-thread-payment')

    const context = getJobContextForThread(THREAD_ID)
    expect(context?.customerProjectId).toBe('project-thread-payment')
  })

  it('keeps proposalSentAt at send-time and proposalAcceptedAt at acceptance-time when accepting an offer', async () => {
    const threadId = 'thread-lifecycle'
    const conversation: Conversation = {
      id: threadId,
      projectId: 'project-lifecycle',
      customerName: 'Customer',
      customerAvatarUrl: '',
      customerUserId: 'cust-1',
      craftsmanName: 'Craftsman',
      craftsmanHandle: '@craft',
      craftsmanAvatarUrl: '',
      craftsmanUserId: 'craft-1',
      projectTitle: 'Lifecycle Project',
      projectSubtitle: 'Anfrage',
      projectStatusLabel: 'Neu',
      timeLabel: 'Jetzt',
      unreadCount: 0,
      inquiryOrigin: 'reel',
      messages: [],
    }
    await addConversation(conversation)

    const beforeAccept = Date.now()
    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: 'cust-1',
      craftsmanUserId: 'craft-1',
      price: '€1.000',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    const job = accepted?.createdJobId ? getJobById(accepted.createdJobId) : undefined

    expect(job?.proposalSentAt).toBe(offer.createdAt)
    expect(job?.proposalAcceptedAt).toBeDefined()
    expect(job?.proposalAcceptedAt).toBeGreaterThanOrEqual(beforeAccept)
    expect(job?.proposalAcceptedAt).toBeGreaterThanOrEqual(job!.proposalSentAt!)
  })

  it('syncs proposalSentAt when reprocessing accepted offer with missing send timestamp', async () => {
    await seedConversation()
    const offer = await createOfferWorkflow({
      conversationId: THREAD_ID,
      customerUserId: 'customer-1',
      craftsmanUserId: 'craftsman-1',
      price: '€2.000',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    const jobId = accepted?.createdJobId
    expect(jobId).toBeTruthy()

    // Simulate drift: sent timestamp missing even though the offer was accepted earlier
    if (jobId) {
      getJobRepository().update(jobId, (job) => ({ ...job, proposalSentAt: undefined }))
    }

    // Re-acceptance should sync proposalSentAt from offer.sentAt, not throw
    const reAccepted = await acceptOfferWorkflow(offer.id)
    expect(reAccepted).toBeDefined()
    expect(reAccepted!.status).toBe('accepted')

    if (jobId) {
      const job = getJobById(jobId)
      expect(job!.proposalSentAt).toBe(offer.sentAt)
    }
  })

  it('creates a project when none exists so the customer CTA has a target', async () => {
    await seedConversation()

    const accepted = await createAndAcceptOffer('1.400 €')
    const jobId = accepted!.createdJobId!

    const project = getProjectByJobId(jobId)
    expect(project).toBeTruthy()
    expect(project?.sourceJobId).toBe(jobId)
    expect(isValidProjectId(project!.id)).toBe(true)

    const job = getJobById(jobId)
    expect(job?.projectId).toBe(project?.id)
  })

  it('keeps thread context linked when the project exists by projectId but lacks sourceJobId', async () => {
    const threadId = 'thread-context-reload'
    await addConversation({
      id: threadId,
      projectId: 'project-context-reload',
      customerName: 'Reload Customer',
      customerAvatarUrl: '',
      customerUserId: 'customer-ctx',
      craftsmanName: 'Reload Craftsman',
      craftsmanHandle: '@reload',
      craftsmanAvatarUrl: '',
      craftsmanUserId: 'craft-reload',
      projectTitle: 'Reloadable Projekt',
      projectSubtitle: 'Kontext prüfen',
      projectStatusLabel: 'Neu',
      timeLabel: 'Jetzt',
    })

    const job: Job = {
      id: 'job-context-reload',
      projectId: 'project-context-reload',
      sourceConversationId: threadId,
      title: 'Kontext Job',
      customer: 'Reload Customer',
      location: 'Berlin',
      dateLabel: 'Heute',
      status: 'new',
      amount: '€900',
      description: '',
      paymentState: 'deposit_required',
      documentationStatus: 'Neu',
      assignedMemberIds: [],
      notes: [],
      photoCount: 0,
      activities: [],
      customerUserId: 'customer-ctx',
      craftsmanUserId: 'craft-reload',
    }
    await addJob(job)

    const now = Date.now()
    await addProject({
      id: 'project-context-reload',
      sourceJobId: '',
      title: 'Projekt ohne SourceJob',
      customer: job.customer,
      craftsman: 'Reload Craftsman',
      location: job.location,
      dateLabel: job.dateLabel,
      price: job.amount,
      status: 'accepted',
      paymentState: 'deposit_required',
      messageCount: 0,
      noteCount: 0,
      photoCount: 0,
      createdAt: now,
      updatedAt: now,
      customerUserId: 'customer-ctx',
      craftsmanUserId: 'craft-reload',
    })

    const context = getJobContextForThread(threadId)
    expect(context?.customerProjectId).toBe('project-context-reload')
  })

  it('keeps job and project payment state in sync with payment transitions', async () => {
    await seedConversation()

    const accepted = await createAndAcceptOffer('1.400 €')
    const jobId = accepted!.createdJobId!

    await confirmDepositWorkflow(jobId)
    expect(getJobById(jobId)?.paymentState).toBe('deposit_paid')
    expect(getProjectByJobId(jobId)?.paymentState).toBe('deposit_paid')

    await lockEscrowWorkflow(jobId)
    expect(getJobById(jobId)?.paymentState).toBe('in_escrow')
    expect(getProjectByJobId(jobId)?.paymentState).toBe('in_escrow')
  })
})
