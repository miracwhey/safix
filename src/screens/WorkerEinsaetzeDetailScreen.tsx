import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AlertCircle, ArrowLeft, Camera, Clock, MapPin, MessageCircle } from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  getCalendarEntries,
  subscribeCalendar,
  updateCalendarStatus,
  type CalendarEntry,
  type CalendarEntryStatus,
} from '../lib/calendar'
import {
  getEntriesForMember,
  getEntriesForUser,
} from '../lib/calendar/calendarSelectors'
import { getJobs, getTeamMembers, subscribeJobs } from '../lib/jobs'
import { subscribeTeamMembers, isTeamMembersHydrated, retryTeamMembersHydration } from '../lib/team'
import { useSession } from '../hooks/useSession'
import { deriveEinsaetzeDetailViewModel } from '../lib/worker/workerEinsaetzeProjection'
import { useSmartBack } from '../hooks/useSmartBack'

const IS_IN_MEMORY = import.meta.env.VITE_DATA_SOURCE !== 'supabase'
const HYDRATION_TIMEOUT_MS = 15_000

// ── Atoms ─────────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  CalendarEntryStatus,
  { label: string; bg: string; text: string }
> = {
  in_progress:      { label: 'In Arbeit',            bg: 'bg-blue-50',    text: 'text-blue-600' },
  scheduled:        { label: 'Geplant',              bg: 'bg-slate-100',  text: 'text-slate-600' },
  awaiting_payment: { label: 'Wartet auf Zahlung',   bg: 'bg-orange-50',  text: 'text-orange-700' },
  completed:        { label: 'Abgeschlossen',        bg: 'bg-emerald-50', text: 'text-emerald-700' },
  pending:          { label: 'Terminplanung offen',  bg: 'bg-amber-50',   text: 'text-amber-600' },
  cancelled:        { label: 'Abgesagt',             bg: 'bg-slate-100',  text: 'text-slate-400' },
}

