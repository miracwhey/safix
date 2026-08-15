import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../hooks/useSession'
import { Search, MessageSquare, SquarePen } from 'lucide-react'
import AppShell from '../components/AppShell'
import NewChatSheet from '../components/messages/NewChatSheet'
import { jobStatusPillStyles } from '../components/messages/jobStatusStyles'
import CraftsmanRequestInboxSection from '../components/messages/CraftsmanRequestInboxSection'
import ScreenEmpty from '../components/system/ScreenEmpty'
import CorridorAction from '../components/system/CorridorAction'
import {
  getThreadConversionState,
  getIncomingProjectRequests,
  type MessageRole,
  type IncomingRequestItem,
} from '../lib/messages'
import {
  useChatThreads,
  useChatHydrated,
  getChatRepository,
  getChatThreadListRow,
  isChatCutoverEnabled,
  sortChatThreadsByUnread,
  type ChatChannelType,
  type ChatThreadListRow,
} from '../lib/chat'
import { getIncomingProjectRequestsFromChat } from '../lib/chat/requestInboxSelectors'
import { channelStyle } from '../components/chat/chatChannelStyle'
import { getJobContextForThread, type ThreadJobContext } from '../lib/workflow'
import { subscribeJobs } from '../lib/jobs'

// Maximum conversation threads shown before the "show more" toggle appears.
const THREADS_INITIAL = 20

type CraftsmanSegment = 'kunden' | 'anfragen' | 'direkt' | 'team' | 'buero' | 'streit'

const CRAFTSMAN_SEGMENTS: {
  id: CraftsmanSegment
  label: string
  channel: ChatChannelType | null
}[] = [
  { id: 'kunden',   label: 'Kunden',   channel: 'customer'  },
  { id: 'anfragen', label: 'Anfragen', channel: null         },
  { id: 'direkt',   label: 'Direkt',   channel: 'direct'     },
  { id: 'team',     label: 'Team',     channel: 'team'       },
  { id: 'buero',    label: 'Büro',     channel: 'office'     },
  { id: 'streit',   label: 'Streit',   channel: 'dispute'    },
]

function threadInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return (parts[0]?.[0] ?? '?').toUpperCase()
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase()
}

type Props = {
  role?: MessageRole
  detailBasePath?: string
}

/**
 * Unified shape rendered by both legacy and chat paths so the JSX below
 * doesn't fork on cutover state. `routeId` is the legacy conversation id
 * (used for navigation + cross-domain lookups like job context); `key` is the
 * data-source id that React uses for reconciliation.
 */
type DisplayThread = {
  key: string
  routeId: string
  row: ChatThreadListRow
  searchHaystack: string
}

