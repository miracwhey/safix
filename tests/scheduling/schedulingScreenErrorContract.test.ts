/**
 * Scheduling Screen Error-Contract Tests
 *
 * Invariants proven here:
 * 1. ProposalReadinessCard: proposalError rendered in proposal_accepted section (not only ready_for_proposal)
 * 2. QueueAppointmentPanel: error state present, onSchedule awaited (regression guard)
 * 3. performCanonicalScheduleSave: returns {success, error} and never throws
 *
 * The previous CraftsmanScheduleScreen.JobScheduleForm describe block was removed:
 * the form lived only in the now-deleted CraftsmanScheduleScreen and is not
 * preserved in CraftsmanOperationsScreen, so its UI invariants are obsolete.
 * The runtime soft-error save contract is covered by QueueAppointmentPanel
 * (regression guard below) and performCanonicalScheduleSave (domain test below).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner } from '../helpers/mockSession'
import { performCanonicalScheduleSave } from '../../src/lib/scheduling'
import { addJob } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'

// ── Factories ──────────────────────────────────────────────────────────────

const SCHED_SCREEN_OWNER_ID = 'sched-screen-owner'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-sched-1',
    projectId: 'proj-sched-1',
    sourceConversationId: 'conv-sched-1',
    title: 'Termin-Test Auftrag',
    customer: 'Test Kunde',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'new',
    amount: '500',
    description: '',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: SCHED_SCREEN_OWNER_ID,
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE AUDIT — ProposalReadinessCard
// ═══════════════════════════════════════════════════════════════════════════

describe('ProposalReadinessCard — proposalError in proposal_accepted section', () => {
  const source = readFileSync(
    new URL('../../src/components/jobs/ProposalReadinessCard.tsx', import.meta.url),
    'utf-8',
  )

  it('proposalError is rendered inside proposal_accepted block', () => {
    // Find the proposal_accepted && !hasSchedule block and confirm proposalError is inside it
    const acceptedBlock = source.match(
      /proposal_accepted.*?!hasSchedule[\s\S]*?(?=proposal_accepted|vm\.readiness === 'proposal_invalid'|\/\* Scheduled)/
    )
    expect(acceptedBlock).not.toBeNull()
    expect(acceptedBlock![0]).toContain('proposalError')
  })

  it('proposalError also rendered in ready_for_proposal section (existing behavior preserved)', () => {
    const readyBlock = source.match(
      /ready_for_proposal[\s\S]*?proposalError/
    )
    expect(readyBlock).not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE AUDIT — QueueAppointmentPanel (regression guard)
// ═══════════════════════════════════════════════════════════════════════════

describe('QueueAppointmentPanel — regression guard', () => {
  const source = readFileSync(
    new URL('../../src/components/dashboard/QueueAppointmentPanel.tsx', import.meta.url),
    'utf-8',
  )

  it('awaits onSchedule call', () => {
    expect(source).toContain('await onSchedule')
  })

  it('has error state for save failures', () => {
    expect(source).toMatch(/\berror\b.*useState|useState.*\berror\b/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN — performCanonicalScheduleSave never throws
// ═══════════════════════════════════════════════════════════════════════════

describe('performCanonicalScheduleSave — soft-error contract', () => {
  beforeEach(() => {
    setupCleanRepositories()
    installSessionForJobOwner({ craftsmanUserId: SCHED_SCREEN_OWNER_ID })
  })

  it('returns success:true for valid job', async () => {
    await addJob(makeJob())
    const start = Date.now() + 86400000
    const result = await performCanonicalScheduleSave({
      jobId: 'job-sched-1',
      scheduledStart: start,
      scheduledEnd: start + 7200000,
    })
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('returns success:false (not throw) for nonexistent job', async () => {
    const result = await performCanonicalScheduleSave({
      jobId: 'nonexistent-job',
      scheduledStart: Date.now() + 86400000,
      scheduledEnd: Date.now() + 86400000 + 7200000,
    })
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('never throws — always resolves', async () => {
    await expect(
      performCanonicalScheduleSave({
        jobId: 'nonexistent',
        scheduledStart: 0,
        scheduledEnd: 0,
      })
    ).resolves.toBeDefined()
  })
})
