import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Calendar,
  Users,
  FileText,
  Camera,
  StickyNote,
  Check,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react'
import AppShell from '../components/AppShell'
import ProfileTabBar from '../components/primitives/ProfileTabBar'
import { ScreenHeader } from '../components/primitives'
import ScreenEmpty from '../components/system/ScreenEmpty'
import DayStrip from '../components/calendar/DayStrip'
import DayTimeGrid from '../components/calendar/DayTimeGrid'
import TeamLoadCard from '../components/calendar/TeamLoadCard'
import {
  getJobs,
  subscribeJobs,
  getTeamMembers,
  type Job,
  type TeamMember,
} from '../lib/jobs'
import {
  getCalendarEntries,
  subscribeCalendar,
  syncCalendarEntriesForJobs,
  isCalendarRelevantJob,
  ensureCalendarEntryForJobId,
} from '../lib/calendar'
import type { CalendarEntry } from '../lib/calendar'
import {
  getSchedules,
  getUnscheduledJobIds,
  isScheduleRepositoryHydrated,
  subscribeOperations,
} from '../lib/operations'
import { getChatRepository } from '../lib/chat'
import { subscribeTeamMembers } from '../lib/team'
import { getCalendarStatusLabel } from '../lib/calendar/calendarSelectors'
import {
  getTimedEntriesForDay,
} from '../lib/calendar/calendarSelectors'
import { performCanonicalScheduleSave } from '../lib/scheduling/canonicalScheduling'
import { addCustomCalendarEntry } from '../lib/calendar/calendarStore'
import {
  getOverbookedTeamLoads,
  getTodayTeamLoads,
} from '../lib/calendar/teamLoadSelectors'
import {
  derivePlanungTab,
  deriveTeamTab,
  deriveTeamZeiten,
  deriveDokuTab,
  type PlanungSubMode,
  type TeamSubMode,
  type TeamMemberStatus,
  type DokuSubMode,
  type DokuCompleteness,
} from '../lib/dashboard/operationsTabSelectors'
import { SupabaseOwnerNoteRepository } from '../lib/owner/repository/OwnerNoteRepository'
import { useSmartBack } from '../hooks/useSmartBack'

// ── Constants ────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'planung', label: 'Planung', icon: Calendar },
  { key: 'doku', label: 'Doku', icon: FileText },
] as const

