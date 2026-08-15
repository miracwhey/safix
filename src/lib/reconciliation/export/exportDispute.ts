/**
 * DSGVO Art. 15 — eigene Auskunft über einen einzelnen Streitfall.
 *
 * SCOPE
 * -----
 * Client-side JSON export only. The same RLS layer that protects the
 * underlying read-model also restricts the data this export can reach —
 * the export is a structural copy of `ReconciliationView`, not a server
 * privilege escalation. Counterparty content stays redacted because the
 * export uses the already-filtered selector output.
 *
 * NOT IN SCOPE — DEFERRED TO N13.5b
 * ----------------------------------
 * - Server-side PDF rendering with custom layout (`puppeteer` edge function)
 * - Multi-asset ZIP including evidence files (requires storage signed URLs)
 * - Long-running async export with email delivery
 *
 * For now, the export covers exactly what the user already sees on the
 * detail screen — Aktenzeichen, lifecycle, snapshot, timeline, evidence
 * references, Stripe trace, decision, deadline. Nothing else.
 */

import type { ReconciliationView } from '../types'

const EXPORT_SCHEMA_VERSION = '1.0'
const EXPORT_PURPOSE =
  'DSGVO Art. 15 — Auskunft über die zu meiner Person gespeicherten Streitfall-Daten.'

export type DisputeExportPayload = {
  schema: 'fixup.reconciliation.dispute_export'
  schemaVersion: string
  exportedAt: string
  exportPurpose: string
  case: {
    aktenzeichen: string
    disputeId: string
    jobId: string
    role: ReconciliationView['role']
    status: ReconciliationView['status']
    statusLabel: string
    nextStep: string
    snapshot: ReconciliationView['snapshot']
    snapshotMissing: boolean
    timeline: ReconciliationView['timeline']
    ownEvidence: ReconciliationView['ownEvidence']
    sharedCounterpartyEvidence: ReconciliationView['sharedCounterpartyEvidence']
    stripeTimeline: ReconciliationView['stripeTimeline']
    deadline: ReconciliationView['deadline']
    decision: ReconciliationView['decision']
  }
}

/**
 * Builds the export payload for a single reconciliation case. Pure function
 * — callers handle Blob creation, download trigger, or tests.
 */
export function buildDisputeExportPayload(
  view: ReconciliationView,
  nowMs: number = Date.now(),
): DisputeExportPayload {
  return {
    schema: 'fixup.reconciliation.dispute_export',
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    exportPurpose: EXPORT_PURPOSE,
    case: {
      aktenzeichen: view.aktenzeichen,
      disputeId: view.disputeId,
      jobId: view.jobId,
      role: view.role,
      status: view.status,
      statusLabel: view.statusLabel,
      nextStep: view.nextStepLabel,
      snapshot: view.snapshot,
      snapshotMissing: view.snapshotMissing,
      timeline: view.timeline,
      ownEvidence: view.ownEvidence,
      sharedCounterpartyEvidence: view.sharedCounterpartyEvidence,
      stripeTimeline: view.stripeTimeline,
      deadline: view.deadline,
      decision: view.decision,
    },
  }
}

/**
 * Serialises the payload into a stable, indented JSON string. Stable means
 * the same input always produces the same output — used by tests and for
 * deterministic download filenames.
 */
export function serialiseDisputeExport(payload: DisputeExportPayload): string {
  return JSON.stringify(payload, null, 2)
}

/**
 * Suggested filename for the per-case download. Uses the URL-safe slug to
 * avoid breaking on the slash in the canonical Aktenzeichen.
 */
export function disputeExportFilename(payload: DisputeExportPayload): string {
  const safeAkz = payload.case.aktenzeichen.replace('/', '_')
  return `safix-streitfall-${safeAkz}.json`
}
