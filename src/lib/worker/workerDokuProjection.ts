/**
 * Worker Doku-tab projection.
 *
 * Pure functions: map CalendarEntry + Job state into Doku list/detail view
 * models. No side effects, no store access.
 *
 * Bounded-truth module model (Block B)
 * ─────────────────────────────────────────────────────────────────────────────
 * Two module families have real storage backing in the current repo:
 *   fotos   → Job.photoCount
 *   bericht → job_reports (mit Fallback auf Job.notes[] für Legacy-Rows)
 *
 * Three families have no dedicated storage yet:
 *   material | maengel | unterschrift → shown as 'unavailable'
 *
 * Only real modules (fotos + bericht) count toward completeness.
 * Unavailable modules are visible in the detail but excluded from the count.
 *
 * Case identity
 * ─────────────────────────────────────────────────────────────────────────────
 * One Doku case = one CalendarEntry assigned to the worker.
 * caseId = CalendarEntry.id
 *
 * Grouping rules
 * ─────────────────────────────────────────────────────────────────────────────
 * offen         status ∈ {pending, scheduled, in_progress}
 * abgeschlossen status === 'completed'
 * cancelled     excluded — assignment did not happen, no documentation needed
 *
 * Sort order
 * ─────────────────────────────────────────────────────────────────────────────
 * offen:         in_progress → scheduled → pending; within same priority by date asc
 * abgeschlossen: newest first (dateKey desc)
 */

import type { CalendarEntry, CalendarEntryStatus } from '../calendar/calendarTypes'
import type { Job } from '../jobs/types'
import type { JobPhoto, JobReport } from './dokuTypes'

// ── Module taxonomy ───────────────────────────────────────────────────────────

export type DokuModuleKey =
  | 'fotos'
  | 'bericht'
  | 'material'
  | 'maengel'
  | 'unterschrift'

export type DokuModuleStatus = 'complete' | 'open' | 'unavailable'
export type DokuCaseStatus = 'offen' | 'abgeschlossen'

const REAL_MODULE_KEYS: DokuModuleKey[] = ['fotos', 'bericht']
const UNAVAILABLE_MODULE_KEYS: DokuModuleKey[] = ['material', 'maengel', 'unterschrift']
const ALL_MODULE_KEYS: DokuModuleKey[] = [
  'fotos',
  'bericht',
  'material',
  'maengel',
  'unterschrift',
]

