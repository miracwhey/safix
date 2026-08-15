export type CalendarEntryStatus =
  | 'pending'
  | 'scheduled'
  | 'in_progress'
  | 'awaiting_payment'
  | 'completed'
  | 'cancelled'

export type CalendarEntryKind = 'job' | 'custom'

export type CalendarViewMode = 'list' | 'week'

export type CalendarEntry = {
  id: string
  /** Job ID — present for job-derived entries, absent for custom entries. */
  jobId?: string
  /** Distinguishes job-derived from manually created entries. */
  kind: CalendarEntryKind
  /**
   * providers.id that owns this assignment.
   * Establishes hard company scope: entries without a providerId are legacy
   * rows that predate the company model and remain accessible to owners via
   * the job-linkage fallback.  New entries always carry this field.
   */
  providerId?: string
  title: string
  /** Free-text notes — set for custom entries, empty string for job-derived entries. */
  description: string
  customerName: string
  location: string
  dateLabel: string
  dateKey: string
  startsAtLabel: string
  endsAtLabel: string
  assignedMemberIds: string[]
  status: CalendarEntryStatus
  createdAt: number
  updatedAt: number
}
