import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import {
  formatDateKey,
  getCalendarEntries,
  subscribeCalendar,
} from '../lib/calendar'
import {
  getEntriesForMember,
  getEntriesForUser,
} from '../lib/calendar/calendarSelectors'
import { getTeamMembers } from '../lib/jobs'
import { subscribeTeamMembers, isTeamMembersHydrated } from '../lib/team'
import { useSession } from '../hooks/useSession'
import {
  deriveNachrichtenViewModel,
  type WorkerGroupThreadData,
  type WorkerNachrichtenThread,
  type WorkerNachrichtenViewModel,
  type WorkerThreadEnrichment,
  type WorkerThreadSegment,
} from '../lib/worker/workerNachrichtenProjection'
import {
  useChatThreads,
  useChatHydrated,
  getOrCreateChatOfficeThread,
  getOrCreateChatTeamThread,
} from '../lib/chat'

const IS_IN_MEMORY = import.meta.env.VITE_DATA_SOURCE !== 'supabase'

// ── Segment helpers ───────────────────────────────────────────────────────────

const SEGMENTS: { id: WorkerThreadSegment; label: string }[] = [
  { id: 'einsaetze', label: 'Einsätze' },
  { id: 'team', label: 'Team' },
  { id: 'buero', label: 'Büro' },
]

function getThreadsForSegment(
  vm: WorkerNachrichtenViewModel,
  seg: WorkerThreadSegment
): WorkerNachrichtenThread[] {
  if (seg === 'einsaetze') return vm.einsaetze
  if (seg === 'team') return vm.team
  return vm.buero
}

// ── Segment control ────────────────────────────────────────────────────────────

