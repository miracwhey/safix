/**
 * Thread Artifact — Invoice (Rechnung) persistence + selector round-trip
 *
 * Block-2 invoice thread-artifact feature. Verifies the write↔read symmetry
 * between the write side (persistInvoiceArtifact / updateInvoiceArtifactPhase
 * in threadArtifactService.ts) and the read side (resolveInvoiceArtifacts →
 * getThreadArtifacts in threadArtifactSelectors.ts).
 *
 * Mapping under test (snapshot fields are stored on generic record columns):
 *   persistInvoiceArtifact param      → ThreadArtifactRecord column → InvoiceSnapshot field
 *   ─────────────────────────────────────────────────────────────────────────────
 *   snapshotAmount                    → snapshotPrice               → amount
 *   snapshotInvoiceNumber             → snapshotSummary             → invoiceNumber
 *   snapshotPhaseLabel                → snapshotPhaseLabel          → phaseLabel
 *   phase                             → phase                       → status (no live entity)
 *
 * Coverage:
 *   1. Round-trip symmetry: distinct values map back EXACTLY, no field swap.
 *   2. updateInvoiceArtifactPhase advances phase/label; reflected by selector.
 *   3. Live-entity enrichment dominates the stale snapshot (status/amount/number).
 *   4. Dedup: persisting the same invoiceId twice yields ONE artifact.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  persistInvoiceArtifact,
  updateInvoiceArtifactPhase,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { setInvoiceRepository } from '../../src/lib/invoices/repository/registry'
import { InMemoryInvoiceRepository } from '../../src/lib/invoices/repository/InMemoryInvoiceRepository'
import type { Invoice } from '../../src/lib/invoices/types'
import { formatEuro } from '../../src/lib/shared/formatters'

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id =
    overrides.id ?? `conv-inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Invoice Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-inv-001',
    craftsmanName: 'Invoice Handwerker',
    craftsmanHandle: 'inv-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-inv-001',
    projectTitle: 'Heizung erneuern',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€3,000–5,000',
    projectDuration: '1 Woche',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

/** Full-shape live Invoice entity for the invoice store. */
function seedInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-live-001',
    jobId: 'job-inv-001',
    invoiceNumber: 'FX-2026-0099',
    status: 'paid',
    parties: {
      issuerName: 'Müller Sanitär GmbH',
      issuerAddress: 'Hauptstraße 5, 10115 Berlin',
      customerName: 'Julia Neumann',
    },
    lineItems: [
      { id: 'li_1', label: 'Heizungsinstallation', quantity: 1, unitPrice: 1500, total: 1500 },
    ],
    // grossAmount is in EUROS (formatEuro input contract).
    amounts: { netAmount: 1260.5, taxAmount: 239.5, grossAmount: 1500 },
    issuedAt: 1_743_840_000_000,
    issuedAtLabel: 'Heute',
    dueAtLabel: 'In 7 Tagen',
    sentAt: 0,
    servicePeriod: null,
    taxBreakdown: null,
    taxNote: null,
    providerSnapshot: null,
    customerSnapshot: null,
    sourceOfferId: null,
    sourceChangeOrderIds: [],
    sourceSupplementaryPaymentIds: [],
    kind: 'invoice',
    originalInvoiceId: null,
    correctionReason: null,
    correctionAmountCents: null,
    originalInvoiceNumber: null,
    originalInvoiceIssuedAtLabel: null,
    refundEventId: null,
    createdAt: 1_743_840_000_000,
    updatedAt: 1_743_840_000_000,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Thread Artifact — Invoice persistence + selector round-trip', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. WRITE ↔ READ SYMMETRY (no live entity)
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Round-trip symmetry (snapshot only, no live entity)', () => {
    it('maps every snapshot field back EXACTLY with no field swap', async () => {
      const threadId = 'conv-inv-roundtrip'
      const invoiceId = 'inv-rt-001'
      const jobId = 'job-rt-001'

      await addConversation(seedConversation({ id: threadId }))

      // Distinct, unmistakable values per field so any swap is caught.
      await persistInvoiceArtifact({
        conversationId: threadId,
        invoiceId,
        jobId,
        phase: 'issued',
        snapshotAmount: '1.190,00 €',
        snapshotInvoiceNumber: 'FX-2026-0042',
        snapshotPhaseLabel: 'Rechnung gestellt',
        customerUserId: 'customer-inv-001',
        craftsmanUserId: 'craftsman-inv-001',
      })

      const { invoiceArtifacts } = getThreadArtifacts(threadId)
      expect(invoiceArtifacts).toHaveLength(1)

      const inv = invoiceArtifacts[0]
      expect(inv.kind).toBe('invoice')

      // No live entity loaded → invoice is null, snapshot drives the card.
      expect(inv.invoice).toBeNull()
      expect(inv.snapshot).not.toBeNull()

      // EXACT mapping — assert each field lands where it belongs.
      expect(inv.snapshot!.amount).toBe('1.190,00 €')          // ← snapshotAmount (snapshotPrice)
      expect(inv.snapshot!.invoiceNumber).toBe('FX-2026-0042') // ← snapshotInvoiceNumber (snapshotSummary)
      expect(inv.snapshot!.phaseLabel).toBe('Rechnung gestellt') // ← snapshotPhaseLabel
      expect(inv.snapshot!.invoiceId).toBe(invoiceId)

      // status derives from the stored phase when no live entity exists.
      expect(inv.status).toBe('issued')

      // jobId round-trips onto the artifact.
      expect(inv.jobId).toBe(jobId)

      // Cross-checks: prove no field collapsed onto another.
      expect(inv.snapshot!.amount).not.toBe(inv.snapshot!.invoiceNumber)
      expect(inv.snapshot!.amount).not.toBe(inv.snapshot!.phaseLabel)
      expect(inv.snapshot!.invoiceNumber).not.toBe(inv.snapshot!.phaseLabel)

      // Deterministic artifact id keyed to invoiceId.
      expect(inv.artifactId).toBe(`ta_inv_${invoiceId}`)
    })

    it('falls back to status-derived label when no snapshotPhaseLabel given', async () => {
      const threadId = 'conv-inv-nolabel'
      const invoiceId = 'inv-nolabel-001'

      await addConversation(seedConversation({ id: threadId }))

      await persistInvoiceArtifact({
        conversationId: threadId,
        invoiceId,
        jobId: 'job-nolabel-001',
        phase: 'sent',
        snapshotAmount: '500,00 €',
        snapshotInvoiceNumber: 'FX-2026-0050',
        // snapshotPhaseLabel intentionally omitted
      })

      const { invoiceArtifacts } = getThreadArtifacts(threadId)
      expect(invoiceArtifacts).toHaveLength(1)
      // status 'sent' → 'Rechnung versendet' via mapInvoiceStatusToPhaseLabel
      expect(invoiceArtifacts[0].status).toBe('sent')
      expect(invoiceArtifacts[0].snapshot!.phaseLabel).toBe('Rechnung versendet')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. PHASE ADVANCE (issued → sent)
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. updateInvoiceArtifactPhase advances phase + label', () => {
    it("advances 'issued' → 'sent' and reflects new label, preserving amount/number", async () => {
      const threadId = 'conv-inv-advance'
      const invoiceId = 'inv-adv-001'

      await addConversation(seedConversation({ id: threadId }))

      await persistInvoiceArtifact({
        conversationId: threadId,
        invoiceId,
        jobId: 'job-adv-001',
        phase: 'issued',
        snapshotAmount: '2.380,00 €',
        snapshotInvoiceNumber: 'FX-2026-0077',
        snapshotPhaseLabel: 'Rechnung gestellt',
      })

      await updateInvoiceArtifactPhase(invoiceId, 'sent', {
        snapshotPhaseLabel: 'Rechnung versendet',
      })

      const { invoiceArtifacts } = getThreadArtifacts(threadId)
      expect(invoiceArtifacts).toHaveLength(1)

      const inv = invoiceArtifacts[0]
      expect(inv.status).toBe('sent')
      expect(inv.snapshot!.phaseLabel).toBe('Rechnung versendet')

      // Amount + number untouched by the phase update.
      expect(inv.snapshot!.amount).toBe('2.380,00 €')
      expect(inv.snapshot!.invoiceNumber).toBe('FX-2026-0077')

      // Same record (upsert by deterministic id), not a new one.
      expect(inv.artifactId).toBe(`ta_inv_${invoiceId}`)
    })

    it('is a no-op when the invoiceId has no persisted artifact', async () => {
      const threadId = 'conv-inv-noop'
      await addConversation(seedConversation({ id: threadId }))

      await updateInvoiceArtifactPhase('inv-does-not-exist', 'sent', {
        snapshotPhaseLabel: 'Rechnung versendet',
      })

      expect(getThreadArtifacts(threadId).invoiceArtifacts).toHaveLength(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. LIVE-ENTITY ENRICHMENT DOMINATES STALE SNAPSHOT
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Live invoice entity enriches over stale snapshot', () => {
    it('status + amount + invoiceNumber come from the live entity (formatEuro), not the snapshot', async () => {
      const threadId = 'conv-inv-live'
      const invoiceId = 'inv-live-001'
      const jobId = 'job-inv-001'

      await addConversation(seedConversation({ id: threadId }))

      // Stale snapshot persisted at creation time (issued, low amount).
      await persistInvoiceArtifact({
        conversationId: threadId,
        invoiceId,
        jobId,
        phase: 'issued',
        snapshotAmount: '1,00 €',
        snapshotInvoiceNumber: 'FX-STALE',
        snapshotPhaseLabel: 'Rechnung gestellt',
      })

      // Live entity now exists in the invoice store: paid, gross 1500 EUR.
      setInvoiceRepository(
        new InMemoryInvoiceRepository([
          seedInvoice({
            id: invoiceId,
            jobId,
            status: 'paid',
            invoiceNumber: 'FX-2026-0099',
            amounts: { netAmount: 1260.5, taxAmount: 239.5, grossAmount: 1500 },
          }),
        ])
      )

      const { invoiceArtifacts } = getThreadArtifacts(threadId)
      expect(invoiceArtifacts).toHaveLength(1)

      const inv = invoiceArtifacts[0]

      // Live entity is attached.
      expect(inv.invoice).not.toBeNull()
      expect(inv.invoice!.id).toBe(invoiceId)

      // Status comes from the live entity, NOT the stale 'issued' phase.
      expect(inv.status).toBe('paid')

      // Amount is formatEuro(grossAmount in euros), NOT the stale '1,00 €'.
      // (formatEuro uses Intl de-DE, which separates with a narrow no-break
      // space U+202F — assert against the formatter, not a hand-typed literal.)
      expect(inv.snapshot!.amount).toBe(formatEuro(1500))
      expect(inv.snapshot!.amount).not.toBe('1,00 €')

      // Invoice number from the live entity, NOT 'FX-STALE'.
      expect(inv.snapshot!.invoiceNumber).toBe('FX-2026-0099')
      expect(inv.snapshot!.invoiceNumber).not.toBe('FX-STALE')

      // Phase label reflects the live 'paid' status.
      expect(inv.snapshot!.phaseLabel).toBe('Rechnung bezahlt')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. DEDUP — deterministic ta_inv_<id> upsert
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Dedup: same invoiceId persisted twice yields ONE artifact', () => {
    it('upserts the deterministic record rather than appending a duplicate', async () => {
      const threadId = 'conv-inv-dedup'
      const invoiceId = 'inv-dedup-001'

      await addConversation(seedConversation({ id: threadId }))

      await persistInvoiceArtifact({
        conversationId: threadId,
        invoiceId,
        jobId: 'job-dedup-001',
        phase: 'issued',
        snapshotAmount: '900,00 €',
        snapshotInvoiceNumber: 'FX-2026-0001',
        snapshotPhaseLabel: 'Rechnung gestellt',
      })

      // Second persist of the SAME invoiceId — must upsert, not append.
      await persistInvoiceArtifact({
        conversationId: threadId,
        invoiceId,
        jobId: 'job-dedup-001',
        phase: 'sent',
        snapshotAmount: '900,00 €',
        snapshotInvoiceNumber: 'FX-2026-0001',
        snapshotPhaseLabel: 'Rechnung versendet',
      })

      const { invoiceArtifacts } = getThreadArtifacts(threadId)
      expect(invoiceArtifacts).toHaveLength(1)
      expect(invoiceArtifacts[0].artifactId).toBe(`ta_inv_${invoiceId}`)
      // Latest write wins on the upserted record.
      expect(invoiceArtifacts[0].status).toBe('sent')
      expect(invoiceArtifacts[0].snapshot!.phaseLabel).toBe('Rechnung versendet')
    })
  })
})
