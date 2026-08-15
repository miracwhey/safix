import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import {
  getActiveOfferForConversation,
  getAcceptedOfferByJobId,
  subscribeOffers,
} from '../../lib/offers'
import { useStoreSync } from '../../lib/reactive'
import { deriveProposalLifecycle } from '../../lib/jobs/helpers'

type Props = {
  jobId: string
}

type ProposalStatusViewModel =
  | {
      state: 'awaiting_response' | 'accepted'
      proposalSentLabel: string
      proposalAcceptedLabel: string | null
      offerId: string | null
      jobKind: 'standard' | 'estimate_tracking' | 'cost_estimate_tracking' | 'diagnosis' | undefined
    }
  | {
      state: 'invalid'
      message: string
    }

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Derive the canonical offerId for a job.
 * - Pending: look up active offer via job.sourceConversationId
 * - Accepted: reverse lookup via offer.createdJobId
 */
function resolveOfferId(jobId: string): string | null {
  const job = getJobById(jobId)
  if (!job) return null
  if (job.sourceConversationId) {
    const active = getActiveOfferForConversation(job.sourceConversationId)
    if (active) return active.id
  }
  const accepted = getAcceptedOfferByJobId(jobId)
  return accepted?.id ?? null
}

function buildVm(jobId: string): ProposalStatusViewModel | null {
  const job = getJobById(jobId)
  if (!job) return null

  const lifecycle = deriveProposalLifecycle(job.proposalSentAt, job.proposalAcceptedAt)
  if (lifecycle.stage === 'invalid') {
    return {
      state: 'invalid',
      message: 'Ungültiger Angebotsstatus: Annahme vorhanden, aber Versandzeitpunkt fehlt.',
    }
  }

  if (!lifecycle.proposalSentAt) return null

  return {
    state: lifecycle.stage === 'accepted' ? 'accepted' : 'awaiting_response',
    proposalSentLabel: formatDate(lifecycle.proposalSentAt),
    proposalAcceptedLabel:
      lifecycle.stage === 'accepted' && lifecycle.proposalAcceptedAt
        ? formatDate(lifecycle.proposalAcceptedAt)
        : null,
    offerId: resolveOfferId(jobId),
    jobKind: job.jobKind,
  }
}

/**
 * Customer-facing card when a craftsman has sent a formal proposal/offer.
 *
 * Type-aware (Paket 4c):
 *   diagnosis — renders as Diagnose with purple styling and diagnosis-specific CTA
 *   other     — renders standard Angebot UI
 *
 * 'awaiting_response': informs the customer and deeplinks to QuoteDetailScreen.
 *   Accept/decline decisions belong there — not here.
 *
 * 'accepted': compact milestone showing the acceptance timestamp.
 *   CustomerProjectStateBlock owns the "what comes next" orchestration —
 *   this card no longer duplicates it.
 */
