/**
 * Post-Conversion Next-Step Truth Alignment
 *
 * Guards the exact corridor:
 *   post-conversion job (status='new', no proposal)
 *   → proposal drafted / proposal sent (proposalSentAt set)
 *   → customer review / offer_received
 *   → proposal accepted (proposalAcceptedAt set) / offer_accepted
 *   → deposit_required actionable / payment-readiness
 *
 * Once an inquiry has been converted into an operative job, every surface that
 * shows a next step, CTA, chip, or status subtitle must read from the SAME
 * canonical truth.  No surface may:
 *   - claim an inquiry-style state after the corridor has advanced
 *   - show a payment/deposit CTA before an offer is accepted
 *   - advance to a later lifecycle stage before the fachliche truth supports it
 *   - disagree with other surfaces on what the next step is
 *   - revert to an earlier stage after reload/re-read
 *
 * Invariants:
 *
 * NS-1  Fresh post-conversion: stage = inquiry_sent, customer/craftsman see
 *        job-domain CTAs only — no payment, no proposal-received hints.
 * NS-2  deposit_required default does NOT produce a payment CTA before
 *        an offer is accepted (getActionablePaymentState gate holds).
 * NS-3  After createOfferWorkflow: proposalSentAt is stamped on the job.
 * NS-4  offer_received stage: customer CTA is urgent (Angebot liegt vor),
 *        craftsman CTA is active (Angebot gesendet) — payment still NOT actionable.
 * NS-5  Cross-selector agreement at offer_received: deriveCustomerNextAction,
 *        deriveNextAction, and deriveCustomerJobStage all agree.
 * NS-6  After acceptOfferWorkflow: proposalAcceptedAt is stamped on the job.
 * NS-7  offer_accepted stage: payment gate opens — deposit_required IS actionable.
 * NS-8  Customer sees payment domain CTA after acceptance; craftsman sees payment
 *        domain CTA after acceptance. Neither sees inquiry-style "Anfrage in Prüfung".
 * NS-9  deriveProposalReadiness is consistent with stage at each lifecycle point:
 *        none → needs_clarification/ready, sent → proposal_sent, accepted → proposal_accepted.
 * NS-10 CustomerProposalStatusCard.buildVm logic: null before offer sent,
 *        awaiting_response after sent, accepted after accepted.
 * NS-11 Invalid lifecycle (acceptedAt without sentAt) is explicit:
 *        stage = inquiry_sent, customer = "Angebot unklar", readiness = proposal_invalid.
 * NS-12 Reload simulation: after offer sent, re-reading the job from the repository
 *        returns the same proposalSentAt; stage remains offer_received.
 * NS-13 Funded dominance: fundingStatus='funded' overrides stale deposit_required
 *        on both customer and craftsman sides.
 * NS-14 Funding-in-progress: fundingStatus='funding_started' shows
 *        "Zahlung wird verarbeitet", NOT the deposit CTA.
 * NS-15 Terminal states are terminal: completed/cancelled jobs stay at idle/terminal.
 * NS-16 Cross-origin consistency: builder-origin and reel-origin jobs go through
 *        the same next-step transitions after createOfferWorkflow.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { mockCustomerSession, installMockSession } from '../helpers/mockSession'

import {
  convertInquiryToProjectWorkflow,
  startReelInquiryWorkflow,
  startProjectInquiryWorkflowFromProvider,
} from '../../src/lib/workflow/exploreInquiryWorkflow'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'

import { getJobById } from '../../src/lib/jobs'
import { getProjectRepository } from '../../src/lib/projects/repository/registry'
import {
  deriveCustomerJobStage,
  CUSTOMER_STAGE_ORDER,
} from '../../src/lib/jobs/customerJobStageSelectors'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import { deriveNextAction } from '../../src/lib/jobs/nextActionSelectors'
import { deriveProposalReadiness, deriveProposalState } from '../../src/lib/jobs/proposalReadinessSelectors'
import { getActionablePaymentState } from '../../src/lib/jobs/helpers'

import type { Project } from '../../src/lib/projects/projectTypes'
import type { ExploreReel, ExploreProviderCard } from '../../src/lib/explore/exploreTypes'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRAFTSMAN_ID = 'user-craftsman-nsta'
const CUSTOMER_USER_ID = 'user-customer-nsta'

const testReel: ExploreReel = {
  id: 'reel-nsta',
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'NSTA Meister',
  craftsmanHandle: 'nsta-meister',
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  title: 'Bodenverlegung',
  category: 'Boden',
  location: 'München',
  thumbnailUrl: 'https://example.com/thumb.jpg',
  likes: 2,
  saves: 1,
  projectTags: ['boden'],
  searchTags: ['boden'],
  costLabel: '2.000 – 5.000 €',
  durationLabel: '1 Woche',
  createdAt: Date.now(),
}

const testProvider: ExploreProviderCard = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'NSTA Meister',
  craftsmanHandle: 'nsta-meister',
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'München',
  primaryCategory: 'Boden',
  tradeCategories: ['Boden'],
  servicesOffered: ['Bodenverlegung'],
  serviceRadiusKm: 40,
}

function makeBuilderProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    sourceJobId: '',
    title: 'Boden verlegen',
    customer: 'NSTA Kunde',
    craftsman: '',
    location: 'München',
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
    category: 'Boden',
    description: 'Alle Böden neu verlegen',
    requestedBudget: '2.000 – 4.000 €',
    requestedTiming: 'Innerhalb 6 Wochen',
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
// Pure selector tests (no workflow, no repositories)
// These test the selector logic directly with explicit job state.
// ---------------------------------------------------------------------------

// ── NS-1 / NS-2: Fresh post-conversion state ─────────────────────────────────

describe('NS-1/2 — Fresh post-conversion: inquiry_sent, no payment CTA', () => {
  it('stage = inquiry_sent when status=new, no proposal, paymentState=deposit_required', () => {
    // This is the exact state of a job right after convertInquiryToProjectWorkflow
    const vm = deriveCustomerJobStage(
      'new',
      'deposit_required',
      undefined,     // proposalSentAt
      undefined,     // proposalAcceptedAt
      undefined,     // fundingStatus
      undefined,     // escrowStatus
    )
    expect(vm.stage).toBe('inquiry_sent')
    expect(vm.activeIndex).toBe(0) // first stage
  })

  it('customer next action domain is "job" (not "payment") for fresh job', () => {
    const action = deriveCustomerNextAction(
      'new',
      'deposit_required', // raw paymentState set at conversion
      undefined,
      undefined,
      undefined,
    )
    expect(action.domain).toBe('job')
    expect(action.priority).not.toBe('urgent') // no urgent payment action
  })

  it('customer next action label indicates inquiry state for fresh job', () => {
    const action = deriveCustomerNextAction('new', 'deposit_required', undefined)
    expect(action.label).toContain('Anfrage')
  })

  it('craftsman next action domain is "job" (not "payment") for fresh job', () => {
    const action = deriveNextAction('new', 'deposit_required', undefined)
    expect(action.domain).toBe('job')
  })

  it('craftsman next action label indicates new inquiry for fresh job', () => {
    const action = deriveNextAction('new', 'deposit_required', undefined)
    expect(action.label).toContain('Anfrage')
  })

  it('getActionablePaymentState = undefined for fresh job (gate holds)', () => {
    const job = {
      status: 'new' as const,
      paymentState: 'deposit_required' as const,
      proposalSentAt: undefined,
      proposalAcceptedAt: undefined,
    }
    const result = getActionablePaymentState(job)
    expect(result).toBeUndefined()
  })

  it('deposit_required is NOT actionable: no payment-domain next action for fresh job', () => {
    // Even with deposit_required set, customer must not see payment CTA
    const customerAction = deriveCustomerNextAction('new', 'deposit_required', undefined)
    const craftsmanAction = deriveNextAction('new', 'deposit_required', undefined)

    expect(customerAction.domain).not.toBe('payment')
    expect(craftsmanAction.domain).not.toBe('payment')
  })
})

// ── NS-4: offer_received state (proposal sent) ────────────────────────────────

describe('NS-4 — offer_received: customer urgent, craftsman active, payment still gated', () => {
  const sentAt = Date.now() - 3600_000

  it('stage = offer_received after proposalSentAt set', () => {
    const vm = deriveCustomerJobStage('new', 'deposit_required', sentAt, undefined)
    expect(vm.stage).toBe('offer_received')
    expect(vm.activeIndex).toBe(CUSTOMER_STAGE_ORDER.indexOf('offer_received'))
  })

  it('customer next action priority = urgent when offer received', () => {
    const action = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, undefined)
    expect(action.priority).toBe('urgent')
  })

  it('customer next action label contains "Angebot" when offer received', () => {
    const action = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, undefined)
    expect(action.label).toContain('Angebot')
  })

  it('craftsman next action label contains "Angebot gesendet" when offer sent', () => {
    const action = deriveNextAction('new', 'deposit_required', undefined, sentAt, undefined)
    expect(action.label).toContain('Angebot gesendet')
  })

  it('craftsman next action priority = active (not urgent) when offer sent', () => {
    const action = deriveNextAction('new', 'deposit_required', undefined, sentAt, undefined)
    expect(action.priority).toBe('active')
  })

  it('payment is still NOT actionable at offer_received stage (not yet accepted)', () => {
    const job = {
      status: 'new' as const,
      paymentState: 'deposit_required' as const,
      proposalSentAt: sentAt,
      proposalAcceptedAt: undefined,
    }
    expect(getActionablePaymentState(job)).toBeUndefined()
  })

  it('customer next action domain = "job" at offer_received (no payment CTA yet)', () => {
    const action = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, undefined)
    expect(action.domain).toBe('job')
  })
})

// ── NS-5: Cross-selector agreement at offer_received ─────────────────────────

describe('NS-5 — Cross-selector agreement at offer_received', () => {
  const sentAt = Date.now() - 2000

  it('customerJobStage=offer_received and customerNextAction agree (both read sent state)', () => {
    const stage = deriveCustomerJobStage('new', 'deposit_required', sentAt, undefined)
    const action = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, undefined)

    expect(stage.stage).toBe('offer_received')
    // Customer action must be urgent at offer_received (customer must respond)
    expect(action.priority).toBe('urgent')
    // No split-brain: action domain must not be payment
    expect(action.domain).not.toBe('payment')
  })

  it('deriveNextAction (craftsman) and deriveCustomerNextAction agree that no payment is actionable', () => {
    const craftsman = deriveNextAction('new', 'deposit_required', undefined, sentAt, undefined)
    const customer = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, undefined)

    // Both read job-domain next actions (payment not yet due)
    expect(craftsman.domain).toBe('job')
    expect(customer.domain).toBe('job')
  })

  it('stage activeIndex increases from inquiry_sent to offer_received', () => {
    const before = deriveCustomerJobStage('new', 'deposit_required', undefined, undefined)
    const after = deriveCustomerJobStage('new', 'deposit_required', sentAt, undefined)

    expect(after.activeIndex).toBeGreaterThan(before.activeIndex)
  })
})

// ── NS-7/8: offer_accepted state (payment gate opens) ────────────────────────

describe('NS-7/8 — offer_accepted: payment gate opens', () => {
  const sentAt = Date.now() - 7200_000
  const acceptedAt = Date.now() - 3600_000

  it('stage = offer_accepted after both timestamps set', () => {
    const vm = deriveCustomerJobStage('new', 'deposit_required', sentAt, acceptedAt)
    expect(vm.stage).toBe('offer_accepted')
  })

  it('payment IS actionable after acceptance (gate opens)', () => {
    const job = {
      status: 'new' as const,
      paymentState: 'deposit_required' as const,
      proposalSentAt: sentAt,
      proposalAcceptedAt: acceptedAt,
    }
    expect(getActionablePaymentState(job)).toBe('deposit_required')
  })

  it('customer next action domain = "payment" after acceptance', () => {
    const action = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, acceptedAt)
    expect(action.domain).toBe('payment')
  })

  it('customer next action label contains "Zahlung" or "Einzahlung" after acceptance', () => {
    const action = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, acceptedAt)
    expect(action.label).toMatch(/Zahlung|Einzahlung/)
  })

  it('craftsman next action domain = "payment" after acceptance (deposit required)', () => {
    const action = deriveNextAction('new', 'deposit_required', undefined, sentAt, acceptedAt)
    expect(action.domain).toBe('payment')
  })

  it('customer next action stage has advanced from inquiry_sent', () => {
    const fresh = deriveCustomerJobStage('new', 'deposit_required', undefined, undefined)
    const accepted = deriveCustomerJobStage('new', 'deposit_required', sentAt, acceptedAt)

    expect(accepted.activeIndex).toBeGreaterThan(fresh.activeIndex)
  })

  it('no surface claims inquiry_sent after acceptance', () => {
    const stage = deriveCustomerJobStage('new', 'deposit_required', sentAt, acceptedAt)
    expect(stage.stage).not.toBe('inquiry_sent')
    expect(stage.stage).not.toBe('offer_received')
  })
})

// ── NS-9: deriveProposalReadiness consistency ─────────────────────────────────

describe('NS-9 — deriveProposalReadiness consistent with stage at each lifecycle point', () => {
  it('no proposal → readiness is not proposal_sent or proposal_accepted', () => {
    const job = {
      id: 'j1', projectId: 'p1', title: 'Test', customer: 'K', location: 'L',
      dateLabel: 'D', status: 'new' as const, paymentState: 'deposit_required' as const,
      documentationStatus: '', assignedMemberIds: [], notes: [], photoCount: 0,
      activities: [], craftsmanUserId: CRAFTSMAN_ID, customerUserId: CUSTOMER_USER_ID,
    }
    const vm = deriveProposalReadiness(job)
    expect(vm.readiness).not.toBe('proposal_sent')
    expect(vm.readiness).not.toBe('proposal_accepted')
  })

  it('proposal sent → readiness = proposal_sent', () => {
    const sentAt = Date.now() - 1000
    const job = {
      id: 'j2', projectId: 'p1', title: 'Test', customer: 'K', location: 'L',
      dateLabel: 'D', status: 'new' as const, paymentState: 'deposit_required' as const,
      documentationStatus: '', assignedMemberIds: [], notes: [], photoCount: 0,
      activities: [], craftsmanUserId: CRAFTSMAN_ID, customerUserId: CUSTOMER_USER_ID,
      proposalSentAt: sentAt,
    }
    const vm = deriveProposalReadiness(job)
    expect(vm.readiness).toBe('proposal_sent')
    expect(vm.proposalSentLabel).not.toBeNull()
    expect(vm.proposalAcceptedLabel).toBeNull()
  })

  it('proposal accepted → readiness = proposal_accepted', () => {
    const sentAt = Date.now() - 7200_000
    const acceptedAt = Date.now() - 3600_000
    const job = {
      id: 'j3', projectId: 'p1', title: 'Test', customer: 'K', location: 'L',
      dateLabel: 'D', status: 'new' as const, paymentState: 'deposit_required' as const,
      documentationStatus: '', assignedMemberIds: [], notes: [], photoCount: 0,
      activities: [], craftsmanUserId: CRAFTSMAN_ID, customerUserId: CUSTOMER_USER_ID,
      proposalSentAt: sentAt,
      proposalAcceptedAt: acceptedAt,
    }
    const vm = deriveProposalReadiness(job)
    expect(vm.readiness).toBe('proposal_accepted')
    expect(vm.proposalSentLabel).not.toBeNull()
    expect(vm.proposalAcceptedLabel).not.toBeNull()
  })

  it('deriveProposalState = none for fresh post-conversion job', () => {
    const job = {
      id: 'j4', projectId: 'p1', title: 'Test', customer: 'K', location: 'L',
      dateLabel: 'D', status: 'new' as const, paymentState: 'deposit_required' as const,
      documentationStatus: '', assignedMemberIds: [], notes: [], photoCount: 0,
      activities: [], craftsmanUserId: CRAFTSMAN_ID, customerUserId: CUSTOMER_USER_ID,
    }
    const vm = deriveProposalState(job)
    expect(vm.state).toBe('none')
    expect(vm.hasDraft).toBe(false)
  })

  it('deriveProposalState = sent when proposalSentAt is set', () => {
    const sentAt = Date.now() - 1000
    const job = {
      id: 'j5', projectId: 'p1', title: 'Test', customer: 'K', location: 'L',
      dateLabel: 'D', status: 'new' as const, paymentState: 'deposit_required' as const,
      documentationStatus: '', assignedMemberIds: [], notes: [], photoCount: 0,
      activities: [], craftsmanUserId: CRAFTSMAN_ID, customerUserId: CUSTOMER_USER_ID,
      proposalSentAt: sentAt,
    }
    const vm = deriveProposalState(job)
    expect(vm.state).toBe('sent')
  })

  it('deriveProposalState = accepted when both timestamps are set', () => {
    const sentAt = Date.now() - 7200_000
    const acceptedAt = Date.now() - 3600_000
    const job = {
      id: 'j6', projectId: 'p1', title: 'Test', customer: 'K', location: 'L',
      dateLabel: 'D', status: 'new' as const, paymentState: 'deposit_required' as const,
      documentationStatus: '', assignedMemberIds: [], notes: [], photoCount: 0,
      activities: [], craftsmanUserId: CRAFTSMAN_ID, customerUserId: CUSTOMER_USER_ID,
      proposalSentAt: sentAt,
      proposalAcceptedAt: acceptedAt,
    }
    const vm = deriveProposalState(job)
    expect(vm.state).toBe('accepted')
  })
})

// ── NS-11: Invalid lifecycle is explicit ──────────────────────────────────────

describe('NS-11 — Invalid lifecycle (acceptedAt without sentAt) is explicit', () => {
  const acceptedAt = Date.now() - 1000

  it('stage = inquiry_sent for invalid lifecycle (not silently advanced)', () => {
    const vm = deriveCustomerJobStage('new', undefined, undefined, acceptedAt)
    expect(vm.stage).toBe('inquiry_sent')
  })

  it('customer next action = "Angebot unklar" for invalid lifecycle', () => {
    const action = deriveCustomerNextAction('new', undefined, undefined, undefined, acceptedAt)
    expect(action.label).toContain('Angebot unklar')
  })

  it('craftsman next action contains "Ungültig" for invalid lifecycle', () => {
    const action = deriveNextAction('new', undefined, undefined, undefined, acceptedAt)
    expect(action.label).toContain('Ungültig')
  })

  it('deriveProposalReadiness = proposal_invalid for invalid lifecycle', () => {
    const job = {
      id: 'j-inv', projectId: 'p1', title: 'Test', customer: 'K', location: 'L',
      dateLabel: 'D', status: 'new' as const, paymentState: 'deposit_required' as const,
      documentationStatus: '', assignedMemberIds: [], notes: [], photoCount: 0,
      activities: [], craftsmanUserId: CRAFTSMAN_ID, customerUserId: CUSTOMER_USER_ID,
      proposalSentAt: undefined,
      proposalAcceptedAt: acceptedAt,
    }
    const vm = deriveProposalReadiness(job)
    expect(vm.readiness).toBe('proposal_invalid')
  })
})

// ── NS-13: Funded dominance ───────────────────────────────────────────────────

describe('NS-13 — Funded dominance overrides stale deposit_required', () => {
  const sentAt = Date.now() - 7200_000
  const acceptedAt = Date.now() - 3600_000

  it('customer sees funded-domain CTA when fundingStatus=funded even if paymentState=deposit_required', () => {
    const action = deriveCustomerNextAction(
      'new',
      'deposit_required',
      undefined,
      sentAt,
      acceptedAt,
      'funded',          // fundingStatus
    )
    expect(action.label).toMatch(/gesichert|Zahlung/i)
    // Must NOT show "Einzahlung leisten" (which implies action needed from customer)
    expect(action.label).not.toContain('leisten')
  })

  it('craftsman sees funded-domain CTA when fundingStatus=funded even if paymentState=deposit_required', () => {
    const action = deriveNextAction(
      'new',
      'deposit_required',
      undefined,
      sentAt,
      acceptedAt,
      'funded',          // fundingStatus
    )
    expect(action.label).toMatch(/Zahlung abgesichert|gesichert/i)
  })

  it('stage advances to funded_in_escrow when fundingStatus=funded', () => {
    const vm = deriveCustomerJobStage(
      'new',
      'deposit_required',
      sentAt,
      acceptedAt,
      'funded',
      undefined,
    )
    expect(vm.stage).toBe('funded_in_escrow')
  })
})

// ── NS-14: Funding-in-progress disambiguation ─────────────────────────────────

describe('NS-14 — Funding-in-progress shows "Zahlung wird verarbeitet", not deposit CTA', () => {
  const sentAt = Date.now() - 7200_000
  const acceptedAt = Date.now() - 3600_000

  it('customer: funding_started → "Zahlung wird verarbeitet"', () => {
    const action = deriveCustomerNextAction(
      'new',
      'deposit_required',
      undefined,
      sentAt,
      acceptedAt,
      'funding_started',
    )
    expect(action.label).toContain('Zahlung wird verarbeitet')
  })

  it('customer: funding_initiated → "Zahlung wird verarbeitet"', () => {
    const action = deriveCustomerNextAction(
      'new',
      'deposit_required',
      undefined,
      sentAt,
      acceptedAt,
      'funding_initiated',
    )
    expect(action.label).toContain('Zahlung wird verarbeitet')
  })

  it('craftsman: funding_started → "Zahlung wird verarbeitet"', () => {
    const action = deriveNextAction(
      'new',
      'deposit_required',
      undefined,
      sentAt,
      acceptedAt,
      'funding_started',
    )
    expect(action.label).toContain('Zahlung wird verarbeitet')
  })

  it('funding_in_progress CTAs differ from deposit_required CTA (no ambiguity)', () => {
    const depositAction = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, acceptedAt)
    const fundingAction = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, acceptedAt, 'funding_started')

    expect(fundingAction.label).not.toBe(depositAction.label)
  })
})

// ── NS-15: Terminal states remain terminal ────────────────────────────────────

describe('NS-15 — Terminal states remain terminal', () => {
  it('completed job → idle priority, not urgent/active', () => {
    const action = deriveNextAction('completed', 'released', undefined)
    expect(action.priority).toBe('idle')
  })

  it('cancelled job → idle priority', () => {
    const action = deriveNextAction('cancelled', undefined, undefined)
    expect(action.priority).toBe('idle')
  })

  it('released payment → payment_released stage', () => {
    const sentAt = Date.now() - 10000
    const acceptedAt = Date.now() - 5000
    const vm = deriveCustomerJobStage('completed', 'released', sentAt, acceptedAt)
    expect(vm.stage).toBe('payment_released')
  })

  it('completed/released does not revert to inquiry_sent or offer_received', () => {
    const vm = deriveCustomerJobStage('completed', 'released', undefined, undefined)
    expect(vm.stage).not.toBe('inquiry_sent')
    expect(vm.stage).not.toBe('offer_received')
    expect(vm.stage).not.toBe('offer_accepted')
  })
})

// ---------------------------------------------------------------------------
// Workflow-based integration tests (repositories + workflow functions)
// ---------------------------------------------------------------------------

// ── NS-3/NS-12: createOfferWorkflow stamps proposalSentAt on converted job ───

describe('NS-3/12 — createOfferWorkflow stamps proposalSentAt on converted job', () => {
  it('proposalSentAt is set on the job after createOfferWorkflow (reel-origin)', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const before = getJobById(jobId)!
    expect(before.proposalSentAt).toBeUndefined()

    await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })

    const after = getJobById(jobId)!
    expect(after.proposalSentAt).toBeDefined()
    expect(typeof after.proposalSentAt).toBe('number')
  })

  it('stage transitions from inquiry_sent to offer_received after offer is created', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const stageBefore = deriveCustomerJobStage(
      getJobById(jobId)!.status,
      getJobById(jobId)!.paymentState,
      getJobById(jobId)!.proposalSentAt,
      getJobById(jobId)!.proposalAcceptedAt,
    )
    expect(stageBefore.stage).toBe('inquiry_sent')

    await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })

    const job = getJobById(jobId)!
    const stageAfter = deriveCustomerJobStage(
      job.status, job.paymentState, job.proposalSentAt, job.proposalAcceptedAt,
    )
    expect(stageAfter.stage).toBe('offer_received')
  })

  it('NS-12: reload simulation — re-reading job preserves proposalSentAt', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '2.000 €',
    })

    // "Reload": re-read the same job from the repository (simulates page reload)
    const reloaded = getJobById(jobId)!
    expect(reloaded.proposalSentAt).toBeDefined()

    const stage = deriveCustomerJobStage(
      reloaded.status, reloaded.paymentState, reloaded.proposalSentAt, reloaded.proposalAcceptedAt,
    )
    expect(stage.stage).toBe('offer_received')
  })
})

// ── NS-6: acceptOfferWorkflow stamps proposalAcceptedAt ──────────────────────

describe('NS-6 — acceptOfferWorkflow stamps proposalAcceptedAt', () => {
  it('proposalAcceptedAt is set on the job after acceptOfferWorkflow', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })

    const beforeAccept = getJobById(jobId)!
    expect(beforeAccept.proposalAcceptedAt).toBeUndefined()

    await acceptOfferWorkflow(offer.id)

    const afterAccept = getJobById(jobId)!
    expect(afterAccept.proposalAcceptedAt).toBeDefined()
    expect(typeof afterAccept.proposalAcceptedAt).toBe('number')
  })

  it('stage transitions to offer_accepted after acceptOfferWorkflow', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })

    await acceptOfferWorkflow(offer.id)

    const job = getJobById(jobId)!
    const stage = deriveCustomerJobStage(
      job.status, job.paymentState, job.proposalSentAt, job.proposalAcceptedAt,
    )
    expect(stage.stage).toBe('offer_accepted')
  })

  it('payment becomes actionable after acceptOfferWorkflow', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })

    await acceptOfferWorkflow(offer.id)

    const job = getJobById(jobId)!
    const actionable = getActionablePaymentState(job)
    expect(actionable).not.toBeUndefined()
    expect(actionable).toBe('deposit_required')
  })
})

// ── NS-8: Customer and craftsman both see payment domain CTA after acceptance ─

describe('NS-8 — Customer and craftsman both see payment domain CTA after acceptance', () => {
  it('customer sees payment-domain CTA after acceptance (not job-domain)', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })
    await acceptOfferWorkflow(offer.id)

    const job = getJobById(jobId)!
    const action = deriveCustomerNextAction(
      job.status, job.paymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt,
    )
    expect(action.domain).toBe('payment')
  })

  it('craftsman sees payment-domain CTA after acceptance (not job-domain)', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })
    await acceptOfferWorkflow(offer.id)

    const job = getJobById(jobId)!
    const action = deriveNextAction(
      job.status, job.paymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt,
    )
    expect(action.domain).toBe('payment')
  })

  it('neither customer nor craftsman sees "Anfrage in Prüfung" after acceptance', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })
    await acceptOfferWorkflow(offer.id)

    const job = getJobById(jobId)!
    const customerAction = deriveCustomerNextAction(
      job.status, job.paymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt,
    )
    const craftsmanAction = deriveNextAction(
      job.status, job.paymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt,
    )

    expect(customerAction.label).not.toContain('Anfrage in Prüfung')
    expect(craftsmanAction.label).not.toContain('Neue Anfrage')
  })
})

// ── NS-16: Cross-origin consistency ──────────────────────────────────────────
// Note: reel and builder inquiries use DIFFERENT craftsman IDs to prevent
// findExistingThreadForCraftsman from conflating the two threads (both have
// anonymous customerUserId in tests, so the lookup key is handle-only).

const CRAFTSMAN_ID_B = 'user-craftsman-nsta-b'

const testProviderB: ExploreProviderCard = {
  ...testProvider,
  craftsmanId: CRAFTSMAN_ID_B,
  craftsmanHandle: 'nsta-meister-b',
}

describe('NS-16 — Cross-origin consistency: reel vs builder go through same next-step transitions', () => {
  it('reel-origin and builder-origin jobs both reach offer_received after createOfferWorkflow', async () => {
    // Reel origin (craftsman A)
    const reelThreadId = await startReelInquiryWorkflow(testReel)
    const reelJobId = await convertInquiryToProjectWorkflow(reelThreadId)
    await createOfferWorkflow({
      conversationId: reelThreadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })
    const reelJob = getJobById(reelJobId)!
    const reelStage = deriveCustomerJobStage(
      reelJob.status, reelJob.paymentState, reelJob.proposalSentAt, reelJob.proposalAcceptedAt,
    )

    // Builder origin (craftsman B — different handle to avoid thread reuse)
    const repo = getProjectRepository()
    const project = makeBuilderProject('proj-ns16-builder', { craftsman: CRAFTSMAN_ID_B })
    await repo.add(project)
    const builderThreadId = await startProjectInquiryWorkflowFromProvider(project, testProviderB)
    const builderJobId = await convertInquiryToProjectWorkflow(builderThreadId)
    await createOfferWorkflow({
      conversationId: builderThreadId,
      craftsmanUserId: CRAFTSMAN_ID_B,
      customerUserId: CUSTOMER_USER_ID,
      price: '2.000 €',
    })
    const builderJob = getJobById(builderJobId)!
    const builderStage = deriveCustomerJobStage(
      builderJob.status, builderJob.paymentState, builderJob.proposalSentAt, builderJob.proposalAcceptedAt,
    )

    expect(reelStage.stage).toBe('offer_received')
    expect(builderStage.stage).toBe('offer_received')
  })

  it('both origins reach offer_accepted after acceptOfferWorkflow', async () => {
    // Reel origin (craftsman A)
    const reelThreadId = await startReelInquiryWorkflow(testReel)
    const reelJobId = await convertInquiryToProjectWorkflow(reelThreadId)
    const reelOffer = await createOfferWorkflow({
      conversationId: reelThreadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })
    await acceptOfferWorkflow(reelOffer.id)
    const reelJob = getJobById(reelJobId)!
    const reelStage = deriveCustomerJobStage(
      reelJob.status, reelJob.paymentState, reelJob.proposalSentAt, reelJob.proposalAcceptedAt,
    )

    // Builder origin (craftsman B)
    const repo = getProjectRepository()
    const project = makeBuilderProject('proj-ns16-builder-accept', { craftsman: CRAFTSMAN_ID_B })
    await repo.add(project)
    const builderThreadId = await startProjectInquiryWorkflowFromProvider(project, testProviderB)
    const builderJobId = await convertInquiryToProjectWorkflow(builderThreadId)
    const builderOffer = await createOfferWorkflow({
      conversationId: builderThreadId,
      craftsmanUserId: CRAFTSMAN_ID_B,
      customerUserId: CUSTOMER_USER_ID,
      price: '2.000 €',
    })
    await acceptOfferWorkflow(builderOffer.id)
    const builderJob = getJobById(builderJobId)!
    const builderStage = deriveCustomerJobStage(
      builderJob.status, builderJob.paymentState, builderJob.proposalSentAt, builderJob.proposalAcceptedAt,
    )

    expect(reelStage.stage).toBe('offer_accepted')
    expect(builderStage.stage).toBe('offer_accepted')
  })

  it('both origins: proposalReadiness = proposal_accepted after acceptOfferWorkflow', async () => {
    // Reel origin (craftsman A)
    const reelThreadId = await startReelInquiryWorkflow(testReel)
    const reelJobId = await convertInquiryToProjectWorkflow(reelThreadId)
    const reelOffer = await createOfferWorkflow({
      conversationId: reelThreadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '1.500 €',
    })
    await acceptOfferWorkflow(reelOffer.id)
    const reelReadiness = deriveProposalReadiness(getJobById(reelJobId)!)

    // Builder origin (craftsman B)
    const repo = getProjectRepository()
    const project = makeBuilderProject('proj-ns16-readiness', { craftsman: CRAFTSMAN_ID_B })
    await repo.add(project)
    const builderThreadId = await startProjectInquiryWorkflowFromProvider(project, testProviderB)
    const builderJobId = await convertInquiryToProjectWorkflow(builderThreadId)
    const builderOffer = await createOfferWorkflow({
      conversationId: builderThreadId,
      craftsmanUserId: CRAFTSMAN_ID_B,
      customerUserId: CUSTOMER_USER_ID,
      price: '2.000 €',
    })
    await acceptOfferWorkflow(builderOffer.id)
    const builderReadiness = deriveProposalReadiness(getJobById(builderJobId)!)

    expect(reelReadiness.readiness).toBe('proposal_accepted')
    expect(builderReadiness.readiness).toBe('proposal_accepted')
  })
})

// ── Full lifecycle smoke test ─────────────────────────────────────────────────

describe('Full corridor smoke test — inquiry_sent → offer_received → offer_accepted', () => {
  it('reel-origin: stage advances correctly through the full pre-payment corridor', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    // Phase 1: fresh post-conversion
    const jobPhase1 = getJobById(jobId)!
    expect(deriveCustomerJobStage(
      jobPhase1.status, jobPhase1.paymentState, jobPhase1.proposalSentAt, jobPhase1.proposalAcceptedAt,
    ).stage).toBe('inquiry_sent')
    expect(getActionablePaymentState(jobPhase1)).toBeUndefined()

    // Phase 2: offer sent
    const offer = await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: CRAFTSMAN_ID,
      customerUserId: CUSTOMER_USER_ID,
      price: '3.000 €',
    })
    const jobPhase2 = getJobById(jobId)!
    expect(deriveCustomerJobStage(
      jobPhase2.status, jobPhase2.paymentState, jobPhase2.proposalSentAt, jobPhase2.proposalAcceptedAt,
    ).stage).toBe('offer_received')
    expect(getActionablePaymentState(jobPhase2)).toBeUndefined() // still gated

    // Phase 3: offer accepted
    await acceptOfferWorkflow(offer.id)
    const jobPhase3 = getJobById(jobId)!
    expect(deriveCustomerJobStage(
      jobPhase3.status, jobPhase3.paymentState, jobPhase3.proposalSentAt, jobPhase3.proposalAcceptedAt,
    ).stage).toBe('offer_accepted')
    expect(getActionablePaymentState(jobPhase3)).toBe('deposit_required') // gate open

    // Validate monotonic stage progression
    const stageIndex = (j: typeof jobPhase1) =>
      CUSTOMER_STAGE_ORDER.indexOf(
        deriveCustomerJobStage(j.status, j.paymentState, j.proposalSentAt, j.proposalAcceptedAt).stage
      )

    expect(stageIndex(jobPhase1)).toBeLessThan(stageIndex(jobPhase2))
    expect(stageIndex(jobPhase2)).toBeLessThan(stageIndex(jobPhase3))
  })
})
