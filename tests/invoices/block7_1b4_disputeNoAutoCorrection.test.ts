/**
 * Block 7.1B4 — Dispute-Guard.
 *
 * §14 Abs. 6 UStG-Korrekturbelege müssen explizit vom Handwerker ausgestellt
 * werden. Eine Dispute-Resolution darf weder bei `release_full` noch bei
 * `refund_full` automatisch eine Stornorechnung oder Gutschrift erzeugen
 * (Rechtssicherheit: Provider muss Begründung eingeben + den Beleg prüfen).
 *
 * Der Vertrag wird statisch über die Source-Datei der DisputeWorkflows
 * geprüft, statt eine vollständige Dispute-Lifecycle-Simulation aufzubauen.
 * Sobald jemand die Korrektur-Workflows in `disputeWorkflow.ts` importiert
 * oder aufruft, schlägt dieser Test an und zwingt zu einer expliziten
 * fachlichen Diskussion.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DISPUTE_WORKFLOW = readFileSync(
  join(__dirname, '../../src/lib/workflow/disputeWorkflow.ts'),
  'utf-8',
)

describe('disputeWorkflow guards (Block 7.1B4)', () => {
  it('importiert die Korrektur-Workflows NICHT (manueller Pfad ist Pflicht)', () => {
    expect(DISPUTE_WORKFLOW).not.toMatch(/createCancellationInvoiceWorkflow/)
    expect(DISPUTE_WORKFLOW).not.toMatch(/createCreditNoteWorkflow/)
    expect(DISPUTE_WORKFLOW).not.toMatch(
      /from\s+['"][^'"]*invoiceCorrectionWorkflow['"]/,
    )
  })
})
