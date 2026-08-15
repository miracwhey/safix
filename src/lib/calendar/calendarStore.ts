import { getJobs } from '../jobs/service'
import type { Job } from '../jobs/types'
import { createCalendarEntryFromJob, formatDateKey, isCalendarRelevantJob, mapJobStatusToCalendarStatus } from './calendarEngine'
import { assignMember, removeMember } from './teamAssignment'
import type { CalendarEntry, CalendarEntryStatus } from './calendarTypes'
import { getCalendarRepository } from './repository'
import { hasPersistenceFailureForEntity } from '../persistence'
import { generateUUID } from '../shared/generateUUID'
import { logWarning } from '../observability'

/** Order-insensitive equality of two assigned-member id lists. */
function sameMemberIds(a: string[] | undefined, b: string[] | undefined): boolean {
  const la = a ?? []
  const lb = b ?? []
  if (la.length !== lb.length) return false
  const set = new Set(lb)
  return la.every((id) => set.has(id))
}

export function subscribeCalendar(listener: () => void): () => void {
  return getCalendarRepository().subscribe(listener)
}

export function isCalendarRepositoryHydrated(): boolean {
  return getCalendarRepository().isHydrated()
}

export function getCalendarEntries(): CalendarEntry[] {
  return getCalendarRepository().getAll()
}

export function getCalendarEntryById(id: string): CalendarEntry | undefined {
  return getCalendarRepository().getById(id)
}

export function getCalendarEntryByJobId(jobId: string): CalendarEntry | undefined {
  return getCalendarRepository().getByJobId(jobId)
}

export function ensureCalendarEntryForJob(job: Job): CalendarEntry {
  const existing = getCalendarRepository().getByJobId(job.id)
  if (existing) return existing
  const created = createCalendarEntryFromJob(job)
  // passive: this is a background projection write — failures must not escalate
  // to the SyncStatusBar banner.  The repository logs the error to observability.
  void getCalendarRepository().add(created, { passive: true }).catch(() => {})
  return created
}

export function ensureCalendarEntryForJobId(jobId: string): CalendarEntry | undefined {
  const job = getJobs().find((job) => job.id === jobId)
  if (!job) return undefined
  return ensureCalendarEntryForJob(job)
}

export function updateCalendarStatus(entryId: string, nextStatus: CalendarEntryStatus): Promise<void> {
  const entry = getCalendarRepository().getById(entryId)
  if (!entry) return Promise.resolve()
  return getCalendarRepository().updateStatus(entryId, nextStatus).catch(() => {})
}

export function addTeamMember(entryId: string, memberId: string): void {
  const entry = getCalendarRepository().getById(entryId)
  if (!entry) return
  void getCalendarRepository().replace(assignMember(entry, memberId)).catch(() => {})
}

export function removeTeamMember(entryId: string, memberId: string): void {
  const entry = getCalendarRepository().getById(entryId)
  if (!entry) return
  void getCalendarRepository().replace(removeMember(entry, memberId)).catch(() => {})
}

export function moveCalendarEntryToDay(entryId: string, nextDay: 'today' | 'tomorrow'): void {
  const entry = getCalendarRepository().getById(entryId)
  if (!entry) return
  const target = new Date()
  if (nextDay === 'tomorrow') target.setDate(target.getDate() + 1)
  void getCalendarRepository().replace({
    ...entry,
    dateLabel: nextDay === 'today' ? 'Heute' : 'Morgen',
    dateKey: formatDateKey(target),
    updatedAt: Date.now(),
  }).catch(() => {})
}

/**
 * Ensures CalendarEntry objects exist for all calendar-relevant jobs and
 * reconciles semi-terminal/terminal job states against existing entries.
 *
 * Reconciliation applies to ALL jobs (not just calendar-relevant ones) so that
 * cancelled jobs — which isCalendarRelevantJob excludes — can still correct
 * entries that existed before the job was cancelled.
 *
 * Reconciled states: awaiting_payment, completed, cancelled.
 * Non-terminal states (pending, scheduled, in_progress) are intentionally not
 * reconciled: workers can manually advance entries independently of job status.
 *
 * awaiting_payment reconciliation corrects legacy rows created by old code that
 * mapped waiting_payment → completed on the calendar.
 *
 * Cross-context coverage: when a customer releases payment, the paymentHooks
 * calendar sync no-ops (no calendar entries in customer RLS scope). The next
 * craftsman/owner session load calls this function and corrects
 * awaiting_payment → completed from the canonical job truth.
 */
