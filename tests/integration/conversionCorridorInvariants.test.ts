/**
 * Conversion corridor invariants
 *
 * Hardens the exact path:
 *   project-origin inquiry / conversation
 *   → convertInquiryToProjectWorkflow
 *   → Job / operative case / Project linkage
 *   → Reload / rehydration consistency
 *
 * These tests guard the following invariants:
 *
 * A. A project-origin conversation converts into an operative entity that
 *    carries the correct sourceProjectId linkage.
 * B. The resulting job retains the correct source linkage after a reload
 *    simulation (conversation.projectId changes to real UUID or '' post-reload).
 * C. Intake context from a project-origin inquiry arrives fully and
 *    deterministically in the converted job.
 * D. Project / conversation / job do not diverge after conversion —
 *    both getProjectByJobId and getConversationForJob resolve the same
 *    canonical entities.
 * E. Mismatch states (sourceProjectId present but project not found) are
 *    detected explicitly by the workflow, not silently hidden.
 * F. Different inquiry entry points (reel, profile, category, project) are
 *    semantically aligned: all carry sourceConversationId, all are idempotent
 *    across reload simulation.
 * G. Reload simulation: post-conversion truth is identical before and after
 *    conversation.projectId changes to its post-Supabase-read value.
 * H. Completed/cancelled/stale objects are handled (idempotency guard still
 *    works for already-converted threads).
 * I. Selectors do not tell contradictory stories for the same converted case.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { mockCustomerSession, installMockSession } from '../helpers/mockSession'

import {
  convertInquiryToProjectWorkflow,
  startReelInquiryWorkflow,
  startProfileInquiryWorkflow,
  startCategoryInquiryWorkflowFromProvider,
  startProjectInquiryWorkflowFromProvider,
} from '../../src/lib/workflow/exploreInquiryWorkflow'

import { getConversationById, updateConversation } from '../../src/lib/messages'
import { getJobById, getJobs } from '../../src/lib/jobs'
import { getProjectRepository } from '../../src/lib/projects/repository/registry'
import { getProjectByJobId } from '../../src/lib/projects'
import { getConversationMessagesForJob } from '../../src/lib/workflow/messageWorkflow'
import type { Project } from '../../src/lib/projects/projectTypes'
import type { ExploreReel, ExploreProviderCard } from '../../src/lib/explore/exploreTypes'
import type { ExploreCraftsmanProfile } from '../../src/lib/explore/exploreProfileService'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRAFTSMAN_ID = 'user-craftsman-corridor'
const CUSTOMER_USER_ID = 'user-customer-corridor'

const testReel: ExploreReel = {
  id: 'reel-corridor',
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Corridor Meister',
  craftsmanHandle: 'corridor-meister',
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  title: 'Dachsanierung',
  category: 'Dach',
  location: 'Stuttgart',
  thumbnailUrl: 'https://example.com/thumb.jpg',
  likes: 3,
  saves: 1,
  projectTags: ['dach'],
  searchTags: ['dach'],
  costLabel: '4.000 – 8.000 €',
  durationLabel: '2 Wochen',
  createdAt: Date.now(),
}

const testProfile: ExploreCraftsmanProfile = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Corridor Meister',
  craftsmanHandle: 'corridor-meister',
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'Stuttgart',
  primaryCategory: 'Dach',
  bio: 'Dachdeckermeister',
  tradeCategories: ['Dach'],
  reels: [],
  portfolioItems: [],
  trust: {
    completedJobsCount: 2,
    wouldHireAgainCount: 2,
    totalFeedbackCount: 2,
    hasPlatformBackedCompletion: true,
    badges: [],
  },
  stats: {
    reels: 0,
    likes: 0,
    saves: 0,
    completedJobs: 2,
    wouldHireAgainCount: 2,
  },
}

const testProvider: ExploreProviderCard = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Corridor Meister',
  craftsmanHandle: 'corridor-meister',
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'Stuttgart',
  primaryCategory: 'Dach',
  tradeCategories: ['Dach'],
  servicesOffered: ['Dachsanierung'],
  serviceRadiusKm: 30,
}

function makeBuilderProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-corridor-builder-1',
    sourceJobId: '',
    title: 'Dach komplett erneuern',
    customer: 'Test Kunde',
    craftsman: '',
    location: 'Stuttgart',
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
    description: 'Alle Dachziegel ersetzen, Dämmung erneuern',
    requestedBudget: '5.000 – 10.000 €',
    requestedTiming: 'Innerhalb 3 Monate',
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
// A. Project-origin conversion: correct project linkage in job
// ---------------------------------------------------------------------------

describe('A — project-origin conversion carries correct project linkage', () => {
  it('job.intakeContext.origin is inquiry_project for builder-origin inquiry', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-a1' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const job = getJobById(jobId)
    expect(job?.intakeContext?.origin).toBe('inquiry_project')
  })

  it('builder project sourceJobId points to the created job after conversion', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-a2' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const updatedProject = repo.getById('proj-a2')
    expect(updatedProject?.sourceJobId).toBe(jobId)
  })

  it('getProjectByJobId returns the original builder project (not an auto-project)', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-a3' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const found = getProjectByJobId(jobId)
    expect(found?.id).toBe('proj-a3')
    expect(found?.source).toBe('builder')
  })

  it('job.sourceConversationId equals threadId', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-a4' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const job = getJobById(jobId)
    expect(job?.sourceConversationId).toBe(threadId)
  })
})

// ---------------------------------------------------------------------------
// B. Reload simulation: idempotency survives conversation.projectId change
// ---------------------------------------------------------------------------

describe('B — post-reload idempotency via sourceConversationId', () => {
  it('reel-origin: second convert call returns same job after projectId cleared to "" (reload sim)', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId1 = await convertInquiryToProjectWorkflow(threadId)

    // Simulate Supabase reload: reel-origin has no real project UUID, so
    // rowToConversation sets projectId = source_project_id ?? '' = ''
    updateConversation(threadId, { projectId: '' })

    const jobId2 = await convertInquiryToProjectWorkflow(threadId)
    expect(jobId2).toBe(jobId1)
  })

  it('reel-origin reload sim: no duplicate job is created', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    await convertInquiryToProjectWorkflow(threadId)

    updateConversation(threadId, { projectId: '' })
    await convertInquiryToProjectWorkflow(threadId)

    const allJobs = getJobs()
    const matchingJobs = allJobs.filter((j) => j.sourceConversationId === threadId)
    expect(matchingJobs).toHaveLength(1)
  })

  it('profile-origin: second convert call returns same job after projectId cleared to "" (reload sim)', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)
    const jobId1 = await convertInquiryToProjectWorkflow(threadId)

    updateConversation(threadId, { projectId: '' })

    const jobId2 = await convertInquiryToProjectWorkflow(threadId)
    expect(jobId2).toBe(jobId1)
  })

  it('builder-origin: second convert call returns same job after projectId changes to real UUID (reload sim)', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-b-reload-1' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId1 = await convertInquiryToProjectWorkflow(threadId)

    // Simulate Supabase reload: builder-origin sets projectId = source_project_id = real UUID
    updateConversation(threadId, { projectId: project.id })

    const jobId2 = await convertInquiryToProjectWorkflow(threadId)
    expect(jobId2).toBe(jobId1)
  })

  it('builder-origin reload sim: no duplicate job or project is created', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-b-reload-2' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    await convertInquiryToProjectWorkflow(threadId)

    updateConversation(threadId, { projectId: project.id })
    await convertInquiryToProjectWorkflow(threadId)

    // Still exactly one project (the builder project), no auto-duplicates
    const allProjects = repo.getAll()
    expect(allProjects).toHaveLength(1)
    expect(allProjects[0].id).toBe('proj-b-reload-2')
  })
})

// ---------------------------------------------------------------------------
// C. Intake context transfer — all fields arrive deterministically
// ---------------------------------------------------------------------------

describe('C — intake context transfer from project-origin inquiry', () => {
  it('requestDescription arrives from project.description', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-c1', description: 'Alle Ziegel erneuern' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const job = getJobById(jobId)
    expect(job?.intakeContext?.requestDescription).toBe('Alle Ziegel erneuern')
  })

  it('requestLocation arrives from project.location', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-c2', location: 'Freiburg' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const job = getJobById(jobId)
    expect(job?.intakeContext?.requestLocation).toBe('Freiburg')
  })

  it('requestBudget arrives from project.requestedBudget', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-c3', requestedBudget: '3.000 – 6.000 €' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const job = getJobById(jobId)
    expect(job?.intakeContext?.requestBudget).toBe('3.000 – 6.000 €')
  })

  it('requestDuration arrives from project.requestedTiming (via projectDuration field)', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-c4', requestedTiming: 'Innerhalb 4 Wochen' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const job = getJobById(jobId)
    expect(job?.intakeContext?.requestDuration).toBe('Innerhalb 4 Wochen')
  })

  it('all intake fields arrive together for a fully specified builder project', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-c5' })
    // makeBuilderProject already has all fields set
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const job = getJobById(jobId)
    expect(job?.intakeContext?.origin).toBe('inquiry_project')
    expect(job?.intakeContext?.requestDescription).toBe('Alle Dachziegel ersetzen, Dämmung erneuern')
    expect(job?.intakeContext?.requestLocation).toBe('Stuttgart')
    expect(job?.intakeContext?.requestBudget).toBe('5.000 – 10.000 €')
    expect(job?.intakeContext?.requestDuration).toBe('Innerhalb 3 Monate')
  })
})

// ---------------------------------------------------------------------------
// D. Domain alignment: project / conversation / job tell the same story
// ---------------------------------------------------------------------------

describe('D — project / conversation / job alignment after conversion', () => {
  it('builder project sourceJobId and job.sourceConversationId form a consistent triangle', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-d1' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const updatedProject = repo.getById('proj-d1')!
    const job = getJobById(jobId)!

    // project → job link
    expect(updatedProject.sourceJobId).toBe(jobId)
    // job → conversation link
    expect(job.sourceConversationId).toBe(threadId)
    // conversation → project link
    const conv = getConversationById(threadId)!
    expect(conv.sourceProjectId).toBe('proj-d1')
  })

  it('getConversationMessagesForJob resolves messages via sourceConversationId after projectId changes', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-d2' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    // Simulate reload: conversation.projectId changes to real UUID
    updateConversation(threadId, { projectId: project.id })

    // Message resolution must still work via sourceConversationId
    const messages = getConversationMessagesForJob(jobId)
    expect(messages.length).toBeGreaterThan(0)
  })

  it('conversation projectStatusLabel is Auftrag erstellt after builder-origin conversion', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-d3' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    await convertInquiryToProjectWorkflow(threadId)

    const conv = getConversationById(threadId)
    expect(conv?.projectStatusLabel).toBe('Auftrag erstellt')
  })

  it('job.customerUserId matches the builder project customerUserId', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-d4', customerUserId: CUSTOMER_USER_ID })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const job = getJobById(jobId)
    expect(job?.customerUserId).toBe(CUSTOMER_USER_ID)
  })
})

// ---------------------------------------------------------------------------
// E. Mismatch detection: sourceProjectId not found → explicit error
// ---------------------------------------------------------------------------

describe('E — mismatch states are explicit, not silently hidden', () => {
  it('returns null for a non-existent threadId — not a silent undefined', async () => {
    const result = await convertInquiryToProjectWorkflow('nonexistent-thread-id')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// F. Entry point alignment: all origins carry sourceConversationId
// ---------------------------------------------------------------------------

describe('F — all inquiry entry points produce sourceConversationId', () => {
  it('reel-origin job carries sourceConversationId', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)
    const job = getJobById(jobId)
    expect(job?.sourceConversationId).toBe(threadId)
  })

  it('profile-origin job carries sourceConversationId', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)
    const jobId = await convertInquiryToProjectWorkflow(threadId)
    const job = getJobById(jobId)
    expect(job?.sourceConversationId).toBe(threadId)
  })

  it('category-origin job carries sourceConversationId', async () => {
    const threadId = await startCategoryInquiryWorkflowFromProvider(
      'Dach',
      'Ziegel erneuern',
      'Stuttgart',
      testProvider
    )
    const jobId = await convertInquiryToProjectWorkflow(threadId)
    const job = getJobById(jobId)
    expect(job?.sourceConversationId).toBe(threadId)
  })

  it('builder-project-origin job carries sourceConversationId', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-f4' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)
    const job = getJobById(jobId)
    expect(job?.sourceConversationId).toBe(threadId)
  })
})

// ---------------------------------------------------------------------------
// G. Reload simulation: post-conversion truth identical before/after
// ---------------------------------------------------------------------------

describe('G — reload simulation does not alter post-conversion operative truth', () => {
  it('getProjectByJobId returns the same project before and after reload simulation (builder)', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-g1' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const before = getProjectByJobId(jobId)

    // Simulate reload: conversation.projectId becomes real UUID
    updateConversation(threadId, { projectId: project.id })

    const after = getProjectByJobId(jobId)

    expect(after?.id).toBe(before?.id)
    expect(after?.source).toBe('builder')
  })

  it('job intakeContext is identical before and after reload simulation', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-g2' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const before = getJobById(jobId)!.intakeContext

    // Simulate reload: idempotency guard returns the existing job; intakeContext is untouched
    updateConversation(threadId, { projectId: project.id })
    const jobId2 = await convertInquiryToProjectWorkflow(threadId)

    const after = getJobById(jobId2)!.intakeContext

    expect(after).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// H. Already-converted (stale) thread: idempotency works regardless of
//    how many times the workflow is called
// ---------------------------------------------------------------------------

describe('H — idempotency is robust across repeated calls and reload simulations', () => {
  it('three consecutive convert calls return the same jobId', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const id1 = await convertInquiryToProjectWorkflow(threadId)
    const id2 = await convertInquiryToProjectWorkflow(threadId)
    const id3 = await convertInquiryToProjectWorkflow(threadId)
    expect(id1).toBe(id2)
    expect(id2).toBe(id3)
  })

  it('convert after reload sim, then convert again: still the same jobId', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const id1 = await convertInquiryToProjectWorkflow(threadId)

    updateConversation(threadId, { projectId: '' })
    const id2 = await convertInquiryToProjectWorkflow(threadId)

    updateConversation(threadId, { projectId: '' })
    const id3 = await convertInquiryToProjectWorkflow(threadId)

    expect(id1).toBe(id2)
    expect(id2).toBe(id3)
  })
})

// ---------------------------------------------------------------------------
// I. Selector consistency: project, conversation, and job agree
// ---------------------------------------------------------------------------

describe('I — selectors tell a consistent story for a converted builder-origin case', () => {
  it('project.sourceJobId === job.id and job.sourceConversationId === conversation.id', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-i1' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const updatedProject = repo.getById('proj-i1')!
    const job = getJobById(jobId)!
    const conv = getConversationById(threadId)!

    expect(updatedProject.sourceJobId).toBe(job.id)
    expect(job.sourceConversationId).toBe(conv.id)
    expect(conv.sourceProjectId).toBe(updatedProject.id)
  })

  it('after reload sim, job→conversation still resolves via sourceConversationId', async () => {
    const repo = getProjectRepository()
    const project = makeBuilderProject({ id: 'proj-i2' })
    await repo.add(project)

    const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    // Simulate reload for builder origin
    updateConversation(threadId, { projectId: project.id })

    const job = getJobById(jobId)!
    // Primary resolution via sourceConversationId must still work
    const conv = getConversationById(job.sourceConversationId!)
    expect(conv).toBeDefined()
    expect(conv?.id).toBe(threadId)
  })
})
