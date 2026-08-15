import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, ArrowLeft } from 'lucide-react'
import AppShell from '../components/AppShell'
import ContentSection from '../components/primitives/ContentSection'
import NotificationItem from '../components/notifications/NotificationItem'
import AttentionBanner from '../components/notifications/AttentionBanner'
import InAppNotificationFeed from '../components/notifications/InAppNotificationFeed'
import {
  subscribeNotifications,
  getNotificationSignals,
  getUnreadNotificationSignals,
  markNotificationRead,
  markAllNotificationsRead,
  buildNotificationItemsForRole,
  groupNotificationsByPriority,
  deriveAttentionItems,
  buildAttentionSummary,
} from '../lib/notifications'
import type { NotificationItem as NotificationItemType } from '../lib/notifications'
import {
  getJobs,
  subscribeJobs,
  type Job,
} from '../lib/jobs'
import {
  getDisputes,
  subscribeDisputes,
  type Dispute,
} from '../lib/disputes'
import { subscribePayments } from '../lib/payments'
import { subscribeFundingRequests } from '../lib/payments/fundingRequest'
import { subscribeEscrowPlans } from '../lib/payments/escrow'
import {
  subscribeInAppNotifications,
  getUnreadInAppNotificationCount,
  markAllInAppNotificationsRead,
} from '../lib/inAppNotifications'
import { useSession } from '../hooks/useSession'
import { useSmartBack } from '../hooks/useSmartBack'
import type { AttentionRole } from '../lib/notifications'

