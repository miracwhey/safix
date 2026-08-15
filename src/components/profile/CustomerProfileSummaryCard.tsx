import { Link } from 'react-router-dom'
import type { CustomerProjectSummary } from '../../lib/jobs/customerProfileSelectors'

type Props = {
  summary: CustomerProjectSummary
}

export default function CustomerProfileSummaryCard({ summary }: Props) {
  return (
    <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Meine Projekte
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-[22px] bg-[#2563EB] p-4 text-white shadow-[0_18px_40px_-28px_rgba(37,99,235,0.65)]">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/75">
            Gesamt
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none">
            {summary.total}
          </div>
          <div className="mt-2 text-[12px] text-white/80">Aufträge</div>
        </div>

        <div className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.22)]">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Aktiv
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none text-slate-900">
            {summary.active}
          </div>
          <div className="mt-2 text-[12px] text-slate-500">Laufend</div>
        </div>
      </div>

      {summary.requiresAttention > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-[18px] bg-amber-50 px-4 py-3 ring-1 ring-amber-200/70">
          <span className="text-[16px]">⚡</span>
          <span className="text-[13px] font-semibold text-amber-800">
            {summary.requiresAttention === 1
              ? '1 Projekt erfordert deine Aufmerksamkeit'
              : `${summary.requiresAttention} Projekte erfordern deine Aufmerksamkeit`}
          </span>
        </div>
      )}

      {summary.mostRecentActiveProject && (
        <div className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-2">
            Zuletzt aktiv
          </div>
          <Link
            to={`/projects/${summary.mostRecentActiveProject.id}`}
            className="block rounded-[18px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/60 transition active:scale-[0.99]"
          >
            <div className="text-[14px] font-semibold text-slate-900 truncate">
              {summary.mostRecentActiveProject.title}
            </div>
            <div className="mt-0.5 text-[12px] text-slate-500">
              {summary.mostRecentActiveProject.craftsman} ·{' '}
              {summary.mostRecentActiveProject.location}
            </div>
          </Link>
        </div>
      )}

      <Link
        to="/projects"
        className="mt-4 flex items-center justify-between rounded-[18px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/60 transition active:scale-[0.99]"
      >
        <span className="text-[14px] font-semibold text-slate-700">
          Alle Projekte ansehen
        </span>
        <span className="text-[14px] font-semibold text-[#2563EB]">→</span>
      </Link>
    </div>
  )
}