export function syncCalendarEntriesForJobs(jobs: Job[]): void {
  for (const job of jobs) {
    const existing = getCalendarRepository().getByJobId(job.id)
    if (existing) {
      const derivedStatus = mapJobStatusToCalendarStatus(job)
      const statusNeedsReconcile =
        derivedStatus !== existing.status &&
        (derivedStatus === 'awaiting_payment' ||
          derivedStatus === 'completed' ||
          derivedStatus === 'cancelled')
      // assignedMemberIds drift: createCalendarEntryFromJob snapshots the
      // members once (often [] before assignment) and nothing re-syncs them, so
      // a member (un)assignment or a Springer reassignment never reaches the
      // Operations team-load board. Reconcile against the live job truth.
      const membersNeedReconcile = !sameMemberIds(existing.assignedMemberIds, job.assignedMemberIds)
      if (!statusNeedsReconcile && !membersNeedReconcile) continue
      // Skip the reconcile write while a recorded failure exists for this
      // entity.  Subscribers (CraftsmanDashboardScreen, OperationsScreen)
      // re-fire syncCalendarEntriesForJobs on every JobRepository notify;
      // without this guard a single failing write turns into a firehose of
      // duplicate failure records that survive the resyncRepositories clear and
      // re-render the SyncStatusBar immediately — the user reads "Erneut
      // versuchen" as a no-op.  The user-driven retry path
      // (SyncStatusBar.handleResync) clears the failure store at the start, so a
      // fresh write does run when the user explicitly asks for it.
      if (hasPersistenceFailureForEntity('calendar', existing.id)) continue
      // passive: reconciliation writes must not escalate to the user banner.
      if (membersNeedReconcile) {
        // Members can only be written via a full-row replace; carry the
        // reconciled status in the same write so the narrow updateStatus path
        // doesn't race-clobber it.
        void getCalendarRepository()
          .replace(
            {
              ...existing,
              ...(statusNeedsReconcile ? { status: derivedStatus } : {}),
              assignedMemberIds: job.assignedMemberIds ?? [],
              updatedAt: Date.now(),
            },
            { passive: true },
          )
          .catch(() => {})
      } else {
        // Status-only reconcile keeps the narrow, RLS-safe updateStatus write.
        void getCalendarRepository().updateStatus(existing.id, derivedStatus, { passive: true }).catch(() => {})
      }
    } else if (isCalendarRelevantJob(job)) {
      const created = createCalendarEntryFromJob(job)
      // Same firehose guard for the create path — a permanent INSERT
      // failure (RLS WITH CHECK / NOT NULL / 23505) must not be retried
      // on every subscriber notify.
      if (hasPersistenceFailureForEntity('calendar', created.id)) continue
      // passive: same reasoning as the updateStatus path above.
      void getCalendarRepository().add(created, { passive: true }).catch(() => {})
    }
  }
}

/**
 * Create a custom calendar entry not tied to any job.
 * Used for manual appointments like "Baumarkt", "Besprechung", etc.
 *
 * Returns the created entry.  If the repository is not yet hydrated (provider
 * ID unknown), the write is skipped entirely — no optimistic local insert and
 * no Supabase call — so a null provider_id can never reach the DB.  The caller
 * receives the entry object but it will not appear in the calendar until the
 * repository has finished loading.  Callers should gate the UI on
 * `isCalendarRepositoryHydrated()` before invoking this function.
 */
export function addCustomCalendarEntry(params: {
  title: string
  description?: string
  dateKey: string
  startsAtLabel: string
  endsAtLabel: string
  location?: string
  providerId?: string
}): CalendarEntry {
  const now = Date.now()
  const date = new Date(
    +params.dateKey.slice(0, 4),
    +params.dateKey.slice(5, 7) - 1,
    +params.dateKey.slice(8, 10)
  )
  const todayKey = formatDateKey(new Date())
  const tomorrowDate = new Date()
  tomorrowDate.setDate(tomorrowDate.getDate() + 1)
  const tomorrowKey = formatDateKey(tomorrowDate)

  const dateLabel =
    params.dateKey === todayKey ? 'Heute'
      : params.dateKey === tomorrowKey ? 'Morgen'
      : date.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })

  const entry: CalendarEntry = {
    id: generateUUID(),
    kind: 'custom',
    ...(params.providerId ? { providerId: params.providerId } : {}),
    title: params.title,
    description: params.description ?? '',
    customerName: '',
    location: params.location ?? '',
    dateLabel,
    dateKey: params.dateKey,
    startsAtLabel: params.startsAtLabel,
    endsAtLabel: params.endsAtLabel,
    assignedMemberIds: [],
    status: 'scheduled',
    createdAt: now,
    updatedAt: now,
  }

  const repo = getCalendarRepository()

  // Hydration guard: custom calendar adds require a resolved provider_id (set
  // during repository initialize()). If the repository is not yet hydrated,
  // the provider ID is unknown and the INSERT would fail with 42501. Skip the
  // write entirely — neither an optimistic local add nor a Supabase round-trip
  // — so no null provider_id reaches the DB and no persistence failure is
  // recorded for a state that will resolve on its own once loading completes.
  if (!repo.isHydrated()) {
    logWarning('calendar.addCustom_skipped_not_hydrated', { entityId: entry.id })
    return entry
  }

  void repo.add(entry).catch(() => {})
  return entry
}
