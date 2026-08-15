/**
 * Spatial · CAD Lane V1.5.1 · linkScanToJob
 *
 * Customer-side workflow that attaches an existing Self-Scan to one of the
 * Customer's own Anfragen (jobs they created). Surface: the "An Anfrage
 * hängen"-target of {@link SpatialShareSheet} (Mockup 06).
 *
 * Guardrails the workflow enforces above and beyond RLS:
 *   - The scan must be `owner_type='customer'` (a Self-Scan) — sharing
 *     HW-owned scans is the HW's job-spatial-share flow, not this one.
 *   - The caller must equal `scan.capturedBy` (the Self-Scan owner) AND
 *     `job.customerUserId` (the Anfrage owner) — the same user owns both.
 *
 * Why a workflow guard on top of RLS:
 *   `scans_update` (Lane 3 Block 1) gates the UPDATE on
 *   `spatial_can_edit_scan`, which allows the Self-Scan owner to mutate
 *   the row, BUT does NOT constrain the target `job_id`. Without this
 *   workflow guard a Customer could attach their scan to a foreign job's
 *   id by guessing it. The check below short-circuits that path with an
 *   explicit ownership match against `jobs.customerUserId`.
 *
 * Idempotent: re-attaching to the same job is a no-op success.
 * Reversible (V1.6 follow-up): a separate `unlinkScanFromJob` will set
 * `job_id` back to NULL — V1.5.1 only ships the link direction.
 */

import { supabase } from '../../supabase'
import { logError, logInfo } from '../../observability'
import { getJobById } from '../../jobs/service'
import { getSpatialRepository } from '../repository/registry'
import type { Scan } from '../types'

export type LinkScanToJobFailure =
  | 'not_authenticated'
  | 'scan_not_found'
  | 'scan_not_self_scan'
  | 'scan_not_owned_by_caller'
  | 'job_not_found'
  | 'job_not_owned_by_caller'
  | 'update_failed'

export type LinkScanToJobResult =
  | { ok: true; scan: Scan; alreadyLinked: boolean }
  | { ok: false; reason: LinkScanToJobFailure; message: string }

export async function linkScanToJob(
  scanId: string,
  jobId: string,
): Promise<LinkScanToJobResult> {
  const { data: authUser } = await supabase.auth.getUser()
  const uid = authUser.user?.id
  if (!uid) {
    return { ok: false, reason: 'not_authenticated', message: 'Anmeldung erforderlich.' }
  }

  const repo = getSpatialRepository()
  const scan = await repo.getScan(scanId)
  if (!scan) {
    return { ok: false, reason: 'scan_not_found', message: 'Aufmaß nicht gefunden.' }
  }
  if (scan.ownerType !== 'customer') {
    return {
      ok: false,
      reason: 'scan_not_self_scan',
      message: 'Nur eigene Aufmaße können an eine Anfrage gehängt werden.',
    }
  }
  if (scan.capturedBy !== uid) {
    return {
      ok: false,
      reason: 'scan_not_owned_by_caller',
      message: 'Dieses Aufmaß gehört nicht dir.',
    }
  }

  // Idempotency — re-link to the same job is a success with no write.
  if (scan.jobId === jobId) {
    return { ok: true, scan, alreadyLinked: true }
  }

  const job = getJobById(jobId)
  if (!job) {
    return { ok: false, reason: 'job_not_found', message: 'Anfrage nicht gefunden.' }
  }
  if (job.customerUserId !== uid) {
    return {
      ok: false,
      reason: 'job_not_owned_by_caller',
      message: 'Diese Anfrage gehört nicht dir.',
    }
  }

  // Repository.updateScan only ships `status / scanEndedAt / archivedAt`; the
  // job_id link is direct UPDATE through the Supabase client. The RLS
  // `scans_update` policy still gates the row to the Self-Scan owner.
  const { data, error } = await supabase
    .from('scans')
    .update({ job_id: jobId })
    .eq('id', scanId)
    .select()
    .single()
  if (error || !data) {
    logError('spatial.linkScanToJob.update_failed', error, { scanId, jobId, uid })
    return {
      ok: false,
      reason: 'update_failed',
      message: error?.message || 'Aufmaß konnte nicht angehängt werden.',
    }
  }

  logInfo('spatial.linkScanToJob.linked', { scanId, jobId, uid })
  const refreshed = await repo.getScan(scanId)
  return { ok: true, scan: refreshed ?? scan, alreadyLinked: false }
}
