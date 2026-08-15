import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Camera, CheckCircle2, ChevronRight } from 'lucide-react'
import AppShell from '../components/AppShell'
import { getCalendarEntries, subscribeCalendar } from '../lib/calendar'
import { intentionalReload } from '../lib/lifecycle/killDetection'
import {
  getEntriesForMember,
  getEntriesForUser,
} from '../lib/calendar/calendarSelectors'
import { getJobs, getTeamMembers, subscribeJobs } from '../lib/jobs'
import { subscribeTeamMembers, isTeamMembersHydrated, retryTeamMembersHydration } from '../lib/team'
import { useSession } from '../hooks/useSession'
import {
  deriveDokuListViewModel,
  type DokuCaseCardViewModel,
} from '../lib/worker/workerDokuProjection'
import type { CalendarEntry } from '../lib/calendar/calendarTypes'
import type { Job } from '../lib/jobs/types'
import {
  SupabaseJobPhotoRepository,
  type JobPhotoRepository,
} from '../lib/worker/repository/JobPhotoRepository'
import {
  SupabaseJobReportRepository,
  type JobReportRepository,
} from '../lib/worker/repository/JobReportRepository'
import type { JobPhoto, JobReport } from '../lib/worker/dokuTypes'
import { logError } from '../lib/observability'

const photoRepo: JobPhotoRepository = new SupabaseJobPhotoRepository()
const reportRepo: JobReportRepository = new SupabaseJobReportRepository()

const IS_IN_MEMORY = import.meta.env.VITE_DATA_SOURCE !== 'supabase'
const HYDRATION_TIMEOUT_MS = 15_000

// ── Atoms ─────────────────────────────────────────────────────────────────────

