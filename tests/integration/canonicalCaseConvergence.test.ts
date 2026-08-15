/**
 * Canonical Case Convergence Tests
 *
 * Verifies that a single real case is represented identically across all
 * affected surfaces: thread, customer home, project detail, job detail,
 * and payment entry.
 *
 * These tests enforce the core invariant: one case = one canonical linked
 * truth.  No surface may contradict another for the same entity.
 *
 * Testing requirements from the problem statement:
 * 1. same case across thread + home + project detail + job detail
 * 2. reload stability of the same case
 * 3. no thread/project message-count divergence
 * 4. no fake project shell navigation
 * 5. accepted case remains payment-ready after reload
 * 6. inquiry case remains inquiry until true advancement
 * 7. no regression to offer lifecycle truth
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getMessagesByConversationId,
  getThreadConversionState,
  sendMessageToThread,
} from '../../src/lib/messages'
import { getJobById, getJobs } from '../../src/lib/jobs'
import {
  getProjectByJobId,
  getProjects,
  isProjectStatusStale,
} from '../../src/lib/projects'
import { syncAllProjectsFromJobs } from '../../src/lib/projects/projectJobSyncBridge'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { convertInquiryToProjectWorkflow } from '../../src/lib/workflow/exploreInquiryWorkflow'
import {
  getJobContextForThread,
  getProjectConversationMessageCount,
} from '../../src/lib/workflow/messageWorkflow'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import { getActionablePaymentState, isJobOperational } from '../../src/lib/jobs/helpers'
import { getOfferById } from '../../src/lib/offers'
import type { Conversation } from '../../src/lib/messages/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-canonical-001',
    projectId: 'project_synthetic_canonical',
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-001',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-001',
    projectTitle: 'Badezimmer Renovation',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'München',
    projectCostRange: '€5.000 – 10.000',
    projectDuration: '3 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [
      {
        id: 'msg-001',
        sender: 'user',
        text: 'Hallo, ich brauche Hilfe.',
        sentAt: Date.now() - 60_000,
        createdAtLabel: 'Vor 1 Min',
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// REQUIREMENT 1: Same case across thread + home + project detail + job detail
// ---------------------------------------------------------------------------

describe('REQ 1 – Same case across all surfaces', () => {
  beforeEach(() => setupCleanRepositories())

  it('inquiry-only case shows "request" on all surfaces', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    // Craftsman converts inquiry → creates job + auto-project
    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    expect(jobId).not.toBeNull()

    const job = getJobById(jobId!)!
    const project = getProjectByJobId(jobId!)!

    // — Job surface: status = 'new', no proposal
    expect(job.status).toBe('new')
    expect(job.proposalSentAt).toBeUndefined()
    expect(job.proposalAcceptedAt).toBeUndefined()

    // — Project surface: status must be 'request' (derived from job)
    expect(project.status).toBe('request')

    // — Thread surface: thread sees 'project' conversion state (job exists)
    expect(getThreadConversionState(conv.id)).toBe('project')

    // — Customer home surface: next action = inquiry state
    const nextAction = deriveCustomerNextAction(
      job.status,
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(nextAction.label).toBe('Anfrage in Prüfung')
    expect(nextAction.domain).toBe('job')

    // — All surfaces agree: this is an inquiry, not an accepted/payment-ready case
    expect(project.status).not.toBe('accepted')
    expect(isJobOperational(job)).toBe(false)
    expect(getActionablePaymentState(job)).toBeUndefined()
  })

  it('accepted case shows consistent state on all surfaces', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    // Create and accept offer
    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€8.500',
    })
    await acceptOfferWorkflow(offer.id)

    const acceptedOffer = getOfferById(offer.id)!
    const job = getJobById(acceptedOffer.createdJobId!)!
    const project = getProjectByJobId(job.id)!

    // — Job surface
    expect(job.proposalSentAt).toBeDefined()
    expect(job.proposalAcceptedAt).toBeDefined()
    expect(isJobOperational(job)).toBe(true)

    // — Project surface: 'accepted'
    expect(project.status).toBe('accepted')

    // — Thread surface: 'project' state
    expect(getThreadConversionState(conv.id)).toBe('project')

    // — Job context for thread: payment visible
    const jobContext = getJobContextForThread(conv.id)
    expect(jobContext).not.toBeNull()
    expect(jobContext?.paymentState).toBe('deposit_required')

    // — Customer home: payment action
    const nextAction = deriveCustomerNextAction(
      job.status,
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(nextAction.label).toBe('Zahlung leisten')
    expect(nextAction.domain).toBe('payment')
  })
})

// ---------------------------------------------------------------------------
// REQUIREMENT 2: Reload stability of the same case
// ---------------------------------------------------------------------------

describe('REQ 2 – Reload stability', () => {
  beforeEach(() => setupCleanRepositories())

  it('inquiry case status remains "request" after sync (simulated reload)', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const project = getProjectByJobId(jobId!)!

    // Before sync: status already correct
    expect(project.status).toBe('request')

    // Simulate reload sync
    await syncAllProjectsFromJobs()

    // After sync: status unchanged
    const projectAfterSync = getProjectByJobId(jobId!)!
    expect(projectAfterSync.status).toBe('request')
  })

  it('accepted case status remains "accepted" after sync (simulated reload)', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€7.000',
    })
    await acceptOfferWorkflow(offer.id)

    const acceptedOffer = getOfferById(offer.id)!
    const job = getJobById(acceptedOffer.createdJobId!)!
    const project = getProjectByJobId(job.id)!

    expect(project.status).toBe('accepted')

    // Simulate reload sync
    await syncAllProjectsFromJobs()

    const projectAfterSync = getProjectByJobId(job.id)!
    expect(projectAfterSync.status).toBe('accepted')
  })

  it('project is not stale after inquiry conversion (no sync needed)', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const job = getJobById(jobId!)!
    const project = getProjectByJobId(jobId!)!

    expect(isProjectStatusStale(project, job)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// REQUIREMENT 3: No thread/project message-count divergence
// ---------------------------------------------------------------------------

describe('REQ 3 – Message count convergence', () => {
  beforeEach(() => setupCleanRepositories())

  it('message count matches across thread and project detail after inquiry conversion', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const job = getJobById(jobId!)!

    // Thread message count
    const threadMessages = getMessagesByConversationId(conv.id)

    // Project detail message count (via canonical resolution)
    const projectMessageCount = getProjectConversationMessageCount(
      job.projectId,
      0,
      job.sourceConversationId
    )

    // Must match
    expect(projectMessageCount).toBe(threadMessages.length)
    expect(projectMessageCount).toBeGreaterThan(0)
  })

  it('message count resolves via sourceConversationId even when projectId diverges', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    // Send extra messages
    await sendMessageToThread(conv.id, 'Wann können Sie vorbeikommen?')
    await sendMessageToThread(conv.id, 'Morgen wäre ideal.', 'counterparty')

    const threadMessages = getMessagesByConversationId(conv.id)

    // Using sourceConversationId (canonical) with a non-matching projectId
    const count = getProjectConversationMessageCount(
      'non-existent-project-id',
      0,
      conv.id  // sourceConversationId resolves correctly
    )

    expect(count).toBe(threadMessages.length)
    expect(count).toBeGreaterThan(0)
  })

  it('message count falls back correctly when no sourceConversationId is available', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    // Using projectId (legacy path)
    const count = getProjectConversationMessageCount(conv.projectId, 0)
    const threadMessages = getMessagesByConversationId(conv.id)

    expect(count).toBe(threadMessages.length)
  })
})

// ---------------------------------------------------------------------------
// REQUIREMENT 4: No fake project shell navigation
// ---------------------------------------------------------------------------

describe('REQ 4 – No fake project shell', () => {
  beforeEach(() => setupCleanRepositories())

  it('auto-project from inquiry conversion is a real entity with sourceJobId', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const project = getProjectByJobId(jobId!)

    // Project is a real entity, not a shell
    expect(project).toBeDefined()
    expect(project!.sourceJobId).toBe(jobId)
    expect(project!.title).toBe(conv.projectTitle)
    expect(project!.id).not.toBe(conv.projectId) // Not the synthetic ID
  })

  it('offer acceptance does not create a duplicate project when auto-project exists', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    // Step 1: Inquiry conversion creates auto-project
    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const autoProject = getProjectByJobId(jobId!)!
    const projectCountBefore = getProjects().length

    // Step 2: Create and accept offer for the same conversation
    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€8.000',
    })
    await acceptOfferWorkflow(offer.id)

    // No duplicate project should be created
    const projectCountAfter = getProjects().length
    expect(projectCountAfter).toBe(projectCountBefore)

    // The same project is now linked to the accepted job
    const projectAfterAccept = getProjectByJobId(jobId!)
    expect(projectAfterAccept).toBeDefined()
    expect(projectAfterAccept!.id).toBe(autoProject.id)
  })
})

// ---------------------------------------------------------------------------
// REQUIREMENT 5: Accepted case remains payment-ready after reload
// ---------------------------------------------------------------------------

describe('REQ 5 – Accepted case stays payment-ready after reload', () => {
  beforeEach(() => setupCleanRepositories())

  it('accepted case has deposit_required after sync (simulated reload)', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€9.000',
    })
    await acceptOfferWorkflow(offer.id)

    const acceptedOffer = getOfferById(offer.id)!
    const job = getJobById(acceptedOffer.createdJobId!)!

    // Payment state is visible
    expect(isJobOperational(job)).toBe(true)
    expect(getActionablePaymentState(job)).toBe('deposit_required')

    // After reload sync
    await syncAllProjectsFromJobs()

    const projectAfterSync = getProjectByJobId(job.id)!
    expect(projectAfterSync.status).toBe('accepted')
    expect(projectAfterSync.paymentState).toBe('deposit_required')

    // Job remains operational
    const jobAfterSync = getJobById(job.id)!
    expect(isJobOperational(jobAfterSync)).toBe(true)
    expect(getActionablePaymentState(jobAfterSync)).toBe('deposit_required')
  })
})

// ---------------------------------------------------------------------------
// REQUIREMENT 6: Inquiry case remains inquiry until true advancement
// ---------------------------------------------------------------------------

describe('REQ 6 – Inquiry remains inquiry until true advancement', () => {
  beforeEach(() => setupCleanRepositories())

  it('inquiry case does NOT show accepted/payment-ready state', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const job = getJobById(jobId!)!
    const project = getProjectByJobId(jobId!)!

    // Project status = 'request' (not 'accepted')
    expect(project.status).toBe('request')
    expect(project.status).not.toBe('accepted')

    // Payment is not actionable
    expect(isJobOperational(job)).toBe(false)
    expect(getActionablePaymentState(job)).toBeUndefined()

    // Customer next action = inquiry, not payment
    const nextAction = deriveCustomerNextAction(
      job.status,
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(nextAction.label).toBe('Anfrage in Prüfung')
    expect(nextAction.domain).not.toBe('payment')
  })

  it('inquiry only advances to accepted when offer is accepted', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)

    // Before offer: inquiry state
    let project = getProjectByJobId(jobId!)!
    expect(project.status).toBe('request')

    // Create offer (sent, not yet accepted)
    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€6.000',
    })

    // After offer sent: project still request (offer doesn't change project)
    await syncAllProjectsFromJobs()
    project = getProjectByJobId(jobId!)!
    // proposalSentAt is set, but project should remain 'request' until accepted
    expect(project.status).toBe('request')

    // Accept offer
    await acceptOfferWorkflow(offer.id)
    await syncAllProjectsFromJobs()

    // Now project should be 'accepted'
    project = getProjectByJobId(jobId!)!
    expect(project.status).toBe('accepted')
  })
})

// ---------------------------------------------------------------------------
// REQUIREMENT 7: No regression to offer lifecycle truth
// ---------------------------------------------------------------------------

describe('REQ 7 – Offer lifecycle truth preserved', () => {
  beforeEach(() => setupCleanRepositories())

  it('offer status transitions: pending → accepted', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€5.500',
      description: 'Komplettrenovierung Bad',
    })

    expect(offer.status).toBe('pending')

    await acceptOfferWorkflow(offer.id)
    const accepted = getOfferById(offer.id)!
    expect(accepted.status).toBe('accepted')
    expect(accepted.createdJobId).toBeDefined()
    expect(accepted.acceptedAt).toBeDefined()
  })

  it('acceptance is idempotent — re-accepting returns same result', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€4.000',
    })

    const first = await acceptOfferWorkflow(offer.id)
    const second = await acceptOfferWorkflow(offer.id)

    expect(first!.createdJobId).toBe(second!.createdJobId)
    expect(getProjects().length).toBe(1)
    expect(getJobs().length).toBe(1)
  })

  it('accepted offer creates job with correct proposal timestamps', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-001',
      craftsmanUserId: 'craftsman-001',
      price: '€7.500',
    })

    await acceptOfferWorkflow(offer.id)
    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    expect(job.proposalSentAt).toBeDefined()
    expect(job.proposalAcceptedAt).toBeDefined()
    expect(job.proposalSentAt).toBeLessThanOrEqual(job.proposalAcceptedAt!)
  })

  it('no "Auftrag erstellt" while project says unassigned request', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const jobId = await convertInquiryToProjectWorkflow(conv.id)
    const job = getJobById(jobId!)!
    const project = getProjectByJobId(jobId!)!

    // Activity may say "Auftrag aus Anfrage erstellt" (that's fine for the job)
    const hasCreationActivity = job.activities.some(
      (a) => a.text.includes('Auftrag aus Anfrage erstellt')
    )
    expect(hasCreationActivity).toBe(true)

    // But project status must match job state — both say "request/new"
    expect(project.status).toBe('request')
    expect(job.status).toBe('new')

    // The activity describes the workflow step; the status fields tell the
    // canonical case truth.  They are not contradictory — the inquiry was
    // converted to a job (activity), but the case is still in inquiry/request
    // phase (status).
  })
})