function SegmentControl({
  active,
  vm,
  onChange,
}: {
  active: WorkerThreadSegment
  vm: WorkerNachrichtenViewModel
  onChange: (seg: WorkerThreadSegment) => void
}) {
  return (
    <div className="flex bg-slate-100/80 rounded-xl p-1 mb-5 gap-0.5">
      {SEGMENTS.map((seg) => {
        const isActive = seg.id === active
        const unread = getThreadsForSegment(vm, seg.id).filter((t) => t.unread).length
        return (
          <button
            key={seg.id}
            type="button"
            onClick={() => onChange(seg.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-[10px] py-2 text-[13px] font-semibold transition-all ${
              isActive
                ? 'bg-white shadow-sm text-slate-900'
                : 'text-slate-500 active:text-slate-700'
            }`}
          >
            <span>{seg.label}</span>
            {unread > 0 && (
              <span
                className={`inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold ${
                  isActive ? 'bg-blue-500 text-white' : 'bg-slate-300 text-slate-600'
                }`}
              >
                {unread}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Thread row ─────────────────────────────────────────────────────────────────

function ThreadRow({
  thread,
  onClick,
}: {
  thread: WorkerNachrichtenThread
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3.5 py-3.5 text-left active:bg-slate-50/60 transition-colors -mx-1 px-1 rounded-xl"
    >
      {/* Avatar */}
      <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
        <span className="text-[11px] font-bold text-slate-500 tracking-tight">
          {thread.initials}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`text-[14px] leading-snug truncate ${
              thread.unread ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'
            }`}
          >
            {thread.title}
          </span>
          <span className="text-[11px] text-slate-400 shrink-0">{thread.timestamp}</span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-[13px] text-slate-500 truncate">
            {thread.lastMessage || 'Noch keine Nachrichten.'}
          </span>
          {thread.unread ? (
            <div className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />
          ) : thread.needsResponse ? (
            <div className="h-2 w-2 rounded-full bg-amber-400 shrink-0" />
          ) : null}
        </div>
      </div>
    </button>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────────

const EMPTY_LABELS: Record<WorkerThreadSegment, string> = {
  einsaetze: 'Keine einsatzbezogenen Nachrichten.',
  team: 'Keine Team-Nachrichten.',
  buero: 'Keine Nachrichten aus dem Büro.',
}

function EmptyState({ segment }: { segment: WorkerThreadSegment }) {
  return (
    <div className="py-16 text-center">
      <p className="text-[14px] text-slate-400">{EMPTY_LABELS[segment]}</p>
    </div>
  )
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export default function WorkerNachrichtenScreen() {
  const { user } = useSession()
  const navigate = useNavigate()
  const [activeSegment, setActiveSegment] = useState<WorkerThreadSegment>('einsaetze')

  const [allEntries, setAllEntries] = useState(getCalendarEntries)
  const [teamMembers, setTeamMembers] = useState(getTeamMembers)
  const [teamMembersHydrated, setTeamMembersHydrated] = useState(isTeamMembersHydrated)
  const chatHydrated = useChatHydrated()
  const chatAssignmentThreads = useChatThreads('assignment')
  const chatOfficeThreads = useChatThreads('office')
  const chatTeamThreads = useChatThreads('team')

  // Proactively ensure office + team threads exist for fresh accounts.
  useEffect(() => {
    if (!chatHydrated) return
    if (chatOfficeThreads.length === 0) getOrCreateChatOfficeThread().catch(() => {})
    if (chatTeamThreads.length === 0) getOrCreateChatTeamThread().catch(() => {})
  }, [chatHydrated, chatOfficeThreads.length, chatTeamThreads.length])

  useEffect(() => {
    const unsubCalendar = subscribeCalendar(() => setAllEntries(getCalendarEntries()))
    const unsubTeam = subscribeTeamMembers(() => {
      setTeamMembers(getTeamMembers())
      setTeamMembersHydrated(isTeamMembersHydrated())
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTeamMembers(getTeamMembers())
    setTeamMembersHydrated(isTeamMembersHydrated())
    return () => {
      unsubCalendar()
      unsubTeam()
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

  const todayKey = useMemo(() => formatDateKey(new Date()), [])

  // Build enrichment map: calendarEntryId → WorkerThreadEnrichment.
  const enrichmentByEntryId = useMemo(() => {
    const map = new Map<string, WorkerThreadEnrichment>()
    for (const ct of chatAssignmentThreads) {
      const cid = ct.displayMetadata?.calendarEntryId
      if (!cid) continue
      map.set(cid, {
        lastMessageBody: ct.lastMessageBody ?? undefined,
        lastMessageAt: ct.lastMessageAt ?? undefined,
        isUnread: ct.unreadCount > 0,
      })
    }
    return map
  }, [chatAssignmentThreads])

  const officeThreadData = useMemo((): WorkerGroupThreadData | null => {
    const ct = chatOfficeThreads[0]
    if (!ct) return null
    return {
      id: ct.id,
      title: 'Büro',
      subtitle: 'Internes Büro',
      lastMessageBody: ct.lastMessageBody ?? undefined,
      lastMessageAt: ct.lastMessageAt ?? undefined,
      isUnread: ct.unreadCount > 0,
    }
  }, [chatOfficeThreads])

  const teamThreadData = useMemo((): WorkerGroupThreadData | null => {
    const ct = chatTeamThreads[0]
    if (!ct) return null
    return {
      id: ct.id,
      title: 'Team',
      subtitle: 'Team-Chat',
      lastMessageBody: ct.lastMessageBody ?? undefined,
      lastMessageAt: ct.lastMessageAt ?? undefined,
      isUnread: ct.unreadCount > 0,
    }
  }, [chatTeamThreads])

  const vm = useMemo(
    () =>
      deriveNachrichtenViewModel(
        userEntries,
        todayKey,
        enrichmentByEntryId,
        officeThreadData,
        teamThreadData,
      ),
    [userEntries, todayKey, enrichmentByEntryId, officeThreadData, teamThreadData],
  )

  const visibleThreads = getThreadsForSegment(vm, activeSegment)

  const handleThreadClick = useCallback(
    (thread: WorkerNachrichtenThread) => {
      navigate(`/worker/nachrichten/${thread.id}`)
    },
    [navigate],
  )

  return (
    <AppShell active="worker-nachrichten" noSafeTop>
      <div className="px-5 pt-[max(56px,env(safe-area-inset-top))]">
        {/* Header */}
        <div className="mb-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Kommunikation
          </p>
          <h1 className="mt-1 text-[26px] font-bold tracking-tight text-slate-900">
            Nachrichten
          </h1>
        </div>

        {/* Segment control — always visible; buero/team don't need team-member hydration */}
        <SegmentControl active={activeSegment} vm={vm} onChange={setActiveSegment} />

        {/* Thread list — einsaetze segment waits for team-member hydration */}
        {!teamMembersHydrated && activeSegment === 'einsaetze' ? (
          <div className="animate-pulse space-y-2">
            <div className="h-14 rounded-[18px] bg-slate-50 ring-1 ring-slate-100" />
            <div className="h-14 rounded-[18px] bg-slate-50 ring-1 ring-slate-100" />
          </div>
        ) : visibleThreads.length === 0 ? (
          <EmptyState segment={activeSegment} />
        ) : (
          <div className="divide-y divide-slate-100">
            {visibleThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                onClick={() => handleThreadClick(thread)}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}
