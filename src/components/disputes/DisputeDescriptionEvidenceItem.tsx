import type { DisputeEvidence } from '../../lib/disputes/types'
import { describeDescriptionEvidenceAuthor } from '../../lib/disputes/disputeResponseSelectors'
import type { Job } from '../../lib/jobs/types'

type Props = {
  evidence: DisputeEvidence
  /** Used to derive the role label (Inhaber / Kunde / SaFix). */
  job?: Job
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function authorTone(label: 'Inhaber' | 'Kunde' | 'SaFix'): {
  border: string
  pill: string
  text: string
} {
  switch (label) {
    case 'Kunde':
      return {
        border: 'border-l-amber-500',
        pill: 'bg-amber-50 text-amber-700',
        text: 'text-amber-700',
      }
    case 'SaFix':
      return {
        border: 'border-l-slate-500',
        pill: 'bg-slate-50 text-slate-700',
        text: 'text-slate-700',
      }
    case 'Inhaber':
    default:
      return {
        border: 'border-l-indigo-500',
        pill: 'bg-indigo-50 text-indigo-700',
        text: 'text-indigo-700',
      }
  }
}

export default function DisputeDescriptionEvidenceItem({ evidence, job }: Props) {
  const label = job
    ? describeDescriptionEvidenceAuthor({
        evidenceSubmittedBy: evidence.submittedBy,
        job,
      })
    : 'Inhaber'
  const tone = authorTone(label)
  const stamp = formatTimestamp(evidence.submittedAt)

  return (
    <div
      className={`rounded-[12px] bg-white border border-slate-200 border-l-[3px] ${tone.border} px-3 py-2`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-semibold ${tone.text}`}>
          Stellungnahme {label}
          {stamp ? ` · ${stamp}` : ''}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone.pill}`}
        >
          Text
        </span>
      </div>
      <div className="mt-1 whitespace-pre-wrap text-[13px] text-slate-700">
        {evidence.description}
      </div>
    </div>
  )
}
