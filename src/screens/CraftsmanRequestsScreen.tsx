import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Inbox } from 'lucide-react'
import AppShell from '../components/AppShell'
import { ScreenHeader } from '../components/primitives'
import CraftsmanRequestInboxSection from '../components/messages/CraftsmanRequestInboxSection'
import ScreenEmpty from '../components/system/ScreenEmpty'
import {
  getIncomingProjectRequests,
  type IncomingRequestItem,
  type IncomingRequestSort,
} from '../lib/messages'
import { getChatRepository, isChatCutoverEnabled } from '../lib/chat'
import { getIncomingProjectRequestsFromChat } from '../lib/chat/requestInboxSelectors'
import { subscribeJobs } from '../lib/jobs'
import { declineRequestWorkflow } from '../lib/workflow'
import { useSmartBack } from '../hooks/useSmartBack'

const SORT_OPTIONS: { id: IncomingRequestSort; label: string }[] = [
  { id: 'newest', label: 'Neueste' },
  { id: 'quality', label: 'Qualität' },
]

/**
 * Dedicated craftsman screen for triaging incoming project requests.
 *
 * Accessible from the backoffice hub under "Anfragen". Shows all open
 * requests grouped by triage status (new, needs response, in conversation)
 * so craftsmen can quickly decide what to act on next. A sort selector
 * reorders within each group by recency or intrinsic quality score.
 */
export default function CraftsmanRequestsScreen() {
  const goBack = useSmartBack('/craftsman/backoffice')
  // Chat-Cutover Slice D: read requests from the chat domain when the
  // craftsman cutover is active. The flag only changes via reload, so
  // resolving it once per render is safe.
  const chatCutover = isChatCutoverEnabled('craftsman')
  const [requests, setRequests] = useState<IncomingRequestItem[]>(() =>
    chatCutover ? getIncomingProjectRequestsFromChat() : getIncomingProjectRequests(),
  )
  const [sortBy, setSortBy] = useState<IncomingRequestSort>('newest')
  useEffect(() => {
    const refresh = () =>
      setRequests(
        chatCutover ? getIncomingProjectRequestsFromChat() : getIncomingProjectRequests(),
      )
    const unsubMessages = getChatRepository().subscribe(refresh)
    const unsubJobs = subscribeJobs(refresh)
    return () => {
      unsubMessages()
      unsubJobs()
    }
  }, [chatCutover])

  const handleDecline = useCallback((threadId: string) => {
    declineRequestWorkflow(threadId)
  }, [])

  return (
    <AppShell active="verwaltung">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-5">
          <button
            type="button"
            onClick={goBack}
            aria-label="Zurück"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
          >
            <ArrowLeft size={18} className="text-ink" aria-hidden />
          </button>
          <ScreenHeader
            eyebrow="Verwaltung"
            title="Anfragen"
            action={
              requests.length > 0 ? (
                <span className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-brand px-2 text-[12px] font-bold text-white">
                  {requests.length}
                </span>
              ) : null
            }
          />

          {requests.length === 0 ? (
            <ScreenEmpty
              icon={<Inbox size={32} className="text-ink-muted" aria-hidden />}
              title="Keine offenen Anfragen"
              description="Sobald Kunden Kontakt aufnehmen, erscheinen ihre Anfragen hier."
            />
          ) : (
            <>
              <div className="flex gap-2" role="radiogroup" aria-label="Sortierung">
                {SORT_OPTIONS.map((opt) => {
                  const active = sortBy === opt.id
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setSortBy(opt.id)}
                      className={[
                        'rounded-full px-3.5 py-1.5 text-[13px] font-semibold ring-1 transition active:scale-[0.97]',
                        active
                          ? 'bg-slate-900 text-white ring-slate-900'
                          : 'bg-white text-slate-600 ring-slate-200',
                      ].join(' ')}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>

              <CraftsmanRequestInboxSection
                requests={requests}
                detailBasePath="/craftsman/messages"
                onDecline={handleDecline}
                sortBy={sortBy}
              />
            </>
          )}
        </div>
      </section>
    </AppShell>
  )
}
