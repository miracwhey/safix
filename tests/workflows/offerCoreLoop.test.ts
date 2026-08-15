import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  declineOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { getOfferRepository } from '../../src/lib/offers/repository/registry'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { updateOffer } from '../../src/lib/offers/service'
import type { Offer } from '../../src/lib/offers/types'

describe('Offer Core Loop — Conversation → Offer → Job', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // -----------------------------------------------------------------------
  // OFFER CREATION
  // -----------------------------------------------------------------------

  describe('offer creation from thread', () => {
    it('creates a structured offer with required price', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.500 €',
      })

      expect(offer).toBeDefined()
      expect(offer.price).toBe('1.500 €')
      expect(offer.status).toBe('pending')
      expect(offer.conversationId).toBe('conv-1')
      expect(offer.customerUserId).toBe('cust-1')
      expect(offer.craftsmanUserId).toBe('craft-1')
      expect(offer.sentAt).toBe(offer.createdAt)
    })

    it('generates a UUID-compatible offer ID', async () => {
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const offer = await createOfferWorkflow({
        conversationId: 'conv-uuid-check',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '100 €',
      })

      expect(offer.id).toMatch(UUID_REGEX)
    })

    it('stores optional description and timing note', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-2',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '800 €',
        description: 'Badezimmer renovieren',
        timingNote: 'Verfügbar ab nächste Woche',
      })

      expect(offer.description).toBe('Badezimmer renovieren')
      expect(offer.timingNote).toBe('Verfügbar ab nächste Woche')
    })

    it('persists the offer in the repository', async () => {
      await createOfferWorkflow({
        conversationId: 'conv-3',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '2.000 €',
      })

      const offers = getOfferRepository().getByConversationId('conv-3')
      expect(offers).toHaveLength(1)
      expect(offers[0].price).toBe('2.000 €')
      expect(offers[0].sentAt).toBeDefined()
    })
  })
  // -----------------------------------------------------------------------
  // CANONICAL SENT TIMESTAMP
  // -----------------------------------------------------------------------

  describe('canonical sent timestamp', () => {
    it('stamps sentAt on the offer and linked job once on send', async () => {
      // Pre-create job to ensure send propagates
      const jobRepo = getJobRepository()
      jobRepo.add({
        id: 'job-sent-1',
        projectId: 'project-sent-1',
        title: 'Test',
        customer: '',
        location: '',
        dateLabel: 'Termin offen',
        status: 'new',
        amount: '1 €',
        description: '',
        paymentState: 'deposit_required',
        documentationStatus: 'Noch keine Dokumentation',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        craftsmanUserId: 'craft-1',
        customerUserId: 'cust-1',
        sourceConversationId: 'conv-sent-1',
      })

      const offer = await createOfferWorkflow({
        conversationId: 'conv-sent-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '99 €',
      })

      const job = jobRepo.getById('job-sent-1')
      expect(offer.sentAt).toBeDefined()
      expect(job?.proposalSentAt).toBe(offer.sentAt)
    })
  })

  // -----------------------------------------------------------------------
  // OFFER PERSISTS ACROSS RELOAD (simulated via repository read)
  // -----------------------------------------------------------------------

  describe('offer persists across reload', () => {
    it('offer is retrievable after creation (simulates reload)', async () => {
      const created = await createOfferWorkflow({
        conversationId: 'conv-4',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '500 €',
      })

      // Simulate reload: read from repository
      const fromRepo = getOfferRepository().getById(created.id)
      expect(fromRepo).toBeDefined()
      expect(fromRepo!.price).toBe('500 €')
      expect(fromRepo!.status).toBe('pending')
    })
  })

  // -----------------------------------------------------------------------
  // BOTH USERS SEE SAME STATE
  // -----------------------------------------------------------------------

  describe('both users see same offer state', () => {
    it('craftsman and customer see the same offer', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-5',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.200 €',
      })

      // Both would query by conversation — same result
      const byConversation = getOfferRepository().getByConversationId('conv-5')
      expect(byConversation).toHaveLength(1)
      expect(byConversation[0].id).toBe(offer.id)
      expect(byConversation[0].status).toBe('pending')
    })

    it('after acceptance, both see accepted status', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-6',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '900 €',
      })

      await acceptOfferWorkflow(offer.id)

      const fromRepo = getOfferRepository().getById(offer.id)
      expect(fromRepo!.status).toBe('accepted')
    })
  })

  // -----------------------------------------------------------------------
  // ACCEPTANCE CREATES EXACTLY ONE JOB
  // -----------------------------------------------------------------------

  describe('acceptance creates exactly one job', () => {
    it('creates a new job on acceptance', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-7',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '3.000 €',
        description: 'Dach reparieren',
      })

      const accepted = await acceptOfferWorkflow(offer.id)

      expect(accepted).toBeDefined()
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.createdJobId).toBeDefined()
      expect(accepted!.acceptedAt).toBeDefined()

      // Verify job exists
      const job = getJobRepository().getById(accepted!.createdJobId!)
      expect(job).toBeDefined()
      expect(job!.amount).toBe('3.000 €')
      expect(job!.description).toBe('Dach reparieren')
      expect(job!.craftsmanUserId).toBe('craft-1')
      expect(job!.customerUserId).toBe('cust-1')
      expect(job!.sourceConversationId).toBe('conv-7')
    })

    it('job has new status and deposit_required payment state', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-8',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      const job = getJobRepository().getById(accepted!.createdJobId!)
      expect(job!.status).toBe('booked')
      expect(job!.paymentState).toBe('deposit_required')
    })

    it('acceptance writes acceptance timestamp without mutating sent timestamp', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-8b',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      const sentAtBefore = offer.sentAt
      const accepted = await acceptOfferWorkflow(offer.id)
      const job = getJobRepository().getById(accepted!.createdJobId!)

      expect(job!.proposalSentAt).toBe(sentAtBefore)
      expect(job!.proposalAcceptedAt).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // DUPLICATE ACCEPTANCE PREVENTED
  // -----------------------------------------------------------------------

  describe('duplicate acceptance prevented', () => {
    it('re-accepting returns the same offer without creating a second job', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-9',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '750 €',
      })

      const first = await acceptOfferWorkflow(offer.id)
      const second = await acceptOfferWorkflow(offer.id)

      expect(second!.id).toBe(first!.id)
      expect(second!.createdJobId).toBe(first!.createdJobId)

      // Only one job created
      const allJobs = getJobRepository().getAll()
      expect(allJobs).toHaveLength(1)
    })

    it('syncs proposalSentAt from offer when job lacks it and accepts successfully', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-9b',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '750 €',
      })

      // Simulate a pre-linked job without proposalSentAt (e.g. created
      // via inquiry conversion before the offer was sent).
      const jobId = 'job-unsent-9b'
      getJobRepository().add({
        id: jobId,
        projectId: 'project-9b',
        title: 'Job ohne Send',
        customer: '',
        location: '',
        dateLabel: 'Termin offen',
        status: 'new',
        amount: '750 €',
        description: '',
        paymentState: 'deposit_required',
        documentationStatus: 'Noch keine Dokumentation',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        craftsmanUserId: 'craft-1',
        customerUserId: 'cust-1',
        sourceConversationId: 'conv-9b',
        proposalSentAt: undefined,
        proposalAcceptedAt: undefined,
      })
      await updateOffer(offer.id, (o) => ({ ...o, createdJobId: jobId }))

      // The offer has sentAt, so acceptance should sync the timestamp
      // to the job and succeed — not throw.
      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted).toBeDefined()
      expect(accepted!.status).toBe('accepted')

      // Verify proposalSentAt was synced to the job
      const job = getJobRepository().getById(jobId)
      expect(job!.proposalSentAt).toBe(offer.sentAt)
    })
  })

  // -----------------------------------------------------------------------
  // DUPLICATE ACTIVE OFFERS BLOCKED
  // -----------------------------------------------------------------------

  describe('duplicate active offers blocked', () => {
    it('throws when creating a second pending offer for the same conversation', async () => {
      await createOfferWorkflow({
        conversationId: 'conv-10',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '500 €',
      })

      await expect(
        createOfferWorkflow({
          conversationId: 'conv-10',
          customerUserId: 'cust-1',
          craftsmanUserId: 'craft-1',
          price: '600 €',
        })
      ).rejects.toThrow(/Active offer already exists/)
    })

    it('allows new offer after previous one was declined', async () => {
      const first = await createOfferWorkflow({
        conversationId: 'conv-11',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '500 €',
      })

      await declineOfferWorkflow(first.id)

      // New offer should now be possible
      const second = await createOfferWorkflow({
        conversationId: 'conv-11',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '450 €',
      })

      expect(second).toBeDefined()
      expect(second.price).toBe('450 €')
    })
  })

  // -----------------------------------------------------------------------
  // DECLINE BLOCKS ACCEPTANCE
  // -----------------------------------------------------------------------

  describe('decline blocks acceptance unless new offer created', () => {
    it('declining an offer prevents subsequent acceptance', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-12',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      await declineOfferWorkflow(offer.id)

      // Trying to accept a declined offer throws a clear error
      await expect(acceptOfferWorkflow(offer.id)).rejects.toThrow(/declined/)
      // Declined before acceptance — no job should be created
      const jobs = getJobRepository().getAll()
      expect(jobs).toHaveLength(0)
    })

    it('a new offer can be accepted after the previous was declined', async () => {
      const first = await createOfferWorkflow({
        conversationId: 'conv-13',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      await declineOfferWorkflow(first.id)

      const second = await createOfferWorkflow({
        conversationId: 'conv-13',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '900 €',
      })

      const accepted = await acceptOfferWorkflow(second.id)
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.createdJobId).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // JOB CORRECTLY LINKED TO CONVERSATION
  // -----------------------------------------------------------------------

  describe('job correctly linked to conversation', () => {
    it('job.sourceConversationId matches the offer conversationId', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-14',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '2.500 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      const job = getJobRepository().getById(accepted!.createdJobId!)

      expect(job!.sourceConversationId).toBe('conv-14')
    })

    it('offer.createdJobId links back to the created job', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-15',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '600 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)

      const job = getJobRepository().getById(accepted!.createdJobId!)
      expect(job).toBeDefined()
      expect(job!.id).toBe(accepted!.createdJobId)
    })
  })

  // -----------------------------------------------------------------------
  // ACCEPT FAILS IF PERSISTENCE FAILS
  // -----------------------------------------------------------------------

  describe('accept fails if persistence fails', () => {
    it('returns undefined for non-existent offer', async () => {
      const result = await acceptOfferWorkflow('non-existent')
      expect(result).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // DECLINE WORKFLOW
  // -----------------------------------------------------------------------

  describe('decline workflow', () => {
    it('sets status to declined with timestamp', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-16',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '300 €',
      })

      const declined = await declineOfferWorkflow(offer.id)

      expect(declined!.status).toBe('declined')
      expect(declined!.declinedAt).toBeDefined()
    })

    it('is idempotent — re-declining returns same result', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-17',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '400 €',
      })

      const first = await declineOfferWorkflow(offer.id)
      const second = await declineOfferWorkflow(offer.id)

      expect(second!.status).toBe('declined')
      expect(second!.declinedAt).toBe(first!.declinedAt)
    })

    it('returns undefined for non-existent offer', async () => {
      const result = await declineOfferWorkflow('non-existent')
      expect(result).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // STATUS VISIBLE IN THREAD (via repository queries)
  // -----------------------------------------------------------------------

  describe('status visible in thread', () => {
    it('pending offer is visible via getByConversationId', async () => {
      await createOfferWorkflow({
        conversationId: 'conv-18',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      const offers = getOfferRepository().getByConversationId('conv-18')
      expect(offers).toHaveLength(1)
      expect(offers[0].status).toBe('pending')
    })

    it('accepted offer shows accepted status and linked job', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-19',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      const offers = getOfferRepository().getByConversationId('conv-19')
      expect(offers).toHaveLength(1)
      expect(offers[0].status).toBe('accepted')
      expect(offers[0].createdJobId).toBeDefined()
    })

    it('conversation with declined and new offer shows both', async () => {
      const first = await createOfferWorkflow({
        conversationId: 'conv-20',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      await declineOfferWorkflow(first.id)

      await createOfferWorkflow({
        conversationId: 'conv-20',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '900 €',
      })

      const offers = getOfferRepository().getByConversationId('conv-20')
      expect(offers).toHaveLength(2)
      expect(offers.filter((o: Offer) => o.status === 'declined')).toHaveLength(1)
      expect(offers.filter((o: Offer) => o.status === 'pending')).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // EDGE CASES
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('cannot accept an already accepted offer from a different conversation', async () => {
      // Ensure two offers in different conversations are independent
      const offer1 = await createOfferWorkflow({
        conversationId: 'conv-21',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '500 €',
      })

      const offer2 = await createOfferWorkflow({
        conversationId: 'conv-22',
        customerUserId: 'cust-2',
        craftsmanUserId: 'craft-1',
        price: '700 €',
      })

      await acceptOfferWorkflow(offer1.id)
      await acceptOfferWorkflow(offer2.id)

      // Both should have their own jobs
      const allJobs = getJobRepository().getAll()
      expect(allJobs).toHaveLength(2)
    })

    it('cannot decline an already accepted offer', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-23',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.200 €',
      })

      await acceptOfferWorkflow(offer.id)

      // Should throw — declining an accepted offer is an invalid transition
      await expect(declineOfferWorkflow(offer.id)).rejects.toThrow(/accepted/)
    })

    it('allows offer for different conversations by same users', async () => {
      await createOfferWorkflow({
        conversationId: 'conv-24a',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '500 €',
      })

      const second = await createOfferWorkflow({
        conversationId: 'conv-24b',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '700 €',
      })

      expect(second).toBeDefined()
      expect(second.conversationId).toBe('conv-24b')
    })
  })
})