const MODULE_LABELS: Record<DokuModuleKey, string> = {
  fotos: 'Fotos',
  bericht: 'Bericht / Notizen',
  material: 'Material',
  maengel: 'Mängel / Abweichungen',
  unterschrift: 'Unterschrift',
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type DokuModuleViewModel = {
  key: DokuModuleKey
  status: DokuModuleStatus
  label: string
  /** Short display line shown under the module label */
  summary: string
  /**
   * True wenn das Modul einen aktiven Editor / CTA hat. Block C.3:
   * - `fotos` und `bericht` sind actionable, sobald Worker auf einem
   *   Job mit Job-Daten ist (auch bei `complete` — Worker kann mehr
   *   Fotos / Reports adden bis 24 h-Edit-Window läuft)
   * - `material` / `maengel` / `unterschrift` bleiben non-actionable
   *   (`unavailable`-Status)
   */
  isActionable: boolean
}

export type DokuCompletenessViewModel = {
  /** Number of real modules (fotos + bericht) that are complete */
  doneCount: number
  /** Total real module count — currently 2 */
  totalCount: number
  progressPct: number
  /** Human-readable labels for real modules still open — e.g. "Fotos fehlen" */
  missingLabels: string[]
  isComplete: boolean
  /**
   * False when no job is linked to this entry.
   * Module states cannot be assessed without job data.
   */
  hasJobData: boolean
}

export type DokuCaseCardViewModel = {
  caseId: string
  assignmentTitle: string
  customerName: string
  location: string
  dateLabel: string
  /** YYYY-MM-DD — used for sorting within the projection */
  dateKey: string
  caseStatus: DokuCaseStatus
  entryStatus: CalendarEntryStatus
  completeness: DokuCompletenessViewModel
}

export type DokuListViewModel = {
  offen: DokuCaseCardViewModel[]
  abgeschlossen: DokuCaseCardViewModel[]
}

export type DokuDetailViewModel = {
  caseId: string
  assignmentTitle: string
  customerName: string
  location: string
  dateLabel: string
  caseStatus: DokuCaseStatus
  entryStatus: CalendarEntryStatus
  completeness: DokuCompletenessViewModel
  modules: DokuModuleViewModel[]
  /** True when entry.jobId is present and a matching job was found */
  hasJobLink: boolean
}

// ── Internal derivation helpers ───────────────────────────────────────────────

function resolveJob(entry: CalendarEntry, jobs: Job[]): Job | null {
  if (!entry.jobId) return null
  return jobs.find((j) => j.id === entry.jobId) ?? null
}

function deriveCaseStatus(entry: CalendarEntry): DokuCaseStatus {
  return entry.status === 'completed' || entry.status === 'awaiting_payment'
    ? 'abgeschlossen'
    : 'offen'
}

/**
 * Block C.3 source-of-truth: Modul-Counts kommen primär aus den Domain-
 * Tabellen `job_photos` / `job_reports`. Wenn die Repos für diesen Job
 * `[]` liefern (z.B. Pre-C.3-Bestandsdaten), fallen wir auf die Legacy-
 * Felder `Job.photoCount` / `Job.notes[]` zurück. Nach Roll-out + Daten-
 * Migration in einem Folge-Block werden Legacy-Reads entfernt.
 */
function countPhotos(job: Job | null, photos: JobPhoto[]): number {
  if (photos.length > 0) return photos.length
  return job?.photoCount ?? 0
}

function countReports(job: Job | null, reports: JobReport[]): number {
  if (reports.length > 0) return reports.length
  return job?.notes?.length ?? 0
}

function deriveCompleteness(
  job: Job | null,
  photos: JobPhoto[],
  reports: JobReport[],
): DokuCompletenessViewModel {
  const hasJobData = job !== null
  const photoCount = countPhotos(job, photos)
  const reportCount = countReports(job, reports)
  const fotosComplete = hasJobData && photoCount > 0
  const berichtComplete = hasJobData && reportCount > 0

  const doneCount = (fotosComplete ? 1 : 0) + (berichtComplete ? 1 : 0)
  const totalCount = REAL_MODULE_KEYS.length

  const missingLabels: string[] = [
    ...(!fotosComplete ? ['Fotos fehlen'] : []),
    ...(!berichtComplete ? ['Bericht offen'] : []),
  ]

  return {
    doneCount,
    totalCount,
    progressPct: (doneCount / totalCount) * 100,
    missingLabels,
    isComplete: doneCount === totalCount,
    hasJobData,
  }
}

function deriveModuleViewModel(
  key: DokuModuleKey,
  job: Job | null,
  photos: JobPhoto[],
  reports: JobReport[],
): DokuModuleViewModel {
  // Modules without dedicated storage
  if (UNAVAILABLE_MODULE_KEYS.includes(key)) {
    return {
      key,
      status: 'unavailable',
      label: MODULE_LABELS[key],
      summary: 'Noch nicht verfügbar',
      isActionable: false,
    }
  }

  // Real modules: no job data means we cannot assess state
  if (job === null) {
    return {
      key,
      status: 'open',
      label: MODULE_LABELS[key],
      summary: 'Keine Auftragsdaten verknüpft',
      isActionable: false,
    }
  }

  if (key === 'fotos') {
    const count = countPhotos(job, photos)
    return {
      key,
      status: count > 0 ? 'complete' : 'open',
      label: MODULE_LABELS[key],
      summary:
        count > 0
          ? count === 1
            ? '1 Foto hochgeladen'
            : `${count} Fotos hochgeladen`
          : 'Noch keine Fotos',
      // Block C.3 — Worker kann jederzeit weitere Fotos hinzufügen, auch
      // wenn Modul `complete` ist. CTA bleibt aktiv.
      isActionable: true,
    }
  }

  if (key === 'bericht') {
    const count = countReports(job, reports)
    return {
      key,
      status: count > 0 ? 'complete' : 'open',
      label: MODULE_LABELS[key],
      summary:
        count > 0
          ? count === 1
            ? '1 Bericht erfasst'
            : `${count} Berichte erfasst`
          : 'Noch kein Bericht',
      // Block C.3 — Bericht ist actionable bis ein Bericht erfasst ist.
      // Multi-Report-Edit-Pfad folgt im 24 h-Window via Modul-Detail
      // (out of scope für MVP CTA — siehe Plan §5).
      isActionable: count === 0,
    }
  }

  // Fallback (should not be reached for known keys)
  return {
    key,
    status: 'open',
    label: MODULE_LABELS[key],
    summary: '',
    isActionable: false,
  }
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

const OFFEN_STATUS_PRIORITY: Partial<Record<CalendarEntryStatus, number>> = {
  in_progress: 0,
  scheduled: 1,
  pending: 2,
}

// ── List projection ───────────────────────────────────────────────────────────

/**
 * Derives the Doku tab list view model from worker-filtered entries + jobs.
 *
 * @param userEntries CalendarEntries already filtered to this worker
 * @param jobs        All known jobs
 * @param photosByJobId Optional: aktuelle job_photos pro Job (Block C.3).
 *                     Wenn leer/missing → fallback auf Job.photoCount-Legacy.
 * @param reportsByJobId Optional: aktuelle job_reports pro Job. Fallback auf
 *                       Job.notes-Legacy.
 */
export function deriveDokuListViewModel(
  userEntries: CalendarEntry[],
  jobs: Job[],
  photosByJobId: ReadonlyMap<string, JobPhoto[]> = new Map(),
  reportsByJobId: ReadonlyMap<string, JobReport[]> = new Map(),
): DokuListViewModel {
  const offen: DokuCaseCardViewModel[] = []
  const abgeschlossen: DokuCaseCardViewModel[] = []

  for (const entry of userEntries) {
    // Cancelled assignments excluded — no documentation needed
    if (entry.status === 'cancelled') continue

    const job = resolveJob(entry, jobs)
    const photos = job ? photosByJobId.get(job.id) ?? [] : []
    const reports = job ? reportsByJobId.get(job.id) ?? [] : []
    const caseStatus = deriveCaseStatus(entry)
    const completeness = deriveCompleteness(job, photos, reports)

    const card: DokuCaseCardViewModel = {
      caseId: entry.id,
      assignmentTitle: entry.title,
      customerName: entry.customerName,
      location: entry.location,
      dateLabel: entry.dateLabel,
      dateKey: entry.dateKey,
      caseStatus,
      entryStatus: entry.status,
      completeness,
    }

    if (caseStatus === 'abgeschlossen') {
      abgeschlossen.push(card)
    } else {
      offen.push(card)
    }
  }

  // Offen: in_progress first, then scheduled, then pending; within same priority nearest date first
  offen.sort((a, b) => {
    const aPri = OFFEN_STATUS_PRIORITY[a.entryStatus] ?? 99
    const bPri = OFFEN_STATUS_PRIORITY[b.entryStatus] ?? 99
    if (aPri !== bPri) return aPri - bPri
    return a.dateKey.localeCompare(b.dateKey)
  })

  // Abgeschlossen: newest first
  abgeschlossen.sort((a, b) => b.dateKey.localeCompare(a.dateKey))

  return { offen, abgeschlossen }
}

// ── Detail projection ─────────────────────────────────────────────────────────

/**
 * Derives the Doku detail view model for a single calendar entry.
 *
 * @param entry   CalendarEntry for this documentation case
 * @param jobs    All known jobs — used only for optional job lookup
 * @param photos  job_photos rows for the linked job. Empty array →
 *                fallback to legacy `Job.photoCount`.
 * @param reports job_reports rows for the linked job. Empty array →
 *                fallback to legacy `Job.notes`.
 */
export function deriveDokuDetailViewModel(
  entry: CalendarEntry,
  jobs: Job[],
  photos: JobPhoto[] = [],
  reports: JobReport[] = [],
): DokuDetailViewModel {
  const job = resolveJob(entry, jobs)
  const caseStatus = deriveCaseStatus(entry)
  const completeness = deriveCompleteness(job, photos, reports)

  const modules = ALL_MODULE_KEYS.map((key) =>
    deriveModuleViewModel(key, job, photos, reports),
  )

  return {
    caseId: entry.id,
    assignmentTitle: entry.title,
    customerName: entry.customerName,
    location: entry.location,
    dateLabel: entry.dateLabel,
    caseStatus,
    entryStatus: entry.status,
    completeness,
    modules,
    hasJobLink: job !== null,
  }
}
