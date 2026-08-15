/**
 * Spatial · Lane 3 V1.6 Block 2 · Workflow · shareScanWithCustomer
 *
 * Single orchestrator for the HW "Mit Kundin teilen / Freigabe zurückziehen"
 * toggle on `CraftsmanJobSpatialDetailScreen`. Wraps the bare repo
 * `updateScanSharing` with the workflow-layer guardrails the UI cannot
 * deliver on its own:
 *
 *   1. RBAC — only the job's HW owner may flip the toggle. RLS already
 *      enforces this server-side on `scans_update`, but the workflow guard
 *      is the third defense (mirror to `assertJobProviderOwner` in offers /
 *      payments) so a worker that constructs scanId/jobId via the JS console
 *      gets a clean RbacError instead of a Postgres 42501.
 *   2. Self-Scan refusal — `ownerType='customer'` scans (Block 4 Self-Scan)
 *      are visible to their owner via ownership, not the shared-toggle.
 *      Flipping the column on a Self-Scan would still RLS-fail but we surface
 *      the wrong-domain failure with a typed reason.
 *   3. Job-anchor CHECK — `shared_with_customer=true` requires a jobId
 *      (DB `scans_sharing_requires_job_chk`). Caught client-side so the
 *      Toggle component can disable itself on `scan.jobId === null` (D5).
 *   4. Timeline-Event emission — ONLY on a true→false→true transition where
 *      the new value is `true`. D4 locks unshare as silent. The
 *      `ensureTimelineEvent` helper is itself idempotent on `(jobId, type)`,
 *      so a second share on the same job (e.g. share Scan-B after Scan-A)
 *      does not double-fire push.
 *
 * Result-typed: failures surface as typed
 * {@link ShareScanWithCustomerResult}; nothing throws (except the test-only
 * `assertJobProviderOwner` route when the caller injects no session).
 *
 * NOTE — this file is intentionally NOT re-exported from
 * `lib/spatial/workflow/index.ts`. It imports `session` (via the RBAC guard)
 * whose module-load `onAuthStateChange` side effect would be dragged into
 * every importer of the spatial barrel, breaking offline unit tests that
 * mock only `supabase.storage`. Mirror of the existing
 * `spatialEditPermissions` / `resumePendingCapture` carve-out.
 */

import type { Scan } from '../types'
import { getSpatialRepository } from '../repository/registry'
import type { SpatialRepository } from '../repository/SpatialRepository'
import { getJobById } from '../../jobs/jobsStore'
import type { Job } from '../../jobs/types'
import {
  RbacError,
  assertJobProviderOwner,
  resolveSession,
} from '../../auth/rbacGuards'
import type { SessionState } from '../../session'
import { ensureTimelineEvent } from '../../timeline'

export type ShareScanWithCustomerFailure =
  /** scanId resolves to nothing — stale id or wrong account. */
  | 'scan_not_found'
  /** Self-Scan (ownerType='customer') — HW share-toggle doesn't apply. */
  | 'scan_owned_by_customer'
  /** Cannot share a jobless scan — DB CHECK mirror. */
  | 'scan_missing_job'
  /** Job row missing — orphan scan, likely a stale workflow call. */
  | 'job_not_found'
  /** Caller is not the job's HW owner. */
  | 'rbac_owner_required'
  /** Repo write failed — Supabase error / RLS / CHECK violation. */
  | 'persistence_failed'

export type ShareScanWithCustomerResult =
  | { ok: true; scan: Scan; changed: boolean }
  | { ok: false; reason: ShareScanWithCustomerFailure; message: string }

export interface ShareScanWithCustomerInput {
  scanId: string
  /** Target value — `true` to share, `false` to retract. */
  value: boolean
}

export interface ShareScanWithCustomerDeps {
  spatialRepo?: SpatialRepository
  session?: SessionState
  /** Test seam — defaults to the synchronous in-memory jobsStore. */
  jobsLookup?: (jobId: string) => Job | undefined
  /** Test seam — defaults to the production `ensureTimelineEvent`. */
  emitTimelineEvent?: typeof ensureTimelineEvent
}