// ── Shared UI helpers ────────────────────────────────────────────────────────

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function SummaryStrip({ items }: { items: { label: string; value: number; warn?: boolean }[] }) {
  return (
    <div className="flex gap-2">
      {items.map((item) => (
        <div
          key={item.label}
          className={`flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-[12px] font-semibold ${
            item.warn && item.value > 0
              ? 'bg-amber-50 text-amber-700'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          <span className="tabular-nums">{item.value}</span>
          <span className="font-medium">{item.label}</span>
        </div>
      ))}
    </div>
  )
}

function SubModeChips<T extends string>({
  modes,
  active,
  onChange,
}: {
  modes: { key: T; label: string }[]
  active: T
  onChange: (key: T) => void
}) {
  return (
    <div className="flex gap-1.5 rounded-card bg-slate-100 p-1">
      {modes.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`flex-1 rounded-card py-1.5 text-[12px] font-semibold transition active:scale-[0.98] ${
            active === key
              ? 'bg-white text-slate-900 shadow-subtle'
              : 'text-slate-500'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

const STATUS_BADGE: Record<string, string> = {
  scheduled: 'bg-blue-50 text-blue-700',
  in_progress: 'bg-brand/10 text-brand',
  pending: 'bg-amber-50 text-amber-700',
  completed: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-slate-100 text-slate-500',
}

const TEAM_STATUS: Record<TeamMemberStatus, { label: string; cls: string }> = {
  active: { label: 'Aktiv', cls: 'bg-brand/10 text-brand' },
  idle: { label: 'Frei', cls: 'bg-slate-100 text-slate-500' },
  overbooked: { label: 'Überlastet', cls: 'bg-amber-50 text-amber-700' },
}

const DOKU_BADGE: Record<DokuCompleteness, { label: string; icon: typeof Check; color: string }> = {
  complete: { label: 'Vollständig', icon: Check, color: 'text-ok' },
  partial: { label: 'Doku fehlt', icon: AlertTriangle, color: 'text-warn' },
  missing: { label: 'Keine Doku', icon: AlertTriangle, color: 'text-danger' },
}

// ── Entry row (shared between Planung + Woche) ──────────────────────────────

function EntryRow({ entry }: { entry: CalendarEntry }) {
  const memberLabel = entry.assignedMemberIds.length > 0
    ? `${entry.assignedMemberIds.length} Mitarbeiter`
    : null

  const isCustom = entry.kind === 'custom'

  const inner = (
    <>
      <div className="w-[48px] shrink-0 pt-0.5">
        {entry.status === 'in_progress' ? (
          <span className="text-[13px] font-bold text-brand">Jetzt</span>
        ) : entry.startsAtLabel ? (
          <span className="text-[13px] font-semibold tabular-nums text-brand">
            {entry.startsAtLabel}
          </span>
        ) : (
          <span className="text-[10px] font-medium text-ink-muted leading-tight">
            Zeit offen
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-ink">{entry.title}</p>
        <p className="mt-0.5 truncate text-[11px] text-ink-muted">
          {isCustom
            ? [entry.location].filter(Boolean).join(' · ')
            : [entry.customerName, entry.location, memberLabel].filter(Boolean).join(' · ')}
        </p>
      </div>
      <span
        className={`shrink-0 rounded-chip px-2 py-0.5 text-[10px] font-semibold ${
          isCustom ? 'bg-slate-100 text-slate-600' : (STATUS_BADGE[entry.status] ?? STATUS_BADGE.pending)
        }`}
      >
        {isCustom ? 'Eigener Termin' : getCalendarStatusLabel(entry.status)}
      </span>
    </>
  )

  const className = 'flex items-start gap-3 rounded-card bg-surface p-3 ring-1 ring-edge shadow-subtle transition active:scale-[0.99]'

  return isCustom ? (
    <div className={className}>{inner}</div>
  ) : (
    <Link to={`/craftsman/jobs/${entry.jobId}`} className={className}>
      {inner}
    </Link>
  )
}

// ── Kalender date helpers ────────────────────────────────────────────────────

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
]

function parseDateKeyToDate(dk: string): Date {
  const [y, m, d] = dk.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatSelectedDate(dk: string): string {
  return parseDateKeyToDate(dk).toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

function getMonthLabel(dk: string): string {
  return MONTHS_DE[parseDateKeyToDate(dk).getMonth()]
}

// ── Planung Tab ──────────────────────────────────────────────────────────────

function PlanungTab({
  calendarEntries,
  teamMembers,
  schedules,
  schedulesHydrated,
}: {
  calendarEntries: CalendarEntry[]
  teamMembers: TeamMember[]
  schedules: ReturnType<typeof getSchedules>
  schedulesHydrated: boolean
}) {
  const todayKey = formatDateKey(new Date())
  const [subMode, setSubMode] = useState<PlanungSubMode>('uebersicht')

  // ── Shared derivation for Übersicht ──
  const data = useMemo(
    () => derivePlanungTab(calendarEntries, todayKey, teamMembers),
    [calendarEntries, todayKey, teamMembers],
  )

  // ── Kalender-specific state ──
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey)

  const isToday = selectedDateKey === todayKey

  const dayGridEntries = useMemo(
    () => getTimedEntriesForDay(calendarEntries, selectedDateKey),
    [calendarEntries, selectedDateKey],
  )

  const todayTeamLoads = useMemo(() => getTodayTeamLoads(calendarEntries), [calendarEntries])
  const overbookedLoads = useMemo(() => getOverbookedTeamLoads(calendarEntries), [calendarEntries])

  const unscheduledJobs = useMemo(() => {
    const allJobs = getJobs()
    const activeJobs = allJobs.filter(
      (j) => j.status !== 'completed' && j.status !== 'cancelled' && j.status !== 'waiting_payment',
    )
    const unscheduledIds = getUnscheduledJobIds(
      activeJobs.map((j) => j.id),
      schedules,
    )
    const idSet = new Set(unscheduledIds)
    return activeJobs.filter((j) => idSet.has(j.id))
  }, [schedules])

  const handleSelectDay = useCallback((dk: string) => setSelectedDateKey(dk), [])
  const handleGoToday = useCallback(() => setSelectedDateKey(todayKey), [todayKey])

  // ── Add-appointment flow state ──
  type AddMode = null | 'choose' | 'project' | 'personal'
  const [addMode, setAddMode] = useState<AddMode>(null)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const savingRef = useRef(false)

  const handleSelectJob = useCallback((jobId: string) => {
    setSelectedJobId(jobId)
    setScheduleError(null)
  }, [])

  const handleSaveSchedule = useCallback(async () => {
    if (!selectedJobId || !scheduleTime) return
    if (savingRef.current) return
    const startDate = new Date(`${selectedDateKey}T${scheduleTime}:00`)
    const startMs = startDate.getTime()
    if (isNaN(startMs)) {
      setScheduleError('Ungültiges Datum oder Uhrzeit')
      return
    }
    const endMs = startMs + 2 * 60 * 60 * 1000
    savingRef.current = true
    setScheduleSaving(true)
    setScheduleError(null)
    try {
      const result = await performCanonicalScheduleSave({ jobId: selectedJobId, scheduledStart: startMs, scheduledEnd: endMs })
      if (!result.success) {
        setScheduleError(result.error ?? 'Termin konnte nicht gespeichert werden')
        return
      }
      setAddMode(null)
      setSelectedJobId(null)
    } catch {
      setScheduleError('Termin konnte nicht gespeichert werden')
    } finally {
      savingRef.current = false
      setScheduleSaving(false)
    }
  }, [selectedJobId, selectedDateKey, scheduleTime])

  // ── Block entry (non-job) state ──
  const [blockTitle, setBlockTitle] = useState('')
  const [blockDescription, setBlockDescription] = useState('')
  const [blockStartTime, setBlockStartTime] = useState('09:00')
  const [blockEndTime, setBlockEndTime] = useState('11:00')

  const handleCloseAdd = useCallback(() => {
    setAddMode(null)
    setSelectedJobId(null)
    setScheduleError(null)
    setBlockTitle('')
    setBlockDescription('')
    setBlockStartTime('09:00')
    setBlockEndTime('11:00')
  }, [])

  const handleSaveBlock = useCallback(() => {
    if (!blockTitle.trim()) {
      setScheduleError('Bezeichnung eingeben')
      return
    }
    if (!blockStartTime || !blockEndTime) {
      setScheduleError('Start- und Endzeit angeben')
      return
    }
    const [sh, sm] = blockStartTime.split(':').map(Number)
    const [eh, em] = blockEndTime.split(':').map(Number)
    if (eh * 60 + em <= sh * 60 + sm) {
      setScheduleError('Endzeit muss nach der Startzeit liegen')
      return
    }
    addCustomCalendarEntry({
      title: blockTitle.trim(),
      description: blockDescription.trim() || undefined,
      dateKey: selectedDateKey,
      startsAtLabel: blockStartTime,
      endsAtLabel: blockEndTime,
    })
    handleCloseAdd()
  }, [blockTitle, blockDescription, selectedDateKey, blockStartTime, blockEndTime, handleCloseAdd])

  // Unified "Ungeplant" count: operations truth (no JobSchedule) is the canonical check.
  // Before schedule repo hydrates, fall back to calendar-derived pendingCount only —
  // using unscheduledJobs before hydration would count all active jobs as unscheduled.
  const ungeplantCount = schedulesHydrated
    ? Math.max(data.summary.pendingCount, unscheduledJobs.length)
    : data.summary.pendingCount
  const problemTotal = data.summary.problemCount + ungeplantCount

  return (
    <div className="space-y-3">
      <SubModeChips
        modes={[
          { key: 'uebersicht' as PlanungSubMode, label: 'Übersicht' },
          { key: 'kalender' as PlanungSubMode, label: 'Kalender' },
        ]}
        active={subMode}
        onChange={setSubMode}
      />

      {/* ── ÜBERSICHT: Dispatch / Triage ─────────────────────────────── */}
      {subMode === 'uebersicht' && (
        <div className="space-y-3">
          {/* Jetzt / Nächster block */}
          {(data.activeEntry || data.nextEntry) && (
            <div className="rounded-container bg-surface p-4 shadow-elevated ring-1 ring-edge">
              {data.activeEntry ? (
                <>
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-brand animate-pulse" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand">
                      Jetzt
                    </span>
                  </div>
                  <EntryRow entry={data.activeEntry} />
                </>
              ) : data.nextEntry ? (
                <>
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-ink-muted" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                      {data.nextEntry.kind === 'custom' ? 'Nächster Termin' : 'Nächster Einsatz'}
                    </span>
                  </div>
                  <EntryRow entry={data.nextEntry} />
                </>
              ) : null}
            </div>
          )}

          {/* Heutige Einsätze */}
          {data.dayEntries.length > 0 ? (
            <div className="space-y-2">
              <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                Heutige Einsätze ({data.dayEntries.length})
              </span>
              {data.dayEntries
                .filter((e) => e.id !== data.activeEntry?.id && e.id !== data.nextEntry?.id)
                .map((entry) => (
                  <EntryRow key={entry.id} entry={entry} />
                ))}
            </div>
          ) : !data.activeEntry && !data.nextEntry ? (
            <div className="rounded-card bg-surface px-4 py-3 text-center text-[13px] text-ink-muted ring-1 ring-edge">
              Heute ist nichts geplant
            </div>
          ) : null}

          {/* Lücken / Ungeplant / Überbucht — consolidated warning section */}
          {problemTotal > 0 && (
            <div className="space-y-2">
              <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-600">
                Handlungsbedarf
              </span>

              {data.unassignedScheduled.length > 0 && (
                <div className="flex items-center gap-2 rounded-card bg-amber-50/60 px-3 py-2 ring-1 ring-amber-200/40">
                  <AlertTriangle size={12} className="shrink-0 text-amber-500" />
                  <span className="text-[11px] font-medium text-amber-700">
                    {data.unassignedScheduled.length} Einsatz{data.unassignedScheduled.length !== 1 ? 'e' : ''} ohne Zuweisung
                  </span>
                </div>
              )}

              {schedulesHydrated && unscheduledJobs.length > 0 && (
                <div className="flex items-center gap-2 rounded-card bg-amber-50/60 px-3 py-2 ring-1 ring-amber-200/40">
                  <AlertTriangle size={12} className="shrink-0 text-amber-500" />
                  <span className="text-[11px] font-medium text-amber-700">
                    {unscheduledJobs.length} Auftrag{unscheduledJobs.length !== 1 ? 'e' : ''} nicht eingeplant
                  </span>
                </div>
              )}

              {data.overbookedNames.length > 0 && (
                <div className="flex items-center gap-2 rounded-card bg-amber-50/60 px-3 py-2 ring-1 ring-amber-200/40">
                  <AlertTriangle size={12} className="shrink-0 text-amber-500" />
                  <span className="text-[11px] font-medium text-amber-700">
                    Überlastung: {data.overbookedNames.join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}

        </div>
      )}

      {/* ── KALENDER: Real scheduling surface ────────────────────────── */}
      {subMode === 'kalender' && (
        <div className="space-y-3">
          {/* Kalender header */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-slate-500">{getMonthLabel(selectedDateKey)}</span>
              {!isToday && (
                <button
                  type="button"
                  onClick={handleGoToday}
                  className="rounded-full bg-blue-50 px-2.5 py-1 text-[12px] font-semibold text-blue-600"
                >
                  Heute
                </button>
              )}
            </div>
            <p className="text-[16px] font-semibold text-slate-800 mt-1">
              {formatSelectedDate(selectedDateKey)}
            </p>
          </div>

          {/* DayStrip */}
          <DayStrip
            selectedDateKey={selectedDateKey}
            todayDateKey={todayKey}
            onSelectDay={handleSelectDay}
          />

          {/* Time grid */}
          <div className="rounded-2xl bg-white ring-1 ring-slate-200/70 overflow-hidden">
            <DayTimeGrid entries={dayGridEntries} isToday={isToday} />
          </div>

          {/* ── Add appointment flow ─────────────────────────────────── */}

          {/* Choice panel */}
          {addMode === 'choose' && (
            <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200/70 shadow-subtle space-y-1.5">
              <button
                type="button"
                onClick={() => setAddMode('project')}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50 active:scale-[0.99]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[14px]">📋</span>
                <div>
                  <span className="text-[13px] font-semibold text-slate-800 block">Projekt einplanen</span>
                  <span className="text-[11px] text-slate-400">Bestehendes Projekt terminieren</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setAddMode('personal')}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50 active:scale-[0.99]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[14px]">📌</span>
                <div>
                  <span className="text-[13px] font-semibold text-slate-800 block">Eigener Eintrag</span>
                  <span className="text-[11px] text-slate-400">Transport, Gespräch, Blocker...</span>
                </div>
              </button>
              <button
                type="button"
                onClick={handleCloseAdd}
                className="w-full text-center text-[11px] text-slate-400 py-1 hover:text-slate-600 transition"
              >
                Abbrechen
              </button>
            </div>
          )}

          {/* Project picker */}
          {addMode === 'project' && !selectedJobId && (
            <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200/70 shadow-subtle space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Projekt auswählen
                </span>
                <button
                  type="button"
                  onClick={handleCloseAdd}
                  className="text-[11px] text-slate-400 hover:text-slate-600 transition"
                >
                  Abbrechen
                </button>
              </div>
              {!schedulesHydrated ? (
                <p className="text-[12px] text-slate-400 text-center py-2">Aufträge werden geladen…</p>
              ) : unscheduledJobs.length > 0 ? (
                <div className="space-y-1">
                  {unscheduledJobs.map((job) => (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => handleSelectJob(job.id)}
                      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition hover:bg-slate-50 active:scale-[0.98]"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-50 text-[12px]">📋</span>
                      <div className="min-w-0 flex-1">
                        <span className="text-[13px] font-medium text-slate-700 truncate block">{job.title}</span>
                        {job.customer && (
                          <span className="text-[11px] text-slate-400 truncate block">{job.customer}</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-slate-400 text-center py-2">
                  Alle Projekte sind bereits eingeplant
                </p>
              )}
            </div>
          )}

          {/* Schedule form (after job selected) */}
          {addMode === 'project' && selectedJobId && (
            <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200/70 shadow-subtle space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Termin festlegen
                </span>
                <button
                  type="button"
                  onClick={handleCloseAdd}
                  className="text-[11px] text-slate-400 hover:text-slate-600 transition"
                >
                  Abbrechen
                </button>
              </div>

              {/* Selected job info */}
              {(() => {
                const job = unscheduledJobs.find((j) => j.id === selectedJobId)
                return job ? (
                  <div className="flex items-center gap-2 rounded-xl bg-blue-50/60 px-3 py-2 ring-1 ring-blue-200/40">
                    <span className="text-[13px]">📋</span>
                    <div className="min-w-0 flex-1">
                      <span className="text-[13px] font-semibold text-slate-800 truncate block">{job.title}</span>
                      {job.customer && <span className="text-[11px] text-slate-400">{job.customer}</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedJobId(null)}
                      className="text-[11px] text-blue-600 font-medium"
                    >
                      Ändern
                    </button>
                  </div>
                ) : null
              })()}

              {scheduleError && (
                <p className="text-[11px] font-semibold text-red-600">{scheduleError}</p>
              )}

              {/* Date + Time */}
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <span className="text-[10px] font-medium text-slate-400 block mb-0.5">Datum</span>
                  <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[12px] font-medium text-slate-700 ring-1 ring-slate-200/70">
                    {formatSelectedDate(selectedDateKey)}
                  </div>
                </div>
                <div className="w-[90px]">
                  <span className="text-[10px] font-medium text-slate-400 block mb-0.5">Uhrzeit</span>
                  <input
                    type="time"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                    className="w-full rounded-lg bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 ring-1 ring-slate-200/70 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={scheduleSaving}
                onClick={handleSaveSchedule}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-[13px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
              >
                {scheduleSaving ? '...' : '📅 Termin speichern'}
              </button>
            </div>
          )}

          {/* Block entry (non-job) */}
          {addMode === 'personal' && (
            <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200/70 shadow-subtle space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Eintrag erstellen
                </span>
                <button
                  type="button"
                  onClick={handleCloseAdd}
                  className="text-[11px] text-slate-400 hover:text-slate-600 transition"
                >
                  Abbrechen
                </button>
              </div>

              {scheduleError && (
                <p className="text-[11px] font-semibold text-red-600">{scheduleError}</p>
              )}

              {/* Title */}
              <div>
                <span className="text-[10px] font-medium text-slate-400 block mb-0.5">Titel des Termins</span>
                <input
                  type="text"
                  value={blockTitle}
                  onChange={(e) => { setBlockTitle(e.target.value); setScheduleError(null) }}
                  placeholder="z.B. Material abholen"
                  className="w-full rounded-lg bg-slate-50 px-2.5 py-2 text-[13px] text-slate-800 ring-1 ring-slate-200/70 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  autoFocus
                />
              </div>

              {/* Description */}
              <div>
                <span className="text-[10px] font-medium text-slate-400 block mb-0.5">Notiz (optional)</span>
                <textarea
                  value={blockDescription}
                  onChange={(e) => setBlockDescription(e.target.value)}
                  placeholder="Weitere Infos zum Termin"
                  rows={2}
                  className="w-full rounded-lg bg-slate-50 px-2.5 py-2 text-[13px] text-slate-800 ring-1 ring-slate-200/70 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                />
              </div>

              {/* Date (read-only, from calendar selection) */}
              <div>
                <span className="text-[10px] font-medium text-slate-400 block mb-0.5">Datum</span>
                <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[12px] font-medium text-slate-700 ring-1 ring-slate-200/70">
                  {formatSelectedDate(selectedDateKey)}
                </div>
              </div>

              {/* Start + End time */}
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <span className="text-[10px] font-medium text-slate-400 block mb-0.5">Von</span>
                  <input
                    type="time"
                    value={blockStartTime}
                    onChange={(e) => setBlockStartTime(e.target.value)}
                    className="w-full rounded-lg bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 ring-1 ring-slate-200/70 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </div>
                <div className="flex-1">
                  <span className="text-[10px] font-medium text-slate-400 block mb-0.5">Bis</span>
                  <input
                    type="time"
                    value={blockEndTime}
                    onChange={(e) => setBlockEndTime(e.target.value)}
                    className="w-full rounded-lg bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 ring-1 ring-slate-200/70 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={handleSaveBlock}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-[13px] font-semibold text-white transition active:scale-[0.98]"
              >
                Eintrag speichern
              </button>
            </div>
          )}

          {/* FAB */}
          {addMode === null && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setAddMode('choose')}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 text-white shadow-lg transition active:scale-[0.95]"
                aria-label="Termin hinzufügen"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
          )}

          {/* Team load */}
          {todayTeamLoads.length > 0 && (
            <div>
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Auslastung heute</h3>
              <div className="space-y-2">
                {todayTeamLoads.map((load) => (
                  <TeamLoadCard key={load.memberId} memberId={load.memberId} jobs={load.jobs} />
                ))}
              </div>
            </div>
          )}

          {overbookedLoads.length > 0 && (
            <div>
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Überbuchte Mitarbeiter</h3>
              <div className="space-y-2">
                {overbookedLoads.map((load) => (
                  <TeamLoadCard key={`overbooked-${load.memberId}`} memberId={load.memberId} jobs={load.jobs} />
                ))}
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  )
}

// ── Zeiten View ─────────────────────────────────────────────────────────────

function ZeitenView({ zeitenData }: { zeitenData: ReturnType<typeof deriveTeamZeiten> }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const todayKey = formatDateKey(new Date())

  if (zeitenData.members.length === 0) {
    return (
      <ScreenEmpty
        title="Keine Zeitdaten"
        description="Geplante Einsätze mit Zeitangaben erscheinen hier als Wochenstunden"
      />
    )
  }

  return (
    <div className="space-y-2">
      {/* Week header */}
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          {zeitenData.weekLabel}
        </span>
        <span className="text-[13px] font-bold text-ink tabular-nums">
          {zeitenData.teamTotal.toFixed(1)} Std.
        </span>
      </div>

      {/* Member rows */}
      {zeitenData.members.map((ms) => {
        const isExpanded = expandedId === ms.memberId
        const workedDays = ms.days.filter((d) => d.hours > 0).length

        return (
          <div key={ms.memberId} className="rounded-card bg-surface ring-1 ring-edge shadow-subtle overflow-hidden">
            {/* Compact row — always visible */}
            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : ms.memberId)}
              className="flex w-full items-center gap-3 p-3.5 text-left transition active:bg-slate-50"
            >
              {/* Avatar */}
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[12px] font-bold text-slate-500">
                {ms.displayName.slice(0, 2).toUpperCase()}
              </div>

              {/* Name + subtitle */}
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[14px] font-semibold text-ink">{ms.displayName}</h3>
                <p className="text-[11px] text-ink-muted">
                  {workedDays} {workedDays === 1 ? 'Tag' : 'Tage'} · {ms.days.filter((d) => d.hours > 0).reduce((s, d) => s + d.entryCount, 0)} Einsätze
                </p>
              </div>

              {/* Big hours number */}
              <div className="shrink-0 text-right">
                <span className="text-[20px] font-bold text-ink tabular-nums leading-none">
                  {ms.weekTotal.toFixed(1)}
                </span>
                <span className="text-[11px] font-medium text-ink-muted ml-0.5">h</span>
              </div>

              {/* Chevron */}
              <svg
                className={`shrink-0 w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="border-t border-edge px-3.5 pb-3.5 pt-3">
                {/* Bar chart */}
                <div className="flex gap-1 mb-3">
                  {ms.days.map((day) => {
                    const maxHours = Math.max(8, ...ms.days.map((d) => d.hours))
                    const barHeight = day.hours > 0 ? Math.max(6, (day.hours / maxHours) * 48) : 0
                    const isToday = day.dateKey === todayKey
                    return (
                      <div key={day.dateKey} className="flex-1 flex flex-col items-center gap-0.5">
                        <div className="w-full h-[52px] flex items-end justify-center">
                          {barHeight > 0 ? (
                            <div
                              className={`w-full max-w-[24px] rounded-t-md ${isToday ? 'bg-blue-400' : 'bg-slate-200'}`}
                              style={{ height: barHeight }}
                            />
                          ) : (
                            <div className="w-full max-w-[24px] h-[2px] rounded bg-slate-100" />
                          )}
                        </div>
                        <span className={`text-[10px] tabular-nums font-semibold ${day.hours > 0 ? 'text-ink' : 'text-ink-muted'}`}>
                          {day.hours > 0 ? day.hours.toFixed(1) : '–'}
                        </span>
                        <span className={`text-[9px] font-medium ${isToday ? 'text-blue-600 font-bold' : 'text-ink-muted'}`}>
                          {day.dayLabel}
                        </span>
                      </div>
                    )
                  })}
                </div>

                {/* Day detail list */}
                <div className="space-y-1">
                  {ms.days.filter((d) => d.hours > 0).map((day) => {
                    const isToday = day.dateKey === todayKey
                    return (
                      <div key={day.dateKey} className="flex items-center justify-between py-1 px-1">
                        <span className={`text-[12px] font-medium ${isToday ? 'text-blue-600' : 'text-ink-sub'}`}>
                          {day.dayLabel}{isToday ? ' (heute)' : ''}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-ink-muted">
                            {day.entryCount} {day.entryCount === 1 ? 'Einsatz' : 'Einsätze'}
                          </span>
                          <span className="text-[12px] font-semibold text-ink tabular-nums">
                            {day.hours.toFixed(1)}h
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {ms.days.every((d) => d.hours === 0) && (
                  <p className="text-[11px] text-ink-muted text-center py-2">
                    Keine Einsätze diese Woche
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Team Tab ─────────────────────────────────────────────────────────────────
// Block 1: Tab aus TABS entfernt, Komponente bleibt für Block 3 (Springer-
// Vorschlag) als Vorlage. Cleanup-Plan: ~/.claude/plans/team-hub-block-1-deferred.md

function TeamTab({
  jobs,
  teamMembers,
  calendarEntries,
}: {
  jobs: Job[]
  teamMembers: TeamMember[]
  calendarEntries: CalendarEntry[]
}) {
  const [subMode, setSubMode] = useState<TeamSubMode>('aktiv')

  const data = useMemo(
    () => deriveTeamTab(jobs, teamMembers, calendarEntries),
    [jobs, teamMembers, calendarEntries],
  )

  const zeitenData = useMemo(
    () => deriveTeamZeiten(calendarEntries, teamMembers),
    [calendarEntries, teamMembers],
  )

  const filteredMembers = useMemo(() => {
    switch (subMode) {
      case 'aktiv':
        return data.members.filter((m) => m.status !== 'idle')
      case 'probleme':
        return data.members.filter((m) => m.status === 'overbooked' || m.hasOpenDoku)
      default:
        return data.members
    }
  }, [data.members, subMode])

  const showProblems = subMode === 'probleme' || subMode === 'aktiv'

  return (
    <div className="space-y-3">
      <Link
        to="/craftsman/team"
        className="flex items-center justify-between gap-3 rounded-card bg-surface px-3 py-2.5 ring-1 ring-edge/60 transition active:scale-[0.99]"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#2563EB]/10 text-[#2563EB]">
            <Users size={14} aria-hidden />
          </div>
          <span className="text-[13px] font-semibold text-ink">Beitritts-Code & Einladung</span>
        </div>
        <ChevronRight size={14} className="shrink-0 text-ink-muted" aria-hidden />
      </Link>

      <SubModeChips
        modes={[
          { key: 'aktiv' as TeamSubMode, label: 'Aktiv' },
          { key: 'alle' as TeamSubMode, label: 'Alle' },
          { key: 'probleme' as TeamSubMode, label: 'Probleme' },
          { key: 'zeiten' as TeamSubMode, label: 'Zeiten' },
        ]}
        active={subMode}
        onChange={setSubMode}
      />

      {/* ── Zeiten view ──────────────────────────────────────────── */}
      {subMode === 'zeiten' && (
        <ZeitenView zeitenData={zeitenData} />
      )}

      {/* Member cards */}
      {subMode !== 'zeiten' && filteredMembers.length > 0 && (
        <div className="space-y-2">
          {filteredMembers.map((ms) => {
            const st = TEAM_STATUS[ms.status]
            return (
              <div
                key={ms.member.id}
                className="rounded-card bg-surface p-3.5 ring-1 ring-edge shadow-subtle"
              >
                <div className="flex items-center justify-between gap-3">
                  <Link
                    to={`/craftsman/team/${ms.member.id}`}
                    className="flex items-center gap-2.5 min-w-0 flex-1 active:opacity-70 transition"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[12px] font-bold text-slate-500">
                      {ms.displayName.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-[14px] font-semibold text-ink">
                        {ms.displayName}
                      </h3>
                      {ms.todayEntryCount > 0 && (
                        <p className="text-[11px] text-ink-muted">
                          {ms.todayEntryCount} Einsatz{ms.todayEntryCount !== 1 ? 'e' : ''} heute
                        </p>
                      )}
                    </div>
                  </Link>
                  <div className="flex items-center gap-1.5">
                    {ms.hasOpenDoku && (
                      <span className="rounded-chip bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        Doku offen
                      </span>
                    )}
                    <span className={`rounded-chip px-2 py-0.5 text-[10px] font-semibold ${st.cls}`}>
                      {st.label}
                    </span>
                    <Link
                      to={`/craftsman/team/${ms.member.id}`}
                      aria-label="Mitarbeiter-Details"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition active:scale-90"
                    >
                      <ChevronRight size={14} aria-hidden />
                    </Link>
                  </div>
                </div>

                <div className="mt-2 space-y-1">
                  {ms.currentJob ? (
                    <Link
                      to={`/craftsman/jobs/${ms.currentJob.id}`}
                      className="flex items-center gap-1.5 text-[12px] text-ink-sub hover:text-brand transition"
                    >
                      <span>🔨</span>
                      <span className="truncate">{ms.currentJob.title}</span>
                    </Link>
                  ) : (
                    <p className="text-[12px] text-ink-muted">Kein aktiver Einsatz</p>
                  )}
                  {ms.nextPlannedJob && (
                    <Link
                      to={`/craftsman/jobs/${ms.nextPlannedJob.id}`}
                      className="flex items-center gap-1.5 text-[12px] text-ink-muted hover:text-brand transition"
                    >
                      <span>📅</span>
                      <span className="truncate">{ms.nextPlannedJob.title}</span>
                    </Link>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Unassigned jobs — always shown in aktiv + probleme mode */}
      {subMode !== 'zeiten' && showProblems && data.unassignedJobs.length > 0 && (
        <div className="space-y-1.5">
          <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-600">
            Nicht zugewiesen ({data.unassignedJobs.length})
          </span>
          {data.unassignedJobs.map((job) => (
            <Link
              key={job.id}
              to={`/craftsman/jobs/${job.id}`}
              className="flex items-center gap-3 rounded-card bg-amber-50/60 px-3 py-2.5 ring-1 ring-amber-200/60 transition active:scale-[0.99]"
            >
              <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-ink">{job.title}</p>
                <p className="text-[11px] text-ink-muted">Keine Zuweisung</p>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Doku-open jobs — prominent in 'probleme', compact hint in other modes */}
      {subMode !== 'zeiten' && data.dokuOpenJobs.length > 0 && (
        subMode === 'probleme' ? (
          <div className="space-y-1.5">
            <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-600">
              Dokumentation offen ({data.dokuOpenJobs.length})
            </span>
            {data.dokuOpenJobs.map((job) => (
              <Link
                key={job.id}
                to={`/craftsman/jobs/${job.id}`}
                className="flex items-center gap-3 rounded-card bg-amber-50/60 px-3 py-2.5 ring-1 ring-amber-200/60 transition active:scale-[0.99]"
              >
                <AlertTriangle size={14} className="shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-ink">{job.title}</p>
                  <p className="text-[11px] text-ink-muted">Keine Fotos oder Notizen</p>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-card bg-amber-50/60 px-3 py-2 ring-1 ring-amber-200/40">
            <AlertTriangle size={12} className="shrink-0 text-amber-500" />
            <span className="text-[11px] font-medium text-amber-700">
              {data.dokuOpenJobs.length} Auftrag{data.dokuOpenJobs.length !== 1 ? 'e' : ''} ohne Dokumentation
            </span>
          </div>
        )
      )}

      {/* Empty state — must check ALL problem sources for 'probleme' mode */}
      {subMode !== 'zeiten' && filteredMembers.length === 0 && data.unassignedJobs.length === 0 && data.dokuOpenJobs.length === 0 && (
        <ScreenEmpty
          title={
            subMode === 'probleme'
              ? 'Keine Probleme'
              : subMode === 'aktiv'
                ? 'Keine aktiven Einsätze'
                : 'Keine Teammitglieder'
          }
          description={
            subMode === 'probleme'
              ? 'Alle Einsätze zugewiesen, Dokumentation vollständig'
              : subMode === 'aktiv'
                ? 'Alle Mitglieder sind aktuell verfügbar'
                : 'Teammitglieder werden aus Auftragszuweisungen erkannt'
          }
        />
      )}
    </div>
  )
}

// ── Doku Tab ─────────────────────────────────────────────────────────────────

function DokuTab({
  jobs,
  calendarEntries,
  teamMembers,
  ownerNotesCounts,
}: {
  jobs: Job[]
  calendarEntries: CalendarEntry[]
  teamMembers: TeamMember[]
  ownerNotesCounts: ReadonlyMap<string, number>
}) {
  const [subMode, setSubMode] = useState<DokuSubMode>('offen')

  const data = useMemo(
    () => deriveDokuTab(jobs, calendarEntries, teamMembers, subMode, ownerNotesCounts),
    [jobs, calendarEntries, teamMembers, subMode, ownerNotesCounts],
  )

  return (
    <div className="space-y-3">
      <SubModeChips
        modes={[
          { key: 'offen' as DokuSubMode, label: `Offen (${data.summary.openCount})` },
          { key: 'heute' as DokuSubMode, label: 'Heute' },
          { key: 'abrechenbar' as DokuSubMode, label: 'Abrechenbar' },
        ]}
        active={subMode}
        onChange={setSubMode}
      />

      {data.entries.length > 0 ? (
        <div className="space-y-2">
          {data.entries.map((entry) => {
            const badge = DOKU_BADGE[entry.completeness]
            const BadgeIcon = badge.icon
            return (
              <Link
                key={entry.job.id}
                to={`/craftsman/jobs/${entry.job.id}`}
                className="block rounded-card bg-surface p-3 ring-1 ring-edge shadow-subtle transition active:scale-[0.99]"
              >
                {/* Line 1: Auftrag · Kunde */}
                <div className="flex items-start justify-between gap-3">
                  <p className="truncate text-[13px] font-semibold text-ink">
                    {entry.job.title}
                    {entry.customerName ? ` · ${entry.customerName}` : ''}
                  </p>
                  <BadgeIcon size={14} className={`shrink-0 mt-0.5 ${badge.color}`} />
                </div>

                {/* Line 2: Mitarbeiter · Datum · Zeit */}
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  {[
                    entry.memberNames.length > 0 ? entry.memberNames.join(', ') : null,
                    entry.scheduledDate,
                    entry.scheduledTime,
                  ].filter(Boolean).join(' · ')}
                </p>

                {/* Line 3: Doku-Status + Counts */}
                <div className="mt-1.5 flex items-center gap-3 text-[11px]">
                  <span className="flex items-center gap-1 text-ink-muted">
                    <Camera size={11} aria-hidden />
                    {entry.photoCount}
                  </span>
                  <span className="flex items-center gap-1 text-ink-muted">
                    <StickyNote size={11} aria-hidden />
                    {entry.notesCount}
                  </span>
                  <span className={`font-semibold ${badge.color}`}>
                    {entry.completeness === 'missing'
                      ? 'Keine Fotos oder Notizen'
                      : entry.completeness === 'partial'
                        ? 'Abschlussnachweis fehlt'
                        : badge.label}
                  </span>
                  {entry.isAbrechenbar && (
                    <span className="rounded-chip bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">
                      Abrechenbar
                    </span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      ) : subMode === 'offen' ? (
        <ScreenEmpty
          icon={<span className="text-[24px]">✅</span>}
          title="Alle dokumentiert"
          description="Keine offenen Dokumentationslücken"
        />
      ) : subMode === 'abrechenbar' ? (
        <ScreenEmpty
          title="Keine abrechenbaren Aufträge"
          description="Aufträge mit vollständiger Dokumentation und abgeschlossener Arbeit erscheinen hier"
        />
      ) : (
        <ScreenEmpty
          title="Keine Einträge für heute"
          description="Heutige Aufträge mit Arbeitsdokumentation erscheinen hier"
        />
      )}
    </div>
  )
}


// ── Main Screen ──────────────────────────────────────────────────────────────

export default function CraftsmanOperationsScreen() {
  const goBack = useSmartBack('/craftsman/backoffice')
  const [activeTab, setActiveTab] = useState('planung')

  const [jobs, setJobs] = useState<Job[]>(getJobs())
  const [calendarEntries, setCalendarEntries] = useState<CalendarEntry[]>(getCalendarEntries())
  const [schedules, setSchedules] = useState(() => getSchedules())
  const [schedulesHydrated, setSchedulesHydrated] = useState(() => isScheduleRepositoryHydrated())
  const [teamMembers, setTeamMembers] = useState(getTeamMembers)
  const [ownerNotesCounts, setOwnerNotesCounts] = useState<ReadonlyMap<string, number>>(new Map())
  const ownerNotesCountsFetched = useRef(false)

  useEffect(() => {
    // Ensure calendar entries exist for all relevant jobs
    getJobs()
      .filter(isCalendarRelevantJob)
      .forEach((job) => ensureCalendarEntryForJobId(job.id))

    const unsubJobs = subscribeJobs(() => {
      const currentJobs = getJobs()
      setJobs(currentJobs)
      syncCalendarEntriesForJobs(currentJobs)
      currentJobs
        .filter(isCalendarRelevantJob)
        .forEach((job) => ensureCalendarEntryForJobId(job.id))
    })
    const unsubCalendar = subscribeCalendar(() => {
      setCalendarEntries(getCalendarEntries())
    })
    const unsubOperations = subscribeOperations(() => {
      setJobs(getJobs())
      setSchedules(getSchedules())
      setSchedulesHydrated(isScheduleRepositoryHydrated())
    })
    const onMessageEvent = () => setJobs(getJobs())
    const unsubMessages = getChatRepository().subscribe(onMessageEvent)
    const unsubTeam = subscribeTeamMembers(() => {
      setTeamMembers(getTeamMembers())
    })

    syncCalendarEntriesForJobs(getJobs())

    return () => {
      unsubJobs()
      unsubCalendar()
      unsubOperations()
      unsubMessages()
      unsubTeam()
    }
  }, [])

  useEffect(() => {
    if (activeTab !== 'doku' || ownerNotesCountsFetched.current) return
    ownerNotesCountsFetched.current = true
    const ids = getJobs().map((j) => j.id)
    if (ids.length === 0) return
    const repo = new SupabaseOwnerNoteRepository()
    void repo.countsByJobIds(ids).then(setOwnerNotesCounts)
  }, [activeTab])

  // Screen-level KPIs — change based on active tab
  const summaryItems = useMemo(() => {
    if (activeTab === 'doku') {
      const dokuData = deriveDokuTab(jobs, calendarEntries, teamMembers, 'offen', ownerNotesCounts)
      return [
        { label: 'Offen', value: dokuData.summary.openCount, warn: true },
        { label: 'Vollständig', value: dokuData.summary.completeCount },
        { label: 'Abrechenbar', value: dokuData.summary.billableCount },
      ]
    }
    // Planung
    const todayKey = formatDateKey(new Date())
    const planungData = derivePlanungTab(calendarEntries, todayKey, teamMembers)
    const allJobs = getJobs()
    const activeJobs = allJobs.filter(
      (j) => j.status !== 'completed' && j.status !== 'cancelled' && j.status !== 'waiting_payment',
    )
    const unscheduledIds = getUnscheduledJobIds(activeJobs.map((j) => j.id), schedules)
    const ungeplant = schedulesHydrated
      ? Math.max(planungData.summary.pendingCount, unscheduledIds.length)
      : planungData.summary.pendingCount
    return [
      { label: 'Heute', value: planungData.summary.todayCount },
      { label: 'Ungeplant', value: ungeplant, warn: ungeplant > 0 },
      { label: 'Probleme', value: planungData.summary.problemCount, warn: true },
    ]
  }, [activeTab, jobs, calendarEntries, teamMembers, schedules, schedulesHydrated, ownerNotesCounts])

  return (
    <AppShell active="verwaltung">
      <section
        className="px-4 py-5"
        style={{ background: 'linear-gradient(180deg, #FAFBFE 0%, #F4F5F8 40%)' }}
      >
        <div className="mx-auto w-full max-w-[420px] space-y-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={goBack} aria-label="Zurück" className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"><ArrowLeft size={18} className="text-ink" aria-hidden /></button>
            <ScreenHeader eyebrow="Verwaltung" title="Betrieb" className="flex-1" />
          </div>

          <SummaryStrip items={summaryItems} />

          <ProfileTabBar
            tabs={[...TABS]}
            active={activeTab}
            onChange={setActiveTab}
          />

          {activeTab === 'planung' && (
            <PlanungTab
              calendarEntries={calendarEntries}
              teamMembers={teamMembers}
              schedules={schedules}
              schedulesHydrated={schedulesHydrated}
            />
          )}
          {activeTab === 'doku' && (
            <DokuTab
              jobs={jobs}
              calendarEntries={calendarEntries}
              teamMembers={teamMembers}
              ownerNotesCounts={ownerNotesCounts}
            />
          )}

        </div>
      </section>
    </AppShell>
  )
}

// Deferred-cleanup keep-alive: TeamTab + ZeitenView werden in Block 3 (Springer-
// Vorschlag) als Basis verwendet. Nicht löschen vor diesem Block.
// Dokument: ~/.claude/plans/team-hub-block-1-deferred.md
void TeamTab
void ZeitenView
