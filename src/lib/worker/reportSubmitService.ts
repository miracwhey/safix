/**
 * Worker-Doku Report-Submit-Service · Block C.2
 *
 * Thin wrapper um JobReportRepository.add — gibt UI/Workflow-Layer einen
 * stable API-Punkt, der später ohne UI-Änderung um Workflow-Guards
 * (z.B. assertJobWorkerOrOwner) erweitert werden kann (C.3).
 *
 * Body-Validierung passiert hier client-seitig nochmal (length 1..10000),
 * spiegelt den DB-CHECK-Constraint und liefert sofortiges Form-Feedback
 * statt erst nach Round-Trip einen 23514 zu sehen.
 */

import {
  SupabaseJobReportRepository,
  type JobReportRepository,
} from './repository/JobReportRepository'
import type { JobReport, SubmitReportInput } from './dokuTypes'

const DEFAULT_REPO: JobReportRepository = new SupabaseJobReportRepository()

const MIN_BODY_LENGTH = 1
const MAX_BODY_LENGTH = 10000

export interface SubmitJobReportOptions {
  /** Test-Hook — Repo-Override für Mock-Tests. */
  repository?: JobReportRepository
}

export async function submitJobReport(
  input: SubmitReportInput & { authoredBy: string },
  options: SubmitJobReportOptions = {},
): Promise<JobReport> {
  const trimmed = input.body.trim()
  if (trimmed.length < MIN_BODY_LENGTH) {
    throw new Error('Bitte einen Bericht eintragen.')
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    throw new Error(
      `Bericht ist zu lang (${trimmed.length}/${MAX_BODY_LENGTH} Zeichen).`,
    )
  }

  const repo = options.repository ?? DEFAULT_REPO
  // Body trimmed an DB schicken: UI rendert den gestoreden Wert direkt,
  // führender/nachfolgender Whitespace würde sonst sichtbar bleiben. DB-
  // CHECK ist length(trim(body)) — das hält trotzdem, ist aber nicht das,
  // was im UI rendered wird.
  return repo.add({
    jobId: input.jobId,
    providerId: input.providerId,
    authoredBy: input.authoredBy,
    body: trimmed,
    ...(input.metadata !== undefined && { metadata: input.metadata }),
  })
}
