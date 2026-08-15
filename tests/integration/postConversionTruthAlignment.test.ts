/**
 * Post-Conversion Operational Truth Alignment
 *
 * Hardens the state AFTER convertInquiryToProjectWorkflow has run.
 * Once an inquiry/conversation has become an operative job, all surfaces
 * must agree on the same lifecycle stage and next-step semantics.
 *
 * Invariants enforced:
 *
 * INV-1  After conversion, Project / Job / Conversation reference the same operative case.
 * INV-2  getThreadConversionState returns 'project' — never 'inquiry' — after conversion.
 * INV-3  findCanonicalJobForConversation resolves via sourceConversationId (primary) before
 *         falling back to projectId — and always finds the correct job.
 * INV-4  isBuilderProjectPending transitions to false once sourceJobId is set.
 * INV-5  isProjectOperational = false for a newly-converted job (offer not yet accepted).
 * INV-6  deriveCanonicalProjection yields 'request' for a fresh post-conversion project
 *         — not a stale pre-conversion default, not an erroneously advanced status.
 * INV-7  getJobContextForThread returns a non-null, correctly-populated context.
 * INV-8  getJobContextForThread.customerProjectId points to the right project:
 *          • builder-origin → original builder project
 *          • reel/category-origin → auto-inquiry project
 *          • profile-origin → null (no project until offer acceptance)
 * INV-9  The craftsman request inbox (getIncomingProjectRequests) excludes the converted
 *         thread immediately — keyed on job.sourceConversationId.
 * INV-10 syncAllProjectsFromJobs does not corrupt a correct post-conversion project.status.
 *
 * Acknowledged cosmetic asymmetry (not tested — no operative impact):
 *   conversation.projectStatusLabel is frozen at 'Auftrag erstellt' after conversion.
 *   getThreadHeader.helperLine reads this frozen string while the job-status pill in
 *   the thread list row reads live job state.  This is a display-only divergence;
 *   no operative decision depends on projectStatusLabel.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { mockCustomerSession, mockOwnerSession, installMockSession } from '../helpers/mockSession'

import {
  convertInquiryToProjectWorkflow,
  startReelInquiryWorkflow,
  startProfileInquiryWorkflow,
  startCategoryInquiryWorkflowFromProvider,
  startProjectInquiryWorkflowFromProvider,
} from '../../src/lib/workflow/exploreInquiryWorkflow'

import { getConversationById, getThreadConversionState } from '../../src/lib/messages'
import { getJobs } from '../../src/lib/jobs'
import { getProjectRepository } from '../../src/lib/projects/repository/registry'
import { getProjectByJobId } from '../../src/lib/projects'
import {
  isBuilderProjectPending,
  isProjectOperational,
} from '../../src/lib/projects/projectOperationalSelectors'
import { deriveCanonicalProjection } from '../../src/lib/shared/canonicalCustomerLifecycle'
import { findCanonicalJobForConversation } from '../../src/lib/messages/threadArtifactSelectors'
import { getIncomingProjectRequests } from '../../src/lib/messages/requestInboxSelectors'
import { getJobContextForThread } from '../../src/lib/workflow/messageWorkflow'
import { syncAllProjectsFromJobs } from '../../src/lib/projects/projectJobSyncBridge'
import { deriveProjectStatusFromJob } from '../../src/lib/projects/projectStatusSync'

import type { Project } from '../../src/lib/projects/projectTypes'
import type { ExploreReel, ExploreProviderCard } from '../../src/lib/explore/exploreTypes'
import type { ExploreCraftsmanProfile } from '../../src/lib/explore/exploreProfileService'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRAFTSMAN_ID = 'craftsman-pct-1'
const CUSTOMER_USER_ID = 'customer-pct-1'

const testReel: ExploreReel = {
  id: 'reel-pct',
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'PCT Meister',
  craftsmanHandle: 'pct-meister',
  craftsmanAvatarUrl: 'https://example.com/a.jpg',
  title: 'Dachsanierung',
  category: 'Dach',
  location: 'Hamburg',
  thumbnailUrl: 'https://example.com/t.jpg',
  likes: 1,
  saves: 0,
  projectTags: ['dach'],
  searchTags: ['dach'],
  costLabel: '6.000 – 12.000 €',
  durationLabel: '3 Wochen',
  createdAt: Date.now(),
}

const testProfile: ExploreCraftsmanProfile = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'PCT Meister',
  craftsmanHandle: 'pct-meister',
  craftsmanAvatarUrl: 'https://example.com/a.jpg',
  location: 'Hamburg',
  primaryCategory: 'Dach',
  bio: 'Dachdeckermeister',
  tradeCategories: ['Dach'],
  reels: [],
  portfolioItems: [],
  trust: {
    completedJobsCount: 1,
    wouldHireAgainCount: 1,
    totalFeedbackCount: 1,
    hasPlatformBackedCompletion: false,
    badges: [],
  },
  stats: { reels: 0, likes: 0, saves: 0, completedJobs: 1, wouldHireAgainCount: 1 },
}

const testProvider: ExploreProviderCard = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'PCT Meister',
  craftsmanHandle: 'pct-meister',
  craftsmanAvatarUrl: 'https://example.com/a.jpg',
  location: 'Hamburg',
  primaryCategory: 'Dach',
  tradeCategories: ['Dach'],
  servicesOffered: ['Dachsanierung'],
  serviceRadiusKm: 50,
}

function makeBuilderProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    sourceJobId: '',
    title: 'Dach erneuern',
    customer: 'PCT Kunde',
    craftsman: '',
    location: 'Hamburg',
    dateLabel: 'Termin offen',
    price: '',
    status: 'request',
    paymentState: 'deposit_required',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'builder',
    category: 'Dach',
    description: 'Alle Ziegel erneuern',
    requestedBudget: '4.000 – 8.000 €',
    requestedTiming: 'Innerhalb 2 Monate',
    customerUserId: CUSTOMER_USER_ID,
    ...overrides,
  }
}

beforeEach(() => {
  setupCleanRepositories()
  // Inquiry workflows enforce assertCustomerRole(); install a customer session
  // so the integration scenarios model the realistic caller identity.
  installMockSession(mockCustomerSession(CUSTOMER_USER_ID))
})

// ---------------------------------------------------------------------------
// INV-1 / INV-2 — Domain alignment & conversion state
// ---------------------------------------------------------------------------

describe('INV-1/2 — Project / Job / Conversation alignment post-conversion', () => {
  it('getThreadConversionState = "project" immediately after conversion (reel)', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    await convertInquiryToProjectWorkflow(threadId)
    expect(getThreadConversionState(threadId)).toBe('project')
  })

  it('getThreadConversionState = "project" immediately after conversion (builder)', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject('inv-builder-1')
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    await convertInquiryToProjectWorkflow(threadId)

    expect(getThreadConversionState(threadId)).toBe('project')
  })

  it('getThreadConversionState = "inquiry" before conversion', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    // Not converted yet
    expect(getThreadConversionState(threadId)).toBe('inquiry')
  })

  it('conversation projectStatusLabel is "Auftrag erstellt" immediately post-conversion', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    await convertInquiryToProjectWorkflow(threadId)
    const conv = getConversationById(threadId)
    expect(conv?.projectStatusLabel).toBe('Auftrag erstellt')
  })
})

// ---------------------------------------------------------------------------
// INV-3 — findCanonicalJobForConversation uses sourceConversationId as primary
// ---------------------------------------------------------------------------

describe('INV-3 — findCanonicalJobForConversation resolution paths', () => {
  it('resolves via sourceConversationId (primary) for a freshly-converted reel inquiry', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const conv = getConversationById(threadId)!
    const result = findCanonicalJobForConversation(conv, getJobs())

    expect(result).not.toBeNull()
    expect(result?.job.id).toBe(jobId)
    expect(result?.canonical).toBe(true) // primary path
  })

  it('resolves via sourceConversationId for a builder-origin inquiry', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject('inv-can-1')
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const conv = getConversationById(threadId)!
    const result = findCanonicalJobForConversation(conv, getJobs())

    expect(result?.job.id).toBe(jobId)
    expect(result?.canonical).toBe(true)
  })

  it('returns null for an unconverted inquiry', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const conv = getConversationById(threadId)!

    expect(findCanonicalJobForConversation(conv, getJobs())).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// INV-4 — isBuilderProjectPending transitions correctly
// ---------------------------------------------------------------------------

describe('INV-4 — isBuilderProjectPending transitions post-conversion', () => {
  it('is true before conversion (builder project with no sourceJobId)', () => {
    const project = makeBuilderProject('inv-pend-1')
    expect(isBuilderProjectPending(project)).toBe(true)
  })

  it('is false after conversion (sourceJobId is set on the project)', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject('inv-pend-2')
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    await convertInquiryToProjectWorkflow(threadId)

    const updated = repo.getById('inv-pend-2')!
    expect(updated.sourceJobId).toBeTruthy()
    expect(isBuilderProjectPending(updated)).toBe(false)
  })

  it('auto-inquiry project (reel) has isBuilderProjectPending = false (source = inquiry)', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const project = getProjectByJobId(jobId)!
    // Auto-inquiry projects have source = 'inquiry', not 'builder'
    expect(project.source).toBe('inquiry')
    expect(isBuilderProjectPending(project)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// INV-5 — isProjectOperational = false for fresh post-conversion project
// ---------------------------------------------------------------------------

describe('INV-5 — isProjectOperational is false for a newly-converted job', () => {
  it('reel-origin: auto-project is active but not yet operational (no offer accepted)', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const project = getProjectByJobId(jobId)!
    // status = 'request' after conversion → not in OPERATIONAL_STATUSES
    expect(isProjectOperational(project)).toBe(false)
    // but it IS active (not cancelled/completed)
    expect(project.status).toBe('request')
  })

  it('builder-origin: project is active but not yet operational after conversion', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject('inv-op-1')
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    await convertInquiryToProjectWorkflow(threadId)

    const updated = repo.getById('inv-op-1')!
    expect(isProjectOperational(updated)).toBe(false)
    expect(updated.status).toBe('request')
  })
})

// ---------------------------------------------------------------------------
// INV-6 — deriveCanonicalProjection yields 'request' post-conversion
// ---------------------------------------------------------------------------

describe('INV-6 — deriveCanonicalProjection for post-conversion project', () => {
  it('yields status = "request" for a reel-origin job with status = "new"', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const project = getProjectByJobId(jobId)!
    const canonical = deriveCanonicalProjection(project)

    expect(canonical.status).toBe('request')
  })

  it('yields status = "request" for a builder-origin job with status = "new"', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject('inv-can-proj-1')
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    // Use the now-linked builder project
    const linked = getProjectByJobId(jobId)!
    const canonical = deriveCanonicalProjection(linked)

    expect(canonical.status).toBe('request')
  })

  it('canonical status is NOT "accepted" or any operational state for a fresh job', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const project = getProjectByJobId(jobId)!
    const canonical = deriveCanonicalProjection(project)

    expect(canonical.status).not.toBe('accepted')
    expect(canonical.status).not.toBe('scheduled')
    expect(canonical.status).not.toBe('in_progress')
    expect(canonical.status).not.toBe('review')
    expect(canonical.status).not.toBe('completed')
    expect(canonical.status).not.toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// INV-7 — getJobContextForThread returns non-null correct context
// ---------------------------------------------------------------------------

describe('INV-7 — getJobContextForThread post-conversion', () => {
  it('returns non-null after reel-origin conversion', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    await convertInquiryToProjectWorkflow(threadId)

    expect(getJobContextForThread(threadId)).not.toBeNull()
  })

  it('returns null before conversion', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    expect(getJobContextForThread(threadId)).toBeNull()
  })

  it('jobId in context matches the created job', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const ctx = getJobContextForThread(threadId)
    expect(ctx?.jobId).toBe(jobId)
  })

  it('status is "new" for a freshly-converted job', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    await convertInquiryToProjectWorkflow(threadId)

    const ctx = getJobContextForThread(threadId)
    expect(ctx?.status).toBe('new')
  })

  it('phase is not a payment or proposal-received phase for a fresh job', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    await convertInquiryToProjectWorkflow(threadId)

    const ctx = getJobContextForThread(threadId)!
    // Fresh job has no proposal → phase should not be payment/completion-adjacent
    expect(ctx.phase).not.toContain('payment')
    expect(ctx.phase).not.toContain('funded')
    expect(ctx.phase).not.toContain('completed')
  })
})

// ---------------------------------------------------------------------------
// INV-8 — getJobContextForThread.customerProjectId per origin
// ---------------------------------------------------------------------------

describe('INV-8 — customerProjectId points to the right project per origin', () => {
  it('reel-origin: customerProjectId = auto-inquiry project id', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const autoProject = getProjectByJobId(jobId)!
    const ctx = getJobContextForThread(threadId)

    expect(ctx?.customerProjectId).toBe(autoProject.id)
  })

  it('builder-origin: customerProjectId = original builder project id', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject('inv-cpid-builder')
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    await convertInquiryToProjectWorkflow(threadId)

    const ctx = getJobContextForThread(threadId)
    expect(ctx?.customerProjectId).toBe('inv-cpid-builder')
  })

  it('profile-origin: customerProjectId = null (no project until offer acceptance)', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)
    await convertInquiryToProjectWorkflow(threadId)

    const ctx = getJobContextForThread(threadId)
    expect(ctx?.customerProjectId).toBeNull()
  })

  it('category-origin: customerProjectId = auto-inquiry project id', async () => {
    const threadId = await startCategoryInquiryWorkflowFromProvider(
      'Dach',
      'Ziegel erneuern',
      'Hamburg',
      testProvider
    )
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const autoProject = getProjectByJobId(jobId)!
    const ctx = getJobContextForThread(threadId)

    expect(ctx?.customerProjectId).toBe(autoProject.id)
  })
})

// ---------------------------------------------------------------------------
// INV-9 — Craftsman request inbox excludes converted threads
// ---------------------------------------------------------------------------

describe('INV-9 — Request inbox excludes converted threads', () => {
  // The inbox selector (`getIncomingProjectRequests`) filters to the current
  // craftsman session. Each test in this block creates the inquiry as the
  // customer (via the global beforeEach) and then switches to a craftsman
  // session before reading the inbox so the realistic actor identity is
  // reflected at each step.
  function readInboxAsCraftsman(craftsmanId: string) {
    installMockSession(mockOwnerSession(craftsmanId))
    return getIncomingProjectRequests()
  }

  it('unconverted reel inquiry appears in the craftsman inbox', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const requests = readInboxAsCraftsman(CRAFTSMAN_ID)
    const ids = requests.map((r) => r.threadId)
    expect(ids).toContain(threadId)
  })

  it('converted reel inquiry is excluded from the craftsman inbox', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    await convertInquiryToProjectWorkflow(threadId)

    const requests = readInboxAsCraftsman(CRAFTSMAN_ID)
    const ids = requests.map((r) => r.threadId)
    expect(ids).not.toContain(threadId)
  })

  it('inbox count decreases by 1 after conversion', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const countBefore = readInboxAsCraftsman(CRAFTSMAN_ID).length

    // Conversion runs under the craftsman session that the previous read
    // installed; restore the customer session before re-running an inquiry
    // workflow would also be valid, but conversion is craftsman-side here.
    await convertInquiryToProjectWorkflow(threadId)
    const countAfter = readInboxAsCraftsman(CRAFTSMAN_ID).length

    expect(countAfter).toBe(countBefore - 1)
  })

  it('converted profile-origin inquiry is excluded from the craftsman inbox', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)
    await convertInquiryToProjectWorkflow(threadId)

    const requests = readInboxAsCraftsman(CRAFTSMAN_ID)
    expect(requests.map((r) => r.threadId)).not.toContain(threadId)
  })

  it('converted builder-origin inquiry is excluded from the craftsman inbox', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject('inv-inbox-builder')
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    await convertInquiryToProjectWorkflow(threadId)

    const requests = readInboxAsCraftsman(CRAFTSMAN_ID)
    expect(requests.map((r) => r.threadId)).not.toContain(threadId)
  })

  it('a second unconverted inquiry from a different craftsman still appears in the inbox', async () => {
    const otherCraftsmanId = 'craftsman-other'
    const otherReel: ExploreReel = {
      ...testReel,
      id: 'reel-other',
      craftsmanId: otherCraftsmanId,
      craftsmanHandle: 'other-meister',
    }

    const thread1 = await startReelInquiryWorkflow(testReel)
    const thread2 = await startReelInquiryWorkflow(otherReel)

    // Convert only thread1
    await convertInquiryToProjectWorkflow(thread1)

    // thread1 belongs to CRAFTSMAN_ID; thread2 belongs to otherCraftsmanId.
    // Read each inbox under the matching craftsman identity.
    const idsForFirst = readInboxAsCraftsman(CRAFTSMAN_ID).map((r) => r.threadId)
    const idsForOther = readInboxAsCraftsman(otherCraftsmanId).map((r) => r.threadId)

    expect(idsForFirst).not.toContain(thread1) // converted — excluded
    expect(idsForOther).toContain(thread2)     // not converted — visible to its craftsman
  })
})

// ---------------------------------------------------------------------------
// INV-10 — syncAllProjectsFromJobs doesn't corrupt post-conversion truth
// ---------------------------------------------------------------------------

describe('INV-10 — Sync bridge preserves correct post-conversion project status', () => {
  it('project.status remains "request" after syncAllProjectsFromJobs (reel)', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const before = getProjectByJobId(jobId)!
    expect(before.status).toBe('request')

    await syncAllProjectsFromJobs()

    const after = getProjectByJobId(jobId)!
    expect(after.status).toBe('request')
  })

  it('project.status remains "request" after syncAllProjectsFromJobs (builder)', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject('inv-sync-1')
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    await convertInquiryToProjectWorkflow(threadId)

    await syncAllProjectsFromJobs()

    const after = repo.getById('inv-sync-1')!
    expect(after.status).toBe('request')
  })

  it('sync does not corrupt paymentState to "none" after reel conversion', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const before = getProjectByJobId(jobId)!
    expect(before.paymentState).toBe('deposit_required')

    await syncAllProjectsFromJobs()

    const after = getProjectByJobId(jobId)!
    // The auto-project was created with paymentState: 'deposit_required'
    // sync reads from job.paymentState which is also 'deposit_required'
    expect(after.paymentState).toBe('deposit_required')
  })
})

// ---------------------------------------------------------------------------
// deriveProjectStatusFromJob — post-conversion status mapping table
// ---------------------------------------------------------------------------

describe('deriveProjectStatusFromJob — full status mapping', () => {
  it('new job (no proposal) → "request"', () => {
    expect(deriveProjectStatusFromJob({
      status: 'new',
      proposalSentAt: undefined,
      proposalAcceptedAt: undefined,
    })).toBe('request')
  })

  it('new job (proposal accepted) → "accepted"', () => {
    const now = Date.now()
    expect(deriveProjectStatusFromJob({
      status: 'new',
      proposalSentAt: now - 3600_000,
      proposalAcceptedAt: now - 1800_000,
    })).toBe('accepted')
  })

  it('scheduled job → "scheduled"', () => {
    expect(deriveProjectStatusFromJob({
      status: 'scheduled',
      proposalSentAt: undefined,
      proposalAcceptedAt: undefined,
    })).toBe('scheduled')
  })

  it('in_progress job → "in_progress"', () => {
    expect(deriveProjectStatusFromJob({
      status: 'in_progress',
      proposalSentAt: undefined,
      proposalAcceptedAt: undefined,
    })).toBe('in_progress')
  })

  it('waiting_payment job → "review"', () => {
    expect(deriveProjectStatusFromJob({
      status: 'waiting_payment',
      proposalSentAt: undefined,
      proposalAcceptedAt: undefined,
    })).toBe('review')
  })

  it('completed job → "completed"', () => {
    expect(deriveProjectStatusFromJob({
      status: 'completed',
      proposalSentAt: undefined,
      proposalAcceptedAt: undefined,
    })).toBe('completed')
  })

  it('cancelled job → "cancelled"', () => {
    expect(deriveProjectStatusFromJob({
      status: 'cancelled',
      proposalSentAt: undefined,
      proposalAcceptedAt: undefined,
    })).toBe('cancelled')
  })

  it('booked job → "accepted"', () => {
    expect(deriveProjectStatusFromJob({
      status: 'booked' as never,
      proposalSentAt: undefined,
      proposalAcceptedAt: undefined,
    })).toBe('accepted')
  })
})
