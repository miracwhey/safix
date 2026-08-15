import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getOutboundProjectRequests,
} from '../../lib/messages'
import type {
  OutboundProjectRequest,
  OutboundRequestStatus,
} from '../../lib/messages'

type Props = {
  /** The builder-project ID to look up outbound inquiries for. */
  projectId: string
}

/** Badge copy and colour per outbound request status. */
const STATUS_CONFIG: Record<
  OutboundRequestStatus,
  { label: string; classes: string }
> = {
  contacted: {
    label: 'Kontaktiert',
    classes: 'bg-blue-50 text-blue-600 ring-blue-200/60',
  },
  awaiting_reply: {
    label: 'Antwort ausstehend',
    classes: 'bg-amber-50 text-amber-600 ring-amber-200/60',
  },
  active_conversation: {
    label: 'Aktives Gespräch',
    classes: 'bg-emerald-50 text-emerald-600 ring-emerald-200/60',
  },
}

/**
 * Displays all outbound inquiry threads that were opened for a specific
 * builder project, together with a derived status label per craftsman.
 *
 * Each row links directly to the message thread so the customer can follow
 * up with a craftsman in one tap.
 *
 * Subscribes to the messages store so it stays in sync when a new inquiry
 * is dispatched via `startProjectInquiryWorkflow`.
 */
export default function ProjectOutboundRequestsCard({ projectId }: Props) {
  const [requests, setRequests] = useState<OutboundProjectRequest[]>(() =>
    getOutboundProjectRequests(projectId)
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRequests(getOutboundProjectRequests(projectId))
  }, [projectId])

  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Angefragte Handwerker
        </div>
        {requests.length > 0 && (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[12px] font-semibold text-slate-600">
            {requests.length}
          </span>
        )}
      </div>

      {/* Empty state */}
      {requests.length === 0 && (
        <div className="mt-4 flex flex-col items-center gap-2 rounded-[16px] bg-slate-50 px-4 py-5 text-center">
          <span className="text-[22px] leading-none">📬</span>
          <p className="text-[14px] font-medium text-slate-700">
            Noch keine Anfragen gesendet
          </p>
          <p className="text-[12px] text-slate-400">
            Nutze „Handwerker anfragen", um Angebote einzuholen.
          </p>
        </div>
      )}

      {/* Request rows */}
      {requests.length > 0 && (
        <>
          <ul className="mt-4 divide-y divide-slate-100">
            {requests.map((req) => (
              <RequestRow
                key={req.threadId}
                request={req}
              />
            ))}
          </ul>

          {/* What happens next */}
          <div className="mt-4 rounded-[16px] bg-slate-50 px-4 py-3">
            <p className="text-[12px] text-slate-500 leading-snug">
              Deine Anfragen laufen. Sobald ein Handwerker antwortet oder ein
              Angebot einreicht, wirst du hier benachrichtigt.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {NEXT_STEP_PILLS.map((pill) => (
                <span
                  key={pill}
                  className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200/70"
                >
                  {pill}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

// ── Private sub-components ─────────────────────────────────────────────────────

const NEXT_STEP_PILLS = [
  '⏳ Auf Antwort warten',
  '📋 Angebot prüfen',
  '✅ Annehmen & starten',
]

type RowProps = {
  request: OutboundProjectRequest
}

function RequestRow({ request }: RowProps) {
  const cfg = STATUS_CONFIG[request.status]

  return (
    <li>
      <Link
        to={`/messages/${request.threadId}`}
        className="flex w-full items-center gap-3 py-3 text-left transition active:scale-[0.99]"
        aria-label={`Nachricht an ${request.craftsmanName} öffnen`}
      >
        {/* Avatar */}
        <div className="relative shrink-0">
          <img
            src={request.craftsmanAvatarUrl}
            alt={request.craftsmanName}
            className="h-10 w-10 rounded-full object-cover ring-1 ring-slate-200/60"
            onError={(e) => {
              const img = e.currentTarget
              img.onerror = null
              img.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(request.craftsmanName)}&size=40&background=e2e8f0&color=64748b`
            }}
          />
          {request.unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#2563EB] text-[9px] font-bold text-white ring-2 ring-white">
              {request.unreadCount > 9 ? '9+' : request.unreadCount}
            </span>
          )}
        </div>

        {/* Name + handle + status */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-slate-900">
              {request.craftsmanName}
            </span>
            {request.timeLabel && (
              <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                {request.timeLabel}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[12px] text-slate-400">
              {request.craftsmanHandle}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${cfg.classes}`}
            >
              {cfg.label}
            </span>
          </div>
        </div>

        {/* Chevron */}
        <span className="shrink-0 text-slate-300" aria-hidden>
          ›
        </span>
      </Link>
    </li>
  )
}
