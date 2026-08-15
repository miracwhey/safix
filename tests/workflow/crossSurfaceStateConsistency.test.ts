/**
 * Cross-Surface State Consistency Tests
 *
 * Verifies that the same inquiry/offer/job/payment state is represented
 * consistently across all customer and craftsman surfaces.
 *
 * These tests ensure NO surface contradicts another for the same entity.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getIncomingRequestForThread,
  getIncomingRequestCounts,
  getThreadConversionState,
  getMessageThreadById,
} from '../../src/lib/messages'
import { addJob, getJobById } from '../../src/lib/jobs'
import { getProjects } from '../../src/lib/projects'
import {
  acceptOfferWorkflow,
  createOfferWorkflow,
} from '../../src/lib/workflow'
import { getOfferById, getOffers } from '../../src/lib/offers'
import { getJobContextForThread } from '../../src/lib/workflow/messageWorkflow'
import { ensurePaymentForJob, getPaymentForJob } from '../../src/lib/payments'
import type { Conversation } from '../../src/lib/messages/types'
import type { Job } from '../../src/lib/jobs/types'

describe('Cross-Surface State Consistency', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  describe('STAGE 1: Inquiry State (no job yet)', () => {
    it('customer thread + craftsman thread + dashboard all show inquiry state consistently', async () => {
      // Create inquiry conversation
      const threadId = 'conv-inquiry-001'
      const conversation: Conversation = {
        id: threadId,
        projectId: 'project-inquiry-001',
        customerName: 'Max Mustermann',
        customerAvatarUrl: '',
        customerUserId: 'customer-123',
        craftsmanName: 'Hans Handwerker',
        craftsmanHandle: 'hans-handwerker',
        craftsmanAvatarUrl: '',
        craftsmanUserId: 'craftsman-456',
        projectTitle: 'Badezimmer Renovation',
        projectSubtitle: 'Neue Anfrage',
        projectLocation: 'Munich',
        projectCostRange: '€5,000-10,000',
        projectDuration: '2 Wochen',
        projectStatusLabel: 'Anfrage läuft',
        timeLabel: 'Vor 5 Minuten',
        unreadCount: 1,
        inquiryOrigin: 'reel',
        messages: [
          {
            id: 'msg-001',
            sender: 'user',
            text: 'Hallo, ich brauche Hilfe mit meinem Badezimmer.',
            sentAt: Date.now() - 300000,
            createdAtLabel: 'Vor 5 Min',
          },
        ],
      }
      await addConversation(conversation)

      // VERIFY: Customer thread state
      const customerThread = getMessageThreadById(threadId)
      expect(customerThread).toBeDefined()
      expect(customerThread?.project.statusLabel).toBe('Anfrage läuft')

      // VERIFY: Craftsman thread state — should show as incoming request
      const craftsmanIncomingRequest = getIncomingRequestForThread(threadId)
      expect(craftsmanIncomingRequest).not.toBeNull()
      expect(craftsmanIncomingRequest?.inquiryOrigin).toBe('reel')
      expect(craftsmanIncomingRequest?.status).toBe('new_unread')

      // VERIFY: Thread conversion state — should be 'inquiry'
      const conversionState = getThreadConversionState(threadId)
      expect(conversionState).toBe('inquiry')

      // VERIFY: Job context — should NOT exist
      const jobContext = getJobContextForThread(threadId)
      expect(jobContext).toBeNull()

      // VERIFY: Dashboard incoming request count — should include this thread
      const requestCounts = getIncomingRequestCounts()
      expect(requestCounts.total).toBe(1)
      expect(requestCounts.unread).toBe(1)
    })
  })

  describe('STAGE 2: Offer Sent State', () => {
    it('customer thread + craftsman thread + dashboard show offer consistently', async () => {
      // Create conversation + offer
      const threadId = 'conv-offer-001'
      const conversation: Conversation = {
        id: threadId,
        projectId: 'project-offer-001',
        customerName: 'Max Mustermann',
        customerAvatarUrl: '',
        customerUserId: 'customer-123',
        craftsmanName: 'Hans Handwerker',
        craftsmanHandle: 'hans-handwerker',
        craftsmanAvatarUrl: '',
        craftsmanUserId: 'craftsman-456',
        projectTitle: 'Badezimmer Renovation',
        projectSubtitle: 'Angebot erhalten',
        projectStatusLabel: 'Angebot läuft',
        timeLabel: 'Vor 10 Minuten',
        unreadCount: 0,
        inquiryOrigin: 'reel',
        messages: [],
      }
      await addConversation(conversation)

      // Craftsman creates offer
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '€8,500',
        description: 'Badezimmer Komplettrenovierung',
      })

      const allOffers = getOffers()
      const offer = allOffers.length > 0 ? allOffers[0] : undefined
      expect(offer).toBeDefined()
      expect(offer?.status).toBe('pending')

      // VERIFY: Thread still shows as inquiry (no job created yet)
      const conversionState = getThreadConversionState(threadId)
      expect(conversionState).toBe('inquiry')

      // VERIFY: Incoming request should still exist (offer sent, not accepted)
      const incomingRequest = getIncomingRequestForThread(threadId)
      expect(incomingRequest).not.toBeNull()

      // VERIFY: Job context should NOT exist (offer not accepted yet)
      const jobContext = getJobContextForThread(threadId)
      expect(jobContext).toBeNull()
    })
  })

  describe('STAGE 3: Offer Accepted → Deposit Required', () => {
    it('all surfaces show deposit_required state consistently after offer acceptance', async () => {
      // Setup: Create conversation + offer
      const threadId = 'conv-accepted-001'
      const conversation: Conversation = {
        id: threadId,
        projectId: 'project-accepted-001',
        customerName: 'Max Mustermann',
        customerAvatarUrl: '',
        customerUserId: 'customer-123',
        craftsmanName: 'Hans Handwerker',
        craftsmanHandle: 'hans-handwerker',
        craftsmanAvatarUrl: '',
        craftsmanUserId: 'craftsman-456',
        projectTitle: 'Badezimmer Renovation',
        projectSubtitle: 'Angebot angenommen',
        projectStatusLabel: 'Zahlung ausstehend',
        timeLabel: 'Vor 15 Minuten',
        unreadCount: 0,
        inquiryOrigin: 'reel',
        messages: [],
      }
      await addConversation(conversation)

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '€8,500',
      })

      // Customer accepts offer
      await acceptOfferWorkflow(offer.id)

      const acceptedOffer = getOfferById(offer.id)!
      expect(acceptedOffer.status).toBe('accepted')
      expect(acceptedOffer.createdJobId).toBeDefined()

      const job = getJobById(acceptedOffer.createdJobId!)!
      expect(job).toBeDefined()
      expect(job.sourceConversationId).toBe(threadId)
      expect(job.proposalAcceptedAt).toBeDefined()

      // VERIFY: Thread conversion state — should now be 'project' (job exists)
      const conversionState = getThreadConversionState(threadId)
      expect(conversionState).toBe('project')

      // VERIFY: Incoming request — should NO LONGER exist (job linked via sourceConversationId)
      const incomingRequest = getIncomingRequestForThread(threadId)
      expect(incomingRequest).toBeNull()

      // VERIFY: Dashboard incoming count — should NOT include this thread anymore
      const requestCounts = getIncomingRequestCounts()
      expect(requestCounts.total).toBe(0)

      // VERIFY: Job context — should exist with deposit_required payment state
      const jobContext = getJobContextForThread(threadId)
      expect(jobContext).not.toBeNull()
      expect(jobContext?.jobId).toBe(job.id)
      expect(jobContext?.paymentState).toBe('deposit_required')

      // VERIFY: Payment entity — should have deposit_required state
      const payment = getPaymentForJob(job.id)
      expect(payment).toBeDefined()
      expect(payment?.state).toBe('deposit_required')

      // VERIFY: Project entity — should be linked to job
      const allProjects = getProjects()
      const linkedProject = allProjects.find((p) => p.sourceJobId === job.id)
      expect(linkedProject).toBeDefined()
      expect(linkedProject?.paymentState).toBe('deposit_required')
    })
  })

  describe('STAGE 4: sourceConversationId vs projectId Resolution', () => {
    it('incoming request detection uses BOTH sourceConversationId AND projectId checks', async () => {
      // Scenario: Job created with sourceConversationId but different projectId
      const threadId = 'conv-dual-path-001'
      const syntheticProjectId = 'project-synthetic-001'

      const conversation: Conversation = {
        id: threadId,
        projectId: syntheticProjectId,
        customerName: 'Max Mustermann',
        customerAvatarUrl: '',
        customerUserId: 'customer-123',
        craftsmanName: 'Hans Handwerker',
        craftsmanHandle: 'hans-handwerker',
        craftsmanAvatarUrl: '',
        craftsmanUserId: 'craftsman-456',
        projectTitle: 'Test Project',
        projectSubtitle: 'Dual path test',
        projectStatusLabel: 'Anfrage läuft',
        timeLabel: 'Jetzt',
        unreadCount: 0,
        inquiryOrigin: 'profile',
        messages: [],
      }
      await addConversation(conversation)

      // Job created with sourceConversationId set (new path)
      const job: Job = {
        id: 'job-dual-path-001',
        projectId: 'project-different-id', // Different from conversation.projectId!
        sourceConversationId: threadId, // But sourceConversationId matches
        title: 'Test Job',
        customer: 'Max Mustermann',
        location: 'Munich',
        dateLabel: 'Heute',
        status: 'new',
        amount: '€5,000',
        description: '',
        paymentState: 'deposit_required',
        documentationStatus: 'Keine Dokumentation',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
      }
      await addJob(job)

      // VERIFY: Incoming request should NOT exist (linked via sourceConversationId)
      const incomingRequest = getIncomingRequestForThread(threadId)
      expect(incomingRequest).toBeNull()

      // VERIFY: Thread conversion state should be 'project' (via sourceConversationId)
      const conversionState = getThreadConversionState(threadId)
      expect(conversionState).toBe('project')

      // VERIFY: Job context should exist (via sourceConversationId lookup)
      const jobContext = getJobContextForThread(threadId)
      expect(jobContext).not.toBeNull()
      expect(jobContext?.jobId).toBe(job.id)
    })

    it('legacy jobs without sourceConversationId still work via projectId fallback', async () => {
      // Scenario: Old job created before sourceConversationId was added
      const threadId = 'conv-legacy-001'
      const projectId = 'project-legacy-001'

      const conversation: Conversation = {
        id: threadId,
        projectId,
        customerName: 'Max Mustermann',
        customerAvatarUrl: '',
        customerUserId: 'customer-123',
        craftsmanName: 'Hans Handwerker',
        craftsmanHandle: 'hans-handwerker',
        craftsmanAvatarUrl: '',
        craftsmanUserId: 'craftsman-456',
        projectTitle: 'Legacy Project',
        projectSubtitle: 'Legacy test',
        projectStatusLabel: 'Läuft',
        timeLabel: 'Vor 1 Stunde',
        unreadCount: 0,
        inquiryOrigin: 'reel',
        messages: [],
      }
      await addConversation(conversation)

      // Legacy job WITHOUT sourceConversationId
      const legacyJob: Job = {
        id: 'job-legacy-001',
        projectId, // Matches conversation.projectId
        // sourceConversationId: undefined (not set for legacy jobs)
        title: 'Legacy Job',
        customer: 'Max Mustermann',
        location: 'Munich',
        dateLabel: 'Gestern',
        status: 'in_progress',
        amount: '€3,000',
        description: '',
        paymentState: 'work_in_progress',
        documentationStatus: 'In Arbeit',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
      }
      await addJob(legacyJob)

      // VERIFY: Incoming request should NOT exist (linked via projectId fallback)
      const incomingRequest = getIncomingRequestForThread(threadId)
      expect(incomingRequest).toBeNull()

      // VERIFY: Thread conversion state should be 'project' (via projectId fallback)
      const conversionState = getThreadConversionState(threadId)
      expect(conversionState).toBe('project')

      // VERIFY: Job context should exist (via projectId fallback lookup)
      const jobContext = getJobContextForThread(threadId)
      expect(jobContext).not.toBeNull()
      expect(jobContext?.jobId).toBe(legacyJob.id)
    })
  })

  describe('STAGE 5: Dashboard Summary Count Consistency', () => {
    it('dashboard incoming request count matches actual incoming threads', async () => {
      // Create 3 inquiry threads
      for (let i = 1; i <= 3; i++) {
        const threadId = `conv-dashboard-${i}`
        await addConversation({
          id: threadId,
          projectId: `project-dashboard-${i}`,
          customerName: `Customer ${i}`,
          customerAvatarUrl: '',
          customerUserId: `customer-${i}`,
          craftsmanName: 'Hans Handwerker',
          craftsmanHandle: 'hans-handwerker',
          craftsmanAvatarUrl: '',
          craftsmanUserId: 'craftsman-456',
          projectTitle: `Project ${i}`,
          projectSubtitle: 'Anfrage',
          projectStatusLabel: 'Anfrage läuft',
          timeLabel: 'Jetzt',
          unreadCount: i === 1 ? 1 : 0,
          inquiryOrigin: 'reel',
          messages: [],
        })
      }

      // VERIFY: Dashboard shows 3 incoming requests
      let counts = getIncomingRequestCounts()
      expect(counts.total).toBe(3)
      expect(counts.unread).toBe(1)

      // Now convert one inquiry to a job (via sourceConversationId)
      const jobFromConv1: Job = {
        id: 'job-from-conv-1',
        projectId: 'project-new-from-conv-1',
        sourceConversationId: 'conv-dashboard-1', // Links to first conversation
        title: 'Converted Job',
        customer: 'Customer 1',
        location: 'Munich',
        dateLabel: 'Heute',
        status: 'new',
        amount: '€2,000',
        description: '',
        paymentState: 'deposit_required',
        documentationStatus: 'Neu',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        customerUserId: 'customer-1',
        craftsmanUserId: 'craftsman-456',
      }
      await addJob(jobFromConv1)

      // VERIFY: Dashboard now shows 2 incoming requests (one was converted)
      counts = getIncomingRequestCounts()
      expect(counts.total).toBe(2)
      expect(counts.unread).toBe(0) // The unread one was converted

      // VERIFY: The converted thread no longer appears as incoming request
      const incomingRequest1 = getIncomingRequestForThread('conv-dashboard-1')
      expect(incomingRequest1).toBeNull()

      // VERIFY: The other two still appear as incoming
      const incomingRequest2 = getIncomingRequestForThread('conv-dashboard-2')
      const incomingRequest3 = getIncomingRequestForThread('conv-dashboard-3')
      expect(incomingRequest2).not.toBeNull()
      expect(incomingRequest3).not.toBeNull()
    })
  })

  describe('STAGE 6: Thread vs Detail Role Separation', () => {
    it('thread shows compact job context bar, detail screen shows full workflow', async () => {
      // Setup job with full workflow state
      const threadId = 'conv-role-sep-001'
      const jobId = 'job-role-sep-001'

      await addConversation({
        id: threadId,
        projectId: 'project-role-sep-001',
        customerName: 'Max Mustermann',
        customerAvatarUrl: '',
        customerUserId: 'customer-123',
        craftsmanName: 'Hans Handwerker',
        craftsmanHandle: 'hans-handwerker',
        craftsmanAvatarUrl: '',
        craftsmanUserId: 'craftsman-456',
        projectTitle: 'Full Workflow Test',
        projectSubtitle: 'Role separation',
        projectStatusLabel: 'Läuft',
        timeLabel: 'Jetzt',
        unreadCount: 0,
        inquiryOrigin: 'profile',
        messages: [],
      })

      const job: Job = {
        id: jobId,
        projectId: 'project-role-sep-001',
        sourceConversationId: threadId,
        title: 'Full Workflow Job',
        customer: 'Max Mustermann',
        location: 'Munich',
        dateLabel: 'Heute',
        status: 'in_progress',
        amount: '€10,000',
        description: 'Full workflow test job',
        paymentState: 'deposit_required', // Keep as deposit_required for test
        documentationStatus: 'In Arbeit',
        assignedMemberIds: [],
        notes: ['Progress note 1', 'Progress note 2'],
        photoCount: 5,
        activities: [],
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        proposalAcceptedAt: Date.now() - 86400000,
        workCompletedAt: undefined,
      }
      await addJob(job)

      // Ensure payment exists (will default to deposit_required)
      await ensurePaymentForJob(jobId, 10000, {
        projectId: 'project-role-sep-001',
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
      })

      // VERIFY: Thread job context is compact — only shows status + CTA
      const jobContext = getJobContextForThread(threadId)
      expect(jobContext).not.toBeNull()
      expect(jobContext?.jobId).toBe(jobId)
      expect(jobContext?.status).toBe('in_progress')
      expect(jobContext?.paymentState).toBe('deposit_required') // Payment entity state
      // ThreadJobContextBar shows: status pill + payment pill + "Öffnen →" CTA
      // It does NOT show notes, photos, timeline, etc. (those live on detail screen)

      // VERIFY: Job detail screen has full operational data
      const fullJob = getJobById(jobId)
      expect(fullJob).toBeDefined()
      expect(fullJob?.notes.length).toBe(2)
      expect(fullJob?.photoCount).toBe(5)
      expect(fullJob?.status).toBe('in_progress')
      // Detail screen shows: full timeline, notes, photos, execution progress, etc.
    })
  })
})
