/**
 * Craftsman Thread Composer Quote Card — Verification Tests
 *
 * Validates the craftsman-side thread action entry and quote card flow:
 *
 * 1. Craftsman sees the action entry in the thread composer
 * 2. Craftsman can open the quote creation flow
 * 3. Craftsman can send a quote card
 * 4. Customer sees the quote card in the same thread
 * 5. Quote card survives reload/re-entry for both participants
 * 6. Quote card is rendered as business event, not plain text
 * 7. No regression to project history, active project logic, participant
 *    scoping, or request detail flow
 */

import path from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  getThreadArtifactRecord,
  persistProjectArtifact,
  subscribeThreadArtifacts,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  createOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { getOffersByConversationId } from '../../src/lib/offers/service'
import { isConversationParticipant } from '../../src/lib/messages/participantScope'
import { formatEuro } from '../../src/lib/shared/formatters'

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

const REPO_ROOT = path.resolve(__dirname, '../..')
const SCREEN_PATH = path.resolve(REPO_ROOT, 'src/screens/MessageThreadScreen.tsx')
const ACTION_SHEET_PATH = path.resolve(REPO_ROOT, 'src/components/messages/CraftsmanActionSheet.tsx')
const QUOTE_SHEET_PATH = path.resolve(REPO_ROOT, 'src/components/messages/QuoteCreationSheet.tsx')
const QUOTE_EVENT_PATH = path.resolve(REPO_ROOT, 'src/components/messages/QuoteSendEventCard.tsx')

