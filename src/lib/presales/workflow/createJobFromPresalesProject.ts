/**
 * Presales · Workflow · createJobFromPresalesProject (V1.5 · Phase B-P2)
 *
 * Conversion-Workflow: provider accepts a customer engagement based on a
 * pre-sales aufmaß → transition the `provider_presales_projects` row to
 * `status='converted'` and create a real `jobs` row.
 *
 * Cross-domain handshake (CLAUDE.md):
 *   - jobs domain   : create row via getJobRepository().add()
 *   - presales      : update status + convertedAt + convertedToJobId
 *
 * Scene-relink to the new job is deferred to V1.5.1 — it requires a
 * SECURITY DEFINER RPC because `spatial_scenes.source_job_id` writes go
 * through provider_org_id RLS, which presales-scenes don't have populated
 * (the auto-fill trigger derives org from job, and presales scans have no
 * job). For V1.5 the scenes stay anchored to `source_scan_id`, and
 * downstream listings join `scans.presales_project_id` ↔
 * `presales.convertedToJobId` to discover the job-equivalent context.
 *
 * Idempotency: if `presales.convertedToJobId IS NOT NULL`, the workflow
 * short-circuits and returns the existing jobId — safe under double-tap.
 *
 * NOTE: We do NOT create a `projects` row for the customer side. V1.5
 * provider-pre-sales-jobs use `jobs.project_id = ''` (legacy default) so
 * downstream selectors that read project-anchored data treat them as
 * direct-create jobs. V1.5.1 may add an optional customer-project sync.
 */

import { generateUUID } from '../../shared/generateUUID'
import { getJobRepository } from '../../jobs/repository'
import { logError } from '../../observability'
import { getSession } from '../../session'
import { resolveProviderOrg } from '../../spatial/canonical/workflow/resolveProviderOrg'
import { addTimelineEvent, createTimelineEvent } from '../../timeline/timelineService'
import { getPresalesProjectRepository } from '../repository/registry'
import type { Job } from '../../jobs/types'

export interface CreateJobFromPresalesProjectInput {
  presalesProjectId: string
  /** Customer-side data captured in the conversion modal. */
  customerName: string
  customerEmail?: string
  customerPhone?: string
  /** Optional schedule string (e.g. "Mo, 27. Mai 2026"). */
  dateLabel?: string
  /** Free-text trade description. Defaults to presales.notes if not given. */
  description?: string
  /** Optional amount label (e.g. "1.250 €"). Stays display-only — escrow flow
   *  takes the canonical numeric value when an offer is sent. */
  amount?: string
}

export type CreateJobFromPresalesProjectResult =
  | { ok: true; jobId: string; alreadyExisted: boolean }
  | { ok: false; reason: CreateJobFromPresalesProjectFailure; message: string }

export type CreateJobFromPresalesProjectFailure =
  | 'not_authenticated'
  | 'not_provider_member'
  | 'cross_org_denied'
  | 'presales_not_found'
  | 'presales_archived'
  | 'invalid_input'
  | 'job_create_failed'
  | 'presales_update_failed'

export async function createJobFromPresalesProject(
  input: CreateJobFromPresalesProjectInput,
): Promise<CreateJobFromPresalesProjectResult> {
  const customerName = input.customerName.trim()
  if (!customerName) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: 'Kundenname ist erforderlich.',
    }
  }

  // B-P4: workflow-layer RBAC. RLS would also block a cross-org findById in
  // prod (Supabase), but the client reaches this path before RLS so we re-check
  // here per CLAUDE.md ("Workflow-layer RBAC guards mandatory").
  const session = getSession()
  const uid = session.user?.id ?? null
  if (!uid) {
    return {
      ok: false,
      reason: 'not_authenticated',
      message: 'Anmeldung erforderlich.',
    }
  }
  const orgResolve = await resolveProviderOrg()
  if (!orgResolve.orgId) {
    return {
      ok: false,
      reason: 'not_provider_member',
      message: 'Conversion ist nur für Handwerker-Betriebe verfügbar.',
    }
  }

  const presalesRepo = getPresalesProjectRepository()
  const presales = await presalesRepo.findById(input.presalesProjectId)
  if (!presales) {
    return {
      ok: false,
      reason: 'presales_not_found',
      message: 'Aufmaß wurde nicht gefunden.',
    }
  }
  if (presales.providerOrgId !== orgResolve.orgId) {
    return {
      ok: false,
      reason: 'cross_org_denied',
      message: 'Dieses Aufmaß gehört zu einem anderen Betrieb.',
    }
  }
  if (presales.status === 'archived') {
    return {
      ok: false,
      reason: 'presales_archived',
      message: 'Aufmaß ist archiviert und kann nicht konvertiert werden.',
    }
  }
  if (presales.convertedToJobId) {
    // Idempotent: return the existing conversion.
    return { ok: true, jobId: presales.convertedToJobId, alreadyExisted: true }
  }

  const jobId = generateUUID()
  const newJob: Job = {
    id: jobId,
    projectId: '',
    title: presales.title,
    customer: customerName,
    location: presales.locationHint ?? '',
    dateLabel: input.dateLabel ?? 'Termin offen',
    status: 'new',
    amount: input.amount ?? '',
    description: input.description ?? presales.notes ?? '',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    providerId: presales.providerOrgId,
    craftsmanUserId: presales.createdByUserId,
  }

  try {
    await getJobRepository().add(newJob)
  } catch (err) {
    logError('presales.convert.job_create_failed', err, {
      presalesId: presales.id,
      jobId,
    })
    return {
      ok: false,
      reason: 'job_create_failed',
      message: 'Projekt konnte nicht angelegt werden.',
    }
  }

  try {
    await presalesRepo.update(presales.id, {
      status: 'converted',
      convertedAt: new Date().toISOString(),
      convertedToJobId: jobId,
    })
  } catch (err) {
    logError('presales.convert.update_failed', err, {
      presalesId: presales.id,
      jobId,
    })
    return {
      ok: false,
      reason: 'presales_update_failed',
      message: 'Projekt wurde angelegt, aber Pre-Sales-Status konnte nicht aktualisiert werden.',
    }
  }

  // B-P4: emit a timeline event on the new job pointing back to the source
  // presales-project. Bridge auto-derives an info notification (provider-only)
  // from this via `notificationConfig`. Non-fatal — a missed event would mean
  // the activity feed lacks a record, but the conversion already succeeded.
  try {
    addTimelineEvent(
      createTimelineEvent({
        jobId,
        type: 'presales_converted',
        entityId: presales.id,
      }),
    )
  } catch (err) {
    logError('presales.convert.timeline_emit_failed', err, {
      presalesId: presales.id,
      jobId,
    })
  }

  return { ok: true, jobId, alreadyExisted: false }
}
