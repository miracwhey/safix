import { useMemo, useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CreditCard, Settings, Search, X, Hammer, MessageSquare } from 'lucide-react'
import AppShell from '../components/AppShell'
import ContentSection from '../components/primitives/ContentSection'
import DisputeResolutionCard from '../components/disputes/DisputeResolutionCard'
import ConsensusSplitSlot from '../components/disputes/ConsensusSplitSlot'

import {
  getActiveDisputeCenterItems,
  getResolvedDisputeCenterItems,
  getDisputes,
  subscribeDisputes,
  isDisputeRepositoryHydrated,
  type Dispute,
} from '../lib/disputes'

import {
  getArtifactsByDisputeId,
  getArtifactViewModels,
  subscribeMedia,
} from '../lib/media'

import {
  resolveDisputeReleaseWorkflow,
  resolveDisputeRefundWorkflow,
  resolveDisputeWorkflow,
  requestCustomerEvidenceWorkflow,
  requestProviderEvidenceWorkflow,
  markDisputeUnderReviewWorkflow,
  rejectDisputeWorkflow,
} from '../lib/workflow'
import { useStoreSubscriptions } from '../lib/reactive'
import { canAccessDisputeResolution } from '../lib/access'
import { useSession } from '../hooks/useSession'
import {
  getAllPayments,
  subscribePayments,
  formatEuro,
  isPaymentEscrowProtected,
} from '../lib/payments'
import type { Payment } from '../lib/payments'
import {
  searchDisputeCenterItems,
  filterDisputeItems,
  type DisputeUrgencyFilter,
} from '../lib/disputes/searchSelectors'
import { resolveCanonicalAmount } from '../lib/shared/canonicalAmountResolver'
import { getOrCreateChatDisputeThread } from '../lib/chat/service'
import ScreenSkeleton from '../components/system/ScreenSkeleton'

