import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Briefcase, Building2, Send, Users } from 'lucide-react'
import AppShell from '../components/AppShell'
import Spinner from '../components/system/Spinner'
import { getCalendarEntries, subscribeCalendar } from '../lib/calendar'
import type { CalendarEntry } from '../lib/calendar/calendarTypes'
import {
  useChatMessages,
  useChatHydrated,
  useChatThread,
} from '../lib/chat'
import { subscribeSession, getSession as getCurrentSession } from '../lib/session'
import {
  getOrCreateChatOfficeThread,
  getOrCreateChatTeamThread,
  getOrCreateChatAssignmentThread,
} from '../lib/chat/service'
import {
  sendMessageWorkflow,
  markThreadReadWorkflow,
} from '../lib/workflow/chatWorkflow'
import { SystemMessageBubble } from '../components/team/SystemMessageBubble'
import { ChatBubble } from '../components/chat'
import { useDraftPersistence } from '../hooks/useDraftPersistence'
import { useThreadAutoScroll } from '../hooks/useThreadAutoScroll'
import { useSmartBack } from '../hooks/useSmartBack'

// Assignment threads navigated from owner context use the same 'einsatz-' prefix
// as the worker side — so both sides can open the same real DB thread.
const EINSATZ_PREFIX = 'einsatz-'

// ── Context block ─────────────────────────────────────────────────────────────

