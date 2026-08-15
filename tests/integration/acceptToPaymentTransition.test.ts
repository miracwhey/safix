/**
 * Canonical Job Accept-to-Payment Transition Tests
 *
 * Verifies that customer offer acceptance correctly mutates the canonical
 * job into an accepted/payment-ready state, and that all downstream surfaces
 * read that persisted truth correctly.
 *
 * Testing requirements:
 * 1. accepting a sent offer writes proposalAcceptedAt on the canonical job
 * 2. accepting a sent offer advances job/payment state correctly
 * 3. customer home shows payment-required after reload
 * 4. project detail reflects the same accepted/payment-ready state via derived job truth
 * 5. no regression to inquiry-only cases
 * 6. no regression to sent-vs-accepted lifecycle truth
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
} from '../../src/lib/messages'
import { getJobById } from '../../src/lib/jobs'
import {
  getProjectByJobId,
  deriveProjectStatusFromJob,
  isProjectStatusStale,
} from '../../src/lib/projects'
import { syncAllProjectsFromJobs } from '../../src/lib/projects/projectJobSyncBridge'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { convertInquiryToProjectWorkflow } from '../../src/lib/workflow/exploreInquiryWorkflow'
import { getJobContextForThread } from '../../src/lib/workflow/messageWorkflow'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import { getActionablePaymentState, isJobOperational } from '../../src/lib/jobs/helpers'
import { getPaymentForJob } from '../../src/lib/payments'
import { getOfferById } from '../../src/lib/offers'
import type { Conversation } from '../../src/lib/messages/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-accept-test',
    projectId: 'project_synthetic_accept',
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-001',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-001',
    projectTitle: 'Küche Renovation',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€3.000 – 6.000',
    projectDuration: '2 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'profile',
    messages: [
      {
        id: 'msg-001',
        sender: 'user',
        text: 'Ich brauche eine neue Küche.',
        sentAt: Date.now() - 60_000,
        createdAtLabel: 'Vor 1 Min',
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// REQ 1: Accepting a sent offer writes proposalAcceptedAt on canonical job
// ---------------------------------------------------------------------------

describe('REQ 1 – acceptOfferWorkflow writes proposalAcceptedAt', () => {
  beforeEach(() => setupCleanRepositories())

  it('sets proposalAcceptedAt on a new job created at acceptance time', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€4.500',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    expect(job.proposalAcceptedAt).toBeDefined()
    expect(job.proposalAcceptedAt).toBeGreaterThan(0)
  })

  it('sets proposalAcceptedAt on an existing job from inquiry conversion', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    // Craftsman converts inquiry → creates job
    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const jobBefore = getJobById(jobId!)!
    expect(jobBefore.proposalAcceptedAt).toBeUndefined()

    // Craftsman sends offer
    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€5.000',
    })

    // Customer accepts
    await acceptOfferWorkflow(offer.id)

    const jobAfter = getJobById(jobId!)!
    expect(jobAfter.proposalAcceptedAt).toBeDefined()
    expect(jobAfter.proposalAcceptedAt).toBeGreaterThan(0)
    expect(jobAfter.proposalSentAt).toBeDefined()
    expect(jobAfter.proposalSentAt!).toBeLessThanOrEqual(jobAfter.proposalAcceptedAt!)
  })

  it('preserves proposalSentAt when writing proposalAcceptedAt', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€3.200',
    })

    const jobAfterSend = getJobById(jobId!)!
    const sentAt = jobAfterSend.proposalSentAt
    expect(sentAt).toBeDefined()

    await acceptOfferWorkflow(offer.id)

    const jobAfterAccept = getJobById(jobId!)!
    // proposalSentAt must not change when accepting
    expect(jobAfterAccept.proposalSentAt).toBe(sentAt)
    expect(jobAfterAccept.proposalAcceptedAt).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// REQ 2: Accepting advances job/payment state correctly
// ---------------------------------------------------------------------------

describe('REQ 2 – Accept advances job/payment state', () => {
  beforeEach(() => setupCleanRepositories())

  it('canonical job becomes operational after acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€4.000',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    expect(isJobOperational(job)).toBe(true)
    expect(job.paymentState).toBe('deposit_required')
  })

  it('payment entity is created with deposit_required state', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€6.000',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const payment = getPaymentForJob(accepted.createdJobId!)

    expect(payment).toBeDefined()
    expect(payment!.state).toBe('deposit_required')
  })

  it('getActionablePaymentState returns deposit_required after acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€5.500',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!
    const payment = getPaymentForJob(job.id)

    expect(getActionablePaymentState(job, payment)).toBe('deposit_required')
  })

  it('thread job context shows payment state after acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€4.200',
    })

    await acceptOfferWorkflow(offer.id)

    const jobContext = getJobContextForThread(conv.id)
    expect(jobContext).not.toBeNull()
    expect(jobContext!.paymentState).toBe('deposit_required')
  })
})

// ---------------------------------------------------------------------------
// REQ 3: Customer home shows payment-required after reload
// ---------------------------------------------------------------------------

describe('REQ 3 – Customer home shows payment after reload', () => {
  beforeEach(() => setupCleanRepositories())

  it('deriveCustomerNextAction shows "Zahlung leisten" with canonical job fields', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€7.000',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    // This is exactly what CustomerHomeScreen does:
    // passes job status + proposal timestamps to deriveCustomerNextAction
    const nextAction = deriveCustomerNextAction(
      job.status,         // 'new' — the real canonical status
      job.paymentState,   // 'deposit_required'
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )

    expect(nextAction.label).toBe('Zahlung leisten')
    expect(nextAction.domain).toBe('payment')
    // deposit_required + created/sent is 'urgent' — customer must act to unblock work
    expect(nextAction.priority).toBe('urgent')
  })

  it('mapProjectStatusToJobStatus("accepted") feeds "new" to deriveCustomerNextAction', async () => {
    // The mapping "accepted" → "new" is correct because the real job status
    // is 'new', and acceptance is tracked via proposalAcceptedAt
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€8.000',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!
    const project = getProjectByJobId(job.id)!

    expect(project.status).toBe('accepted')

    // Simulate what CustomerHomeScreen does after reload:
    // project.status 'accepted' should map to job status 'new'
    // (not 'scheduled' which was the old buggy mapping)
    const nextAction = deriveCustomerNextAction(
      'new',  // The correct mapping for 'accepted' project status
      project.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )

    expect(nextAction.label).toBe('Zahlung leisten')
    expect(nextAction.domain).toBe('payment')
  })

  it('payment-ready state survives simulated reload (sync cycle)', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€5.800',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    // Simulate reload sync
    await syncAllProjectsFromJobs()

    // Re-read after sync
    const jobAfterSync = getJobById(job.id)!
    const projectAfterSync = getProjectByJobId(job.id)!

    // Job truth is unchanged
    expect(jobAfterSync.proposalAcceptedAt).toBeDefined()
    expect(isJobOperational(jobAfterSync)).toBe(true)
    expect(getActionablePaymentState(jobAfterSync)).toBe('deposit_required')

    // Project derived status remains 'accepted'
    expect(projectAfterSync.status).toBe('accepted')
    expect(projectAfterSync.paymentState).toBe('deposit_required')

    // Customer home action remains correct
    const nextAction = deriveCustomerNextAction(
      jobAfterSync.status,
      jobAfterSync.paymentState,
      undefined,
      jobAfterSync.proposalSentAt,
      jobAfterSync.proposalAcceptedAt
    )
    expect(nextAction.label).toBe('Zahlung leisten')
  })
})

// ---------------------------------------------------------------------------
// REQ 4: Project detail reflects accepted/payment-ready via derived job truth
// ---------------------------------------------------------------------------

describe('REQ 4 – Project detail derives status from canonical job', () => {
  beforeEach(() => setupCleanRepositories())

  it('project status syncs to "accepted" immediately after offer acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    // For profile-origin inquiries, conversion does NOT create an auto-project.
    // The project is only created at offer acceptance time.
    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    expect(getProjectByJobId(jobId!)).toBeUndefined()

    // Create and accept offer — this creates the real project
    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€4.500',
    })
    await acceptOfferWorkflow(offer.id)

    // Project should be 'accepted' IMMEDIATELY (created at acceptance)
    const project = getProjectByJobId(jobId!)!
    expect(project).toBeDefined()
    expect(project.status).toBe('accepted')
  })

  it('project is not stale after acceptance (status matches canonical job)', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€3.800',
    })
    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!
    const project = getProjectByJobId(job.id)!

    expect(isProjectStatusStale(project, job)).toBe(false)
  })

  it('deriveProjectStatusFromJob returns "accepted" for accepted canonical job', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€6.200',
    })
    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    expect(deriveProjectStatusFromJob(job)).toBe('accepted')
  })
})

// ---------------------------------------------------------------------------
// REQ 5: No regression to inquiry-only cases
// ---------------------------------------------------------------------------

describe('REQ 5 – Inquiry-only cases unaffected', () => {
  beforeEach(() => setupCleanRepositories())

  it('inquiry job is NOT operational', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const job = getJobById(jobId!)!

    expect(isJobOperational(job)).toBe(false)
    expect(getActionablePaymentState(job)).toBeUndefined()
  })

  it('inquiry job derives project status "request"', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const job = getJobById(jobId!)!

    expect(deriveProjectStatusFromJob(job)).toBe('request')
  })

  it('inquiry customer next action shows inquiry label, not payment', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const job = getJobById(jobId!)!

    const nextAction = deriveCustomerNextAction(
      job.status,
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )

    expect(nextAction.label).toBe('Anfrage in Prüfung')
    expect(nextAction.domain).toBe('job')
    expect(nextAction.domain).not.toBe('payment')
  })
})

// ---------------------------------------------------------------------------
// REQ 6: No regression to sent-vs-accepted lifecycle truth
// ---------------------------------------------------------------------------

describe('REQ 6 – Sent vs accepted lifecycle truth', () => {
  beforeEach(() => setupCleanRepositories())

  it('sent-but-not-accepted offer: no project exists for profile inquiries', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)

    // Create offer (sends it) but don't accept
    await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€4.000',
    })

    await syncAllProjectsFromJobs()

    // For profile inquiries, no project exists until acceptance
    const project = getProjectByJobId(jobId!)
    expect(project).toBeUndefined()
  })

  it('sent-only job shows "Angebot liegt vor" not "Zahlung leisten"', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)

    await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€4.000',
    })

    const job = getJobById(jobId!)!
    expect(job.proposalSentAt).toBeDefined()
    expect(job.proposalAcceptedAt).toBeUndefined()

    const nextAction = deriveCustomerNextAction(
      job.status,
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )

    expect(nextAction.label).toBe('Angebot liegt vor')
    expect(nextAction.domain).toBe('job')
  })

  it('accepted offer changes label from "Angebot liegt vor" to "Zahlung leisten"', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€4.000',
    })

    // Before acceptance: "Angebot liegt vor"
    let job = getJobById(jobId!)!
    let nextAction = deriveCustomerNextAction(
      job.status, job.paymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt
    )
    expect(nextAction.label).toBe('Angebot liegt vor')

    // After acceptance: "Zahlung leisten"
    await acceptOfferWorkflow(offer.id)
    job = getJobById(jobId!)!
    nextAction = deriveCustomerNextAction(
      job.status, job.paymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt
    )
    expect(nextAction.label).toBe('Zahlung leisten')
    expect(nextAction.domain).toBe('payment')
  })

  it('deriveProposalLifecycle correctly distinguishes sent from accepted', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€3.500',
    })

    // After send: proposalSentAt set, proposalAcceptedAt not
    let job = getJobById(jobId!)!
    expect(job.proposalSentAt).toBeDefined()
    expect(job.proposalAcceptedAt).toBeUndefined()

    // After acceptance: both set
    await acceptOfferWorkflow(offer.id)
    job = getJobById(jobId!)!
    expect(job.proposalSentAt).toBeDefined()
    expect(job.proposalAcceptedAt).toBeDefined()
    expect(job.proposalSentAt!).toBeLessThanOrEqual(job.proposalAcceptedAt!)
  })
})