function StatusPill({ status }: { status: CalendarEntryStatus }) {
  const c = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold ${c.bg} ${c.text}`}
    >
      {c.label}
    </span>
  )
}

function ConnectionModule({
  label,
  sublabel,
  icon,
  onClick,
}: {
  label: string
  sublabel: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-[22px] bg-white p-4 ring-1 ring-slate-200/60 shadow-[0_10px_24px_-16px_rgba(2,6,23,0.14)] text-left active:scale-[0.99] transition-transform"
    >
      <div className="mb-3 text-slate-400">{icon}</div>
      <div className="text-[14px] font-semibold text-slate-800">{label}</div>
      <div className="mt-0.5 text-[12px] text-slate-400">{sublabel}</div>
    </button>
  )
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export default function WorkerEinsaetzeDetailScreen() {
  const { entryId } = useParams<{ entryId: string }>()
  const navigate = useNavigate()
  const { user } = useSession()

  const [allEntries, setAllEntries] = useState<CalendarEntry[]>(getCalendarEntries)
  const [teamMembers, setTeamMembers] = useState(getTeamMembers)
  const [jobs, setJobs] = useState(getJobs)
  const [teamMembersHydrated, setTeamMembersHydrated] = useState(isTeamMembersHydrated)
  const [hydrationTimedOut, setHydrationTimedOut] = useState(false)
  const [hydrationRetryEpoch, setHydrationRetryEpoch] = useState(0)

  useEffect(() => {
    if (teamMembersHydrated) { setHydrationTimedOut(false); return }
    const t = setTimeout(() => setHydrationTimedOut(true), HYDRATION_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [teamMembersHydrated, hydrationRetryEpoch])

  useEffect(() => {
    const unsubCalendar = subscribeCalendar(() => setAllEntries(getCalendarEntries()))
    const unsubTeam = subscribeTeamMembers(() => {
      setTeamMembers(getTeamMembers())
      setTeamMembersHydrated(isTeamMembersHydrated())
    })
    const unsubJobs = subscribeJobs(() => setJobs(getJobs()))
    // Immediate post-subscribe snapshot: closes the render→subscribe race window.
    setTeamMembers(getTeamMembers())
    setTeamMembersHydrated(isTeamMembersHydrated())
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

  const entry = useMemo(
    () => userEntries.find((e) => e.id === entryId) ?? null,
    [userEntries, entryId]
  )

  const detailVm = useMemo(
    () => (entry ? deriveEinsaetzeDetailViewModel(entry, jobs) : null),
    [entry, jobs]
  )

  const goBack = useSmartBack('/worker/einsaetze')

  const updatingRef = useRef(false)
  const [isUpdating, setIsUpdating] = useState(false)

  const handleStart = useCallback(async () => {
    if (!entry || updatingRef.current) return
    updatingRef.current = true
    setIsUpdating(true)
    try {
      await updateCalendarStatus(entry.id, 'in_progress')
    } finally {
      updatingRef.current = false
      setIsUpdating(false)
    }
  }, [entry])

  const handleComplete = useCallback(async () => {
    if (!entry || updatingRef.current) return
    updatingRef.current = true
    setIsUpdating(true)
    try {
      await updateCalendarStatus(entry.id, 'awaiting_payment')
    } finally {
      updatingRef.current = false
      setIsUpdating(false)
    }
  }, [entry])

  const handleOpenDoku = useCallback(
    () => navigate(`/worker/doku/${entry?.id ?? ''}`),
    [navigate, entry]
  )

  const handleOpenNachrichten = useCallback(
    () => navigate('/worker/nachrichten'),
    [navigate]
  )

  // Block 7.2.7c — Korrektur melden mit calendar-entry-Anker, damit
  // approveCorrectionWorkflow + applyCorrectionToTarget einen Apply-Target hat.
  const handleReportCorrection = useCallback(
    () => navigate(`/worker/korrekturen/neu?calendarEntryId=${entry?.id ?? ''}`),
    [navigate, entry]
  )

  // ── Hydrating ───────────────────────────────────────────────────────────────
  if (!teamMembersHydrated) {
    return (
      <AppShell active="worker-einsaetze" noSafeTop>
        <div className="px-4 pt-[max(56px,env(safe-area-inset-top))]">
          <div className="mx-auto w-full max-w-[420px]">
            <button
              onClick={goBack}
              className="mb-6 flex items-center gap-1.5 text-[13px] font-medium text-slate-500 active:opacity-70"
            >
              <ArrowLeft size={15} strokeWidth={2} />
              Einsätze
            </button>
            {hydrationTimedOut ? (
              <div className="rounded-[28px] bg-white p-5 ring-1 ring-red-100">
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
              <div className="animate-pulse space-y-4">
                <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70">
                  <div className="h-3 w-20 rounded-full bg-slate-100" />
                  <div className="mt-3 h-5 w-48 rounded-full bg-slate-100" />
                  <div className="mt-2 h-4 w-32 rounded-full bg-slate-100" />
                </div>
                <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/60">
                  <div className="h-10 w-full rounded-[16px] bg-slate-100" />
                </div>
              </div>
            )}
          </div>
        </div>
      </AppShell>
    )
  }

  // ── Not found ───────────────────────────────────────────────────────────────
  if (!entry || !detailVm) {
    return (
      <AppShell active="worker-einsaetze" noSafeTop>
        <div className="px-4 pt-[max(56px,env(safe-area-inset-top))]">
          <div className="mx-auto w-full max-w-[420px]">
            <button
              onClick={goBack}
              className="mb-6 flex items-center gap-1.5 text-[13px] font-medium text-slate-500 active:opacity-70"
            >
              <ArrowLeft size={15} strokeWidth={2} />
              Einsätze
            </button>
            <div className="rounded-[22px] bg-slate-50 px-5 py-8 ring-1 ring-slate-100 text-center">
              <p className="text-[14px] text-slate-500">Einsatz nicht gefunden.</p>
            </div>
          </div>
        </div>
      </AppShell>
    )
  }

  const isActive = entry.status === 'in_progress'
  const isDone = entry.status === 'completed' || entry.status === 'awaiting_payment' || entry.status === 'cancelled'

  return (
    <AppShell active="worker-einsaetze" noSafeTop>
      <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-10">
        <div className="mx-auto w-full max-w-[420px] space-y-4">

          {/* Back navigation */}
          <button
            onClick={goBack}
            className="flex items-center gap-1.5 text-[13px] font-medium text-slate-500 active:opacity-70"
          >
            <ArrowLeft size={15} strokeWidth={2} />
            Einsätze
          </button>

          {/* 1. Identity header */}
          <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_20px_44px_-28px_rgba(2,6,23,0.28)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  {entry.dateLabel}
                </div>
                <h1 className="mt-1.5 text-[20px] font-bold tracking-tight text-slate-900 leading-snug">
                  {entry.title}
                </h1>
                <div className="mt-0.5 text-[14px] text-slate-600">{entry.customerName}</div>
              </div>
              <div className="shrink-0 pt-0.5">
                <StatusPill status={entry.status} />
              </div>
            </div>

            <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
              <div className="flex items-center gap-2.5 text-[13px] text-slate-500">
                <Clock size={14} strokeWidth={1.8} className="shrink-0 text-slate-400" />
                <span>
                  {entry.startsAtLabel} – {entry.endsAtLabel} Uhr
                </span>
              </div>
              {entry.location && (
                <div className="flex items-center gap-2.5 text-[13px] text-slate-500">
                  <MapPin size={14} strokeWidth={1.8} className="shrink-0 text-slate-400" />
                  <span>{entry.location}</span>
                </div>
              )}
            </div>
          </div>

          {/* 2. Status / action panel */}
          {!isDone && (
            <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/60 shadow-[0_14px_32px_-22px_rgba(2,6,23,0.18)]">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                Nächste Aktion
              </div>

              {isActive ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                      <span className="text-[14px] font-semibold text-blue-700">
                        Läuft gerade
                      </span>
                    </div>
                    <p className="text-[12px] text-slate-500">
                      Dokumentation beim Abschließen ausfüllen.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleComplete}
                    disabled={isUpdating}
                    className="shrink-0 rounded-[14px] bg-emerald-600 px-4 py-2.5 active:scale-95 transition-transform disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <span className="text-[13px] font-semibold text-white">
                      {isUpdating ? 'Lädt…' : 'Abschließen'}
                    </span>
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[14px] text-slate-700">
                    {entry.status === 'pending'
                      ? 'Terminplanung noch offen.'
                      : 'Einsatz noch nicht gestartet.'}
                  </p>
                  <button
                    type="button"
                    onClick={handleStart}
                    disabled={isUpdating}
                    className="shrink-0 rounded-[14px] bg-slate-900 px-4 py-2.5 active:scale-95 transition-transform disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <span className="text-[13px] font-semibold text-white">
                      {isUpdating ? 'Lädt…' : 'Starten'}
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 3. Work order / context */}
          <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/60 shadow-[0_10px_24px_-16px_rgba(2,6,23,0.12)]">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Auftrag
            </div>
            {detailVm.job?.description ? (
              <p className="text-[13px] text-slate-700 leading-relaxed">
                {detailVm.job.description}
              </p>
            ) : (
              <p className="text-[13px] text-slate-400">
                Keine Auftragsdetails hinterlegt.
              </p>
            )}
          </div>

          {/* 4. Tasks / notes */}
          <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/60 shadow-[0_10px_24px_-16px_rgba(2,6,23,0.12)]">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Aufgaben
            </div>
            {detailVm.job?.notes && detailVm.job.notes.length > 0 ? (
              <div className="space-y-2">
                {detailVm.job.notes.map((note, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 rounded-[16px] bg-slate-50 px-4 py-3 ring-1 ring-slate-100"
                  >
                    <div className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-slate-200 bg-white" />
                    <span className="text-[13px] text-slate-600">{note}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-slate-400">Keine Aufgaben hinterlegt.</p>
            )}
          </div>

          {/* 5. Connection modules — Doku + Nachrichten */}
          <div className="flex gap-3">
            <ConnectionModule
              label="Doku"
              sublabel="Fotos & Notizen"
              icon={<Camera size={20} strokeWidth={1.5} />}
              onClick={handleOpenDoku}
            />
            <ConnectionModule
              label="Nachrichten"
              sublabel="Kunde & Betrieb"
              icon={<MessageCircle size={20} strokeWidth={1.5} />}
              onClick={handleOpenNachrichten}
            />
          </div>

          {/* 6. Korrektur-CTA (Block 7.2.7c) — sekundär, mit Bezug auf diesen Einsatz */}
          <button
            type="button"
            data-testid="worker-einsatz-report-correction"
            onClick={handleReportCorrection}
            className="flex w-full items-center gap-2.5 rounded-[18px] bg-white px-4 py-3 ring-1 ring-slate-200/60 text-left active:bg-slate-50 transition-colors"
          >
            <AlertCircle size={16} strokeWidth={1.8} className="shrink-0 text-slate-400" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-700">
                Etwas stimmt nicht?
              </div>
              <div className="text-[12px] text-slate-400">
                Korrektur zu diesem Einsatz melden
              </div>
            </div>
          </button>

        </div>
      </div>
    </AppShell>
  )
}