function DisputeAdminActions({
  dispute,
  operatorId,
}: {
  dispute: Dispute
  operatorId?: string
}) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const { status, jobId } = dispute

  const run = async (action: () => unknown) => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
    } catch (e) {
      console.error(e)
      setActionError('Aktion fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  if (status === 'open') {
    return (
      <div className="mt-3 border-t border-edge pt-3">
        <div className="flex flex-wrap gap-2">
          <button
            disabled={busy}
            onClick={() => run(() => requestCustomerEvidenceWorkflow(jobId, operatorId))}
            className="rounded-card bg-orange-50 px-3 py-2 text-[12px] font-semibold text-orange-700 ring-1 ring-orange-200 transition active:scale-[0.97] disabled:opacity-60"
          >
            Vom Kunden anfordern
          </button>
          <button
            disabled={busy}
            onClick={() => run(() => requestProviderEvidenceWorkflow(jobId, operatorId))}
            className="rounded-card bg-orange-50 px-3 py-2 text-[12px] font-semibold text-orange-700 ring-1 ring-orange-200 transition active:scale-[0.97] disabled:opacity-60"
          >
            Vom Anbieter anfordern
          </button>
          <button
            disabled={busy}
            onClick={() => run(() => markDisputeUnderReviewWorkflow(jobId))}
            className="rounded-card bg-blue-50 px-3 py-2 text-[12px] font-semibold text-blue-700 ring-1 ring-blue-200 transition active:scale-[0.97] disabled:opacity-60"
          >
            In Prüfung setzen
          </button>
        </div>
        {actionError && (
          <p className="mt-1.5 text-[12px] text-red-500">{actionError}</p>
        )}
      </div>
    )
  }

  if (status === 'customer_waiting' || status === 'provider_waiting') {
    return (
      <div className="mt-3 border-t border-edge pt-3">
        <p className="mb-2 text-[12px] text-orange-600">
          {status === 'customer_waiting'
            ? 'Belege wurden vom Kunden angefordert – Prüfung kann beginnen, sobald eingereicht.'
            : 'Belege wurden vom Anbieter angefordert – Prüfung kann beginnen, sobald eingereicht.'}
        </p>
        <button
          disabled={busy}
          onClick={() => run(() => markDisputeUnderReviewWorkflow(jobId))}
          className="rounded-card bg-blue-50 px-3 py-2 text-[12px] font-semibold text-blue-700 ring-1 ring-blue-200 transition active:scale-[0.97] disabled:opacity-60"
        >
          In Prüfung setzen
        </button>
        {actionError && (
          <p className="mt-1.5 text-[12px] text-red-500">{actionError}</p>
        )}
      </div>
    )
  }

  if (status === 'under_review') {
    return (
      <div className="mt-3 border-t border-slate-100 pt-3">
        <p className="mb-2 text-[12px] text-blue-600">
          In Prüfung – Entscheidung über Auflösung oder Ablehnung steht aus.
        </p>
        <button
          disabled={busy}
          onClick={() => run(() => rejectDisputeWorkflow(jobId, operatorId))}
          className="rounded-xl bg-slate-100 px-3 py-2 text-[12px] font-semibold text-slate-600 ring-1 ring-slate-200 transition active:scale-[0.97] disabled:opacity-60"
        >
          Ablehnen
        </button>
        {actionError && (
          <p className="mt-1.5 text-[12px] text-red-500">{actionError}</p>
        )}
      </div>
    )
  }

  // Terminal dispute with pending settlement — the decision was persisted
  // but the financial action (release/refund/split) has not yet completed.
  // Offer the operator a retry button that re-invokes the same workflow
  // (which skips decision persist and goes straight to money action).
  if (dispute.settlementStatus === 'pending') {
    const retryAction = () => {
      return resolveDisputeWorkflow(dispute.id, dispute.decision ?? 'release', dispute.splitRatio, operatorId)
    }

    const decisionLabels: Record<string, string> = {
      release: 'Freigabe',
      refund: 'Erstattung',
      split: 'Aufteilung',
      reject: 'Ablehnung',
    }
    const label = decisionLabels[dispute.decision ?? ''] ?? 'Abwicklung'

    return (
      <div className="mt-3 border-t border-amber-200 pt-3">
        <p className="mb-2 text-[12px] font-medium text-amber-700">
          Entscheidung getroffen, Zahlung ausstehend — {label} erneut versuchen.
        </p>
        <button
          disabled={busy}
          onClick={() => run(retryAction)}
          className="rounded-card bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-800 ring-1 ring-amber-300 transition active:scale-[0.97] disabled:opacity-60"
          data-testid="settlement-retry"
        >
          {busy ? 'Wird verarbeitet …' : `${label} erneut versuchen`}
        </button>
        {actionError && (
          <p className="mt-1.5 text-[12px] text-red-500">{actionError}</p>
        )}
      </div>
    )
  }

  return null
}

// Maximum resolved disputes shown before the "show more" toggle appears.
const RESOLVED_DISPUTES_INITIAL = 8

