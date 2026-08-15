/**
 * DSGVO Art. 15 — eigene Vollauskunft über alle Streitfälle des Nutzers.
 *
 * Bundles the list-buckets payload plus a reference list per case. Per-case
 * detail (timeline, evidence, decision) is intentionally NOT inlined here —
 * the user can export a single case via `buildDisputeExportPayload` for that.
 * Bundling everything would require pulling the full detail selector for
 * every case, which is expensive and unnecessary for the high-level
 * Auskunftsrecht response.
 */

import type {
  ReconciliationListBuckets,
  ReconciliationListItem,
  ReconciliationRole,
} from '../types'

const SCHEMA_VERSION = '1.0'
const EXPORT_PURPOSE =
  'DSGVO Art. 15 — Auskunftsrecht über alle bei SaFix zu meiner Person geführten Streitfall-Verfahren.'

export type AllDisputesExportPayload = {
  schema: 'fixup.reconciliation.all_disputes_export'
  schemaVersion: string
  exportedAt: string
  exportPurpose: string
  viewer: {
    userId: string
    role: ReconciliationRole
  }
  counts: ReconciliationListBuckets['counts']
  active: ReconciliationListItem[]
  resolved: ReconciliationListItem[]
}

export function buildAllDisputesExportPayload(params: {
  buckets: ReconciliationListBuckets
  viewerUserId: string
  role: ReconciliationRole
  nowMs?: number
}): AllDisputesExportPayload {
  const nowMs = params.nowMs ?? Date.now()
  return {
    schema: 'fixup.reconciliation.all_disputes_export',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    exportPurpose: EXPORT_PURPOSE,
    viewer: {
      userId: params.viewerUserId,
      role: params.role,
    },
    counts: params.buckets.counts,
    active: params.buckets.active,
    resolved: params.buckets.resolved,
  }
}

export function serialiseAllDisputesExport(payload: AllDisputesExportPayload): string {
  return JSON.stringify(payload, null, 2)
}

export function allDisputesExportFilename(payload: AllDisputesExportPayload): string {
  const date = payload.exportedAt.slice(0, 10)
  return `safix-streitfaelle-${date}.json`
}
