import { useCallback, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Building2, Users } from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  useChatThreads,
  useChatHydrated,
  getOrCreateChatOfficeThread,
  getOrCreateChatTeamThread,
  type ChatThreadViewModel,
} from '../lib/chat'
import { useSmartBack } from '../hooks/useSmartBack'

type ThreadRowData = {
  id: string
  threadType: 'office' | 'team' | 'assignment'
  isUnread: boolean
  lastMessageAt: number | undefined
  lastMessageBody: string | undefined
}

function chatThreadToRow(
  t: ChatThreadViewModel,
  threadType: 'office' | 'team' | 'assignment',
): ThreadRowData {
  return {
    id: t.id,
    threadType,
    lastMessageBody: t.lastMessageBody ?? undefined,
    lastMessageAt: t.lastMessageAt ?? undefined,
    isUnread: t.unreadCount > 0,
  }
}

// ── Thread row ────────────────────────────────────────────────────────────────

function formatTimestamp(at: number | undefined): string {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
}

function GroupThreadRow({
  thread,
  onClick,
}: {
  thread: ThreadRowData
  onClick: () => void
}) {
  const isOffice = thread.threadType === 'office'
  const Icon = isOffice ? Building2 : Users
  const label = isOffice ? 'Büro' : 'Team'
  const subtitle = isOffice ? 'Interne Bürokommunikation' : 'Alle Teammitglieder'

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3.5 py-3.5 text-left active:bg-slate-50/60 transition-colors -mx-1 px-1 rounded-xl"
    >
      {/* Icon avatar */}
      <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
        <Icon size={18} className="text-slate-500" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`text-[14px] leading-snug truncate ${
              thread.isUnread ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'
            }`}
          >
            {label}
          </span>
          {thread.lastMessageAt != null && (
            <span className="text-[11px] text-slate-400 shrink-0">
              {formatTimestamp(thread.lastMessageAt)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-[13px] text-slate-500 truncate">
            {thread.lastMessageBody ?? subtitle}
          </span>
          {thread.isUnread && (
            <div className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />
          )}
        </div>
      </div>
    </button>
  )
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function CraftsmanNachrichtenScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/backoffice')

  const chatHydrated = useChatHydrated()
  const chatOfficeThreads = useChatThreads('office')
  const chatTeamThreads = useChatThreads('team')

  // Proactively ensure office + team threads exist for fresh accounts.
  // getOrCreate RPCs are idempotent — safe to call even when threads already exist.
  useEffect(() => {
    if (!chatHydrated) return
    if (chatOfficeThreads.length === 0) getOrCreateChatOfficeThread().catch(() => {})
    if (chatTeamThreads.length === 0) getOrCreateChatTeamThread().catch(() => {})
  }, [chatHydrated, chatOfficeThreads.length, chatTeamThreads.length])

  const officeThread = useMemo<ThreadRowData | null>(() => {
    const ct = chatOfficeThreads[0]
    return ct ? chatThreadToRow(ct, 'office') : null
  }, [chatOfficeThreads])

  const teamThread = useMemo<ThreadRowData | null>(() => {
    const ct = chatTeamThreads[0]
    return ct ? chatThreadToRow(ct, 'team') : null
  }, [chatTeamThreads])

  const handleOfficeClick = useCallback(() => {
    if (officeThread) navigate(`/craftsman/nachrichten/${officeThread.id}`)
  }, [navigate, officeThread])

  const handleTeamClick = useCallback(() => {
    if (teamThread) navigate(`/craftsman/nachrichten/${teamThread.id}`)
  }, [navigate, teamThread])

  return (
    <AppShell active="verwaltung" noSafeTop>
      <div className="px-5 pt-[max(56px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={goBack}
          aria-label="Zurück"
          className="mb-4 flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
        >
          <ArrowLeft size={18} className="text-ink" aria-hidden />
        </button>
        {/* Header */}
        <div className="mb-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Betrieb
          </p>
          <h1 className="mt-1 text-[26px] font-bold tracking-tight text-slate-900">
            Team-Nachrichten
          </h1>
        </div>

        {/* Thread list */}
        <div className="divide-y divide-slate-100">
          {officeThread ? (
            <GroupThreadRow thread={officeThread} onClick={handleOfficeClick} />
          ) : (
            <LoadingRow label="Büro" Icon={Building2} />
          )}
          {teamThread ? (
            <GroupThreadRow thread={teamThread} onClick={handleTeamClick} />
          ) : (
            <LoadingRow label="Team" Icon={Users} />
          )}
        </div>

        <p className="mt-8 text-[12px] text-slate-400 text-center leading-relaxed">
          Einsatz-Threads sind über den jeweiligen Auftrag erreichbar.
        </p>
      </div>
    </AppShell>
  )
}

function LoadingRow({
  label,
  Icon,
}: {
  label: string
  Icon: typeof Building2
}) {
  return (
    <div className="flex items-center gap-3.5 py-3.5 -mx-1 px-1">
      <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center shrink-0 animate-pulse">
        <Icon size={18} className="text-slate-300" />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-[14px] font-medium text-slate-400">{label}</span>
        <div className="mt-0.5 h-3 w-32 rounded bg-slate-100 animate-pulse" />
      </div>
    </div>
  )
}