export default function DisputeCenterScreen() {
  const disputesReady = isDisputeRepositoryHydrated()
  const session = useSession()
  const navigate = useNavigate()
  const adminAccess = canAccessDisputeResolution(session)
  const [disputes, setDisputes] = useState<Dispute[]>(getDisputes())
  const [payments, setPayments] = useState<Payment[]>(() => getAllPayments())
  const [, setMediaVersion] = useState(0)
  const [resolvingJobId, setResolvingJobId] = useState<string | null>(null)
  const [resolveErrors, setResolveErrors] = useState<Record<string, string>>({})
  const [showAllResolved, setShowAllResolved] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [urgencyFilter, setUrgencyFilter] = useState<DisputeUrgencyFilter | null>(null)
  const [chatBusyId, setChatBusyId] = useState<string | null>(null)

  useStoreSubscriptions([
    {
      subscribe: subscribeDisputes,
      onChange: () => setDisputes(getDisputes()),
    },
    {
      subscribe: subscribeMedia,
      onChange: () => setMediaVersion((v) => v + 1),
    },
    {
      subscribe: subscribePayments,
      onChange: () => setPayments(getAllPayments()),
    },
  ])

  const allActiveItems = useMemo(() => getActiveDisputeCenterItems(disputes), [disputes])
  const activeItems = useMemo(
    () => searchDisputeCenterItems(searchQuery, filterDisputeItems(urgencyFilter, allActiveItems)),
    [allActiveItems, searchQuery, urgencyFilter]
  )
  const resolvedItems = useMemo(
    () => searchDisputeCenterItems(searchQuery, getResolvedDisputeCenterItems(disputes)),
    [disputes, searchQuery]
  )

  useEffect(() => {
    setShowAllResolved(false)
  }, [searchQuery, urgencyFilter])

  const visibleResolvedItems = showAllResolved
    ? resolvedItems
    : resolvedItems.slice(0, RESOLVED_DISPUTES_INITIAL)
  const hiddenResolvedCount = resolvedItems.length - visibleResolvedItems.length
  const frozenTotal = useMemo(() => {
    const activeJobIds = new Set(activeItems.map((item) => item.jobId))
    return payments
      .filter((p) => isPaymentEscrowProtected(p.state) && activeJobIds.has(p.jobId))
      .reduce((sum, p) => sum + (resolveCanonicalAmount(p.jobId).amount ?? 0), 0)
  }, [payments, activeItems])

  const urgencyCounts = useMemo(() => {
    const critical = allActiveItems.filter((i) => i.urgencyLevel === 'critical').length
    const elevated = allActiveItems.filter((i) => i.urgencyLevel === 'elevated').length
    return { critical, elevated }
  }, [allActiveItems])

  const unsettledCount = useMemo(
    () => resolvedItems.filter((i) => i.dispute.settlementStatus === 'pending').length,
    [resolvedItems]
  )

  const handleRelease = async (jobId: string) => {
    setResolvingJobId(jobId)
    setResolveErrors((prev) => ({ ...prev, [jobId]: '' }))
    try {
      await resolveDisputeReleaseWorkflow(jobId, session.user?.id)
    } catch (e) {
      console.error(e)
      setResolveErrors((prev) => ({ ...prev, [jobId]: 'Freigabe fehlgeschlagen' }))
    } finally {
      setResolvingJobId(null)
    }
  }

  const handleRefund = async (jobId: string) => {
    setResolvingJobId(jobId)
    setResolveErrors((prev) => ({ ...prev, [jobId]: '' }))
    try {
      await resolveDisputeRefundWorkflow(jobId, session.user?.id)
    } catch (e) {
      console.error(e)
      setResolveErrors((prev) => ({ ...prev, [jobId]: 'Erstattung fehlgeschlagen' }))
    } finally {
      setResolvingJobId(null)
    }
  }

  const handleSplit = async (jobId: string, disputeId: string, ratio: number) => {
    setResolvingJobId(jobId)
    setResolveErrors((prev) => ({ ...prev, [jobId]: '' }))
    try {
      await resolveDisputeWorkflow(disputeId, 'split', ratio, session.user?.id)
    } catch (e) {
      console.error(e)
      setResolveErrors((prev) => ({ ...prev, [jobId]: 'Aufteilung fehlgeschlagen' }))
    } finally {
      setResolvingJobId(null)
    }
  }

  const handleOpenDisputeChat = async (disputeId: string) => {
    if (chatBusyId) return
    setChatBusyId(disputeId)
    try {
      const threadId = await getOrCreateChatDisputeThread(disputeId)
      navigate(`/craftsman/messages/${threadId}?backPath=${encodeURIComponent('/craftsman/disputes')}`)
    } catch {
      // thread creation failed — re-enable button silently (error visible in service log)
    } finally {
      setChatBusyId(null)
    }
  }

  if (!disputesReady) {
    return (
      <AppShell active="home">
        <ScreenSkeleton variant="list" />
      </AppShell>
    )
  }

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          {/* ── Header: stats + operator quick-links ── */}
          <ContentSection eyebrow="SaFix" title="Dispute Center">
            <div className="flex gap-3">
              <div className="flex-1 rounded-card bg-slate-50 px-3 py-2.5 text-center ring-1 ring-edge">
                <div className="text-[20px] font-semibold text-ink">
                  {activeItems.length}
                </div>
                <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                  Aktiv
                </div>
              </div>
              <div className="flex-1 rounded-card bg-slate-50 px-3 py-2.5 text-center ring-1 ring-edge">
                <div className="text-[20px] font-semibold text-ink">
                  {resolvedItems.length}
                </div>
                <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                  Abgeschlossen
                </div>
              </div>
              {frozenTotal > 0 && (
                <div className="flex-1 rounded-card bg-amber-50 px-3 py-2.5 text-center ring-1 ring-amber-200/70">
                  <div className="text-[18px] font-semibold text-amber-800">
                    {formatEuro(frozenTotal)}
                  </div>
                  <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-amber-600">
                    Eingefroren
                  </div>
                </div>
              )}
              {unsettledCount > 0 && (
                <div className="flex-1 rounded-card bg-red-50 px-3 py-2.5 text-center ring-1 ring-red-200/70">
                  <div className="text-[20px] font-semibold text-red-800">
                    {unsettledCount}
                  </div>
                  <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-red-600">
                    Unsettled
                  </div>
                </div>
              )}
            </div>

            {/* Operator quick-links */}
            <div className="mt-3 flex flex-wrap gap-2 border-t border-edge pt-3">
              <Link
                to="/craftsman/finance"
                className="inline-flex items-center gap-1.5 rounded-chip bg-blue-50 px-3 py-1.5 text-[12px] font-semibold text-blue-700 ring-1 ring-blue-200 transition active:scale-[0.97]"
              >
                <CreditCard size={13} aria-hidden />
                <span>Finanzen</span>
              </Link>
              <Link
                to="/craftsman/operator"
                className="inline-flex items-center gap-1.5 rounded-chip bg-slate-50 px-3 py-1.5 text-[12px] font-semibold text-ink-sub ring-1 ring-edge transition active:scale-[0.97]"
              >
                <Settings size={13} aria-hidden />
                <span>Operator Dashboard</span>
              </Link>
            </div>
          </ContentSection>

          {/* ── Search bar ── */}
          <div className="flex items-center gap-3 rounded-container bg-surface px-4 py-3 ring-1 ring-edge shadow-subtle">
            <Search size={16} className="shrink-0 text-ink-muted" aria-hidden />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Streitfälle durchsuchen"
              aria-label="Streitfälle durchsuchen"
              className="flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="text-ink-muted transition hover:text-ink"
                aria-label="Suche löschen"
              >
                <X size={14} aria-hidden />
              </button>
            )}
          </div>

          {/* ── Urgency quick filters ── */}
          {allActiveItems.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Dringlichkeits-Filter">
              {([null, 'critical', 'elevated', 'normal'] as const).map((u) => {
                const active = urgencyFilter === u
                const urgencyLabels: Record<string, string> = { critical: 'Kritisch', elevated: 'Erhöht', normal: 'Normal' }
                const label = u === null ? 'Alle' : urgencyLabels[u]
                const urgencyActiveColors: Record<string, string> = {
                  critical: 'bg-rose-600 text-white ring-rose-600',
                  elevated: 'bg-amber-500 text-white ring-amber-500',
                  normal: 'bg-slate-500 text-white ring-slate-500',
                }
                const colorActive = u === null ? 'bg-ink text-white ring-ink' : (urgencyActiveColors[u] ?? 'bg-ink text-white ring-ink')
                const colorIdle = 'bg-surface text-ink-sub ring-edge'
                return (
                  <button
                    key={u ?? 'all'}
                    onClick={() => setUrgencyFilter(u)}
                    className={`rounded-chip px-3 py-1 text-[12px] font-semibold ring-1 transition active:scale-[0.97] ${active ? colorActive : colorIdle}`}
                    aria-pressed={active}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}

          {/* ── Urgency health banner ── */}
          {activeItems.length > 0 && (urgencyCounts.critical > 0 || urgencyCounts.elevated > 0) && (
            <div className={`rounded-container p-4 ring-1 ${urgencyCounts.critical > 0 ? 'bg-rose-50 ring-rose-200/80' : 'bg-amber-50 ring-amber-200/70'}`}>
              <div className={`text-[12px] font-semibold uppercase tracking-[0.14em] ${urgencyCounts.critical > 0 ? 'text-rose-600' : 'text-amber-600'}`}>
                {urgencyCounts.critical > 0 ? 'Sofortiger Handlungsbedarf' : 'Priorisierung empfohlen'}
              </div>
              <div className={`mt-1 text-[14px] font-semibold ${urgencyCounts.critical > 0 ? 'text-rose-900' : 'text-amber-900'}`}>
                {urgencyCounts.critical > 0
                  ? `${urgencyCounts.critical} ${urgencyCounts.critical === 1 ? 'Fall' : 'Fälle'} warten auf Belege`
                  : `${urgencyCounts.elevated} ${urgencyCounts.elevated === 1 ? 'Fall' : 'Fälle'} seit mehr als 3 Tagen offen`}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {urgencyCounts.critical > 0 && (
                  <span className="rounded-chip bg-rose-100 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200">
                    {urgencyCounts.critical} kritisch
                  </span>
                )}
                {urgencyCounts.elevated > 0 && (
                  <span className="rounded-chip bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
                    {urgencyCounts.elevated} erhöht
                  </span>
                )}
                {frozenTotal > 0 && (
                  <span className="rounded-chip bg-surface px-2.5 py-0.5 text-[11px] font-semibold text-ink-sub ring-1 ring-edge">
                    {formatEuro(frozenTotal)} eingefroren
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── Empty state ── */}
          {activeItems.length === 0 && resolvedItems.length === 0 ? (
            (searchQuery.trim().length > 0 || urgencyFilter !== null) ? (
              <div className="rounded-container bg-surface p-4 text-center ring-1 ring-edge">
                <div className="flex justify-center">
                  <Search size={28} className="text-ink-muted" aria-hidden />
                </div>
                <div className="mt-2 text-[14px] font-semibold text-ink">Keine Ergebnisse</div>
                <div className="mt-1 text-[13px] text-ink-muted">
                  {searchQuery
                    ? `Keine Streitfälle für „${searchQuery}" gefunden.`
                    : 'Keine Streitfälle mit dem gewählten Filter gefunden.'}
                </div>
              </div>
            ) : (
              <div className="rounded-container bg-surface p-4 text-center ring-1 ring-edge">
                <div className="text-[14px] font-semibold text-ink">Keine Streitfälle</div>
                <div className="mt-1 text-[13px] text-ink-muted">
                  Aktive Konflikte erscheinen hier automatisch.
                </div>
              </div>
            )
          ) : null}

          {/* ── Active disputes ── */}
          {activeItems.length > 0 ? (
            <div className="space-y-3">
              <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                Aktiv ({activeItems.length})
              </div>
              {activeItems.map((item) => (
                <div key={item.id}>
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <span className="text-[12px] text-ink-muted">{item.ageLabel}</span>
                    <div className="flex items-center gap-2">
                      {item.urgencyLevel === 'critical' && (
                        <span className="rounded-chip bg-orange-100 px-2.5 py-0.5 text-[11px] font-semibold text-orange-700 ring-1 ring-orange-200/60">
                          Sofort: Belege anfordern
                        </span>
                      )}
                      {item.urgencyLevel === 'elevated' && (
                        <span className="rounded-chip bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200/60">
                          Priorisieren
                        </span>
                      )}
                      <Link
                        to={`/craftsman/jobs/${item.jobId}`}
                        className="inline-flex items-center gap-1 rounded-chip bg-surface px-2.5 py-0.5 text-[11px] font-semibold text-ink-sub ring-1 ring-edge transition active:scale-[0.97]"
                      >
                        <Hammer size={11} aria-hidden />
                        <span>Auftrag ansehen</span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => void handleOpenDisputeChat(item.dispute.id)}
                        disabled={chatBusyId === item.dispute.id}
                        className="inline-flex items-center gap-1 rounded-chip bg-surface px-2.5 py-0.5 text-[11px] font-semibold text-ink-sub ring-1 ring-edge transition active:scale-[0.97] disabled:opacity-50"
                      >
                        <MessageSquare size={11} aria-hidden />
                        <span>{chatBusyId === item.dispute.id ? '…' : 'Chat'}</span>
                      </button>
                    </div>
                  </div>
                  <DisputeResolutionCard
                    item={item}
                    evidenceArtifacts={getArtifactViewModels(
                      getArtifactsByDisputeId(item.dispute.id)
                    )}
                    role={adminAccess ? 'admin' : 'craftsman'}
                    onRelease={adminAccess && resolvingJobId !== item.dispute.jobId ? () => handleRelease(item.dispute.jobId) : undefined}
                    onRefund={adminAccess && resolvingJobId !== item.dispute.jobId ? () => handleRefund(item.dispute.jobId) : undefined}
                    onSplit={adminAccess && resolvingJobId !== item.dispute.jobId ? (ratio) => handleSplit(item.dispute.jobId, item.dispute.id, ratio) : undefined}
                    ownerUserId={session.user?.id}
                    consensusSlot={
                      <ConsensusSplitSlot
                        dispute={item.dispute}
                        jobId={item.jobId}
                        currentUserId={session.user?.id}
                        isParty={!adminAccess && session.role === 'craftsman' && session.craftsmanRole === 'owner'}
                      />
                    }
                  />
                  {resolveErrors[item.dispute.jobId] && (
                    <p className="mt-2 text-[12px] leading-relaxed text-red-500">
                      {resolveErrors[item.dispute.jobId]}
                    </p>
                  )}
                  {adminAccess && (
                    <DisputeAdminActions
                      dispute={item.dispute}
                      operatorId={session.user?.id}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {/* ── Resolved disputes ── */}
          {resolvedItems.length > 0 ? (
            <div className="space-y-3">
              <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                Abgeschlossen ({resolvedItems.length})
              </div>
              {visibleResolvedItems.map((item) => (
                <div key={item.id}>
                  <div className="mb-1 flex items-center justify-between">
                    {item.dispute.settlementStatus === 'settled' ? (
                      <span className="rounded-chip bg-green-50 px-2.5 py-0.5 text-[11px] font-semibold text-green-700 ring-1 ring-green-200">
                        Abgewickelt
                      </span>
                    ) : item.dispute.settlementStatus === 'pending' ? (
                      <span className="rounded-chip bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
                        Zahlung ausstehend
                      </span>
                    ) : (
                      <span />
                    )}
                    <Link
                      to={`/craftsman/jobs/${item.jobId}`}
                      className="inline-flex items-center gap-1 rounded-chip bg-surface px-2.5 py-0.5 text-[11px] font-semibold text-ink-sub ring-1 ring-edge transition active:scale-[0.97]"
                    >
                      <Hammer size={11} aria-hidden />
                      <span>Auftrag ansehen</span>
                    </Link>
                  </div>
                  <DisputeResolutionCard
                    item={item}
                    evidenceArtifacts={getArtifactViewModels(
                      getArtifactsByDisputeId(item.dispute.id)
                    )}
                    role={adminAccess ? 'admin' : 'craftsman'}
                  />
                  {adminAccess && item.dispute.settlementStatus === 'pending' && (
                    <DisputeAdminActions
                      dispute={item.dispute}
                      operatorId={session.user?.id}
                    />
                  )}
                </div>
              ))}
              {hiddenResolvedCount > 0 && (
                <button
                  onClick={() => setShowAllResolved(true)}
                  className="w-full rounded-card bg-slate-50 px-4 py-3 text-[13px] font-semibold text-ink-sub ring-1 ring-edge transition active:bg-slate-100"
                >
                  Weitere anzeigen ({hiddenResolvedCount} weitere)
                </button>
              )}
            </div>
          ) : null}
        </div>
      </section>
    </AppShell>
  )
}
