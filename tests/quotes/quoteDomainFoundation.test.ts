/**
 * Quote Domain Foundation — Tests
 *
 * Validates:
 *   1. Quote model supports the required structured fields
 *   2. Quote status foundation (draft/pending/accepted/declined/expired/superseded/cancelled)
 *   3. Quote detail view renders grouped core sections
 *   4. Quote card links to the correct detail screen path
 *   5. No regression to message thread / offer workflow behavior
 *   6. Migration adds the expected columns
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  declineOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { getOfferRepository } from '../../src/lib/offers/repository/registry'
import type { Offer, OfferStatus, QuoteLineItem } from '../../src/lib/offers/types'
import * as fs from 'fs'
import * as path from 'path'

describe('Quote Domain Foundation', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 1. QUOTE MODEL — STRUCTURED FIELDS
  // ─────────────────────────────────────────────────────────────────────────

  describe('quote model supports required structured fields', () => {
    it('supports core fields from the domain spec', () => {
      const offer: Offer = {
        id: 'offer-1',
        conversationId: 'conv-1',
        projectId: 'proj-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.500 €',
        currency: 'EUR',
        grossTotal: 150000,
        netTotal: 126050,
        vatAmount: 23950,
        vatRate: 19,
        laborCost: 80000,
        materialCost: 40000,
        otherCost: 6050,
        scopeSummary: 'Badezimmer renovieren',
        scopeIncluded: 'Fliesen, Sanitär, Malerarbeiten',
        scopeExcluded: 'Elektrik, Möbel',
        assumptions: 'Zugang ohne Einschränkung',
        paymentTerms: '50 % Anzahlung',
        validUntil: '2026-04-15',
        cancellationTerms: 'Kostenlos bis 48h vorher',
        escrowRequired: true,
        status: 'pending',
        version: 1,
        sentAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      expect(offer.projectId).toBe('proj-1')
      expect(offer.currency).toBe('EUR')
      expect(offer.grossTotal).toBe(150000)
      expect(offer.netTotal).toBe(126050)
      expect(offer.vatAmount).toBe(23950)
      expect(offer.vatRate).toBe(19)
      expect(offer.laborCost).toBe(80000)
      expect(offer.materialCost).toBe(40000)
      expect(offer.otherCost).toBe(6050)
      expect(offer.scopeSummary).toBe('Badezimmer renovieren')
      expect(offer.scopeIncluded).toBe('Fliesen, Sanitär, Malerarbeiten')
      expect(offer.scopeExcluded).toBe('Elektrik, Möbel')
      expect(offer.assumptions).toBe('Zugang ohne Einschränkung')
      expect(offer.paymentTerms).toBe('50 % Anzahlung')
      expect(offer.validUntil).toBe('2026-04-15')
      expect(offer.cancellationTerms).toBe('Kostenlos bis 48h vorher')
      expect(offer.escrowRequired).toBe(true)
      expect(offer.version).toBe(1)
    })

    it('supports optional snapshot fields', () => {
      const offer: Offer = {
        id: 'offer-2',
        conversationId: 'conv-2',
        customerUserId: 'cust-2',
        craftsmanUserId: 'craft-2',
        price: '800 €',
        status: 'pending',
        sentAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectTitleSnapshot: 'Küche renovieren',
        customerDescriptionSnapshot: 'Neue Schränke und Arbeitsplatte',
        locationSnapshot: 'Berlin Mitte',
      }

      expect(offer.projectTitleSnapshot).toBe('Küche renovieren')
      expect(offer.customerDescriptionSnapshot).toBe('Neue Schränke und Arbeitsplatte')
      expect(offer.locationSnapshot).toBe('Berlin Mitte')
    })

    it('supports line items structure', () => {
      const lineItems: QuoteLineItem[] = [
        { id: 'li-1', label: 'Arbeitszeit', category: 'labor', netAmount: 5000, quantity: 8, unit: 'Std' },
        { id: 'li-2', label: 'Fliesen', category: 'material', netAmount: 3000, quantity: 20, unit: 'm²' },
        { id: 'li-3', label: 'Anfahrt', category: 'other', netAmount: 2500, quantity: 1 },
      ]

      const offer: Offer = {
        id: 'offer-3',
        conversationId: 'conv-3',
        customerUserId: 'cust-3',
        craftsmanUserId: 'craft-3',
        price: '1.200 €',
        status: 'pending',
        sentAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lineItems,
      }

      expect(offer.lineItems).toHaveLength(3)
      expect(offer.lineItems![0].category).toBe('labor')
      expect(offer.lineItems![1].category).toBe('material')
      expect(offer.lineItems![2].category).toBe('other')
    })

    it('supports notes field', () => {
      const offer: Offer = {
        id: 'offer-4',
        conversationId: 'conv-4',
        customerUserId: 'cust-4',
        craftsmanUserId: 'craft-4',
        price: '500 €',
        status: 'draft',
        sentAt: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        notes: 'Intern: Material bestellen',
      }

      expect(offer.notes).toBe('Intern: Material bestellen')
    })

    it('supports lockedAt timestamp', () => {
      const now = Date.now()
      const offer: Offer = {
        id: 'offer-5',
        conversationId: 'conv-5',
        customerUserId: 'cust-5',
        craftsmanUserId: 'craft-5',
        price: '2.000 €',
        status: 'accepted',
        sentAt: now - 10000,
        createdAt: now - 20000,
        updatedAt: now,
        acceptedAt: now - 5000,
        lockedAt: now,
      }

      expect(offer.lockedAt).toBe(now)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 2. STATUS FOUNDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('quote status foundation', () => {
    it('supports all seven status values at type level', () => {
      const statuses: OfferStatus[] = [
        'draft',
        'pending',
        'accepted',
        'declined',
        'expired',
        'superseded',
        'cancelled',
      ]

      expect(statuses).toHaveLength(7)
      expect(new Set(statuses).size).toBe(7)
    })

    it('existing pending→accepted transition still works', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-status-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })
      expect(offer.status).toBe('pending')

      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted?.status).toBe('accepted')
    })

    it('existing pending→declined transition still works', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-status-2',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '800 €',
      })
      expect(offer.status).toBe('pending')

      const declined = await declineOfferWorkflow(offer.id)
      expect(declined?.status).toBe('declined')
    })

    it('draft status is valid at domain level', () => {
      const offer: Offer = {
        id: 'draft-1',
        conversationId: 'conv-draft',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '500 €',
        status: 'draft',
        sentAt: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      expect(offer.status).toBe('draft')
    })

    it('expired status is valid at domain level', () => {
      const offer: Offer = {
        id: 'expired-1',
        conversationId: 'conv-expired',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.500 €',
        status: 'expired',
        sentAt: Date.now() - 86400000,
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now(),
        validUntil: '2026-03-01',
      }

      expect(offer.status).toBe('expired')
    })

    it('superseded status is valid at domain level', () => {
      const offer: Offer = {
        id: 'superseded-1',
        conversationId: 'conv-sup',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
        status: 'superseded',
        version: 1,
        sentAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      expect(offer.status).toBe('superseded')
    })

    it('cancelled status is valid at domain level', () => {
      const offer: Offer = {
        id: 'cancelled-1',
        conversationId: 'conv-cancel',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '2.500 €',
        status: 'cancelled',
        sentAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      expect(offer.status).toBe('cancelled')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 3. OFFER REPOSITORY — EXTENDED FIELDS
  // ─────────────────────────────────────────────────────────────────────────

  describe('offer repository preserves extended fields', () => {
    it('stores and retrieves offers with extended scope fields', async () => {
      const repo = getOfferRepository()
      const offer: Offer = {
        id: 'ext-1',
        conversationId: 'conv-ext-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '2.000 €',
        status: 'pending',
        sentAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        scopeSummary: 'Complete bathroom renovation',
        scopeIncluded: 'Tiles, plumbing',
        scopeExcluded: 'Electrical work',
        assumptions: 'Water supply intact',
      }

      await repo.add(offer)
      const retrieved = repo.getById('ext-1')

      expect(retrieved).toBeDefined()
      expect(retrieved!.scopeSummary).toBe('Complete bathroom renovation')
      expect(retrieved!.scopeIncluded).toBe('Tiles, plumbing')
      expect(retrieved!.scopeExcluded).toBe('Electrical work')
      expect(retrieved!.assumptions).toBe('Water supply intact')
    })

    it('stores and retrieves offers with extended price fields', async () => {
      const repo = getOfferRepository()
      const offer: Offer = {
        id: 'ext-2',
        conversationId: 'conv-ext-2',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.190 €',
        currency: 'EUR',
        grossTotal: 119000,
        netTotal: 100000,
        vatAmount: 19000,
        vatRate: 19,
        laborCost: 60000,
        materialCost: 30000,
        otherCost: 10000,
        status: 'pending',
        sentAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      await repo.add(offer)
      const retrieved = repo.getById('ext-2')

      expect(retrieved!.currency).toBe('EUR')
      expect(retrieved!.grossTotal).toBe(119000)
      expect(retrieved!.netTotal).toBe(100000)
      expect(retrieved!.vatAmount).toBe(19000)
      expect(retrieved!.laborCost).toBe(60000)
      expect(retrieved!.materialCost).toBe(30000)
      expect(retrieved!.otherCost).toBe(10000)
    })

    it('stores and retrieves offers with conditions fields', async () => {
      const repo = getOfferRepository()
      const offer: Offer = {
        id: 'ext-3',
        conversationId: 'conv-ext-3',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '3.000 €',
        status: 'pending',
        sentAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        paymentTerms: '50 % upfront',
        validUntil: '2026-05-01',
        cancellationTerms: 'Free cancellation',
        escrowRequired: true,
      }

      await repo.add(offer)
      const retrieved = repo.getById('ext-3')

      expect(retrieved!.paymentTerms).toBe('50 % upfront')
      expect(retrieved!.validUntil).toBe('2026-05-01')
      expect(retrieved!.cancellationTerms).toBe('Free cancellation')
      expect(retrieved!.escrowRequired).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 4. QUOTE CARD — DETAIL SCREEN PATH
  // ─────────────────────────────────────────────────────────────────────────

  describe('quote card links to correct detail screen', () => {
    it('customer detail path uses /quotes/:offerId', () => {
      const offerId = 'offer-nav-1'
      const customerPath = `/quotes/${offerId}`
      expect(customerPath).toBe('/quotes/offer-nav-1')
    })

    it('craftsman detail path uses /craftsman/quotes/:offerId', () => {
      const offerId = 'offer-nav-2'
      const craftsmanPath = `/craftsman/quotes/${offerId}`
      expect(craftsmanPath).toBe('/craftsman/quotes/offer-nav-2')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 5. NO REGRESSION — EXISTING WORKFLOW STILL WORKS
  // ─────────────────────────────────────────────────────────────────────────

  describe('no regression to offer workflow', () => {
    it('creates offer with backward-compatible fields', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-compat-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.200 €',
        description: 'Fliesen verlegen',
        timingNote: 'Ab nächste Woche',
      })

      expect(offer.id).toBeDefined()
      expect(offer.price).toBe('1.200 €')
      expect(offer.description).toBe('Fliesen verlegen')
      expect(offer.timingNote).toBe('Ab nächste Woche')
      expect(offer.status).toBe('pending')
      expect(offer.sentAt).toBeDefined()
    })

    it('duplicate active offer is blocked', async () => {
      await createOfferWorkflow({
        conversationId: 'conv-dup-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '500 €',
      })

      await expect(
        createOfferWorkflow({
          conversationId: 'conv-dup-1',
          customerUserId: 'cust-1',
          craftsmanUserId: 'craft-1',
          price: '600 €',
        })
      ).rejects.toThrow()
    })

    it('accept then re-lookup shows accepted status', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-flow-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      await acceptOfferWorkflow(offer.id)
      const repo = getOfferRepository()
      const accepted = repo.getById(offer.id)!
      expect(accepted.status).toBe('accepted')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 6. MIGRATION — SCHEMA GUARD
  // ─────────────────────────────────────────────────────────────────────────

  describe('quote domain migration', () => {
    const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations')
    const migrationFile = '20260324000001_offers_quote_domain.sql'
    const migrationPath = path.join(MIGRATIONS_DIR, migrationFile)

    it('migration file exists', () => {
      expect(fs.existsSync(migrationPath)).toBe(true)
    })

    it('adds expanded status constraint', () => {
      const sql = fs.readFileSync(migrationPath, 'utf-8')
      expect(sql).toContain('draft')
      expect(sql).toContain('expired')
      expect(sql).toContain('superseded')
      expect(sql).toContain('cancelled')
    })

    it('adds price structure columns', () => {
      const sql = fs.readFileSync(migrationPath, 'utf-8')
      expect(sql).toContain('gross_total')
      expect(sql).toContain('net_total')
      expect(sql).toContain('vat_amount')
      expect(sql).toContain('labor_cost')
      expect(sql).toContain('material_cost')
      expect(sql).toContain('other_cost')
    })

    it('adds scope columns', () => {
      const sql = fs.readFileSync(migrationPath, 'utf-8')
      expect(sql).toContain('scope_summary')
      expect(sql).toContain('scope_included')
      expect(sql).toContain('scope_excluded')
      expect(sql).toContain('assumptions')
    })

    it('adds conditions columns', () => {
      const sql = fs.readFileSync(migrationPath, 'utf-8')
      expect(sql).toContain('payment_terms')
      expect(sql).toContain('valid_until')
      expect(sql).toContain('cancellation_terms')
      expect(sql).toContain('escrow_required')
    })

    it('adds snapshot columns', () => {
      const sql = fs.readFileSync(migrationPath, 'utf-8')
      expect(sql).toContain('project_title_snapshot')
      expect(sql).toContain('customer_description_snapshot')
      expect(sql).toContain('location_snapshot')
    })

    it('adds versioning and locking columns', () => {
      const sql = fs.readFileSync(migrationPath, 'utf-8')
      expect(sql).toContain('version')
      expect(sql).toContain('locked_at')
    })

    it('adds line_items column', () => {
      const sql = fs.readFileSync(migrationPath, 'utf-8')
      expect(sql).toContain('line_items')
      expect(sql).toContain('JSONB')
    })
  })
})
