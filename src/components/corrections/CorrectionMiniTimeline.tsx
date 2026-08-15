import {
  deriveCorrectionTimeline,
  type CorrectionRequest,
  type CorrectionTimelineEvent,
} from '../../lib/corrections'

const LABELS: Record<CorrectionTimelineEvent['labelKey'], string> = {
  submitted: 'Du hast eingereicht',
  resolved: 'Admin hat übernommen',
  rejected: 'Admin hat abgelehnt',
}

const ACCENT: Record<CorrectionTimelineEvent['labelKey'], string> = {
  submitted: 'bg-blue-500',
  resolved: 'bg-emerald-500',
  rejected: 'bg-red-500',
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function CorrectionMiniTimeline({
  request,
}: {
  request: CorrectionRequest
}) {
  const events = deriveCorrectionTimeline(request)

  return (
    <div data-testid="correction-mini-timeline" className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Verlauf
      </div>
      <ol className="space-y-1.5">
        {events.map((evt, idx) => (
          <li
            key={`${evt.kind}-${idx}`}
            className="flex items-start gap-3 rounded-[12px] bg-slate-50 px-3 py-2 ring-1 ring-slate-100"
          >
            <span
              aria-hidden="true"
              className={`mt-1 h-2 w-2 shrink-0 rounded-full ${ACCENT[evt.labelKey]}`}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-slate-700">
                {LABELS[evt.labelKey]}
              </div>
              <div className="text-[10px] text-slate-400">
                {formatTimestamp(evt.occurredAt)}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
