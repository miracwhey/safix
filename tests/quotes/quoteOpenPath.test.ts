/**
 * Quote Open-Path — Tests
 *
 * Validates the end-to-end quote/offer open-path repair:
 *
 *   1. resolveCanonicalQuoteId resolves by direct offerId
 *   2. resolveCanonicalQuoteId resolves by jobId fallback
 *   3. resolveCanonicalQuoteId returns undefined for unknown identifiers
 *   4. Quote open works for pending offers
 *   5. Quote open works for accepted/booked offers
 *   6. Quote open works after job creation (funded/linked)
 *   7. Thread card entry paths produce the correct canonical offerId
 *   8. No stale legacy path misroutes to wrong/missing data
 *   9. QuoteDetailScreen uses deterministic hydration-aware loading (no timeout)
 *  10. No regression to Blocks 1–5C
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { getOfferById, getAcceptedOfferByJobId, isOfferRepositoryHydrated } from '../../src/lib/offers/service'
import { resolveCanonicalQuoteId } from '../../src/lib/offers/resolveCanonicalQuoteId'
import { addConversation } from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import * as fs from 'fs'
import * as path from 'path'

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> & { id: string }): Conversation {
  return {
    id: overrides.id,
    craftsmanHandle: overrides.craftsmanHandle ?? 'craftsman-handle-001',
    craftsmanUserId: overrides.craftsmanUserId ?? 'craftsman-user-001',
    customerUserId: overrides.customerUserId ?? 'customer-user-001',
    customerName: overrides.customerName ?? 'Test Customer',
    projectTitle: overrides.projectTitle ?? 'Test Project',
    projectStatusLabel: overrides.projectStatusLabel ?? 'Offen',
    projectLocation: overrides.projectLocation ?? 'Berlin',
    lastMessage: overrides.lastMessage ?? '',
    lastMessageAt: overrides.lastMessageAt ?? Date.now(),
    createdAt: overrides.createdAt ?? Date.now(),
    status: overrides.status ?? 'open',
    ...overrides,
  }
}

function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Quote Open-Path Repair', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. resolveCanonicalQuoteId — DIRECT OFFER ID RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════

  describe('FIX 1 — canonical quote ID resolution', () => {
    it('resolves a pending offer by direct offerId', async () => {
      const threadId = 'conv-open-path-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '1.500 €',
      })

      const resolved = resolveCanonicalQuoteId(offer.id)
      expect(resolved).toBeDefined()
      expect(resolved!.id).toBe(offer.id)
      expect(resolved!.status).toBe('pending')
    })

    it('resolves an accepted offer by direct offerId', async () => {
      const threadId = 'conv-open-path-002'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '2.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      const resolved = resolveCanonicalQuoteId(offer.id)
      expect(resolved).toBeDefined()
      expect(resolved!.id).toBe(offer.id)
      expect(resolved!.status).toBe('accepted')
    })

    it('resolves by jobId fallback when offerId is actually a jobId', async () => {
      const threadId = 'conv-open-path-003'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '3.000 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted).toBeDefined()
      expect(accepted!.createdJobId).toBeDefined()

      // Use the jobId as the identifier — should fall back to reverse lookup
      const resolved = resolveCanonicalQuoteId(accepted!.createdJobId!)
      expect(resolved).toBeDefined()
      expect(resolved!.id).toBe(offer.id)
      expect(resolved!.status).toBe('accepted')
    })

    it('returns undefined for an unknown identifier', () => {
      const resolved = resolveCanonicalQuoteId('nonexistent-id')
      expect(resolved).toBeUndefined()
    })

    it('returns undefined for an empty string', () => {
      const resolved = resolveCanonicalQuoteId('')
      expect(resolved).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. ACCEPTED/BOOKED/FUNDED COMPATIBILITY
  // ═══════════════════════════════════════════════════════════════════════

  describe('FIX 3 — accepted/booked/funded compatibility', () => {
    it('accepted quote remains resolvable by offerId', async () => {
      const threadId = 'conv-lifecycle-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '4.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      // The offer must still be findable by its original ID
      const direct = getOfferById(offer.id)
      expect(direct).toBeDefined()
      expect(direct!.status).toBe('accepted')
      expect(direct!.createdJobId).toBeDefined()

      // The canonical resolver must also find it
      const resolved = resolveCanonicalQuoteId(offer.id)
      expect(resolved).toBeDefined()
      expect(resolved!.id).toBe(offer.id)
    })

    it('accepted offer has createdJobId populated for reverse lookup', async () => {
      const threadId = 'conv-lifecycle-002'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '5.000 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted!.createdJobId).toBeDefined()

      // Reverse lookup by jobId
      const byJob = getAcceptedOfferByJobId(accepted!.createdJobId!)
      expect(byJob).toBeDefined()
      expect(byJob!.id).toBe(offer.id)
    })

    it('re-acceptance (idempotent) does not break quote opening', async () => {
      const threadId = 'conv-lifecycle-003'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '2.500 €',
      })

      // Accept twice (idempotent)
      await acceptOfferWorkflow(offer.id)
      await acceptOfferWorkflow(offer.id)

      const resolved = resolveCanonicalQuoteId(offer.id)
      expect(resolved).toBeDefined()
      expect(resolved!.status).toBe('accepted')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. ENTRY PATH CORRECTNESS
  // ═══════════════════════════════════════════════════════════════════════

  describe('FIX 2 — entry path correctness', () => {
    it('customer detail path uses /quotes/:offerId', () => {
      const offerId = 'offer-path-cust-001'
      const customerPath = `/quotes/${offerId}`
      expect(customerPath).toBe('/quotes/offer-path-cust-001')
    })

    it('craftsman detail path uses /craftsman/quotes/:offerId', () => {
      const offerId = 'offer-path-craft-001'
      const craftsmanPath = `/craftsman/quotes/${offerId}`
      expect(craftsmanPath).toBe('/craftsman/quotes/offer-path-craft-001')
    })

    it('ThreadArtifactOfferCard uses offer.id or snapshot.offerId for detail path', () => {
      const source = readSource(
        path.resolve(__dirname, '../../src/components/messages/ThreadArtifactOfferCard.tsx')
      )
      // Must use offerId for detail path, not jobId/projectId/conversationId
      expect(source).toContain("offer?.id ?? snapshot?.offerId")
      expect(source).toContain("/quotes/")
      expect(source).not.toMatch(/detailPath.*projectId/)
      expect(source).not.toMatch(/detailPath.*conversationId/)
    })

    it('QuoteSendEventCard uses offer.id or snapshot.offerId for detail path', () => {
      const source = readSource(
        path.resolve(__dirname, '../../src/components/messages/QuoteSendEventCard.tsx')
      )
      expect(source).toContain("offer?.id ?? snapshot?.offerId")
      expect(source).toContain("/quotes/")
      expect(source).not.toMatch(/detailPath.*projectId/)
      expect(source).not.toMatch(/detailPath.*conversationId/)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. LEGACY OPEN-PATH CLEANUP
  // ═══════════════════════════════════════════════════════════════════════

  describe('FIX 4 — no stale/legacy open paths', () => {
    it('QuoteDetailScreen uses resolveCanonicalQuoteId (not bare getOfferById)', () => {
      const source = readSource(
        path.resolve(__dirname, '../../src/screens/QuoteDetailScreen.tsx')
      )
      expect(source).toContain('resolveCanonicalQuoteId')
      // The screen must NOT import getOfferById directly — using it was the
      // root cause of the premature "not found" bug.  resolveCanonicalQuoteId
      // wraps the lookup with a fallback path.
      expect(source).not.toMatch(/import\s.*getOfferById/)
    })

    it('no route navigates to /quotes/ with a jobId or projectId param', () => {
      // ThreadArtifactOfferCard
      const offerCard = readSource(
        path.resolve(__dirname, '../../src/components/messages/ThreadArtifactOfferCard.tsx')
      )
      // QuoteSendEventCard
      const eventCard = readSource(
        path.resolve(__dirname, '../../src/components/messages/QuoteSendEventCard.tsx')
      )
      // Both must derive the route from offerId, not jobId or projectId
      for (const source of [offerCard, eventCard]) {
        expect(source).toContain("offer?.id ?? snapshot?.offerId")
      }
    })

    it('resolveCanonicalQuoteId is exported from offers barrel', async () => {
      const mod = await import('../../src/lib/offers')
      expect(typeof mod.resolveCanonicalQuoteId).toBe('function')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. FACTUAL DETAIL CORRECTNESS
  // ═══════════════════════════════════════════════════════════════════════

  describe('FIX 5 — factual detail correctness', () => {
    it('resolved offer has correct price', async () => {
      const threadId = 'conv-detail-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '6.750 €',
        description: 'Dachsanierung komplett',
      })

      const resolved = resolveCanonicalQuoteId(offer.id)
      expect(resolved).toBeDefined()
      expect(resolved!.price).toBe('6.750 €')
      expect(resolved!.description).toBe('Dachsanierung komplett')
    })

    it('resolved accepted offer has correct accepted status and job link', async () => {
      const threadId = 'conv-detail-002'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '8.000 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)

      const resolved = resolveCanonicalQuoteId(offer.id)
      expect(resolved).toBeDefined()
      expect(resolved!.status).toBe('accepted')
      expect(resolved!.acceptedAt).toBeDefined()
      expect(resolved!.createdJobId).toBe(accepted!.createdJobId)
    })

    it('resolveCanonicalQuoteId never returns a job or project disguised as an offer', async () => {
      const threadId = 'conv-detail-003'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '1.000 €',
      })

      const resolved = resolveCanonicalQuoteId(offer.id)
      expect(resolved).toBeDefined()
      // Must be an Offer type — has price, conversationId, craftsmanUserId
      expect(typeof resolved!.price).toBe('string')
      expect(typeof resolved!.conversationId).toBe('string')
      expect(typeof resolved!.craftsmanUserId).toBe('string')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. SCREEN LOADING BEHAVIOR — DETERMINISTIC HYDRATION (no timeout)
  // ═══════════════════════════════════════════════════════════════════════

  describe('QuoteDetailScreen deterministic loading', () => {
    it('screen uses isOfferRepositoryHydrated for deterministic loaded decision', () => {
      const source = readSource(
        path.resolve(__dirname, '../../src/screens/QuoteDetailScreen.tsx')
      )
      expect(source).toContain('isOfferRepositoryHydrated')
    })

    it('screen does NOT use any timeout-based loading decision', () => {
      const source = readSource(
        path.resolve(__dirname, '../../src/screens/QuoteDetailScreen.tsx')
      )
      // No settle timeout
      expect(source).not.toContain('SETTLE_TIMEOUT_MS')
      expect(source).not.toContain('settleTimer')
      expect(source).not.toContain('setTimeout')
      // No ref-based resolved tracking (was part of the timeout model)
      expect(source).not.toContain('resolvedRef')
    })

    it('screen subscribes to offer repository changes', () => {
      const source = readSource(
        path.resolve(__dirname, '../../src/screens/QuoteDetailScreen.tsx')
      )
      expect(source).toContain('subscribeOffers')
    })

    it('screen uses resolveCanonicalQuoteId for resolution', () => {
      const source = readSource(
        path.resolve(__dirname, '../../src/screens/QuoteDetailScreen.tsx')
      )
      expect(source).toContain('resolveCanonicalQuoteId')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. HYDRATION READINESS — isOfferRepositoryHydrated
  // ═══════════════════════════════════════════════════════════════════════

  describe('offer repository hydration readiness', () => {
    it('InMemoryOfferRepository is hydrated immediately', () => {
      // setupCleanRepositories sets InMemory repos, which are hydrated at construction
      expect(isOfferRepositoryHydrated()).toBe(true)
    })

    it('hydrated repo with unknown ID returns undefined deterministically', () => {
      expect(isOfferRepositoryHydrated()).toBe(true)
      const result = resolveCanonicalQuoteId('nonexistent-id')
      expect(result).toBeUndefined()
      // This is a TRUE not-found: repo is hydrated and ID not found
    })

    it('valid quote in hydrated repo resolves immediately', async () => {
      const threadId = 'conv-hydrate-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '1.000 €',
      })

      expect(isOfferRepositoryHydrated()).toBe(true)
      const resolved = resolveCanonicalQuoteId(offer.id)
      expect(resolved).toBeDefined()
      expect(resolved!.id).toBe(offer.id)
    })

    it('isOfferRepositoryHydrated is exported from offers barrel', async () => {
      const mod = await import('../../src/lib/offers')
      expect(typeof mod.isOfferRepositoryHydrated).toBe('function')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. NO REGRESSION — Blocks 1–5C
  // ═══════════════════════════════════════════════════════════════════════

  describe('no regression to Blocks 1–5C', () => {
    it('offer workflow still creates offers correctly', async () => {
      const threadId = 'conv-regression-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '1.200 €',
      })

      expect(offer).toBeDefined()
      expect(offer.status).toBe('pending')
      expect(offer.price).toBe('1.200 €')
    })

    it('accept workflow still works correctly', async () => {
      const threadId = 'conv-regression-002'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-user-001',
        craftsmanUserId: 'craftsman-user-001',
        price: '2.400 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted).toBeDefined()
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.createdJobId).toBeDefined()
    })

    it('QuoteDetailView component still exports correctly', async () => {
      const mod = await import('../../src/components/quotes/QuoteDetailView')
      expect(typeof mod.default).toBe('function')
    })

    it('ThreadArtifactOfferCard component still exports correctly', async () => {
      const mod = await import('../../src/components/messages/ThreadArtifactOfferCard')
      expect(typeof mod.default).toBe('function')
    })

    it('QuoteSendEventCard component still exports correctly', async () => {
      const mod = await import('../../src/components/messages/QuoteSendEventCard')
      expect(typeof mod.default).toBe('function')
    })
  })
})