export default function MessagesScreen({
  role = 'customer',
  detailBasePath = '/messages',
}: Props) {
  const session = useSession()
  const userId = session.user?.id

  const [searchQuery, setSearchQuery] = useState('')
  const [showAllThreads, setShowAllThreads] = useState(false)
  const [activeSegment, setActiveSegment] = useState<CraftsmanSegment>('kunden')
  const [newChatOpen, setNewChatOpen] = useState(false)

  // Chat-Cutover Slice D: the craftsman request arm reads from the chat
  // domain when the craftsman cutover is active (flag only changes via reload).
  const chatCutover = role === 'craftsman' && isChatCutoverEnabled('craftsman')

  const [incomingRequests, setIncomingRequests] = useState<IncomingRequestItem[]>(
    () =>
      role === 'craftsman'
        ? chatCutover
          ? getIncomingProjectRequestsFromChat()
          : getIncomingProjectRequests()
        : [],
  )

  // Fetch all threads the user participates in; role-appropriate filtering
  // happens in allDisplayThreads (customer sees customer + direct; craftsman
  // segments split by channel). Previously customer was hard-scoped to
  // 'customer', which excluded 1:1 direct chats.
  const chatThreads = useChatThreads(undefined)
  const chatHydrated = useChatHydrated()

  useEffect(() => {
    const refreshIncomingRequests = () => {
      if (role === 'craftsman') {
        setIncomingRequests(
          chatCutover
            ? getIncomingProjectRequestsFromChat()
            : getIncomingProjectRequests(),
        )
      }
    }
    const unsubJobs = subscribeJobs(refreshIncomingRequests)
    // Under the cutover the request items derive from the chat cache, so
    // realtime/hydration chat updates must re-read them as well.
    const unsubChat = chatCutover
      ? getChatRepository().subscribe(refreshIncomingRequests)
      : undefined
    return () => {
      unsubJobs()
      unsubChat?.()
    }
  }, [role, userId, chatCutover])

  const requestThreadIds = useMemo(
    () => new Set(incomingRequests.map((r) => r.threadId)),
    [incomingRequests],
  )

  const allDisplayThreads = useMemo<DisplayThread[]>(() => {
    // Customers see their customer-channel threads + 1:1 direct chats (disputes
    // have their own surface). Craftsman keeps all channels; segments split them.
    const source =
      role === 'customer'
        ? chatThreads.filter((t) => t.channelType === 'customer' || t.channelType === 'direct')
        : chatThreads
    const sorted = sortChatThreadsByUnread(source)
    return sorted.map((t) => {
      const row = getChatThreadListRow(t, role, userId)
      const routeId = t.legacyThreadId ?? t.id
      return {
        key: t.id,
        routeId,
        row,
        searchHaystack: [
          row.primaryName,
          row.secondaryLine,
          row.preview,
        ]
          .join(' ')
          .toLowerCase(),
      }
    })
  }, [chatThreads, role, userId])

  const segmentUnreads = useMemo(() => {
    const counts: Record<ChatChannelType, number> = { customer: 0, office: 0, team: 0, assignment: 0, dispute: 0, direct: 0 }
    for (const d of allDisplayThreads) counts[d.row.channelType] += d.row.unreadCount
    return counts
  }, [allDisplayThreads])

  const sortedFilteredThreads = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase()
    let filtered = !normalized
      ? allDisplayThreads
      : allDisplayThreads.filter((d) => d.searchHaystack.includes(normalized))
    if (role === 'craftsman') {
      if (activeSegment === 'anfragen') return []
      const seg = CRAFTSMAN_SEGMENTS.find((s) => s.id === activeSegment)
      if (seg?.channel) filtered = filtered.filter((d) => d.row.channelType === seg.channel)
      // Chat-sourced request items carry the chat-thread id (`key`); legacy
      // items carry the legacy conversation id (`routeId`).
      filtered = filtered.filter(
        (d) => !requestThreadIds.has(chatCutover ? d.key : d.routeId),
      )
    }
    return filtered
  }, [searchQuery, allDisplayThreads, role, activeSegment, requestThreadIds, chatCutover])

  const visibleThreads = showAllThreads
    ? sortedFilteredThreads
    : sortedFilteredThreads.slice(0, THREADS_INITIAL)
  const hiddenThreadCount = sortedFilteredThreads.length - visibleThreads.length

  const threadJobContexts = useMemo(() => {
    const map = new Map<string, ThreadJobContext | null>()
    for (const d of visibleThreads) {
      map.set(d.routeId, getJobContextForThread(d.routeId))
    }
    return map
  }, [visibleThreads])

  const threadConversionStates = useMemo(() => {
    const map = new Map<string, 'inquiry' | 'project' | null>()
    for (const d of visibleThreads) {
      map.set(d.routeId, getThreadConversionState(d.routeId))
    }
    return map
  }, [visibleThreads])

  const isHydrated = chatHydrated

  return (
    <AppShell active="messages" className="bg-canvas">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-[24px] font-semibold text-ink">
                Nachrichten
              </h1>
              <p className="mt-1 text-[14px] text-ink-muted">
                {role === 'customer'
                  ? 'Projektbezogene Kommunikation mit Handwerkern.'
                  : 'Projektbezogene Kommunikation mit Kunden.'}
              </p>
            </div>
            {(role === 'customer' || (activeSegment !== 'anfragen' && activeSegment !== 'streit')) && (
              <button
                type="button"
                onClick={() => setNewChatOpen(true)}
                aria-label="Neuer Chat"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand transition active:scale-95"
              >
                <SquarePen size={19} aria-hidden />
              </button>
            )}
          </div>

          <div className="flex items-center gap-3 rounded-container bg-surface px-4 py-3 ring-1 ring-edge shadow-subtle">
            <Search size={16} className="shrink-0 text-ink-muted" aria-hidden />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Chats durchsuchen"
              className="flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted"
            />
          </div>

          {/* ── Craftsman: Segment-Tabs ─────────────────────────────────── */}
          {role === 'craftsman' && (
            <div className="flex gap-[6px] overflow-x-auto pb-0.5 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              {CRAFTSMAN_SEGMENTS.map((seg) => {
                const isActive = activeSegment === seg.id
                const count =
                  seg.id === 'anfragen'
                    ? incomingRequests.length
                    : seg.channel
                      ? segmentUnreads[seg.channel]
                      : 0
                return (
                  <button
                    key={seg.id}
                    type="button"
                    onClick={() => setActiveSegment(seg.id)}
                    className={`flex shrink-0 items-center gap-[5px] rounded-full px-[14px] py-[7px] text-[12.5px] font-semibold transition ${
                      isActive ? 'bg-slate-900 text-white' : 'bg-canvas text-slate-500'
                    }`}
                  >
                    {seg.label}
                    {count > 0 && (
                      <span
                        className={`flex min-w-[16px] h-[16px] items-center justify-center rounded-full px-[4px] text-[9.5px] font-bold tabular-nums ${
                          isActive && seg.id === 'streit'
                            ? 'bg-red-500 text-white'
                            : isActive
                              ? 'bg-white text-slate-900'
                              : 'bg-blue-600 text-white'
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {/* ── Anfragen-Segment: Request-Inbox ────────────────────────── */}
          {role === 'craftsman' && activeSegment === 'anfragen' && (
            <div className="overflow-hidden rounded-container bg-surface ring-1 ring-edge shadow-subtle">
              <CraftsmanRequestInboxSection
                requests={incomingRequests}
                detailBasePath={detailBasePath}
              />
            </div>
          )}

          {/* ── Thread-Liste ────────────────────────────────────────────── */}
          {(role !== 'craftsman' || activeSegment !== 'anfragen') && (
            <div className="overflow-hidden rounded-container bg-surface ring-1 ring-edge shadow-subtle">
              {sortedFilteredThreads.length === 0 ? (
                !isHydrated && !searchQuery ? (
                  <div className="animate-pulse px-5 py-8">
                    <div className="h-3 w-32 rounded-full bg-slate-100" />
                    <div className="mt-3 h-10 rounded-[14px] bg-slate-100" />
                    <div className="mt-2 h-10 rounded-[14px] bg-slate-100" />
                  </div>
                ) : (
                  <ScreenEmpty
                    icon={<MessageSquare size={32} className="text-ink-muted" aria-hidden />}
                    title="Keine Chats gefunden"
                    description={
                      searchQuery
                        ? 'Versuch es mit einem anderen Suchbegriff.'
                        : 'Starte eine Unterhaltung, um hier Chats zu sehen.'
                    }
                  />
                )
              ) : (
                <>
                  {visibleThreads.map((displayThread, index) => {
                    const { row, routeId, key } = displayThread
                    const jobCtx = threadJobContexts.get(routeId) ?? null
                    const statusStyle = jobCtx ? jobStatusPillStyles[jobCtx.status] : null
                    const conversionState = threadConversionStates.get(routeId) ?? null
                    const isInquiry = !jobCtx && conversionState === 'inquiry'
                    const actionPriority = jobCtx?.nextAction.priority ?? 'idle'
                    const showActionBadge = jobCtx && actionPriority !== 'idle'
                    const actionBadgeStyle =
                      actionPriority === 'urgent'
                        ? 'bg-rose-50 text-rose-700 ring-rose-100'
                        : 'bg-amber-50 text-amber-700 ring-amber-100'
                    const isUnread = row.unreadCount > 0
                    const chStyle = channelStyle(row.channelType)
                    const hasPills = isInquiry || (jobCtx && statusStyle) || showActionBadge

                    return (
                      <Link
                        key={key}
                        to={`${detailBasePath}/${routeId}`}
                        className={`relative flex items-start gap-[10px] py-[10px] pr-[14px] pl-[12px] transition active:bg-slate-50/60 ${
                          index !== 0 ? 'border-t border-slate-100' : ''
                        }`}
                      >
                        {/* Left stripe */}
                        <div
                          className={`absolute left-0 top-[10px] bottom-[10px] w-[3px] rounded-r-[2px] ${chStyle.stripeClass}`}
                          aria-hidden
                        />

                        {/* Avatar */}
                        <div
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold tracking-tight ${chStyle.avatarClass}`}
                          aria-hidden
                        >
                          {threadInitials(row.primaryName)}
                        </div>

                        {/* Body */}
                        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                          <div
                            className={`truncate text-[12.5px] ${isUnread ? 'font-bold text-slate-900' : 'font-semibold text-slate-500'}`}
                          >
                            {row.primaryName}
                          </div>
                          <div className="truncate text-[10.5px] font-medium text-slate-400">
                            {row.secondaryLine}
                          </div>
                          {hasPills && (
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                              {isInquiry && (
                                <span className="inline-flex shrink-0 items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 ring-1 ring-blue-100">
                                  Anfrage
                                </span>
                              )}
                              {jobCtx && statusStyle && (
                                <span
                                  className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusStyle.pill}`}
                                >
                                  {jobCtx.statusLabel}
                                </span>
                              )}
                              {showActionBadge && jobCtx && (
                                <span
                                  className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${actionBadgeStyle}`}
                                >
                                  {jobCtx.nextAction.icon} {jobCtx.nextAction.label}
                                </span>
                              )}
                            </div>
                          )}
                          <div
                            className={`truncate text-[13.5px] leading-[1.35] ${hasPills ? '' : 'mt-[2px]'} ${isUnread ? 'font-medium text-slate-900' : 'text-slate-400'}`}
                          >
                            {row.preview}
                          </div>
                        </div>

                        {/* Meta */}
                        <div className="flex shrink-0 flex-col items-end gap-[5px]">
                          {row.timeLabel && (
                            <span
                              className={`text-[10.5px] tabular-nums ${isUnread ? 'font-bold text-blue-600' : 'font-medium text-slate-400'}`}
                            >
                              {row.timeLabel}
                            </span>
                          )}
                          {isUnread && (
                            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-600 px-[5px] text-[10px] font-bold tabular-nums text-white">
                              {row.unreadCount}
                            </span>
                          )}
                        </div>
                      </Link>
                    )
                  })}
                  {hiddenThreadCount > 0 && (
                    <CorridorAction
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAllThreads(true)}
                    >
                      {hiddenThreadCount} weitere Chats anzeigen
                    </CorridorAction>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </section>
      <NewChatSheet open={newChatOpen} onClose={() => setNewChatOpen(false)} detailBasePath={detailBasePath} />
    </AppShell>
  )
}