export default function NotificationCenterScreen() {
  const session = useSession()
  const role: AttentionRole = (session.role as AttentionRole) ?? 'craftsman'
  const goBack = useSmartBack('/')

  const [items, setItems] = useState<NotificationItemType[]>(() =>
    buildNotificationItemsForRole(getNotificationSignals(), role)
  )
  const [signalUnreadCount, setSignalUnreadCount] = useState<number>(
    () => getUnreadNotificationSignals().length
  )
  const [inAppUnreadCount, setInAppUnreadCount] = useState<number>(
    () => getUnreadInAppNotificationCount()
  )
  const [jobs, setJobs] = useState<Job[]>(getJobs())
  const [disputes, setDisputes] = useState<Dispute[]>(getDisputes())
  // Tick-counter bumped whenever payment, funding, or escrow truth changes
  // (including their initial hydration). deriveAttentionItems reads canonical
  // payment state behind a hydration guard — without this tick the attention
  // banner would stay empty after cold-start hydration until an unrelated
  // job/dispute event re-ran the memo.
  const [paymentsTick, setPaymentsTick] = useState(0)
  const userId = session.user?.id

  useEffect(() => {
    // Re-read all state immediately on user or role change so stale counts/items
    // from the previous user are flushed before subscriptions fire callbacks.
    function readAll() {
      setItems(buildNotificationItemsForRole(getNotificationSignals(), role))
      setSignalUnreadCount(getUnreadNotificationSignals().length)
      setInAppUnreadCount(getUnreadInAppNotificationCount())
      setJobs(getJobs())
      setDisputes(getDisputes())
      setPaymentsTick((t) => t + 1)
    }
    readAll()

    const unsubNotif = subscribeNotifications(() => {
      setItems(buildNotificationItemsForRole(getNotificationSignals(), role))
      setSignalUnreadCount(getUnreadNotificationSignals().length)
    })
    const unsubInApp = subscribeInAppNotifications(() => {
      setInAppUnreadCount(getUnreadInAppNotificationCount())
    })
    const unsubJobs = subscribeJobs(() => setJobs(getJobs()))
    const unsubDisputes = subscribeDisputes(() => setDisputes(getDisputes()))
    const bumpPayments = () => setPaymentsTick((t) => t + 1)
    const unsubPayments = subscribePayments(bumpPayments)
    const unsubFunding = subscribeFundingRequests(bumpPayments)
    const unsubEscrow = subscribeEscrowPlans(bumpPayments)

    return () => {
      unsubNotif()
      unsubInApp()
      unsubJobs()
      unsubDisputes()
      unsubPayments()
      unsubFunding()
      unsubEscrow()
    }
  }, [role, userId])

  const totalUnreadCount = signalUnreadCount + inAppUnreadCount

  function markAllRead() {
    markAllNotificationsRead()
    if (userId) {
      markAllInAppNotificationsRead(userId)
    }
  }

  const attentionSummary = useMemo(() => {
    const allItems = deriveAttentionItems(jobs, disputes)
    return buildAttentionSummary(allItems, role)
    // paymentsTick triggers recomputation once payment / funding / escrow
    // repositories hydrate. deriveAttentionItems reads canonical payment
    // state and is gated on hydration inside the selector; without this
    // dep the banner would miss payment-critical items on cold start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, disputes, role, paymentsTick])

  const { alerts, actions, infos } = useMemo(
    () => groupNotificationsByPriority(items),
    [items]
  )

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          {/* ── Header ── */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <button type="button" onClick={goBack} aria-label="Zurück" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"><ArrowLeft size={18} className="text-ink" aria-hidden /></button>
              <div>
                <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
                  System
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <h1 className="text-[26px] font-semibold text-ink">
                    Benachrichtigungen
                  </h1>
                  {totalUnreadCount > 0 && (
                    <span className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-chip bg-brand px-2 text-[12px] font-bold text-white">
                      {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {totalUnreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="rounded-chip bg-brand px-4 py-2 text-[13px] font-semibold text-white shadow-elevated hover:opacity-90 transition active:scale-[0.97]"
              >
                Alle gelesen
              </button>
            )}
          </div>

          {/* ── Attention banner ── */}
          {attentionSummary.totalCount > 0 && (
            <ContentSection eyebrow="Aufmerksamkeit" title="Handlungsbedarf">
              <AttentionBanner summary={attentionSummary} viewerRole={role} />
            </ContentSection>
          )}

          {/* ── Empty state ── */}
          {items.length === 0 && attentionSummary.totalCount === 0 && (
            <div className="flex flex-col items-center justify-center rounded-container bg-surface py-12 text-center ring-1 ring-edge shadow-elevated">
              <Bell size={36} className="text-ink-muted" aria-hidden />
              <p className="mt-3 text-[15px] font-semibold text-ink">
                Alles auf dem neuesten Stand
              </p>
              <p className="mt-2 max-w-[260px] text-[13px] leading-relaxed text-ink-muted">
                Hier erscheinen Meldungen zu Aufträgen, Zahlungen, Streitfällen und Kundenanfragen – sobald es Neuigkeiten gibt.
              </p>
              <Link
                to="/craftsman/jobs"
                className="mt-5 rounded-chip bg-brand px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition"
              >
                Zu den Aufträgen
              </Link>
            </div>
          )}

          {/* ── Alert section ── */}
          {alerts.length > 0 && (
            <ContentSection
              eyebrow="Dringend"
              title="Streitfälle & Erstattungen"
              headerRight={
                <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-chip bg-red-100 px-1.5 text-[11px] font-bold text-red-700">
                  {alerts.length}
                </span>
              }
            >
              <div className="space-y-2">
                {alerts.map((item) => (
                  <NotificationItem
                    key={item.id}
                    item={item}
                    onMarkRead={markNotificationRead}
                    role="craftsman"
                  />
                ))}
              </div>
            </ContentSection>
          )}

          {/* ── Action section ── */}
          {actions.length > 0 && (
            <ContentSection
              eyebrow="Handlungsbedarf"
              title="Aktionen erforderlich"
              headerRight={
                <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-chip bg-amber-100 px-1.5 text-[11px] font-bold text-amber-700">
                  {actions.length}
                </span>
              }
            >
              <div className="space-y-2">
                {actions.map((item) => (
                  <NotificationItem
                    key={item.id}
                    item={item}
                    onMarkRead={markNotificationRead}
                    role="craftsman"
                  />
                ))}
              </div>
            </ContentSection>
          )}

          {/* ── Info section ── */}
          {infos.length > 0 && (
            <ContentSection eyebrow="Information" title="Neuigkeiten">
              <div className="space-y-2">
                {infos.map((item) => (
                  <NotificationItem
                    key={item.id}
                    item={item}
                    onMarkRead={markNotificationRead}
                    role="craftsman"
                  />
                ))}
              </div>
            </ContentSection>
          )}

          {/* ── Personal activity feed ── */}
          <section>
            <div className="mb-3 border-t border-edge pt-4">
              <div className="px-1 text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
                Persönliche Aktivitäten
              </div>
            </div>
            <InAppNotificationFeed limit={10} userId={userId} />
          </section>
        </div>
      </section>
    </AppShell>
  )
}
