/**
 * WorkerSickHistoryScreen — Block 3.
 *
 * Lists the worker's own absences (active + cancelled) sorted by start
 * date desc. Active rows show a "Zurücknehmen" inline action; cancelled
 * rows are read-only history.
 */

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Stethoscope } from 'lucide-react'

import AppShell from '../components/AppShell'
import Spinner from '../components/system/Spinner'
import {
  getAbsences,
  getTeamMembers,
  isAbsencesHydrated,
  subscribeAbsences,
  subscribeTeamMembers,
} from '../lib/team'
import { useSession } from '../hooks/useSession'
import { cancelAbsenceWorkflow } from '../lib/workflow/absenceWorkflow'
import {
  deriveAbsenceHistory,
} from '../lib/team/absenceSelectors'
import { useSmartBack } from '../hooks/useSmartBack'

function formatDateRange(start: string, end: string): string {
  const fmt = (s: string) => {
    const [y, m, d] = s.split('-')
    if (!y || !m || !d) return s
    return `${d}.${m}.${y}`
  }
  if (start === end) return fmt(start)
  return `${fmt(start)} – ${fmt(end)}`
}

export default function WorkerSickHistoryScreen() {
  const { user } = useSession()
  const goBack = useSmartBack('/worker/konto')
  const [absences, setAbsences] = useState(getAbsences)
  const [members, setMembers] = useState(getTeamMembers)
  const [hydrated, setHydrated] = useState(isAbsencesHydrated)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsubA = subscribeAbsences(() => {
      setAbsences(getAbsences())
      setHydrated(isAbsencesHydrated())
    })
    const unsubM = subscribeTeamMembers(() => setMembers(getTeamMembers()))
    return () => {
      unsubA()
      unsubM()
    }
  }, [])

  const memberId = useMemo(() => {
    if (!user) return null
    const mine = members.find((m) => m.userId === user.id)
    return mine?.id ?? null
  }, [members, user])

  const history = useMemo(
    () => (memberId ? deriveAbsenceHistory(absences, memberId) : []),
    [absences, memberId],
  )

  const handleCancel = async (absenceId: string) => {
    setCancellingId(absenceId)
    setError(null)
    try {
      await cancelAbsenceWorkflow(absenceId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unbekannter Fehler')
    } finally {
      setCancellingId(null)
    }
  }

  return (
    <AppShell active="worker-konto">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goBack}
              aria-label="Zurück"
              className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Konto
              </p>
              <h1 className="text-[20px] font-semibold text-slate-900">Krankmeldungen</h1>
            </div>
          </div>

          {!hydrated && (
            <div className="flex items-center justify-center rounded-3xl bg-white p-8 ring-1 ring-slate-200/70">
              <Spinner size="md" tone="neutral" />
            </div>
          )}

          {hydrated && history.length === 0 && (
            <div className="rounded-3xl bg-white p-6 text-center ring-1 ring-slate-200/70">
              <Stethoscope className="mx-auto mb-2 h-8 w-8 text-slate-300" />
              <p className="text-[14px] text-slate-500">Noch keine Krankmeldungen</p>
            </div>
          )}

          {hydrated && history.length > 0 && (
            <ul className="space-y-2">
              {history.map((absence) => {
                const isActive = absence.status === 'active'
                const isCancelling = cancellingId === absence.id
                return (
                  <li
                    key={absence.id}
                    className={`rounded-2xl bg-white p-4 ring-1 ${
                      isActive ? 'ring-amber-200' : 'ring-slate-200/70'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                          isActive ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        <Stethoscope className="h-4 w-4" />
                      </div>
                      <div className="flex-1">
                        <p className="text-[14px] font-medium text-slate-900">
                          {formatDateRange(absence.startDate, absence.endDate)}
                        </p>
                        {absence.reasonNote && (
                          <p className="mt-0.5 text-[12px] text-slate-500">{absence.reasonNote}</p>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          {isActive ? (
                            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                              aktiv
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                              zurückgenommen
                            </span>
                          )}
                          {absence.sickNoteRequested && (
                            <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
                              Attest angefordert
                            </span>
                          )}
                        </div>
                      </div>
                      {isActive && (
                        <button
                          type="button"
                          onClick={() => handleCancel(absence.id)}
                          disabled={isCancelling}
                          className="flex items-center gap-1 rounded-xl border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                        >
                          {isCancelling && <Spinner size="sm" tone="current" inButton />}
                          <span>Zurücknehmen</span>
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {error && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>
          )}
        </div>
      </section>
    </AppShell>
  )
}
