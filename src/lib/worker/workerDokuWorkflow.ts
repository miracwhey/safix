/**
 * WorkerDoku Workflow-Layer · Block C.3
 *
 * Workflow-Wrapper über `photoCaptureService.uploadJobPhoto` und
 * `reportSubmitService.submitJobReport`. Pflicht-Schicht laut Memory
 * `feedback_workflow_layer_rbac_pflicht`: Workflow-Guards laufen
 * client-seitig BEVOR der Service Storage/DB anspricht — sodass eine
 * verloren-gegangene Session, eine Job-Cross-Tenant-Race oder ein
 * fehl-konfigurierter Caller schon im Frontend einen klaren Fehler
 * sehen, statt erst nach Server-Round-Trip mit RLS-Reject zu enden.
 *
 * Auth-Defence-In-Depth: Workflow → RLS-Tabellen-Policies → Storage-
 * Bucket-Policies. Jeder Layer schützt unabhängig.
 */

import type { Job } from '../jobs/types'
import { assertJobWorkerOrOwner } from '../auth/rbacGuards'
import type { SessionState } from '../session'
import {
  uploadJobPhoto,
  type UploadJobPhotoInput,
  type UploadJobPhotoOptions,
} from './photoCaptureService'
import {
  submitJobReport,
  type SubmitJobReportOptions,
} from './reportSubmitService'
import {
  SupabaseJobReportRepository,
  type JobReportRepository,
} from './repository/JobReportRepository'
import type { CapturePhotoResult, JobReport, SubmitReportInput } from './dokuTypes'

export interface CaptureJobPhotoWorkflowInput {
  job: Job
  file: File
}

/**
 * Block C.3 — Worker-Doku Photo-Capture mit RBAC-Wrapper.
 */
export async function captureJobPhotoWorkflow(
  input: CaptureJobPhotoWorkflowInput,
  session: SessionState,
  options: UploadJobPhotoOptions = {},
): Promise<CapturePhotoResult> {
  assertJobWorkerOrOwner(input.job, session)
  if (!session.user?.id) {
    throw new Error('Keine aktive Sitzung — bitte erneut anmelden.')
  }
  if (!input.job.providerId) {
    throw new Error('Auftrag ist keinem Betrieb zugeordnet.')
  }
  const captureInput: UploadJobPhotoInput = {
    jobId: input.job.id,
    providerId: input.job.providerId,
    uploadedBy: session.user.id,
    file: input.file,
  }
  return uploadJobPhoto(captureInput, options)
}

export interface AddJobReportWorkflowInput {
  job: Job
  body: string
  metadata?: Record<string, unknown>
}

export async function addJobReportWorkflow(
  input: AddJobReportWorkflowInput,
  session: SessionState,
  options: SubmitJobReportOptions = {},
): Promise<JobReport> {
  assertJobWorkerOrOwner(input.job, session)
  if (!session.user?.id) {
    throw new Error('Keine aktive Sitzung — bitte erneut anmelden.')
  }
  if (!input.job.providerId) {
    throw new Error('Auftrag ist keinem Betrieb zugeordnet.')
  }
  const submitInput: SubmitReportInput & { authoredBy: string } = {
    jobId: input.job.id,
    providerId: input.job.providerId,
    authoredBy: session.user.id,
    body: input.body,
    ...(input.metadata !== undefined && { metadata: input.metadata }),
  }
  return submitJobReport(submitInput, options)
}

/**
 * Block FU-A · Update eines eigenen Berichts innerhalb des 24-Stunden-
 * Edit-Windows. RLS-Policy `job_reports_worker_update_own` (Migration
 * 20260508000003) erzwingt server-seitig dieselben Bedingungen; der
 * Workflow assertet client-seitig zusätzlich für sofortiges UX-Feedback
 * statt erst nach Round-Trip.
 */
export interface UpdateJobReportWorkflowInput {
  job: Job
  /** Existing report row (für RBAC-pre-check + 24h-window). */
  report: JobReport
  body: string
  metadata?: Record<string, unknown>
}

export interface UpdateJobReportWorkflowOptions {
  repository?: JobReportRepository
  /** Test-Hook: now-Override für deterministisches 24 h-Window-Testing. */
  now?: number
}

const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000

export async function updateJobReportWorkflow(
  input: UpdateJobReportWorkflowInput,
  session: SessionState,
  options: UpdateJobReportWorkflowOptions = {},
): Promise<JobReport> {
  assertJobWorkerOrOwner(input.job, session)
  if (!session.user?.id) {
    throw new Error('Keine aktive Sitzung — bitte erneut anmelden.')
  }
  if (input.report.authoredBy !== session.user.id) {
    throw new Error('Nur der Verfasser kann seinen eigenen Bericht ändern.')
  }
  const now = options.now ?? Date.now()
  if (now - input.report.createdAt > EDIT_WINDOW_MS) {
    throw new Error('Bearbeitungszeit von 24 Stunden ist abgelaufen.')
  }
  const trimmed = input.body.trim()
  if (trimmed.length < 1) {
    throw new Error('Bitte einen Bericht eintragen.')
  }
  if (trimmed.length > 10000) {
    throw new Error(`Bericht ist zu lang (${trimmed.length}/10000 Zeichen).`)
  }
  const repo = options.repository ?? new SupabaseJobReportRepository()
  try {
    return await repo.update({
      reportId: input.report.id,
      body: trimmed,
      ...(input.metadata !== undefined && { metadata: input.metadata }),
    })
  } catch (err) {
    // Server-seitige RLS-Policy `job_reports_worker_update_own` greift
    // wenn die client-seitige Window-Prüfung wegen Clock-Skew oder Tick-
    // Verzögerung das Update durchgelassen hat. Postgres meldet 42501
    // (RLS deny). Statt rohem SQL-State zeigen wir die User-freundliche
    // Variante derselben Constraint, die wir oben schon werfen.
    const code = (err as { code?: string } | null)?.code
    if (code === '42501') {
      throw new Error('Bearbeitungszeit von 24 Stunden ist abgelaufen.')
    }
    throw err
  }
}
