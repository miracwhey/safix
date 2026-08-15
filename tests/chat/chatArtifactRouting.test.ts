import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getArtifactRoute,
  isKnownArtifactType,
  KNOWN_ARTIFACT_TYPES,
} from '../../src/components/chat/chatArtifactRouting'
import type { ChatRole } from '../../src/lib/chat'

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
}))

import { logError } from '../../src/lib/observability'

const ID = 'art-123'

describe('chatArtifactRouting — getArtifactRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Project', () => {
    // Customer (project owner) opens their own project surface.
    it.each([
      ['customer' as ChatRole, 'active'],
      ['customer' as ChatRole, undefined],
    ])('role=%s state=%s → /projects/{id}', (role, state) => {
      expect(getArtifactRoute({ artifactType: 'Project', artifactId: ID, role, state })).toBe(
        `/projects/${ID}`,
      )
    })

    // Recipient craftsman/worker/owner inspect the shared project via the
    // craftsman request-detail view (the customer route would 404 for them).
    it.each([
      ['craftsman' as ChatRole, 'completed'],
      ['worker' as ChatRole, 'request'],
      ['owner' as ChatRole, 'in_progress'],
    ])('role=%s state=%s → /craftsman/request/{id}', (role, state) => {
      expect(getArtifactRoute({ artifactType: 'Project', artifactId: ID, role, state })).toBe(
        `/craftsman/request/${ID}`,
      )
    })
  })

  describe('OfferPayment', () => {
    it('customer + sent → /quotes/{id}', () => {
      expect(
        getArtifactRoute({ artifactType: 'OfferPayment', artifactId: ID, role: 'customer', state: 'sent' }),
      ).toBe(`/quotes/${ID}`)
    })

    it('customer + pending → /quotes/{id}', () => {
      expect(
        getArtifactRoute({ artifactType: 'OfferPayment', artifactId: ID, role: 'customer', state: 'pending' }),
      ).toBe(`/quotes/${ID}`)
    })

    it.each([
      ['craftsman' as ChatRole],
      ['worker' as ChatRole],
      ['owner' as ChatRole],
    ])('%s + sent → /craftsman/quotes/{id}', (role) => {
      expect(
        getArtifactRoute({ artifactType: 'OfferPayment', artifactId: ID, role, state: 'sent' }),
      ).toBe(`/craftsman/quotes/${ID}`)
    })

    it.each([
      ['customer' as ChatRole],
      ['craftsman' as ChatRole],
      ['worker' as ChatRole],
    ])('%s + accepted → /quotes/{id} (canonical read-only)', (role) => {
      expect(
        getArtifactRoute({ artifactType: 'OfferPayment', artifactId: ID, role, state: 'accepted' }),
      ).toBe(`/quotes/${ID}`)
    })

    it.each([
      ['declined'],
      ['cancelled'],
    ])('any role + %s → /quotes/{id}', (state) => {
      expect(
        getArtifactRoute({ artifactType: 'OfferPayment', artifactId: ID, role: 'craftsman', state }),
      ).toBe(`/quotes/${ID}`)
    })

    // Payment-due offers do NOT deep-link to /funding (the card carries the
    // OFFER id, not a funding-request id). Payment is reached from the quote
    // detail — role-aware, like every other offer state (fixed 2026-06-23).
    it.each([
      ['customer' as ChatRole, 'payment_due'],
      ['customer' as ChatRole, 'diagnosis_payment_due'],
    ])('role=%s state=%s → /quotes/{id}', (role, state) => {
      expect(
        getArtifactRoute({ artifactType: 'OfferPayment', artifactId: ID, role, state }),
      ).toBe(`/quotes/${ID}`)
    })

    it.each([
      ['craftsman' as ChatRole, 'payment_due'],
      ['craftsman' as ChatRole, 'diagnosis_payment_due'],
    ])('role=%s state=%s → /craftsman/quotes/{id}', (role, state) => {
      expect(
        getArtifactRoute({ artifactType: 'OfferPayment', artifactId: ID, role, state }),
      ).toBe(`/craftsman/quotes/${ID}`)
    })

    it('documentType does not change sent route — both binding and diagnosis route per role', () => {
      const binding = getArtifactRoute({
        artifactType: 'OfferPayment',
        artifactId: ID,
        role: 'craftsman',
        state: 'sent',
        documentType: 'binding_offer',
      })
      const diagnosis = getArtifactRoute({
        artifactType: 'OfferPayment',
        artifactId: ID,
        role: 'craftsman',
        state: 'sent',
        documentType: 'diagnosis',
      })
      expect(binding).toBe(`/craftsman/quotes/${ID}`)
      expect(diagnosis).toBe(`/craftsman/quotes/${ID}`)
    })
  })

  describe('FundingStep', () => {
    it.each([
      ['customer' as ChatRole, 'sent'],
      ['craftsman' as ChatRole, 'funding_started'],
      ['customer' as ChatRole, 'funded'],
      ['craftsman' as ChatRole, 'funding_failed'],
      ['customer' as ChatRole, 'cancelled'],
      ['worker' as ChatRole, 'expired'],
      ['customer' as ChatRole, undefined],
    ])('role=%s state=%s → /funding/{id}', (role, state) => {
      // Canonical 2-segment funding entry (buildFundingEntryPath). The old
      // 3-segment /funding/request/{id} never matched /funding/:id and dead-
      // ended at the catch-all → home (fixed 2026-06-23).
      expect(
        getArtifactRoute({ artifactType: 'FundingStep', artifactId: ID, role, state }),
      ).toBe(`/funding/${ID}`)
    })
  })

  describe('ChangeOrder', () => {
    it('customer + pending → /nachtrag/{id}', () => {
      expect(
        getArtifactRoute({ artifactType: 'ChangeOrder', artifactId: ID, role: 'customer', state: 'pending' }),
      ).toBe(`/nachtrag/${ID}`)
    })

    it.each([
      ['craftsman' as ChatRole],
      ['worker' as ChatRole],
      ['owner' as ChatRole],
    ])('%s + pending → /craftsman/nachtrag/{id}', (role) => {
      expect(
        getArtifactRoute({ artifactType: 'ChangeOrder', artifactId: ID, role, state: 'pending' }),
      ).toBe(`/craftsman/nachtrag/${ID}`)
    })

    it.each([
      ['accepted'],
      ['declined'],
      ['cancelled'],
    ])('any role + %s → /nachtrag/{id} (canonical)', (state) => {
      for (const role of ['customer', 'craftsman', 'worker', 'owner'] as ChatRole[]) {
        expect(
          getArtifactRoute({ artifactType: 'ChangeOrder', artifactId: ID, role, state }),
        ).toBe(`/nachtrag/${ID}`)
      }
    })
  })

  describe('Invoice', () => {
    it('customer → /rechnung/{id}', () => {
      expect(
        getArtifactRoute({ artifactType: 'Invoice', artifactId: ID, role: 'customer', state: 'sent' }),
      ).toBe(`/rechnung/${ID}`)
    })

    it.each([
      ['craftsman' as ChatRole],
      ['worker' as ChatRole],
      ['owner' as ChatRole],
    ])('%s → /craftsman/rechnung/{id}', (role) => {
      expect(
        getArtifactRoute({ artifactType: 'Invoice', artifactId: ID, role, state: 'sent' }),
      ).toBe(`/craftsman/rechnung/${ID}`)
    })

    // Role-aware, lifecycle-state-agnostic: the invoice card always opens the
    // role's Rechnung detail regardless of status.
    it.each([
      ['issued'],
      ['sent'],
      ['paid'],
      ['cancelled'],
    ])('customer + %s → /rechnung/{id}', (state) => {
      expect(
        getArtifactRoute({ artifactType: 'Invoice', artifactId: ID, role: 'customer', state }),
      ).toBe(`/rechnung/${ID}`)
    })
  })

  describe('Fallback (unknown artifactType)', () => {
    it('unknown artifactType → "/" + logError invoked', () => {
      const path = getArtifactRoute({
        artifactType: 'Rating',
        artifactId: ID,
        role: 'customer',
        state: 'submitted',
      })
      expect(path).toBe('/')
      expect(logError).toHaveBeenCalledWith(
        'chat.unknown_artifact_route',
        expect.any(Error),
        expect.objectContaining({ artifactType: 'Rating', artifactId: ID }),
      )
    })

    it('empty artifactType → "/" + logError invoked', () => {
      const path = getArtifactRoute({
        artifactType: '',
        artifactId: ID,
        role: 'customer',
      })
      expect(path).toBe('/')
      expect(logError).toHaveBeenCalled()
    })
  })
})

describe('chatArtifactRouting — isKnownArtifactType', () => {
  it.each([['Project'], ['OfferPayment'], ['FundingStep'], ['ChangeOrder'], ['Invoice']])(
    '%s is known',
    (type) => {
      expect(isKnownArtifactType(type)).toBe(true)
    },
  )

  it.each([['Rating'], ['Dispute'], ['random'], ['']])('%s is not known', (type) => {
    expect(isKnownArtifactType(type)).toBe(false)
  })

  it('KNOWN_ARTIFACT_TYPES exposes exactly 5 canonical types', () => {
    expect(KNOWN_ARTIFACT_TYPES).toHaveLength(5)
    expect(KNOWN_ARTIFACT_TYPES).toEqual([
      'Project',
      'OfferPayment',
      'FundingStep',
      'ChangeOrder',
      'Invoice',
    ])
  })
})
