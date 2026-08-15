/**
 * Customer Reload Stage Rehydration Tests
 *
 * Verifies that after reload, customer-facing surfaces show the correct
 * persisted lifecycle stage:
 * - Customer home "Aktuelles Projekt" stage
 * - Project status badge
 * - Notifications/attention
 * - Project context remains stable
 *
 * Non-negotiable: no local UI state may be required to preserve offer sent/accepted/payment due.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveProjectStatusFromJob,
  isProjectStatusStale,
  syncProjectFromJob,
} from '../../src/lib/projects/projectStatusSync'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Project } from '../../src/lib/projects/projectTypes'

const NOW = 1_700_000_000_000
const HOUR_MS = 1000 * 60 * 60

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Test Job',
    customer: 'Test Customer',
    location: 'Test Location',
    dateLabel: 'Test Date',
    status: 'new',
    amount: '1000€',
    description: 'Test description',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-1',
    customerUserId: 'customer-1',
    ...overrides,
  }
}

function createTestProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    sourceJobId: 'job-1',
    title: 'Test Project',
    customer: 'Test Customer',
    craftsman: 'Test Craftsman',
    location: 'Test Location',
    dateLabel: 'Test Date',
    price: '1000€',
    status: 'request',
    paymentState: 'deposit_required',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Project Status Sync from Job Tests
// ---------------------------------------------------------------------------

describe('deriveProjectStatusFromJob', () => {
  it('returns "request" for new job with no proposal sent', () => {
    const job = createTestJob({ status: 'new' })
    expect(deriveProjectStatusFromJob(job)).toBe('request')
  })

  it('returns "request" for new job with proposal sent but not accepted', () => {
    const job = createTestJob({
      status: 'new',
      proposalSentAt: NOW - 24 * HOUR_MS,
    })
    expect(deriveProjectStatusFromJob(job)).toBe('request')
  })

  it('returns "accepted" for new job with proposal accepted', () => {
    const job = createTestJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR_MS,
      proposalAcceptedAt: NOW - 24 * HOUR_MS,
    })
    expect(deriveProjectStatusFromJob(job)).toBe('accepted')
  })

  it('returns "scheduled" for scheduled job', () => {
    const job = createTestJob({ status: 'scheduled' })
    expect(deriveProjectStatusFromJob(job)).toBe('scheduled')
  })

  it('returns "in_progress" for in_progress job', () => {
    const job = createTestJob({ status: 'in_progress' })
    expect(deriveProjectStatusFromJob(job)).toBe('in_progress')
  })

  it('returns "review" for waiting_payment job', () => {
    const job = createTestJob({ status: 'waiting_payment' })
    expect(deriveProjectStatusFromJob(job)).toBe('review')
  })

  it('returns "completed" for completed job', () => {
    const job = createTestJob({ status: 'completed' })
    expect(deriveProjectStatusFromJob(job)).toBe('completed')
  })
})

describe('isProjectStatusStale', () => {
  it('returns true when project status does not match job state', () => {
    const project = createTestProject({ status: 'request' })
    const job = createTestJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR_MS,
      proposalAcceptedAt: NOW - 24 * HOUR_MS,
    })
    expect(isProjectStatusStale(project, job)).toBe(true)
  })

  it('returns false when project status matches job state', () => {
    const project = createTestProject({ status: 'accepted' })
    const job = createTestJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR_MS,
      proposalAcceptedAt: NOW - 24 * HOUR_MS,
    })
    expect(isProjectStatusStale(project, job)).toBe(false)
  })
})

describe('syncProjectFromJob', () => {
  it('returns correct status and paymentState update', () => {
    const job = createTestJob({
      status: 'in_progress',
      paymentState: 'work_in_progress',
    })
    const update = syncProjectFromJob(job)
    expect(update).toEqual({
      status: 'in_progress',
      paymentState: 'work_in_progress',
    })
  })

  it('syncs accepted status for job with accepted proposal', () => {
    const job = createTestJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR_MS,
      proposalAcceptedAt: NOW - 24 * HOUR_MS,
      paymentState: 'deposit_required',
    })
    const update = syncProjectFromJob(job)
    expect(update).toEqual({
      status: 'accepted',
      paymentState: 'deposit_required',
    })
  })
})

// ---------------------------------------------------------------------------
// Customer Home Stage After Reload Tests
// ---------------------------------------------------------------------------

describe('Customer Home Stage After Reload', () => {
  describe('Inquiry state', () => {
    it('shows "Anfrage in Prüfung" for new job with no proposal sent', () => {
      const job = createTestJob({ status: 'new' })
      const projectStatus = deriveProjectStatusFromJob(job)
      expect(projectStatus).toBe('request')

      const nextAction = deriveCustomerNextAction('new', job.paymentState, undefined)
      expect(nextAction.label).toBe('Anfrage in Prüfung')
      expect(nextAction.text).toContain('Deine Anfrage wird aktuell geprüft')
    })

    it('project status remains "request" after reload for raw inquiry', () => {
      const job = createTestJob({ status: 'new' })
      const project = createTestProject({ status: 'request' })

      expect(isProjectStatusStale(project, job)).toBe(false)
    })
  })

  describe('Sent offer state', () => {
    it('shows "Angebot liegt vor" for new job with proposal sent', () => {
      const proposalSentAt = NOW - 24 * HOUR_MS
      const nextAction = deriveCustomerNextAction(
        'new',
        'deposit_required',
        undefined,
        proposalSentAt,
        undefined
      )
      expect(nextAction.label).toBe('Angebot liegt vor')
      expect(nextAction.text).toContain('Der Handwerker hat ein Angebot')
    })

    it('project remains "request" for sent-but-not-accepted offer after reload', () => {
      const job = createTestJob({
        status: 'new',
        proposalSentAt: NOW - 24 * HOUR_MS,
      })
      const projectStatus = deriveProjectStatusFromJob(job)
      expect(projectStatus).toBe('request')
    })

    it('detects stale project when offer was sent but project not updated', () => {
      const project = createTestProject({ status: 'request' })
      const job = createTestJob({
        status: 'new',
        proposalSentAt: NOW - 24 * HOUR_MS,
      })
      // Project status is actually correct for sent-but-not-accepted
      expect(isProjectStatusStale(project, job)).toBe(false)
    })
  })

  describe('Accepted offer state', () => {
    it('shows accepted state for new job with proposal accepted', () => {
      const proposalSentAt = NOW - 48 * HOUR_MS
      const proposalAcceptedAt = NOW - 24 * HOUR_MS
      const nextAction = deriveCustomerNextAction(
        'new',
        'deposit_required',
        undefined,
        proposalSentAt,
        proposalAcceptedAt
      )
      // deposit_required + created/sent is 'urgent' — customer must act to unblock work
      expect(nextAction.priority).toBe('urgent')
      expect(nextAction.domain).toBe('payment')
      expect(nextAction.label).toBe('Zahlung leisten')
    })

    it('project shows "accepted" for job with accepted proposal after reload', () => {
      const job = createTestJob({
        status: 'new',
        proposalSentAt: NOW - 48 * HOUR_MS,
        proposalAcceptedAt: NOW - 24 * HOUR_MS,
      })
      const projectStatus = deriveProjectStatusFromJob(job)
      expect(projectStatus).toBe('accepted')
    })

    it('syncs project from "request" to "accepted" when proposal accepted', () => {
      const project = createTestProject({ status: 'request' })
      const job = createTestJob({
        status: 'new',
        proposalSentAt: NOW - 48 * HOUR_MS,
        proposalAcceptedAt: NOW - 24 * HOUR_MS,
      })

      expect(isProjectStatusStale(project, job)).toBe(true)

      const update = syncProjectFromJob(job)
      expect(update.status).toBe('accepted')
    })
  })

  describe('Payment due state', () => {
    it('shows payment required for accepted job with deposit_required', () => {
      const proposalSentAt = NOW - 48 * HOUR_MS
      const proposalAcceptedAt = NOW - 24 * HOUR_MS
      const nextAction = deriveCustomerNextAction(
        'new',
        'deposit_required',
        undefined,
        proposalSentAt,
        proposalAcceptedAt
      )
      expect(nextAction.label).toBe('Zahlung leisten')
      expect(nextAction.domain).toBe('payment')
    })

    it('project remains stable at "accepted" for payment-due job after reload', () => {
      const job = createTestJob({
        status: 'new',
        proposalSentAt: NOW - 48 * HOUR_MS,
        proposalAcceptedAt: NOW - 24 * HOUR_MS,
        paymentState: 'deposit_required',
      })
      const project = createTestProject({ status: 'accepted' })

      expect(isProjectStatusStale(project, job)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Cross-Surface Consistency After Reload
// ---------------------------------------------------------------------------

describe('Cross-Surface Consistency After Reload', () => {
  it('inquiry state: customer home and project status match', () => {
    const job = createTestJob({ status: 'new' })
    const projectStatus = deriveProjectStatusFromJob(job)

    // Both surfaces see inquiry state
    expect(projectStatus).toBe('request')

    const nextAction = deriveCustomerNextAction('new', job.paymentState, undefined)
    expect(nextAction.label).toBe('Anfrage in Prüfung')
  })

  it('sent offer: customer home sees offer, project status remains request', () => {
    const job = createTestJob({
      status: 'new',
      proposalSentAt: NOW - 24 * HOUR_MS,
    })
    const projectStatus = deriveProjectStatusFromJob(job)

    // Project status stays at 'request' until accepted
    expect(projectStatus).toBe('request')

    // But customer home correctly shows offer sent via proposalSentAt
    const nextAction = deriveCustomerNextAction(
      'new',
      job.paymentState,
      undefined,
      job.proposalSentAt,
      undefined
    )
    expect(nextAction.label).toBe('Angebot liegt vor')
  })

  it('accepted offer: customer home and project both reflect acceptance', () => {
    const job = createTestJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR_MS,
      proposalAcceptedAt: NOW - 24 * HOUR_MS,
      paymentState: 'deposit_required',
    })
    const projectStatus = deriveProjectStatusFromJob(job)

    // Project status advances to 'accepted'
    expect(projectStatus).toBe('accepted')

    // Customer home shows payment required
    const nextAction = deriveCustomerNextAction(
      'new',
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    expect(nextAction.domain).toBe('payment')
    // deposit_required + created/sent is 'urgent' — customer must act to unblock work
    expect(nextAction.priority).toBe('urgent')
    expect(nextAction.label).toBe('Zahlung leisten')
  })

  it('no regression: case does not show as "Anfrage" when offer accepted', () => {
    const job = createTestJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR_MS,
      proposalAcceptedAt: NOW - 24 * HOUR_MS,
    })
    const projectStatus = deriveProjectStatusFromJob(job)

    // Must NOT be 'request'
    expect(projectStatus).not.toBe('request')
    expect(projectStatus).toBe('accepted')

    const nextAction = deriveCustomerNextAction(
      'new',
      job.paymentState,
      undefined,
      job.proposalSentAt,
      job.proposalAcceptedAt
    )
    // Must NOT show inquiry state
    expect(nextAction.label).not.toBe('Anfrage in Prüfung')
  })
})

// ---------------------------------------------------------------------------
// Project Context Reload Stability
// ---------------------------------------------------------------------------

describe('Project Context Reload Stability', () => {
  it('project with sourceJobId remains stable after reload', () => {
    const project = createTestProject({
      sourceJobId: 'job-1',
      status: 'accepted',
    })
    const job = createTestJob({
      id: 'job-1',
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR_MS,
      proposalAcceptedAt: NOW - 24 * HOUR_MS,
    })

    // Project status matches job state - no sync needed
    expect(isProjectStatusStale(project, job)).toBe(false)
  })

  it('project without sourceJobId does not break sync', () => {
    const project = createTestProject({
      sourceJobId: '',
      status: 'request',
    })
    const job = createTestJob({ status: 'new' })

    // Sync should gracefully handle missing sourceJobId
    expect(isProjectStatusStale(project, job)).toBe(false)
  })

  it('project with valid sourceJobId syncs correctly after job update', () => {
    const project = createTestProject({
      sourceJobId: 'job-1',
      status: 'request',
    })
    const job = createTestJob({
      id: 'job-1',
      status: 'in_progress',
    })

    expect(isProjectStatusStale(project, job)).toBe(true)

    const update = syncProjectFromJob(job)
    expect(update.status).toBe('in_progress')
  })
})