export default function CustomerProposalStatusCard({ jobId }: Props) {
  const navigate = useNavigate()
  const [vm, setVm] = useState<ProposalStatusViewModel | null>(() => buildVm(jobId))

  useStoreSync([subscribeJobs, subscribeOffers], () => setVm(buildVm(jobId)))

  if (!vm) return null

  if (vm.state === 'invalid') {
    return (
      <section className="rounded-[28px] bg-white p-5 ring-1 ring-red-200 shadow-[0_18px_40px_-28px_rgba(185,28,28,0.32)]">
        <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-red-600">
          Angebotsstatus ungültig
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-slate-600">{vm.message}</p>
        <p className="mt-1 text-[12px] text-slate-400">
          Bitte Handwerker kontaktieren und um erneuten Angebotsversand bitten.
        </p>
      </section>
    )
  }

  const isAccepted = vm.state === 'accepted'
  const isDiagnosis = vm.jobKind === 'diagnosis'
  const detailPath = vm.offerId ? `/quotes/${vm.offerId}` : null

  // ── Accepted: compact milestone ────────────────────────────────────────
  if (isAccepted) {
    if (isDiagnosis) {
      return (
        <section className="relative overflow-hidden rounded-[28px] bg-white p-5 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ring-1 ring-purple-200/80">
          <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-purple-500 via-purple-400 to-purple-300" />
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-purple-600"
              style={{ boxShadow: '0 6px 16px -10px rgba(2,6,23,0.4)' }}
            >
              <span className="text-[16px] leading-none">🔍</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-purple-700">Diagnoseeinsatz freigegeben</div>
              {vm.proposalAcceptedLabel && (
                <div className="mt-0.5 text-[12px] text-slate-400">{vm.proposalAcceptedLabel}</div>
              )}
            </div>
            {detailPath && (
              <button
                type="button"
                onClick={() => navigate(detailPath)}
                className="shrink-0 text-[11px] font-medium text-blue-600 transition hover:text-blue-700"
                data-testid="proposal-detail-link"
              >
                Details →
              </button>
            )}
          </div>
          <div className="mt-3 rounded-[12px] bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 ring-1 ring-amber-200/50">
            ⚠️ Weitere Ausführungsarbeiten erfordern ein neues Angebot.
          </div>
        </section>
      )
    }

    return (
      <section className="relative overflow-hidden rounded-[28px] bg-white p-5 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ring-1 ring-emerald-200/80">
        <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300" />
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-emerald-600"
            style={{ boxShadow: '0 6px 16px -10px rgba(2,6,23,0.4)' }}
          >
            <span className="text-[16px] leading-none">✅</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-emerald-700">Angebot angenommen</div>
            {vm.proposalAcceptedLabel && (
              <div className="mt-0.5 text-[12px] text-slate-400">{vm.proposalAcceptedLabel}</div>
            )}
          </div>
          {detailPath && (
            <button
              type="button"
              onClick={() => navigate(detailPath)}
              className="shrink-0 text-[11px] font-medium text-blue-600 transition hover:text-blue-700"
              data-testid="proposal-detail-link"
            >
              Details →
            </button>
          )}
        </div>
      </section>
    )
  }

  // ── Awaiting response ────────────────────────────────────────────────────
  if (isDiagnosis) {
    return (
      <section className="relative overflow-hidden rounded-[28px] bg-white p-5 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ring-1 ring-purple-200/80">
        <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-purple-500 via-purple-400 to-purple-300" />

        {/* Eyebrow + action badge */}
        <div className="flex items-center gap-2">
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-purple-600">
            Diagnose eingegangen
          </div>
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-amber-600 ring-1 ring-amber-200">
            HANDLUNG ERFORDERLICH
          </span>
        </div>

        {/* Icon + title row */}
        <div className="mt-3 flex items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-purple-600"
            style={{ boxShadow: '0 8px 20px -12px rgba(2,6,23,0.4)' }}
          >
            <span className="text-[18px] leading-none">🔍</span>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-snug text-slate-900">
              Diagnose liegt vor
            </h2>
          </div>
        </div>

        <p className="mt-3 text-[14px] leading-relaxed text-slate-500">
          Der Handwerker hat eine Diagnose-Anfrage eingereicht. Mit Freigabe erlaubst du ausschließlich den Diagnoseeinsatz — keine weitergehenden Arbeiten.
        </p>

        {/* Date info */}
        <div className="mt-4 rounded-[14px] bg-purple-50 px-3.5 py-3 ring-1 ring-purple-100">
          <div className="text-[12px] font-semibold text-purple-700 mb-0.5">
            Diagnose eingegangen
          </div>
          <div className="text-[13px] text-slate-500">{vm.proposalSentLabel}</div>
        </div>

        {/* Primary CTA */}
        <div className="mt-4">
          {detailPath ? (
            <button
              type="button"
              onClick={() => navigate(detailPath)}
              className="w-full rounded-[16px] bg-purple-600 py-3 text-[15px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(124,58,237,0.5)] transition active:scale-[0.98]"
              data-testid="proposal-review-cta"
            >
              Diagnose prüfen →
            </button>
          ) : (
            <p className="text-center text-[13px] text-slate-400">
              Diagnose wird geladen…
            </p>
          )}
        </div>
      </section>
    )
  }

  // ── Awaiting response — standard offer ───────────────────────────────────
  return (
    <section className="relative overflow-hidden rounded-[28px] bg-white p-5 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ring-1 ring-blue-200/80">
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-blue-500 via-blue-400 to-blue-300" />

      {/* Eyebrow + action badge */}
      <div className="flex items-center gap-2">
        <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-blue-500">
          Angebot eingegangen
        </div>
        <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-amber-600 ring-1 ring-amber-200">
          HANDLUNG ERFORDERLICH
        </span>
      </div>

      {/* Icon + title row */}
      <div className="mt-3 flex items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-600"
          style={{ boxShadow: '0 8px 20px -12px rgba(2,6,23,0.4)' }}
        >
          <span className="text-[18px] leading-none">📋</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-snug text-slate-900">
            Angebot liegt vor
          </h2>
        </div>
      </div>

      <p className="mt-3 text-[14px] leading-relaxed text-slate-500">
        Der Handwerker hat ein Angebot für dein Projekt eingereicht. Prüfe Preis,
        Leistungsumfang und Konditionen vor der Entscheidung.
      </p>

      {/* Date info */}
      <div className="mt-4 rounded-[14px] bg-blue-50 px-3.5 py-3 ring-1 ring-blue-100">
        <div className="text-[12px] font-semibold text-blue-700 mb-0.5">
          Angebot eingegangen
        </div>
        <div className="text-[13px] text-slate-500">{vm.proposalSentLabel}</div>
      </div>

      {/* Primary CTA: navigate to canonical offer detail — decision lives there */}
      <div className="mt-4">
        {detailPath ? (
          <button
            type="button"
            onClick={() => navigate(detailPath)}
            className="w-full rounded-[16px] bg-blue-600 py-3 text-[15px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(37,99,235,0.5)] transition active:scale-[0.98]"
            data-testid="proposal-review-cta"
          >
            Angebot prüfen →
          </button>
        ) : (
          <p className="text-center text-[13px] text-slate-400">
            Angebot wird geladen…
          </p>
        )}
      </div>
    </section>
  )
}
