/**
 * Block 1 — Hydration Gates: Repository Readiness Semantics Tests
 *
 * Verifies the deterministic readiness contract for critical repositories:
 *
 *   1. All critical repositories expose isHydrated() in their interface
 *   2. InMemory repositories return true immediately (data available at construction)
 *   3. Subscribers re-evaluate after hydration completion
 *   4. "not found" is only valid after the relevant repository has hydrated
 *   5. "empty" messaging is only valid after the relevant repository has hydrated
 *   6. Multi-repository dependencies do not prematurely decide on partial readiness
 *   7. No timeout or collection-size-based fake readiness decisions
 *   8. No regression to the existing quote open-path deterministic loading behavior
 *
 * Sub-block 1.1 additions: Invoice, Notification, Timeline domains.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { InMemoryPaymentRepository } from '../../src/lib/payments/repository/InMemoryPaymentRepository'
import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { InMemoryEscrowPlanRepository } from '../../src/lib/payments/escrow/InMemoryEscrowPlanRepository'
import { InMemoryFundingRequestRepository } from '../../src/lib/payments/fundingRequest/InMemoryFundingRequestRepository'
import { InMemoryOfferRepository } from '../../src/lib/offers/repository/InMemoryOfferRepository'
import { InMemoryProjectRepository } from '../../src/lib/projects/repository/InMemoryProjectRepository'
// Sub-block 1.1
import { InMemoryInvoiceRepository } from '../../src/lib/invoices/repository/InMemoryInvoiceRepository'
import { InMemoryNotificationRepository } from '../../src/lib/notifications/repository/InMemoryNotificationRepository'
import { InMemoryTimelineRepository } from '../../src/lib/timeline/repository/InMemoryTimelineRepository'

import { setPaymentRepository } from '../../src/lib/payments/repository/registry'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { setEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'
import { setFundingRequestRepository } from '../../src/lib/payments/fundingRequest/fundingRequestRegistry'
import { setOfferRepository } from '../../src/lib/offers/repository/registry'
import { setProjectRepository } from '../../src/lib/projects/repository/registry'
// Sub-block 1.1
import { setInvoiceRepository } from '../../src/lib/invoices/repository/registry'
import { setNotificationRepository } from '../../src/lib/notifications/repository/registry'
import { setTimelineRepository } from '../../src/lib/timeline/repository/registry'

import { isPaymentRepositoryHydrated } from '../../src/lib/payments/service'
import { isJobRepositoryHydrated } from '../../src/lib/jobs/service'
import { isMessageRepositoryHydrated } from '../../src/lib/messages/service'
import { isEscrowPlanRepositoryHydrated } from '../../src/lib/payments/escrow/escrowService'
import { isFundingRequestRepositoryHydrated } from '../../src/lib/payments/fundingRequest/fundingRequestService'
import { isOfferRepositoryHydrated } from '../../src/lib/offers/service'
import { isProjectRepositoryHydrated } from '../../src/lib/projects/projectsStore'
// Sub-block 1.1
import { isInvoiceRepositoryHydrated } from '../../src/lib/invoices/invoiceStore'
import { isNotificationRepositoryHydrated } from '../../src/lib/notifications/notificationStore'
import { isTimelineRepositoryHydrated } from '../../src/lib/timeline/timelineStore'

import { areRepositoriesHydrated } from '../../src/lib/shared/repositoryReadiness'
// Sub-block 1.3
import { syncInvoiceWithPayment } from '../../src/lib/invoices/invoiceService'
import type { InvoiceRepository } from '../../src/lib/invoices/repository/InvoiceRepository'

// ── Setup ─────────────────────────────────────────────────────────────────

function setupCleanRepos() {
  setPaymentRepository(new InMemoryPaymentRepository([]))
  setJobRepository(new InMemoryJobRepository([]))
  setMessageRepository(new InMemoryMessageRepository([], []))
  setEscrowPlanRepository(new InMemoryEscrowPlanRepository())
  // Sub-block 1.1
  setInvoiceRepository(new InMemoryInvoiceRepository([]))
  setNotificationRepository(new InMemoryNotificationRepository())
  setTimelineRepository(new InMemoryTimelineRepository())
  setFundingRequestRepository(new InMemoryFundingRequestRepository())
  setOfferRepository(new InMemoryOfferRepository())
  setProjectRepository(new InMemoryProjectRepository([]))
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Block 1 — Repository Readiness Semantics', () => {
  beforeEach(() => {
    setupCleanRepos()
  })

  // ── 1. All critical repositories expose isHydrated() ──────────────────

  describe('1. All critical repositories expose isHydrated()', () => {
    it('PaymentRepository.isHydrated() exists and returns boolean', () => {
      const repo = new InMemoryPaymentRepository([])
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })

    it('JobRepository.isHydrated() exists and returns boolean', () => {
      const repo = new InMemoryJobRepository([])
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })

    it('MessageRepository.isHydrated() exists and returns boolean', () => {
      const repo = new InMemoryMessageRepository([], [])
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })

    it('EscrowPlanRepository.isHydrated() exists and returns boolean', () => {
      const repo = new InMemoryEscrowPlanRepository()
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })

    it('FundingRequestRepository.isHydrated() exists and returns boolean', () => {
      const repo = new InMemoryFundingRequestRepository()
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })

    it('OfferRepository.isHydrated() exists and returns boolean (existing)', () => {
      const repo = new InMemoryOfferRepository()
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })

    it('ProjectRepository.isHydrated() exists and returns boolean', () => {
      const repo = new InMemoryProjectRepository([])
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })

    // Sub-block 1.1
    it('InvoiceRepository.isHydrated() exists and returns boolean', () => {
      const repo = new InMemoryInvoiceRepository([])
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })

    it('NotificationRepository.isHydrated() exists and returns boolean', () => {
      const repo = new InMemoryNotificationRepository()
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })

    it('TimelineRepository.isHydrated() exists and returns boolean', () => {
      const repo = new InMemoryTimelineRepository()
      expect(typeof repo.isHydrated).toBe('function')
      expect(typeof repo.isHydrated()).toBe('boolean')
    })
  })

  // ── 2. InMemory repositories are always hydrated ──────────────────────

  describe('2. InMemory repositories are always hydrated at construction', () => {
    it('InMemoryPaymentRepository.isHydrated() returns true', () => {
      expect(new InMemoryPaymentRepository([]).isHydrated()).toBe(true)
    })

    it('InMemoryJobRepository.isHydrated() returns true', () => {
      expect(new InMemoryJobRepository([]).isHydrated()).toBe(true)
    })

    it('InMemoryMessageRepository.isHydrated() returns true', () => {
      expect(new InMemoryMessageRepository([], []).isHydrated()).toBe(true)
    })

    it('InMemoryEscrowPlanRepository.isHydrated() returns true', () => {
      expect(new InMemoryEscrowPlanRepository().isHydrated()).toBe(true)
    })

    it('InMemoryFundingRequestRepository.isHydrated() returns true', () => {
      expect(new InMemoryFundingRequestRepository().isHydrated()).toBe(true)
    })

    it('InMemoryOfferRepository.isHydrated() returns true (existing)', () => {
      expect(new InMemoryOfferRepository().isHydrated()).toBe(true)
    })

    it('InMemoryProjectRepository.isHydrated() returns true', () => {
      expect(new InMemoryProjectRepository([]).isHydrated()).toBe(true)
    })

    // Sub-block 1.1
    it('InMemoryInvoiceRepository.isHydrated() returns true', () => {
      expect(new InMemoryInvoiceRepository([]).isHydrated()).toBe(true)
    })

    it('InMemoryNotificationRepository.isHydrated() returns true', () => {
      expect(new InMemoryNotificationRepository().isHydrated()).toBe(true)
    })

    it('InMemoryTimelineRepository.isHydrated() returns true', () => {
      expect(new InMemoryTimelineRepository().isHydrated()).toBe(true)
    })
  })

  // ── 3. Service-layer hydration check functions work ───────────────────

  describe('3. Service-layer hydration check functions', () => {
    it('isPaymentRepositoryHydrated() returns true for InMemory', () => {
      expect(isPaymentRepositoryHydrated()).toBe(true)
    })

    it('isJobRepositoryHydrated() returns true for InMemory', () => {
      expect(isJobRepositoryHydrated()).toBe(true)
    })

    it('isMessageRepositoryHydrated() returns true for InMemory', () => {
      expect(isMessageRepositoryHydrated()).toBe(true)
    })

    it('isEscrowPlanRepositoryHydrated() returns true for InMemory', () => {
      expect(isEscrowPlanRepositoryHydrated()).toBe(true)
    })

    it('isFundingRequestRepositoryHydrated() returns true for InMemory', () => {
      expect(isFundingRequestRepositoryHydrated()).toBe(true)
    })

    it('isOfferRepositoryHydrated() returns true for InMemory (existing)', () => {
      expect(isOfferRepositoryHydrated()).toBe(true)
    })

    it('isProjectRepositoryHydrated() returns true for InMemory', () => {
      expect(isProjectRepositoryHydrated()).toBe(true)
    })

    // Sub-block 1.1
    it('isInvoiceRepositoryHydrated() returns true for InMemory', () => {
      expect(isInvoiceRepositoryHydrated()).toBe(true)
    })

    it('isNotificationRepositoryHydrated() returns true for InMemory', () => {
      expect(isNotificationRepositoryHydrated()).toBe(true)
    })

    it('isTimelineRepositoryHydrated() returns true for InMemory', () => {
      expect(isTimelineRepositoryHydrated()).toBe(true)
    })
  })

  // ── 4. "not found" requires hydration ─────────────────────────────────

  describe('4. Deterministic not-found decisions after hydration', () => {
    it('empty PaymentRepository with hydration = "loaded empty", not "not loaded"', () => {
      const repo = new InMemoryPaymentRepository([])
      expect(repo.getAll()).toEqual([])
      expect(repo.isHydrated()).toBe(true)
      // After hydration: empty collection = genuinely no data
      expect(repo.getByJobId('nonexistent')).toBeUndefined()
    })

    it('empty JobRepository with hydration = "loaded empty", not "not loaded"', () => {
      const repo = new InMemoryJobRepository([])
      expect(repo.getAll()).toEqual([])
      expect(repo.isHydrated()).toBe(true)
      expect(repo.getById('nonexistent')).toBeUndefined()
    })

    it('empty MessageRepository with hydration = "loaded empty", not "not loaded"', () => {
      const repo = new InMemoryMessageRepository([], [])
      expect(repo.getConversations()).toEqual([])
      expect(repo.isHydrated()).toBe(true)
      expect(repo.getConversationById('nonexistent')).toBeUndefined()
    })

    it('empty EscrowPlanRepository with hydration = "loaded empty"', () => {
      const repo = new InMemoryEscrowPlanRepository()
      expect(repo.getAllPlans()).toEqual([])
      expect(repo.isHydrated()).toBe(true)
      expect(repo.getPlanByJobId('nonexistent')).toBeUndefined()
    })

    it('empty FundingRequestRepository with hydration = "loaded empty"', () => {
      const repo = new InMemoryFundingRequestRepository()
      expect(repo.getAll()).toEqual([])
      expect(repo.isHydrated()).toBe(true)
      expect(repo.getByJobId('nonexistent')).toBeUndefined()
    })

    it('empty ProjectRepository with hydration = "loaded empty"', () => {
      const repo = new InMemoryProjectRepository([])
      expect(repo.getAll()).toEqual([])
      expect(repo.isHydrated()).toBe(true)
      expect(repo.getById('nonexistent')).toBeUndefined()
    })
  })

  // ── 5. Subscribers re-evaluate after hydration ────────────────────────

  describe('5. Subscribers re-evaluate after hydration completion', () => {
    it('PaymentRepository subscription fires on data change', () => {
      const repo = new InMemoryPaymentRepository([])
      setPaymentRepository(repo)
      let notified = false
      repo.subscribe(() => { notified = true })
      repo.add({
        id: 'pay-1', jobId: 'job-1', state: 'escrow_locked' as never,
        amounts: { totalAmount: 100, depositAmount: 25, finalAmount: 75 },
        createdAt: Date.now(), updatedAt: Date.now(),
      })
      expect(notified).toBe(true)
    })

    it('JobRepository subscription fires on data change', async () => {
      const repo = new InMemoryJobRepository([])
      setJobRepository(repo)
      let notified = false
      repo.subscribe(() => { notified = true })
      await repo.add({
        id: 'j-1', projectId: 'p-1', title: 'Test', customer: 'C',
        location: 'L', dateLabel: 'D', status: 'new', amount: '100',
        description: '', paymentState: 'deposit_required',
        documentationStatus: '', assignedMemberIds: [], notes: [],
        photoCount: 0, activities: [],
      })
      expect(notified).toBe(true)
    })

    it('MessageRepository subscription fires on conversation add', async () => {
      const repo = new InMemoryMessageRepository([], [])
      setMessageRepository(repo)
      let notified = false
      repo.subscribe(() => { notified = true })
      await repo.addConversation({
        id: 'conv-1', projectId: 'proj-1',
        customerName: 'A', customerAvatarUrl: '', craftsmanName: 'B',
        craftsmanHandle: 'b', craftsmanAvatarUrl: '',
        projectTitle: 'T', projectSubtitle: 'S',
        timeLabel: 'now', unreadCount: 0, messages: [],
      } as never)
      expect(notified).toBe(true)
    })
  })

  // ── 6. Multi-repository hydration gating ──────────────────────────────

  describe('6. Multi-repository hydration gating', () => {
    it('areRepositoriesHydrated returns true when all checks pass', () => {
      expect(areRepositoriesHydrated([
        isJobRepositoryHydrated,
        isPaymentRepositoryHydrated,
        isEscrowPlanRepositoryHydrated,
      ])).toBe(true)
    })

    it('areRepositoriesHydrated returns false when any check fails', () => {
      expect(areRepositoriesHydrated([
        isJobRepositoryHydrated,
        () => false, // Simulate a non-hydrated repo
        isEscrowPlanRepositoryHydrated,
      ])).toBe(false)
    })

    it('areRepositoriesHydrated returns true for empty array', () => {
      expect(areRepositoriesHydrated([])).toBe(true)
    })

    it('project + job multi-gate works for CustomerProjectDetailScreen pattern', () => {
      expect(areRepositoriesHydrated([
        isProjectRepositoryHydrated,
        isJobRepositoryHydrated,
      ])).toBe(true)
    })

    it('project + message multi-gate works for CraftsmanRequestDetailScreen pattern', () => {
      expect(areRepositoriesHydrated([
        isProjectRepositoryHydrated,
        isMessageRepositoryHydrated,
      ])).toBe(true)
    })

    it('job + funding + escrow multi-gate works for funding screens', () => {
      expect(areRepositoriesHydrated([
        isJobRepositoryHydrated,
        isFundingRequestRepositoryHydrated,
        isEscrowPlanRepositoryHydrated,
      ])).toBe(true)
    })
  })

  // ── Sub-block 1.2: Invoice write contract is async ────────────────────

  describe('Sub-block 1.2: InvoiceRepository write methods return Promise<void>', () => {
    it('InMemoryInvoiceRepository.add() returns a Promise', () => {
      const repo = new InMemoryInvoiceRepository([])
      const result = repo.add({
        id: 'inv-1', jobId: 'job-1', invoiceNumber: 'INV-001',
        status: 'draft' as never,
        parties: {} as never, lineItems: [], amounts: {} as never,
        issuedAtLabel: '', dueAtLabel: '',
        createdAt: Date.now(), updatedAt: Date.now(),
      })
      expect(result).toBeInstanceOf(Promise)
    })

    it('InMemoryInvoiceRepository.update() returns a Promise', () => {
      const invoice = {
        id: 'inv-2', jobId: 'job-2', invoiceNumber: 'INV-002',
        status: 'draft' as never,
        parties: {} as never, lineItems: [], amounts: {} as never,
        issuedAtLabel: '', dueAtLabel: '',
        createdAt: Date.now(), updatedAt: Date.now(),
      }
      const repo = new InMemoryInvoiceRepository([invoice])
      const result = repo.update('inv-2', (inv) => inv)
      expect(result).toBeInstanceOf(Promise)
    })

    it('InMemoryInvoiceRepository.add() is awaitable and mutates state', async () => {
      const repo = new InMemoryInvoiceRepository([])
      const invoice = {
        id: 'inv-3', jobId: 'job-3', invoiceNumber: 'INV-003',
        status: 'draft' as never,
        parties: {} as never, lineItems: [], amounts: {} as never,
        issuedAtLabel: '', dueAtLabel: '',
        createdAt: Date.now(), updatedAt: Date.now(),
      }
      await repo.add(invoice)
      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getByJobId('job-3')).toBeDefined()
    })

    it('InMemoryInvoiceRepository.update() is awaitable and mutates state', async () => {
      const invoice = {
        id: 'inv-4', jobId: 'job-4', invoiceNumber: 'INV-004',
        status: 'draft' as never,
        parties: {} as never, lineItems: [], amounts: {} as never,
        issuedAtLabel: '', dueAtLabel: '',
        createdAt: Date.now(), updatedAt: Date.now(),
      }
      const repo = new InMemoryInvoiceRepository([invoice])
      await repo.update('inv-4', (inv) => ({ ...inv, invoiceNumber: 'INV-004-UPDATED' }))
      expect(repo.getByJobId('job-4')?.invoiceNumber).toBe('INV-004-UPDATED')
    })

    it('InMemoryInvoiceRepository.add() is idempotent (duplicate id ignored)', async () => {
      const invoice = {
        id: 'inv-5', jobId: 'job-5', invoiceNumber: 'INV-005',
        status: 'draft' as never,
        parties: {} as never, lineItems: [], amounts: {} as never,
        issuedAtLabel: '', dueAtLabel: '',
        createdAt: Date.now(), updatedAt: Date.now(),
      }
      const repo = new InMemoryInvoiceRepository([invoice])
      await repo.add(invoice)
      expect(repo.getAll()).toHaveLength(1)
    })
  })

  // ── Sub-block 1.3: syncInvoiceWithPayment hydration guard ────────────

  describe('Sub-block 1.3: syncInvoiceWithPayment hydration guard', () => {
    it('does not call update when invoice repository is not hydrated', async () => {
      let updateCalled = false
      const unhydratedRepo: InvoiceRepository = {
        initialize: async () => {},
        isHydrated: () => false,
        getAll: () => [],
        getByJobId: () => undefined,
        add: async () => {},
        update: async () => { updateCalled = true },
        subscribe: () => () => {},
        notify: () => {},
      }
      setInvoiceRepository(unhydratedRepo)

      await syncInvoiceWithPayment('any-job-id')

      expect(updateCalled).toBe(false)
    })

    it('is a no-op (no error) when hydrated but invoice does not exist', async () => {
      setInvoiceRepository(new InMemoryInvoiceRepository([]))
      await expect(syncInvoiceWithPayment('no-such-job')).resolves.toBeUndefined()
    })

    it('is a no-op (no error) when hydrated but payment does not exist', async () => {
      const invoice = {
        id: 'inv-sync-1', jobId: 'job-sync-1', invoiceNumber: 'INV-S001',
        status: 'draft' as never,
        parties: {} as never, lineItems: [], amounts: {} as never,
        issuedAtLabel: '', dueAtLabel: '',
        createdAt: Date.now(), updatedAt: Date.now(),
      }
      setInvoiceRepository(new InMemoryInvoiceRepository([invoice]))
      // No payment registered for job-sync-1 → no-op
      await expect(syncInvoiceWithPayment('job-sync-1')).resolves.toBeUndefined()
    })
  })

  // ── 7. No regression to existing quote open-path ──────────────────────

  describe('7. No regression to existing quote open-path readiness', () => {
    it('OfferRepository isHydrated still works as before', () => {
      const repo = new InMemoryOfferRepository()
      expect(repo.isHydrated()).toBe(true)
      expect(isOfferRepositoryHydrated()).toBe(true)
    })

    it('OfferRepository isHydrated is true even with empty data', () => {
      const repo = new InMemoryOfferRepository([])
      setOfferRepository(repo)
      expect(repo.isHydrated()).toBe(true)
      expect(repo.getAll()).toEqual([])
    })
  })
})