export async function shareScanWithCustomer(
  input: ShareScanWithCustomerInput,
  deps: ShareScanWithCustomerDeps = {},
): Promise<ShareScanWithCustomerResult> {
  const repo = deps.spatialRepo ?? getSpatialRepository()
  const lookupJob = deps.jobsLookup ?? getJobById
  const emit = deps.emitTimelineEvent ?? ensureTimelineEvent

  // 1. Scan lookup. Repo throws for transport errors — surface as
  //    persistence_failed so the UI can display a generic toast.
  let scan: Scan | null
  try {
    scan = await repo.getScan(input.scanId)
  } catch (e) {
    return {
      ok: false,
      reason: 'persistence_failed',
      message: e instanceof Error ? e.message : 'Aufmaß konnte nicht geladen werden.',
    }
  }
  if (!scan) {
    return {
      ok: false,
      reason: 'scan_not_found',
      message: `Aufmaß ${input.scanId} nicht gefunden.`,
    }
  }

  // 2. Self-Scan refusal — Block 4 territory, not this toggle.
  if (scan.ownerType === 'customer') {
    return {
      ok: false,
      reason: 'scan_owned_by_customer',
      message: 'Eigene Aufmaße der Kundin können nicht über diese Freigabe gesteuert werden.',
    }
  }

  // 3. Job-anchor CHECK (only when sharing → true). The repo enforces the
  //    same CHECK, but the UI needs the typed failure to disable the toggle
  //    before the call (D5 disabled card).
  if (input.value && scan.jobId === null) {
    return {
      ok: false,
      reason: 'scan_missing_job',
      message: 'Aufmaß ist keinem Auftrag zugeordnet — Freigabe nur mit Auftrag möglich.',
    }
  }

  // 4. Job lookup for RBAC. Unshare path also needs the job — without a
  //    jobId we can't authenticate the caller against the job owner.
  //    Jobless craftsman-scans are legacy (pre-Lane-3) and should never hit
  //    this workflow — surface as `scan_missing_job` so the operator can
  //    inspect.
  if (scan.jobId === null) {
    return {
      ok: false,
      reason: 'scan_missing_job',
      message: 'Aufmaß hat keinen Auftrag-Anker.',
    }
  }
  const job = lookupJob(scan.jobId)
  if (!job) {
    return {
      ok: false,
      reason: 'job_not_found',
      message: `Auftrag ${scan.jobId} nicht gefunden — Datenkonsistenz prüfen.`,
    }
  }

  // 5. RBAC — only the job's HW owner may flip the toggle.
  try {
    const session = resolveSession(deps.session)
    assertJobProviderOwner(job, session)
  } catch (e) {
    if (e instanceof RbacError) {
      return {
        ok: false,
        reason: 'rbac_owner_required',
        message: 'Nur der Auftragsinhaber kann die Freigabe steuern.',
      }
    }
    throw e
  }

  // 6. Repo write. Same-value calls short-circuit in the repo + the DB
  //    trigger; we detect by comparing the prior value.
  const priorValue = scan.sharedWithCustomer
  let updated: Scan
  try {
    updated = await repo.updateScanSharing(input.scanId, input.value)
  } catch (e) {
    return {
      ok: false,
      reason: 'persistence_failed',
      message: e instanceof Error ? e.message : 'Freigabe konnte nicht gespeichert werden.',
    }
  }

  const changed = priorValue !== input.value

  // 7. Timeline-Event — ONLY on a meaningful flip TO shared (D4 locks
  //    unshare as silent; same-value idempotency suppresses too). The
  //    `ensureTimelineEvent` helper guards against duplicates per
  //    (jobId, type), so a second share on the same job (after unshare or
  //    on a second scan) does not refire push — by design (no spam).
  if (changed && input.value === true) {
    emit({
      jobId: job.id,
      type: 'spatial_shared_with_customer',
      entityId: updated.id,
    })
  }

  return { ok: true, scan: updated, changed }
}
