import type { CorrectionRequest } from './types'

/**
 * Lifecycle-event abgeleitet aus dem Korrektur-Record. Korrekturen sind
 * team-scoped, nicht job-scoped — die zentrale `ProjectTimelineSignal` lässt
 * sich daher nicht direkt nutzen. Mockup verlangt aber eine kleine Worker-
 * Timeline ("du eingereicht / Admin reagiert / Decision"). Pure-function
 * statt Audit-Tabelle: das DB-Schema kennt nur createdAt + updatedAt + status,
 * mehr Granularität gibt es nicht.
 */
export type CorrectionTimelineEventKind =
  | 'submitted'
  | 'resolved'
  | 'rejected'

export type CorrectionTimelineEvent = {
  kind: CorrectionTimelineEventKind
  occurredAt: number
  /** Stable label keys für UI; deutsch in der View. */
  labelKey: 'submitted' | 'resolved' | 'rejected'
}

/**
 * Leitet die Mini-Timeline-Events aus dem Korrektur-Record ab.
 *
 * Regeln:
 *   - "submitted" immer (bei createdAt)
 *   - "resolved" / "rejected" nur wenn status terminal AND updatedAt > createdAt
 *     (gleicher Timestamp = Submit ohne Admin-Touch → kein zweites Event)
 *   - sortiert chronologisch aufsteigend
 */
export function deriveCorrectionTimeline(
  request: CorrectionRequest,
): CorrectionTimelineEvent[] {
  const events: CorrectionTimelineEvent[] = [
    {
      kind: 'submitted',
      occurredAt: request.createdAt,
      labelKey: 'submitted',
    },
  ]

  const wasReviewed = request.updatedAt > request.createdAt

  if (wasReviewed && request.status === 'resolved') {
    events.push({
      kind: 'resolved',
      occurredAt: request.updatedAt,
      labelKey: 'resolved',
    })
  } else if (wasReviewed && request.status === 'rejected') {
    events.push({
      kind: 'rejected',
      occurredAt: request.updatedAt,
      labelKey: 'rejected',
    })
  }

  return events
}
