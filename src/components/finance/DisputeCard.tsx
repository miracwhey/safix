import type { DisputeCenterItem } from '../../lib/disputes'
import type { DisputeDecision, DisputeStatus } from '../../lib/disputes/types'
import type { MediaArtifactViewModel } from '../../lib/media'
import DisputeEvidenceSection from '../disputes/DisputeEvidenceSection'

type Props = {
  item: DisputeCenterItem
  evidenceArtifacts?: MediaArtifactViewModel[]
  onRelease?: () => void
  onRefund?: () => void
  /** When provided, enables the real Supabase Storage evidence upload flow */
  ownerUserId?: string
}

function getStatusBadgeClass(status: DisputeStatus, decision?: DisputeDecision): string {
  switch (status) {
    case 'open':
      return 'bg-amber-50 text-amber-700'
    case 'customer_waiting':
    case 'provider_waiting':
      return 'bg-orange-50 text-orange-700'
    case 'under_review':
      return 'bg-blue-50 text-blue-700'
    case 'closed':
      return 'bg-slate-100 text-slate-500'
    case 'cancelled':
      return 'bg-slate-100 text-slate-500'
    case 'resolved':
      if (decision === 'release') return 'bg-emerald-50 text-emerald-700'
      if (decision === 'refund') return 'bg-rose-50 text-rose-700'
      if (decision === 'split') return 'bg-amber-50 text-amber-700'
      return 'bg-slate-100 text-slate-500'
  }
}

export default function DisputeCard({
  item,
  evidenceArtifacts = [],
  onRelease,
  onRefund,
  ownerUserId,
}: Props) {
  return (
    <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-slate-900">
            {item.title}
          </div>

          <div className="mt-1 text-[13px] text-slate-500">
            {item.reasonLabel}
          </div>
        </div>

        <div
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusBadgeClass(
            item.dispute.status,
            item.dispute.decision,
          )}`}
        >
          {item.statusLabel}
        </div>
      </div>

      <div className="mt-3 text-[13px] leading-relaxed text-slate-600">
        {item.description}
      </div>

      {!item.isResolved && onRelease && onRefund ? (
        <div className="mt-4 flex gap-2">
          <button
            onClick={onRelease}
            className="rounded-xl bg-emerald-500 px-3 py-2 text-sm text-white"
          >
            Geld freigeben
          </button>

          <button
            onClick={onRefund}
            className="rounded-xl bg-red-500 px-3 py-2 text-sm text-white"
          >
            Rückerstatten
          </button>
        </div>
      ) : null}

      <DisputeEvidenceSection
        artifacts={evidenceArtifacts}
        uploadConfig={
          !item.isResolved && ownerUserId
            ? { disputeId: item.dispute.id, ownerUserId }
            : undefined
        }
      />
    </div>
  )
}
