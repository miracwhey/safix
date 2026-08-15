/**
 * In-app notifications tests.
 *
 * Covers:
 * - InMemoryInAppNotificationRepository CRUD and subscription lifecycle
 * - inAppNotificationService facade functions
 * - ratingWorkflow notification hook (creates notification for provider)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  InMemoryInAppNotificationRepository,
} from '../../src/lib/inAppNotifications/repository/InMemoryInAppNotificationRepository'
import {
  setInAppNotificationRepository,
  getInAppNotificationRepository,
} from '../../src/lib/inAppNotifications/repository/registry'
import {
  createInAppNotification,
  markInAppNotificationRead,
  markAllInAppNotificationsRead,
} from '../../src/lib/inAppNotifications/inAppNotificationService'
import type { InAppNotification } from '../../src/lib/inAppNotifications/types'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { submitRatingWorkflow } from '../../src/lib/workflow/ratingWorkflow'
import type { Job } from '../../src/lib/jobs/types'
import type { RatingSubmission } from '../../src/lib/ratings/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotification(overrides: Partial<InAppNotification> = {}): InAppNotification {
  return {
    id: 'notif-1',
    userId: 'user-a',
    type: 'job_completed',
    entityType: 'job',
    entityId: 'job-1',
    title: 'Arbeit abgeschlossen',
    message: 'Test-Nachricht',
    isRead: false,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Auftrag ${id}`,
    customer: 'Test Kunde',
    location: 'Test Ort',
    dateLabel: 'Heute',
    status: 'completed',
    amount: '500 €',
    description: 'Test Beschreibung',
    paymentState: 'released',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'user-customer',
    craftsmanUserId: 'user-craftsman',
    ...overrides,
  }
  getJobRepository().add(job)
  return job
}

// ---------------------------------------------------------------------------
// InMemoryInAppNotificationRepository
// ---------------------------------------------------------------------------

describe('InMemoryInAppNotificationRepository', () => {
  let repo: InMemoryInAppNotificationRepository

  beforeEach(async () => {
    repo = new InMemoryInAppNotificationRepository()
    await repo.initialize('user-a')
  })

  it('create() adds a notification', () => {
    const n = makeNotification()
    repo.create(n)
    expect(repo.getAll()).toHaveLength(1)
    expect(repo.getAll()[0].id).toBe('notif-1')
  })

  it('create() is idempotent (no duplicates)', () => {
    const n = makeNotification()
    repo.create(n)
    repo.create(n)
    expect(repo.getAll()).toHaveLength(1)
  })

  it('getAll() returns notifications sorted descending by createdAt', () => {
    repo.create(makeNotification({ id: 'a', createdAt: 1000 }))
    repo.create(makeNotification({ id: 'b', createdAt: 3000 }))
    repo.create(makeNotification({ id: 'c', createdAt: 2000 }))
    const all = repo.getAll()
    expect(all[0].id).toBe('b')
    expect(all[1].id).toBe('c')
    expect(all[2].id).toBe('a')
  })

  it('getUnread() returns only unread notifications', () => {
    repo.create(makeNotification({ id: 'a', isRead: false }))
    repo.create(makeNotification({ id: 'b', isRead: true }))
    const unread = repo.getUnread()
    expect(unread).toHaveLength(1)
    expect(unread[0].id).toBe('a')
  })

  it('getUnreadCount() returns correct count', () => {
    repo.create(makeNotification({ id: 'a', isRead: false }))
    repo.create(makeNotification({ id: 'b', isRead: true }))
    repo.create(makeNotification({ id: 'c', isRead: false }))
    expect(repo.getUnreadCount()).toBe(2)
  })

  it('markRead() marks a single notification as read', () => {
    repo.create(makeNotification({ id: 'a', isRead: false }))
    repo.create(makeNotification({ id: 'b', isRead: false }))
    repo.markRead('a')
    expect(repo.getAll().find((n) => n.id === 'a')?.isRead).toBe(true)
    expect(repo.getAll().find((n) => n.id === 'b')?.isRead).toBe(false)
  })

  it('markAllRead() marks all notifications as read', () => {
    repo.create(makeNotification({ id: 'a', isRead: false }))
    repo.create(makeNotification({ id: 'b', isRead: false }))
    repo.markAllRead('user-a')
    expect(repo.getUnreadCount()).toBe(0)
  })

  it('markAllRead() is a no-op when nothing is unread', () => {
    repo.create(makeNotification({ id: 'a', isRead: true }))
    const listener = vi.fn()
    repo.subscribe(listener)
    repo.markAllRead('user-a')
    // listener should not be called because nothing changed
    expect(listener).not.toHaveBeenCalled()
  })

  it('hasNotification() returns true for existing, false for missing', () => {
    repo.create(makeNotification({ id: 'a' }))
    expect(repo.hasNotification('a')).toBe(true)
    expect(repo.hasNotification('z')).toBe(false)
  })

  it('subscribe() / notify() lifecycle fires listener on create', () => {
    const listener = vi.fn()
    const unsubscribe = repo.subscribe(listener)
    repo.create(makeNotification())
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    repo.create(makeNotification({ id: 'second' }))
    // Listener should not be called after unsubscribe
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('subscribe() fires listener on markRead', () => {
    repo.create(makeNotification({ id: 'a', isRead: false }))
    const listener = vi.fn()
    repo.subscribe(listener)
    repo.markRead('a')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// inAppNotificationService
// ---------------------------------------------------------------------------

describe('inAppNotificationService', () => {
  let repo: InMemoryInAppNotificationRepository

  beforeEach(async () => {
    repo = new InMemoryInAppNotificationRepository()
    await repo.initialize('user-a')
    setInAppNotificationRepository(repo)
  })

  it('createInAppNotification() persists via repository', () => {
    const n = makeNotification()
    createInAppNotification(n)
    expect(getInAppNotificationRepository().getAll()).toHaveLength(1)
  })

  it('markInAppNotificationRead() marks as read via repository', () => {
    const n = makeNotification({ id: 'notif-x', isRead: false })
    createInAppNotification(n)
    markInAppNotificationRead('notif-x')
    expect(
      getInAppNotificationRepository().getAll().find((x) => x.id === 'notif-x')?.isRead,
    ).toBe(true)
  })

  it('markAllInAppNotificationsRead() marks all as read via repository', () => {
    createInAppNotification(makeNotification({ id: 'a', isRead: false }))
    createInAppNotification(makeNotification({ id: 'b', isRead: false }))
    markAllInAppNotificationsRead('user-a')
    expect(getInAppNotificationRepository().getUnreadCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ratingWorkflow notification hook
// ---------------------------------------------------------------------------

describe('submitRatingWorkflow — notification hook', () => {
  let inAppRepo: InMemoryInAppNotificationRepository

  beforeEach(async () => {
    setupCleanRepositories()
    inAppRepo = new InMemoryInAppNotificationRepository()
    await inAppRepo.initialize('user-provider')
    setInAppNotificationRepository(inAppRepo)

    // Seed a completed job
    seedJob('job-1', {
      id: 'job-1',
      status: 'completed',
      customerUserId: 'user-customer',
      craftsmanUserId: 'user-craftsman',
    })
  })

  it('creates a rating_received notification for the provider', async () => {
    const submission: RatingSubmission = {
      jobId: 'job-1',
      providerUserId: 'user-craftsman',
      customerUserId: 'user-customer',
      ratingScore: 5,
    }

    const rating = await submitRatingWorkflow(submission)
    expect(rating).toBeDefined()

    const notifications = inAppRepo.getAll()
    expect(notifications).toHaveLength(1)

    const notif = notifications[0]
    expect(notif.type).toBe('rating_received')
    expect(notif.userId).toBe('user-craftsman')
    expect(notif.entityType).toBe('rating')
    expect(notif.isRead).toBe(false)
    expect(notif.title).toBe('Neue Bewertung erhalten')
    expect(notif.message).toContain('5-Sterne-Bewertung')
  })

  it('does not create a notification if the rating is blocked (duplicate)', async () => {
    const submission: RatingSubmission = {
      jobId: 'job-1',
      providerUserId: 'user-craftsman',
      customerUserId: 'user-customer',
      ratingScore: 4,
    }

    await submitRatingWorkflow(submission)
    // Second call blocked by canSubmitRating guard
    await submitRatingWorkflow(submission)

    // Only one notification (the first successful rating)
    expect(inAppRepo.getAll()).toHaveLength(1)
  })

  it('returns undefined and creates no notification when job not found', async () => {
    const submission: RatingSubmission = {
      jobId: 'nonexistent-job',
      providerUserId: 'user-craftsman',
      customerUserId: 'user-customer',
      ratingScore: 5,
    }

    const result = await submitRatingWorkflow(submission)
    expect(result).toBeUndefined()
    expect(inAppRepo.getAll()).toHaveLength(0)
  })
})