function SectionHeader({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  return (
    <div className="mb-3 px-1">
      <h2
        className={
          quiet
            ? 'text-[13px] font-semibold text-slate-500'
            : 'text-[16px] font-semibold text-slate-800'
        }
      >
        {children}
      </h2>
    </div>
  )
}

// ── Open case card ────────────────────────────────────────────────────────────

function OffenCard({
  vm,
  onOpen,
}: {
  vm: DokuCaseCardViewModel
  onOpen: () => void
}) {
  const { completeness } = vm
  const missingCount = completeness.missingLabels.length
  const isNearlyDone = missingCount === 1
  const isAllDone = completeness.isComplete

  const ringCls = isAllDone || isNearlyDone
    ? 'ring-emerald-200/70 shadow-[0_20px_44px_-28px_rgba(16,185,129,0.22)]'
    : 'ring-slate-200/70 shadow-[0_20px_44px_-28px_rgba(2,6,23,0.22)]'

  const barCls = isAllDone || isNearlyDone ? 'bg-emerald-400' : 'bg-blue-400'

  return (
    <div className={`rounded-[28px] bg-white p-5 ring-1 ${ringCls}`}>
      {/* Identity */}
      <div className="mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400 mb-1">
          {vm.dateLabel} · {vm.location}
        </div>
        <div className="text-[16px] font-bold tracking-tight text-slate-900 leading-snug">
          {vm.assignmentTitle}
        </div>
        <div className="mt-0.5 text-[13px] text-slate-500">{vm.customerName}</div>
      </div>

      {/* Progress */}
      <div className="mb-3 border-t border-slate-100 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium text-slate-500">
            {completeness.hasJobData
              ? `${completeness.doneCount} von ${completeness.totalCount} Nachweisen`
              : 'Keine Auftragsdaten'}
          </span>
          {isAllDone && (
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-600">
              Vollständig
            </span>
          )}
          {isNearlyDone && !isAllDone && (
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-600">
              Fast fertig
            </span>
          )}
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full transition-all ${barCls}`}
            style={{ width: `${completeness.progressPct}%` }}
          />
        </div>
      </div>

      {/* Missing modules — only shown when there are gaps */}
      {completeness.missingLabels.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {completeness.missingLabels.map((label) => (
            <div key={label} className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
              <span className="text-[13px] text-slate-600">{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* No-job warning */}
      {!completeness.hasJobData && (
        <div className="mb-4 space-y-1.5">
          <p className="text-[12px] text-slate-400">
            Auftragsdaten konnten nicht zugeordnet werden.
          </p>
          <button
            type="button"
            onClick={() => intentionalReload()}
            className="text-[12px] font-medium text-slate-500 underline underline-offset-2 active:opacity-60"
          >
            Seite neu laden
          </button>
        </div>
      )}

      {/* CTA */}
      <button
        type="button"
        onClick={onOpen}
        className={`w-full rounded-[16px] py-3 text-[14px] font-semibold active:scale-[0.99] transition-transform ${
          isAllDone
            ? 'bg-slate-100 text-slate-700'
            : isNearlyDone
            ? 'bg-emerald-600 text-white'
            : 'bg-slate-900 text-white'
        }`}
      >
        {isAllDone ? 'Überprüfen' : 'Dokumentieren'}
      </button>
    </div>
  )
}

// ── Completed row ─────────────────────────────────────────────────────────────

function AbgeschlossenRow({
  vm,
  onOpen,
}: {
  vm: DokuCaseCardViewModel
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left rounded-[20px] bg-slate-50/80 px-4 py-3 ring-1 ring-slate-100 active:scale-[0.99] transition-transform flex items-center justify-between gap-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-emerald-500" />
          <span className="text-[14px] font-semibold text-slate-700 truncate">
            {vm.assignmentTitle}
          </span>
        </div>
        <div className="ml-[21px] mt-0.5 text-[12px] text-slate-400">
          {vm.customerName} · {vm.dateLabel}
        </div>
      </div>
      <ChevronRight size={13} strokeWidth={2} className="shrink-0 text-slate-300" />
    </button>
  )
}

// ── Sections ──────────────────────────────────────────────────────────────────

function OffenSection({
  cases,
  onOpen,
}: {
  cases: DokuCaseCardViewModel[]
  onOpen: (caseId: string) => void
}) {
  return (
    <section>
      <SectionHeader>Offen</SectionHeader>

      {cases.length === 0 ? (
        <div className="rounded-[22px] bg-slate-50 px-5 py-5 ring-1 ring-slate-100">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={18} strokeWidth={1.8} className="shrink-0 text-emerald-500" />
            <p className="text-[13px] font-medium text-slate-600">
              Alle Dokumentationen sind abgeschlossen.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {cases.map((vm) => (
            <OffenCard key={vm.caseId} vm={vm} onOpen={() => onOpen(vm.caseId)} />
          ))}
        </div>
      )}
    </section>
  )
}

function AbgeschlossenSection({
  cases,
  onOpen,
}: {
  cases: DokuCaseCardViewModel[]
  onOpen: (caseId: string) => void
}) {
  return (
    <section>
      <SectionHeader quiet>Abgeschlossen</SectionHeader>

      {cases.length === 0 ? (
        <div className="rounded-[22px] bg-slate-50 px-5 py-3 ring-1 ring-slate-100">
          <p className="text-[12px] text-slate-400">
            Noch keine abgeschlossenen Dokumentationen.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {cases.map((vm) => (
            <AbgeschlossenRow key={vm.caseId} vm={vm} onOpen={() => onOpen(vm.caseId)} />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Empty state (no assignments at all) ──────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
      <div className="h-14 w-14 rounded-2xl bg-slate-100 flex items-center justify-center">
        <Camera size={24} strokeWidth={1.5} className="text-slate-400" />
      </div>
      <div>
        <p className="text-[15px] font-semibold text-slate-700">Keine Einträge</p>
        <p className="text-[13px] text-slate-400 mt-1 max-w-[220px]">
          Dokumentationsfälle zu Einsätzen erscheinen hier.
        </p>
      </div>
    </div>
  )
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export default function WorkerDokuScreen() {
  const { user } = useSession()
  const navigate = useNavigate()

  const [allEntries, setAllEntries] = useState<CalendarEntry[]>(getCalendarEntries)
  const [teamMembers, setTeamMembers] = useState(getTeamMembers)
  const [jobs, setJobs] = useState<Job[]>(getJobs)
  const [teamMembersHydrated, setTeamMembersHydrated] = useState(isTeamMembersHydrated)
  const [hydrationTimedOut, setHydrationTimedOut] = useState(false)
  const [hydrationRetryEpoch, setHydrationRetryEpoch] = useState(0)

  useEffect(() => {
    if (teamMembersHydrated) return
    const t = setTimeout(() => setHydrationTimedOut(true), HYDRATION_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [teamMembersHydrated, hydrationRetryEpoch])

  useEffect(() => {
    const unsubCalendar = subscribeCalendar(() => setAllEntries(getCalendarEntries()))
    const unsubTeam = subscribeTeamMembers(() => {
      setTeamMembers(getTeamMembers())
      setTeamMembersHydrated(isTeamMembersHydrated())
    })
    // Immediate post-subscribe snapshot: closes the render→subscribe race window.
    // CustomerHomeScreen uses the same pattern; rule fires here for unknown reasons.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTeamMembers(getTeamMembers())
    setTeamMembersHydrated(isTeamMembersHydrated())
    const unsubJobs = subscribeJobs(() => setJobs(getJobs()))
    return () => {
      unsubCalendar()
      unsubTeam()
      unsubJobs()
    }
  }, [])

  const userEntries = useMemo(() => {
    if (!user) return []
    const linked = getEntriesForUser(allEntries, teamMembers, user.id)
    if (linked.length === 0 && IS_IN_MEMORY) {
      return getEntriesForMember(allEntries, 'tm-1')
    }
    return linked
  }, [allEntries, teamMembers, user])

  // Block FU-B · List-Aggregate für canonical photo/report counts pro
  // visible job. Fallback auf Legacy `Job.photoCount`/`notes` macht die
  // Projection automatisch wenn die Map einen Job nicht enthält. Trigger
  // bei jobIds-Set-Change (stable join-key vermeidet redundante Fetches).
  const visibleJobIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of userEntries) {
      if (entry.jobId) ids.add(entry.jobId)
    }
    return Array.from(ids).sort()
  }, [userEntries])
  const visibleJobIdsKey = visibleJobIds.join(',')

  const [photosByJobId, setPhotosByJobId] = useState<Map<string, JobPhoto[]>>(
    () => new Map(),
  )
  const [reportsByJobId, setReportsByJobId] = useState<Map<string, JobReport[]>>(
    () => new Map(),
  )

  useEffect(() => {
    if (visibleJobIds.length === 0) return
    let cancelled = false
    void (async () => {
      const photoMap = new Map<string, JobPhoto[]>()
      const reportMap = new Map<string, JobReport[]>()
      await Promise.all(
        visibleJobIds.map(async (jobId) => {
          try {
            const [p, r] = await Promise.all([
              photoRepo.listForJob(jobId),
              reportRepo.listForJob(jobId),
            ])
            photoMap.set(jobId, p)
            reportMap.set(jobId, r)
          } catch (err) {
            // Read-Fail darf den List-Render nicht crashen — Projection
            // fällt für diesen Job auf Legacy-Felder zurück.
            logError(
              'worker.doku.list_aggregate_failed',
              err instanceof Error ? err : undefined,
              { jobId },
            )
          }
        }),
      )
      if (cancelled) return
      setPhotosByJobId(photoMap)
      setReportsByJobId(reportMap)
    })()
    return () => {
      cancelled = true
    }
    // visibleJobIdsKey ist stable string-rep der ID-Liste; vermeidet
    // dep-array-Identity-Issues bei Array-References.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleJobIdsKey])

  const vm = useMemo(
    () => deriveDokuListViewModel(userEntries, jobs, photosByJobId, reportsByJobId),
    [userEntries, jobs, photosByJobId, reportsByJobId],
  )

  const isEmpty = vm.offen.length === 0 && vm.abgeschlossen.length === 0

  const handleOpen = useCallback(
    (caseId: string) => navigate(`/worker/doku/${caseId}`),
    [navigate]
  )

  return (
    <AppShell active="worker-doku" noSafeTop>
      <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-10">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="mb-6 px-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Dokumentation
            </p>
            <h1 className="mt-1 text-[26px] font-bold tracking-tight text-slate-900">Doku</h1>
          </div>

          {!teamMembersHydrated ? (
            hydrationTimedOut ? (
              <div className="rounded-[24px] bg-white p-5 ring-1 ring-red-100">
                <div className="text-[14px] font-semibold text-slate-800">
                  Daten konnten nicht geladen werden
                </div>
                <div className="mt-1 text-[13px] text-slate-500">
                  Bitte prüfe deine Verbindung und versuche es erneut.
                </div>
                <button
                  type="button"
                  onClick={() => { setHydrationTimedOut(false); setHydrationRetryEpoch((n) => n + 1); retryTeamMembersHydration() }}
                  className="mt-4 rounded-[14px] bg-slate-900 px-5 py-2.5 text-[13px] font-medium text-white active:bg-slate-700"
                >
                  Erneut versuchen
                </button>
              </div>
            ) : (
              <div className="animate-pulse rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70">
                <div className="h-3 w-20 rounded-full bg-slate-100" />
                <div className="mt-4 h-32 rounded-[20px] bg-slate-100" />
              </div>
            )
          ) : isEmpty ? (
            <EmptyState />
          ) : (
            <div className="space-y-8">
              <OffenSection cases={vm.offen} onOpen={handleOpen} />
              <AbgeschlossenSection cases={vm.abgeschlossen} onOpen={handleOpen} />
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
