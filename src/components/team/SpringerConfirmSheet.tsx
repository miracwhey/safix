/**
 * SpringerConfirmSheet — Block 3.
 *
 * Owner picks a Springer to take over a sick member's operational jobs today.
 * The sheet shows:
 *   1. The sick member + the affected jobs.
 *   2. A list of free candidates (sorted by affectedJobCount desc).
 *   3. A confirm step that calls reassignSpringerWorkflow per affected job.
 *
 * Multi-job: the same Springer covers all affected jobs in one click.
 * Per-job-failure surfaces inline (idempotent retry possible).
 */

import { useMemo, useState } from 'react'
import { X } from 'lucide-react'

import Spinner from '../system/Spinner'
import {
  reassignSpringerWorkflow,
  type SpringerReassignmentResult,
} from '../../lib/workflow/springerReassignmentWorkflow'
import {
  deriveSpringerCandidates,
  type SpringerCandidate,
} from '../../lib/team/absenceSelectors'
import type { Job, TeamMember } from '../../lib/jobs/types'

type Props = {
  open: boolean
  sickMember: { memberId: string; displayName: string } | null
  affectedJobs: Job[]
  members: TeamMember[]
  /** Other concurrently-sick members, excluded from candidates. */
  excludeMemberIds: Set<string>
  onClose: () => void
  onReassigned: (results: SpringerReassignmentResult[]) => void
}

export function SpringerConfirmSheet({
  open,
  sickMember,
  affectedJobs,
  members,
  excludeMemberIds,
  onClose,
  onReassigned,
}: Props) {
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<SpringerReassignmentResult[] | null>(null)

  const candidates: SpringerCandidate[] = useMemo(() => {
    if (!sickMember) return []
    const exclude = new Set(excludeMemberIds)
    exclude.add(sickMember.memberId)
    return deriveSpringerCandidates(members, affectedJobs, exclude)
  }, [members, affectedJobs, sickMember, excludeMemberIds])

  if (!open || !sickMember) return null

  const handleConfirm = async () => {
    if (!selectedCandidateId) return
    setSubmitting(true)
    setResults(null)
    try {
      const jobIds = affectedJobs.map((j) => j.id)
      const out = await reassignSpringerWorkflow(
        jobIds,
        sickMember.memberId,
        selectedCandidateId,
      )
      setResults(out)
      onReassigned(out)
      const allOk = out.every((r) => r.status === 'reassigned')
      if (allOk) {
        // Defer close so the user briefly sees the success state.
        window.setTimeout(() => {
          setResults(null)
          setSelectedCandidateId(null)
          onClose()
        }, 600)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unbekannter Fehler'
      setResults([{ jobId: '*', status: 'failed', error: msg }])
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50">
      <div className="w-full max-w-[420px] max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(20px,env(safe-area-inset-bottom))]">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-amber-600">
              Springer einsetzen
            </p>
            <h2 className="mt-1 text-[20px] font-semibold text-slate-900">
              {sickMember.displayName} ist krank
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {affectedJobs.length === 1
                ? '1 Auftrag betroffen'
                : `${affectedJobs.length} Aufträge betroffen`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-50"
            aria-label="Schließen"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4">
          <p className="text-[12px] font-medium text-slate-600">Aufträge</p>
          <ul className="mt-2 space-y-1.5">
            {affectedJobs.map((j) => (
              <li
                key={j.id}
                className="rounded-xl bg-slate-50 px-3 py-2 text-[13px] text-slate-800"
              >
                {j.title || j.id}
                <span className="ml-2 text-[11px] text-slate-500">{j.location}</span>
              </li>
            ))}
            {affectedJobs.length === 0 && (
              <li className="text-[12px] text-slate-400">
                Keine offenen Aufträge — kein Springer nötig.
              </li>
            )}
          </ul>
        </div>

        {affectedJobs.length > 0 && (
          <div className="mt-4">
            <p className="text-[12px] font-medium text-slate-600">Springer wählen</p>
            {candidates.length === 0 ? (
              <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[12px] text-slate-500">
                Keine freien Mitarbeiter verfügbar.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {candidates.map((c) => {
                  const isSelected = selectedCandidateId === c.memberId
                  return (
                    <li key={c.memberId}>
                      <button
                        type="button"
                        onClick={() => setSelectedCandidateId(c.memberId)}
                        disabled={submitting}
                        className={`w-full rounded-2xl border px-3 py-2 text-left ${
                          isSelected
                            ? 'border-amber-500 bg-amber-50'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        } disabled:opacity-50`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[14px] font-medium text-slate-900">
                            {c.displayName}
                          </span>
                          <span className="text-[11px] text-slate-500">
                            übernimmt {affectedJobs.length}{' '}
                            {affectedJobs.length === 1 ? 'Auftrag' : 'Aufträge'}
                          </span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        {results && (
          <div className="mt-4 space-y-1.5">
            {results.map((r, i) => (
              <p
                key={`${r.jobId}-${i}`}
                className={`rounded-xl px-3 py-1.5 text-[12px] ${
                  r.status === 'reassigned'
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-red-50 text-red-700'
                }`}
              >
                {r.jobId === '*'
                  ? r.error
                  : r.status === 'reassigned'
                  ? `${r.jobId}: zugewiesen`
                  : `${r.jobId}: ${r.error}`}
              </p>
            ))}
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-[14px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!selectedCandidateId || submitting || affectedJobs.length === 0}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-amber-500 px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {submitting && <Spinner size="sm" tone="current" inButton />}
            <span>Bestätigen</span>
          </button>
        </div>
      </div>
    </div>
  )
}
