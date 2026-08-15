export type CorrectionKind =
  | 'missing_time'
  | 'wrong_time'
  | 'wrong_assignment'
  | 'other'

export type CorrectionStatus =
  | 'open'
  | 'in_review'
  | 'resolved'
  | 'rejected'

/** Block 7.2.7b — Reason persistiert wenn Auto-Apply nach Approve nicht ausgeführt
 *  wurde. Best-effort: Status-Update gewinnt immer, Apply ist sekundär. */
export type CorrectionApplySkipReason =
  | 'kind_not_supported'
  | 'missing_calendar_entry'
  | 'invalid_time_format'
  | 'repository_error'

export type CorrectionRequest = {
  id: string
  /** Company scope — providers.id */
  providerId: string
  /** team_members.id of the submitting worker */
  workerTeamMemberId: string
  /** auth.uid() of the submitting worker — used for RLS */
  workerProfileId: string
  /** Optional reference to a specific calendar entry */
  calendarEntryId?: string
  /** Optional date the correction refers to, as YYYY-MM-DD */
  requestedDate?: string
  kind: CorrectionKind
  description: string
  status: CorrectionStatus
  /** Owner/admin response note, set during review */
  ownerNote?: string
  /** Block 7.2.3 — strukturierte Korrektur-Felder (alle optional). */
  field?: string
  currentValue?: string
  proposedValue?: string
  reason?: string
  /** Block 7.2.7b — Auto-Apply-Trace. Set wenn approveCorrectionWorkflow den
   *  verknüpften calendar_entry erfolgreich aktualisiert hat. */
  appliedAt?: number
  appliedTargetEntryId?: string
  /** Set wenn Approve durchging, Apply aber übersprungen/fehlgeschlagen. */
  applySkipReason?: CorrectionApplySkipReason
  createdAt: number
  updatedAt: number
}