async function readSource(path: string): Promise<string> {
  const fs = await import('fs')
  return fs.readFileSync(path, 'utf-8')
}

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-quote-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-quote-001',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-quote-001',
    projectTitle: 'Küche Sanierung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€5,000-10,000',
    projectDuration: '2 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-quote-${Date.now()}`,
    title: 'Küche Sanierung',
    customer: 'Anna Kundin',
    craftsman: '',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    price: '',
    status: 'request',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'builder',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Craftsman Thread Composer — Quote Card', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. CRAFTSMAN SEES THE ACTION ENTRY IN THE THREAD COMPOSER
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Craftsman sees action entry in thread composer', () => {
    it('MessageThreadScreen routes craftsman tile actions to quote flow', async () => {
      const screenSource = await readSource(SCREEN_PATH)

      // Craftsman tile actions are handled via ChatComposer's handleTileTrigger
      expect(screenSource).toContain('handleTileTrigger')
      expect(screenSource).toContain("role === 'craftsman'")
    })

    it('craftsman action entry is only rendered for craftsman role', async () => {
      const screenSource = await readSource(SCREEN_PATH)

      // The craftsman action button is gated by craftsman role check
      expect(screenSource).toContain("role === 'craftsman'")
    })

    it.skip('craftsman action entry renders a plus button — Slice 7: legacy composer replaced by ChatComposer tiles', async () => {
      // Legacy plus buttons (data-testid="craftsman-composer-action" / "thread-attach-project")
      // replaced by ChatComposer tile system in Slice 7.
    })

    it.skip('CraftsmanActionSheet directly imported in screen — Slice 7: now invoked via ChatComposer tile handleTileTrigger', async () => {
      // CraftsmanActionSheet is still exported as a component; it is opened via
      // handleTileTrigger → kind.type === 'offer' path, not a direct import in the screen.
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. CRAFTSMAN CAN OPEN THE QUOTE CREATION FLOW
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Craftsman can open the quote creation flow', () => {
    it('CraftsmanActionSheet has Kostenvoranschlag senden entry', async () => {
      const sheetSource = await readSource(ACTION_SHEET_PATH)

      expect(sheetSource).toContain('Kostenvoranschlag senden')
      expect(sheetSource).toContain('craftsman-action-send-quote')
      expect(sheetSource).toContain('onSendQuote')
    })

    it('CraftsmanActionSheet action opens QuoteCreationSheet', async () => {
      const screenSource = await readSource(SCREEN_PATH)

      // Clicking the send quote action in the action sheet triggers showQuoteForm
      expect(screenSource).toContain('showQuoteForm')
      expect(screenSource).toContain('QuoteCreationSheet')
    })

    it('QuoteCreationSheet collects minimum required data', async () => {
      const sheetSource = await readSource(QUOTE_SHEET_PATH)

      // Price is required
      expect(sheetSource).toContain('quote-price-input')
      expect(sheetSource).toContain('Betrag')

      // Summary / scope description
      expect(sheetSource).toContain('quote-summary-input')
      expect(sheetSource).toContain('Leistungsbeschreibung')

      // Note
      expect(sheetSource).toContain('quote-note-input')
      expect(sheetSource).toContain('Hinweis')

      // Validity hint
      expect(sheetSource).toContain('quote-validity-input')
      expect(sheetSource).toContain('Gültigkeit')

      // Submit button
      expect(sheetSource).toContain('quote-submit-button')
      expect(sheetSource).toContain('Kostenvoranschlag senden')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. CRAFTSMAN CAN SEND A QUOTE CARD
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Craftsman can send a quote card', () => {
    it('quote creation uses createOfferWorkflow (canonical write path)', async () => {
      const sheetSource = await readSource(QUOTE_SHEET_PATH)

      // Uses canonical offer workflow, not ad-hoc message
      expect(sheetSource).toContain('createOfferWorkflow')
      expect(sheetSource).not.toContain('sendDirectMessage')
      expect(sheetSource).not.toContain('sendMessageToThread')
    })

    it('sending a quote creates an offer entity in the store', async () => {
      const threadId = 'conv-quote-send-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '2.500 €',
        description: 'Komplette Küchenmontage inkl. Material',
      })

      const offers = getOffersByConversationId(threadId)
      expect(offers).toHaveLength(1)
      expect(offers[0].price).toBe('2.500 €')
      expect(offers[0].description).toBe('Komplette Küchenmontage inkl. Material')
      expect(offers[0].status).toBe('pending')
    })

    it('sending a quote creates an offer artifact record', async () => {
      const threadId = 'conv-quote-artifact-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '3.000 €',
        description: 'Sanitärarbeiten',
        timingNote: 'Gültig 14 Tage',
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record).toBeDefined()
      expect(record!.artifactType).toBe('offer')
      expect(record!.snapshotPrice).toBe(formatEuro(3000))
      expect(record!.snapshotSummary).toBe('Sanitärarbeiten')
      expect(record!.phase).toBe('sent')
    })

    it('sending a quote with timing note persists it in the offer', async () => {
      const threadId = 'conv-quote-timing-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '1.800 €',
        timingNote: 'Gültig bis Ende des Monats',
      })

      const offers = getOffersByConversationId(threadId)
      expect(offers).toHaveLength(1)
      expect(offers[0].timingNote).toBe('Gültig bis Ende des Monats')
    })

    it('duplicate quote for same thread is prevented', async () => {
      const threadId = 'conv-quote-dup-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '1.500 €',
      })

      // Second attempt should throw
      await expect(
        createOfferWorkflow({
          conversationId: threadId,
          customerUserId: 'customer-quote-001',
          craftsmanUserId: 'craftsman-quote-001',
          price: '2.000 €',
        })
      ).rejects.toThrow('Active offer already exists')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. CUSTOMER SEES THE QUOTE CARD IN THE SAME THREAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Customer sees the quote card in the same thread', () => {
    it('getThreadArtifacts resolves offer artifact after quote send', async () => {
      const threadId = 'conv-quote-customer-view-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '4.200 €',
        description: 'Fliesenarbeiten Bad',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      expect(artifacts.offerPaymentArtifact!.offer).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.offer!.price).toBe('4.200 €')
    })

    it('quote artifact has createdAt for timeline interleaving', async () => {
      const threadId = 'conv-quote-timeline-001'
      await addConversation(seedConversation({ id: threadId }))

      const before = Date.now()
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '1.000 €',
      })
      const after = Date.now()

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeGreaterThanOrEqual(before)
      expect(artifacts.offerPaymentArtifact!.createdAt).toBeLessThanOrEqual(after)
    })

    it('QuoteSendEventCard renders as a business event, not a chat bubble', async () => {
      const cardSource = await readSource(QUOTE_EVENT_PATH)

      // Renders as a centered event card, not a chat bubble
      expect(cardSource).toContain('quote-send-event')
      expect(cardSource).toContain('Kostenvoranschlag')

      // Shows price prominently
      expect(cardSource).toContain('price')

      // Shows description/scope
      expect(cardSource).toContain('description')

      // Uses ownership alignment, not centered neutral layout or chat bubble patterns
      expect(cardSource).not.toContain('justify-center')
      expect(cardSource).not.toContain('rounded-br-')
      expect(cardSource).not.toContain('rounded-bl-')
    })

    it('quote event card is interleaved in the timeline', async () => {
      const screenSource = await readSource(SCREEN_PATH)

      // QuoteSendEventCard is imported and used in the timeline
      expect(screenSource).toContain('QuoteSendEventCard')
      expect(screenSource).toContain('quote_send')
      expect(screenSource).toContain('offerPaymentArtifact')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. QUOTE CARD SURVIVES RELOAD / RE-ENTRY FOR BOTH PARTICIPANTS
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Quote card survives reload/re-entry', () => {
    it('quote artifact present after re-reading from repository', async () => {
      const threadId = 'conv-quote-reload-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '5.500 €',
        description: 'Heizungsinstallation',
      })

      // Simulate re-entry by reading artifacts multiple times
      const a1 = getThreadArtifacts(threadId)
      const a2 = getThreadArtifacts(threadId)
      const a3 = getThreadArtifacts(threadId)

      expect(a1.offerPaymentArtifact).not.toBeNull()
      expect(a2.offerPaymentArtifact).not.toBeNull()
      expect(a3.offerPaymentArtifact).not.toBeNull()

      expect(a1.offerPaymentArtifact!.offer!.price).toBe('5.500 €')
      expect(a2.offerPaymentArtifact!.offer!.price).toBe('5.500 €')
      expect(a3.offerPaymentArtifact!.offer!.price).toBe('5.500 €')
    })

    it('artifact record survives in persisted storage', async () => {
      const threadId = 'conv-quote-persist-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '2.800 €',
      })

      // Record is in the artifact repository
      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record).toBeDefined()
      expect(record!.offerId).toBeTruthy()
      expect(record!.snapshotPrice).toBe(formatEuro(2800))
      expect(record!.phase).toBe('sent')
    })

    it('snapshot renders quote card even without full offer entity', async () => {
      const threadId = 'conv-quote-snapshot-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '1.200 €',
        description: 'Malerarbeiten Wohnzimmer',
      })

      // Verify snapshot data is stored in the artifact record
      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record!.snapshotPrice).toBe(formatEuro(1200))
      expect(record!.snapshotSummary).toBe('Malerarbeiten Wohnzimmer')
      expect(record!.snapshotPhaseLabel).toBe('Verbindliches Angebot liegt vor')
    })

    it('artifact subscription notifies on quote creation', async () => {
      const threadId = 'conv-quote-sub-001'
      await addConversation(seedConversation({ id: threadId }))

      let notified = false
      const unsub = subscribeThreadArtifacts(() => { notified = true })

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '800 €',
      })

      expect(notified).toBe(true)
      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. QUOTE CARD IS RENDERED AS BUSINESS EVENT, NOT PLAIN TEXT
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. Quote card is a business event, not plain text', () => {
    it('quote is persisted as offer artifact, not as a message', async () => {
      const threadId = 'conv-quote-not-msg-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '3.200 €',
      })

      // The offer artifact record exists
      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record).toBeDefined()
      expect(record!.artifactType).toBe('offer')

      // It resolves as a proper artifact
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
    })

    it('QuoteCreationSheet does not send plain text messages', async () => {
      const sheetSource = await readSource(QUOTE_SHEET_PATH)

      // Uses structured offer workflow, not plain text
      expect(sheetSource).toContain('createOfferWorkflow')
      expect(sheetSource).not.toContain('sendDirectMessage')
      expect(sheetSource).not.toContain('sendMessageToThread')
    })

    it('QuoteSendEventCard renders as a unified artifact card, not a chat bubble', async () => {
      const cardSource = await readSource(QUOTE_EVENT_PATH)
      const screenSource = await readSource(SCREEN_PATH)

      // V5 (2026-06-23): renders through the shared ArtifactCardShell — full-width
      // unified card, no ownership alignment.
      expect(cardSource).toContain('ArtifactCardShell')
      expect(cardSource).toContain('quote-send-event')

      // Screen interleaves it in timeline alongside messages
      expect(screenSource).toContain("kind: 'quote_send'")
    })

    it('quote card has proper business card data structure', async () => {
      const threadId = 'conv-quote-structure-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '6.000 €',
        description: 'Komplette Badsanierung',
        timingNote: 'Gültig 30 Tage',
      })

      const artifacts = getThreadArtifacts(threadId)
      const quote = artifacts.offerPaymentArtifact!

      // Proper business card structure
      expect(quote.kind).toBe('offer_payment')
      expect(quote.phase).toBe('sent')
      expect(quote.offer).not.toBeNull()
      expect(quote.offer!.price).toBe('6.000 €')
      expect(quote.offer!.description).toBe('Komplette Badsanierung')
      expect(quote.offer!.timingNote).toBe('Gültig 30 Tage')
      expect(quote.offer!.status).toBe('pending')
      expect(quote.persistenceStatus).toBe('confirmed')
      expect(quote.createdAt).toBeGreaterThan(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. NO REGRESSION TO PROJECT HISTORY, ACTIVE PROJECT, PARTICIPANT
  //    SCOPING, OR REQUEST DETAIL FLOW
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. No regression to existing systems', () => {
    it('project artifacts remain intact after quote creation', async () => {
      const threadId = 'conv-quote-no-regress-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      // First attach a project
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: VALID_UUID,
      })

      // Then send a quote
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-quote-001',
        craftsmanUserId: 'craftsman-quote-001',
        price: '4.000 €',
      })

      // Both artifacts coexist
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project!.id).toBe(VALID_UUID)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.offer!.price).toBe('4.000 €')
    })

    it('participant scoping is not affected by quote', async () => {
      const conv = seedConversation({
        id: 'conv-quote-scope-001',
        customerUserId: 'cust-A',
        craftsmanUserId: 'craft-B',
      })
      await addConversation(conv)

      await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: 'cust-A',
        craftsmanUserId: 'craft-B',
        price: '1.500 €',
      })

      expect(isConversationParticipant(conv, 'cust-A')).toBe(true)
      expect(isConversationParticipant(conv, 'craft-B')).toBe(true)
      expect(isConversationParticipant(conv, 'stranger')).toBe(false)
    })

    it('quote artifact includes participant user IDs', async () => {
      const threadId = 'conv-quote-participant-ids-001'
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'cust-X',
        craftsmanUserId: 'craft-Y',
      }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'cust-X',
        craftsmanUserId: 'craft-Y',
        price: '2.200 €',
      })

      const record = getThreadArtifactRecord(threadId, 'offer')
      expect(record!.customerUserId).toBe('cust-X')
      expect(record!.craftsmanUserId).toBe('craft-Y')
    })

    it('screen uses canonical patterns, no legacy reintroduction', async () => {
      const screenSource = await readSource(SCREEN_PATH)

      // Uses canonical patterns
      expect(screenSource).toContain('getThreadArtifacts')
      expect(screenSource).toContain('subscribeThreadArtifacts')
      // Persistent top-cards removed (V5 2026-06-23): stream-only artifact cards.
      expect(screenSource).toContain('ChatArtifactCardCompact')
      expect(screenSource).not.toContain('ThreadArtifactCards')

      // No legacy patterns reintroduced
      expect(screenSource).not.toContain('getJobContextForThread')
      expect(screenSource).not.toContain('canAttachProject')
      expect(screenSource).not.toContain('linkedProjectId')
    })

    it('project attach is available for customer and quote form for craftsman', async () => {
      const screenSource = await readSource(SCREEN_PATH)

      // Both paths exist via ChatComposer tile dispatch
      expect(screenSource).toContain('showProjectPicker')
      expect(screenSource).toContain('showQuoteForm')

      // Customer attach still role-gated in handleTileTrigger
      expect(screenSource).toContain("role === 'customer'")

      // Craftsman tile path still role-gated
      const craftsmanGateMatch = screenSource.match(/role === 'craftsman'/g)
      expect(craftsmanGateMatch).not.toBeNull()
      expect(craftsmanGateMatch!.length).toBeGreaterThanOrEqual(1)
    })

    it('payment card is not built in this package', async () => {
      const screenSource = await readSource(SCREEN_PATH)

      // No new payment logic added in the composer or action entries
      expect(screenSource).not.toContain('paymentWorkflow')
      expect(screenSource).not.toContain('createPayment')
      expect(screenSource).not.toContain('PaymentCreationSheet')
    })
  })
})