function ContextBlock({
  threadType,
  entry,
  onJobLink,
}: {
  threadType: 'assignment' | 'office' | 'team'
  entry: CalendarEntry | null
  onJobLink?: () => void
}) {
  if (threadType === 'assignment') {
    if (!entry) {
      return (
        <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-100">
          <div className="flex items-center gap-1.5">
            <Briefcase size={13} className="text-slate-400 shrink-0" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Einsatz
            </span>
          </div>
          <div className="mt-1 text-[12px] text-slate-400">Einsatzdaten werden geladen …</div>
        </div>
      )
    }
    return (
      <div className="px-4 py-3 bg-blue-50/60 border-b border-blue-100/80">
        <div className="flex items-center gap-1.5">
          <Briefcase size={13} className="text-blue-400 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-500">
            Einsatz
          </span>
        </div>
        <div className="mt-1 text-[13px] font-semibold text-slate-800 leading-snug">
          {entry.title}
        </div>
        <div className="text-[12px] text-slate-500 mt-0.5">
          {entry.dateLabel} · {entry.location}
        </div>
        {onJobLink && (
          <div className="mt-2">
            <button
              type="button"
              onClick={onJobLink}
              className="text-[12px] text-blue-500 font-medium"
            >
              Zum Auftrag →
            </button>
          </div>
        )}
      </div>
    )
  }

  if (threadType === 'team') {
    return (
      <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-100">
        <div className="flex items-center gap-1.5">
          <Users size={13} className="text-slate-400 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Team
          </span>
        </div>
        <div className="mt-1 text-[12px] text-slate-400">Interne Team-Kommunikation</div>
      </div>
    )
  }

  return (
    <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-100">
      <div className="flex items-center gap-1.5">
        <Building2 size={13} className="text-slate-400 shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Büro
        </span>
      </div>
      <div className="mt-1 text-[12px] text-slate-400">Bürokommunikation</div>
    </div>
  )
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function CraftsmanNachrichtenThreadScreen() {
  const { threadId } = useParams<{ threadId: string }>()
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/nachrichten')

  const chatHydrated = useChatHydrated()

  const [allEntries, setAllEntries] = useState<CalendarEntry[]>(getCalendarEntries)

  useEffect(() => {
    return subscribeCalendar(() => setAllEntries(getCalendarEntries()))
  }, [])

  // Determine whether this is an assignment thread (einsatz-{entryId} prefix)
  // or a group thread (real DB UUID).
  const isEinsatzThread = Boolean(threadId?.startsWith(EINSATZ_PREFIX))
  const entryId = isEinsatzThread ? threadId!.slice(EINSATZ_PREFIX.length) : null

  const entry = useMemo(
    () => (entryId ? (allEntries.find((e) => e.id === entryId) ?? null) : null),
    [entryId, allEntries],
  )

  const chatThreadFromUrl = useChatThread(
    !isEinsatzThread ? threadId : undefined,
  )

  const threadType: 'assignment' | 'office' | 'team' = isEinsatzThread
    ? 'assignment'
    : chatThreadFromUrl?.channelType === 'team'
      ? 'team'
      : 'office'

  // ── Thread resolution ──────────────────────────────────────────────────────

  const [chatThreadId, setChatThreadId] = useState<string | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadError, setThreadError] = useState<string | null>(null)

  useEffect(() => {
    if (!chatHydrated) return
    let cancelled = false
    setThreadLoading(true)
    setThreadError(null)
    const resolver = (async (): Promise<string> => {
      if (isEinsatzThread && entryId) return getOrCreateChatAssignmentThread(entryId)
      if (threadType === 'team') return getOrCreateChatTeamThread()
      return getOrCreateChatOfficeThread()
    })()
    resolver
      .then((tid) => {
        if (cancelled) return
        setChatThreadId(tid)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[CraftsmanNachrichtenThreadScreen] chat thread resolution failed:', err)
        setThreadError('Nachrichten konnten nicht geladen werden.')
      })
      .finally(() => {
        if (!cancelled) setThreadLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chatHydrated, isEinsatzThread, entryId, threadType])

  // ── Messages ───────────────────────────────────────────────────────────────

  const chatMessages = useChatMessages(chatThreadId ?? undefined)

  const activeThreadId = chatThreadId
  const messagesLength = chatMessages.length

  const lastMarkedReadIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!chatThreadId || chatMessages.length === 0) return
    const last = chatMessages[chatMessages.length - 1]
    if (!last) return
    // Optimistic own send: temp_-ids don't exist server-side — marking read
    // against them is a guaranteed-failing UPDATE on every send. Skip WITHOUT
    // touching the dedupe ref so the server echo (real id) marks afterwards.
    if (last.id.startsWith('temp_')) return
    if (lastMarkedReadIdRef.current === last.id) return
    lastMarkedReadIdRef.current = last.id
    void markThreadReadWorkflow(chatThreadId, last.id)
  }, [chatThreadId, chatMessages])

  // Reset the markRead-dedupe key when the chat thread changes so the next
  // arrival in the new thread is acknowledged.
  useEffect(() => {
    lastMarkedReadIdRef.current = null
  }, [chatThreadId])

  // ── Sender names ───────────────────────────────────────────────────────────

  const [currentUserId, setCurrentUserId] = useState<string | null>(
    () => getCurrentSession().user?.id ?? null,
  )
  useEffect(() => {
    return subscribeSession(() => {
      setCurrentUserId(getCurrentSession().user?.id ?? null)
    })
  }, [])

  // Scroll management (Block 3 scroll-twofer): instant jump to the latest
  // message once per thread; afterwards auto-follow only near-bottom or for
  // own sends — a realtime arrival must not yank the user out of their
  // reading position (previously scrollIntoView fired on EVERY length change).
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  useThreadAutoScroll({
    endRef: messagesEndRef,
    scrollerRef: messagesScrollRef,
    messages: chatMessages,
    currentUserId,
    threadKey: chatThreadId,
  })

  // ── Composer ───────────────────────────────────────────────────────────────

  // Draft persisted per resolved chat-thread (resume robustness): survives
  // unmount/remount (navigation, AuthGate error-swap) and WebView memory
  // kills. Key is null until thread resolution — the input is disabled in
  // that window, so no keystrokes can be lost. Cleared only on successful
  // send dispatch; the catch below restores it on failure.
  const {
    value: draftBody,
    setValue: setDraftBody,
    clear: clearDraftBody,
  } = useDraftPersistence(chatThreadId !== null ? `fixup.chat.draft.${chatThreadId}` : null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState(false)

  // Synchronous double-tap guard. `setSending(true)` is queued by React, so
  // two touch events in the same tick can both pass the `!sending` check
  // before the state update lands and create two distinct messages with
  // different client_message_ids. The ref is updated synchronously and
  // catches the second invocation immediately.
  const sendingRef = useRef(false)

  const canSubmit = activeThreadId !== null && draftBody.trim().length > 0 && !sending

  const handleSend = async () => {
    if (!canSubmit || !activeThreadId || sendingRef.current) return
    sendingRef.current = true
    const body = draftBody.trim()
    setSending(true)
    setSendError(false)
    try {
      await sendMessageWorkflow({
        threadId: activeThreadId,
        body,
        clientMessageId: crypto.randomUUID(),
        callerRole: 'craftsman',
      })
      // Draft erst NACH erfolgreichem Dispatch löschen — ein mid-flight
      // WebView-Kill darf den persistierten Text nicht kosten (Input ist
      // während des Sends disabled, der Draft kann nicht divergieren).
      clearDraftBody()
    } catch (err) {
      console.error('[CraftsmanNachrichtenThreadScreen] send failed:', err)
      // NOTE: in cutover mode the chat repository keeps the optimistic row
      // with status='failed' (✗ icon). The untouched draft therefore
      // produces a transient dual-state (failed bubble + draft). Clean-up
      // is deferred to a follow-up pass that adds repository-level
      // removeOptimistic + a retry affordance on the failed bubble.
      setSendError(true)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // ── Retry ──────────────────────────────────────────────────────────────────

  const handleRetry = () => {
    setThreadLoading(true)
    setThreadError(null)
    const resolver: Promise<string> = isEinsatzThread && entryId
      ? getOrCreateChatAssignmentThread(entryId)
      : threadType === 'team'
        ? getOrCreateChatTeamThread()
        : getOrCreateChatOfficeThread()
    resolver
      .then((tid) => setChatThreadId(tid))
      .catch(() => setThreadError('Laden fehlgeschlagen. Bitte versuche es erneut.'))
      .finally(() => setThreadLoading(false))
  }

  // ── Header labels ──────────────────────────────────────────────────────────

  // In cutover mode the legacy `groupThread.threadType` may be null because the
  // legacy cache is unpopulated. Source the title from the resolved
  // `threadType` (which itself reads chatThreadFromUrl in cutover mode).
  const title = isEinsatzThread
    ? (entry?.title ?? '—')
    : threadType === 'team'
      ? 'Team'
      : 'Büro'

  const subtitle = isEinsatzThread ? (entry?.customerName ?? '—') : 'Internes Team'

  // Show the loading spinner (instead of the empty-state "Noch keine
  // Nachrichten") while chat-domain is still hydrating in cutover mode.
  // Otherwise the user briefly sees a misleading empty-state on cold start.
  const showLoadingState = threadLoading || !chatHydrated

  return (
    <AppShell hideBottomNav immersive>
      <div className="flex flex-col h-[100svh]">

        {/* Header */}
        <div className="shrink-0 bg-white/95 backdrop-blur-sm border-b border-slate-100 pt-[env(safe-area-inset-top)]">
          <div className="flex items-center gap-3 px-4 py-3">
            <button
              type="button"
              onClick={goBack}
              className="flex items-center gap-0.5 text-blue-500 -ml-1 shrink-0"
            >
              <ArrowLeft size={18} />
              <span className="text-[14px] font-medium">Nachrichten</span>
            </button>

            <div className="flex-1 min-w-0 text-center">
              <div className="text-[15px] font-semibold text-slate-900 truncate leading-tight">
                {title}
              </div>
              <div className="text-[12px] text-slate-400 truncate leading-tight mt-px">
                {subtitle}
              </div>
            </div>

            <div className="shrink-0 w-[88px]" />
          </div>
        </div>

        {/* Context block */}
        <div className="shrink-0">
          <ContextBlock
            threadType={threadType}
            entry={entry}
            onJobLink={
              entry?.jobId
                ? () => navigate(`/craftsman/jobs/${entry.jobId}`)
                : undefined
            }
          />
        </div>

        {/* Messages */}
        <div ref={messagesScrollRef} className="flex-1 overflow-y-auto px-4 py-4 bg-slate-50/30">
          {showLoadingState && (
            <div className="flex items-center justify-center h-full">
              <p className="text-[13px] text-slate-400">Wird geladen …</p>
            </div>
          )}

          {!showLoadingState && threadError && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <p className="text-[13px] text-slate-400 text-center leading-relaxed">
                {threadError}
              </p>
              <button
                type="button"
                onClick={handleRetry}
                className="text-[13px] text-blue-500 font-medium"
              >
                Erneut versuchen
              </button>
            </div>
          )}

          {!showLoadingState && !threadError && messagesLength === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-[13px] text-slate-400 text-center leading-relaxed">
                Noch keine Nachrichten.<br />
                <span className="text-slate-300">Schreib die erste Nachricht.</span>
              </p>
            </div>
          )}

          {!showLoadingState && !threadError && messagesLength > 0 && (
            <>
              {chatMessages.map((msg) => {
                // Keys use clientMessageId — stable across the optimistic
                // temp_→server-id swap. Keying on msg.id remounted every
                // sent bubble on the realtime echo.
                if (msg.messageType === 'system') {
                  return (
                    <SystemMessageBubble
                      key={msg.clientMessageId ?? msg.id}
                      body={msg.body ?? ''}
                      createdAt={msg.createdAt}
                    />
                  )
                }
                return (
                  <ChatBubble
                    key={msg.clientMessageId ?? msg.id}
                    body={msg.body}
                    createdAt={msg.createdAt}
                    status={msg.status}
                    isOwnBubble={currentUserId !== null && msg.senderUserId === currentUserId}
                    senderName={msg.sender.displayName ?? undefined}
                    showSenderName
                    messageType={msg.messageType}
                  />
                )
              })}
            </>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-slate-100 bg-white px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          {sendError && (
            <p className="mb-2 text-[12px] text-red-500 text-center">
              Nachricht konnte nicht gesendet werden. Bitte versuche es erneut.
            </p>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={activeThreadId === null || sending}
              placeholder={
                activeThreadId === null
                  ? threadLoading
                    ? 'Wird verbunden …'
                    : threadError
                      ? 'Nicht verfügbar.'
                      : 'Wird verbunden …'
                  : 'Nachricht …'
              }
              className="flex-1 bg-slate-100/50 rounded-full px-4 py-2.5 text-[14px] placeholder:text-slate-400 outline-none min-w-0 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSubmit}
              className="h-9 w-9 rounded-full bg-blue-500 flex items-center justify-center shrink-0 disabled:opacity-30 transition-opacity"
            >
              {sending ? (
                <Spinner size="sm" tone="onDark" inButton />
              ) : (
                <Send size={15} className="text-white" style={{ transform: 'translateX(1px)' }} />
              )}
            </button>
          </div>
        </div>

      </div>
    </AppShell>
  )
}
