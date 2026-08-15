import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ChevronRight, Clock, MapPin } from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  formatDateKey,
  getCalendarEntries,
  subscribeCalendar,
  type CalendarEntry,
} from '../lib/calendar'
import {
  getEntriesForMember,
  getEntriesForUser,
} from '../lib/calendar/calendarSelectors'
import { getTeamMembers } from '../lib/jobs'
import { subscribeTeamMembers, isTeamMembersHydrated, retryTeamMembersHydration } from '../lib/team'
import { useSession } from '../hooks/useSession'
import {
  deriveEinsaetzeListViewModel,
  type EinsaetzeHeuteGroups,
  type EinsaetzeDemnaechstGroup,
} from '../lib/worker/workerEinsaetzeProjection'

const IS_IN_MEMORY = import.meta.env.VITE_DATA_SOURCE !== 'supabase'
const HYDRATION_TIMEOUT_MS = 15_000

// ── Shared atoms ──────────────────────────────────────────────────────────────

function SectionHeader({
  children,
  quiet = false,
}: {
  children: ReactNode
  quiet?: boolean
}) {
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

function GroupLabel({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <div className="px-1 mb-1.5">
      <span
        className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${
          active ? 'text-blue-500' : 'text-slate-400'
        }`}
      >
        {label}
      </span>
    </div>
  )
}

// ── Assignment card ───────────────────────────────────────────────────────────

type CardVariant = 'active' | 'next' | 'normal' | 'light'

function EntryCard({
  entry,
  variant = 'normal',
  onClick,
}: {
  entry: CalendarEntry
  variant?: CardVariant
  onClick: () => void
}) {
  const containerCls =
    variant === 'active'
      ? 'bg-white ring-2 ring-blue-200 shadow-[0_20px_44px_-28px_rgba(37,99,235,0.26)]'
      : variant === 'next'
      ? 'bg-white ring-1 ring-slate-200/70 shadow-[0_16px_36px_-24px_rgba(2,6,23,0.22)]'
      : variant === 'light'
      ? 'bg-slate-50/80 ring-1 ring-slate-100'
      : 'bg-white ring-1 ring-slate-200/60 shadow-[0_10px_24px_-16px_rgba(2,6,23,0.16)]'

  const paddingCls = variant === 'light' ? 'px-4 py-3' : 'p-4'

  const isCompact = variant === 'light'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-[22px] ${paddingCls} ${containerCls} active:scale-[0.99] transition-transform`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {variant === 'active' && (
            <div className="mb-2 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-500">
                Läuft gerade
              </span>
            </div>
          )}

          <div
            className={`font-semibold leading-snug ${
              isCompact ? 'text-[14px] text-slate-700' : 'text-[15px] text-slate-900'
            }`}
          >
            {entry.title}
          </div>

          <div
            className={`mt-0.5 truncate ${
              isCompact ? 'text-[12px] text-slate-400' : 'text-[13px] text-slate-500'
            }`}
          >
            {entry.customerName}
          </div>

          {isCompact ? (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
              <Clock size={10} strokeWidth={2} />
              <span>
                {entry.startsAtLabel}–{entry.endsAtLabel}
              </span>
              {entry.location && (
                <>
                  <span className="text-slate-300">·</span>
                  <span className="truncate max-w-[120px]">{entry.location}</span>
                </>
              )}
            </div>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="flex items-center gap-1 text-[12px] text-slate-400">
                <Clock size={11} strokeWidth={2} />
                <span>
                  {entry.startsAtLabel}–{entry.endsAtLabel}
                </span>
              </div>
              {entry.location && (
                <div className="flex items-center gap-1 text-[12px] text-slate-400">
                  <MapPin size={11} strokeWidth={2} />
                  <span className="truncate max-w-[160px]">{entry.location}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <ChevronRight size={14} strokeWidth={2} className="shrink-0 mt-1 text-slate-300" />
      </div>
    </button>
  )
}

// ── Section: Heute ────────────────────────────────────────────────────────────

function HeuteSection({
  groups,
  onSelect,
}: {
  groups: EinsaetzeHeuteGroups
  onSelect: (entry: CalendarEntry) => void
}) {
  const isEmpty =
    groups.jetzt.length === 0 &&
    groups.alsNaechstes.length === 0 &&
    groups.spaeterHeute.length === 0

  return (
    <section>
      <SectionHeader>Heute</SectionHeader>

      {isEmpty ? (
        <div className="rounded-[22px] bg-slate-50 px-5 py-4 ring-1 ring-slate-100">
          <p className="text-[13px] text-slate-400">
            Für heute sind keine Einsätze geplant.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.jetzt.length > 0 && (
            <div className="space-y-2">
              <GroupLabel label="Jetzt" active />
              {groups.jetzt.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  variant="active"
                  onClick={() => onSelect(entry)}
                />
              ))}
            </div>
          )}

          {groups.alsNaechstes.length > 0 && (
            <div className="space-y-2">
              <GroupLabel label="Als Nächstes" />
              {groups.alsNaechstes.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  variant="next"
                  onClick={() => onSelect(entry)}
                />
              ))}
            </div>
          )}

          {groups.spaeterHeute.length > 0 && (
            <div className="space-y-2">
              <GroupLabel label="Später heute" />
              {groups.spaeterHeute.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  variant="normal"
                  onClick={() => onSelect(entry)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ── Section: Demnächst ────────────────────────────────────────────────────────

function DemnaechstSection({
  groups,
  onSelect,
}: {
  groups: EinsaetzeDemnaechstGroup[]
  onSelect: (entry: CalendarEntry) => void
}) {
  return (
    <section>
      <SectionHeader>Demnächst</SectionHeader>

      {groups.length === 0 ? (
        <div className="rounded-[22px] bg-slate-50 px-5 py-4 ring-1 ring-slate-100">
          <p className="text-[13px] text-slate-400">
            Aktuell sind keine weiteren Einsätze vorgemerkt.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.dateKey} className="space-y-2">
              <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                {group.dateLabel}
              </div>
              {group.entries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  variant="light"
                  onClick={() => onSelect(entry)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Section: Abgeschlossen ────────────────────────────────────────────────────

function AbgeschlossenSection({
  entries,
  onSelect,
}: {
  entries: CalendarEntry[]
  onSelect: (entry: CalendarEntry) => void
}) {
  return (
    <section>
      <SectionHeader quiet>Abgeschlossen</SectionHeader>

      {entries.length === 0 ? (
        <div className="rounded-[22px] bg-slate-50 px-5 py-3 ring-1 ring-slate-100">
          <p className="text-[12px] text-slate-400">Noch keine abgeschlossenen Einsätze.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              variant="light"
              onClick={() => onSelect(entry)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export default function WorkerEinsaetzeScreen() {
  const { user } = useSession()
  const navigate = useNavigate()

  const [allEntries, setAllEntries] = useState<CalendarEntry[]>(getCalendarEntries)
  const [teamMembers, setTeamMembers] = useState(getTeamMembers)
  const [teamMembersHydrated, setTeamMembersHydrated] = useState(isTeamMembersHydrated)
  const [hydrationTimedOut, setHydrationTimedOut] = useState(false)
  const [hydrationRetryEpoch, setHydrationRetryEpoch] = useState(0)

  useEffect(() => {
    const unsubCalendar = subscribeCalendar(() => setAllEntries(getCalendarEntries()))
    const unsubTeam = subscribeTeamMembers(() => {
      setTeamMembers(getTeamMembers())
      setTeamMembersHydrated(isTeamMembersHydrated())
    })
    return () => {
      unsubCalendar()
      unsubTeam()
    }
  }, [])

  useEffect(() => {
    if (teamMembersHydrated) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHydrationTimedOut(false)
      return
    }
    const t = setTimeout(() => setHydrationTimedOut(true), HYDRATION_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [teamMembersHydrated, hydrationRetryEpoch])

  const userEntries = useMemo(() => {
    if (!user) return []
    const linked = getEntriesForUser(allEntries, teamMembers, user.id)
    if (linked.length === 0 && IS_IN_MEMORY) {
      return getEntriesForMember(allEntries, 'tm-1')
    }
    return linked
  }, [allEntries, teamMembers, user])

  const todayKey = useMemo(() => formatDateKey(new Date()), [])

  const vm = useMemo(
    () => deriveEinsaetzeListViewModel(userEntries, todayKey),
    [userEntries, todayKey]
  )

  const handleSelect = useCallback(
    (entry: CalendarEntry) => {
      navigate(`/worker/einsaetze/${entry.id}`)
    },
    [navigate]
  )

  return (
    <AppShell active="worker-einsaetze" noSafeTop>
      <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-10">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="mb-6 px-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Meine Aufgaben
            </p>
            <h1 className="mt-1 text-[26px] font-bold tracking-tight text-slate-900">
              Einsätze
            </h1>
          </div>

          {!teamMembersHydrated ? (
            hydrationTimedOut ? (
              <div className="rounded-[24px] bg-white px-5 py-6 ring-1 ring-red-100">
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
              <div className="rounded-[24px] bg-white px-5 py-6 text-[13px] text-slate-400 ring-1 ring-slate-200/70 animate-pulse">
                <div className="h-3 w-24 rounded-full bg-slate-100" />
                <div className="mt-4 h-16 rounded-[20px] bg-slate-100" />
              </div>
            )
          ) : (
            <div className="space-y-8">
              <HeuteSection groups={vm.heute} onSelect={handleSelect} />
              <DemnaechstSection groups={vm.demnaechst} onSelect={handleSelect} />
              <AbgeschlossenSection entries={vm.abgeschlossen} onSelect={handleSelect} />
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
