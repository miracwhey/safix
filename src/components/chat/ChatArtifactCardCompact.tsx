import { useEffect, useState } from 'react'
import type {
  ChatMessageViewModel,
  ChatRole,
} from '../../lib/chat'
import type { Project } from '../../lib/projects'
import {
  ensureProjectLoaded,
  getProjectById,
  subscribeProjects,
} from '../../lib/projects'
import type { Offer, OfferDocumentType } from '../../lib/offers/types'
import {
  getOfferById,
  subscribeOffers,
} from '../../lib/offers/service'
import type { ChangeOrder, ChangeOrderStatus } from '../../lib/changeOrders/types'
import {
  getChangeOrderById,
  subscribeChangeOrders,
  ensureChangeOrderLoaded,
} from '../../lib/changeOrders/service'
import type { Invoice } from '../../lib/invoices/types'
import {
  getInvoiceById,
  subscribeInvoices,
  ensureInvoiceLoaded,
} from '../../lib/invoices/invoiceStore'
import type { FundingRequest } from '../../lib/payments/fundingRequest/types'
import {
  getFundingRequestById,
  subscribeFundingRequests,
} from '../../lib/payments/fundingRequest/index'
// Type-only: the party-scoped artifact projection (thread_artifacts snapshot +
// derived phase) the screen already resolves via getThreadArtifacts. Used as a
// fallback when the recipient store lacks the full entity (RLS scoping /
// 200-row load cap), mirroring ThreadArtifactOfferCard's entity→snapshot
// preference. `import type` is erased at build time — no cross-domain runtime
// module load.
import type {
  ThreadArtifacts,
  OfferPaymentArtifact,
  ProjectArtifact,
  FundingStepArtifact,
  ChangeOrderArtifact,
  OfferPaymentPhase,
  FundingStepPhase,
  OfferSnapshot,
  ProjectSnapshot,
  FundingStepSnapshot,
  ChangeOrderSnapshot,
  InvoiceArtifact,
  InvoiceSnapshot,
} from '../../lib/messages/threadArtifactTypes'
import { getArtifactRoute, isKnownArtifactType } from './chatArtifactRouting'
import { ArtifactCardShell } from './ArtifactCardShell'
import {
  type ArtifactCardView,
  tone,
  formatCents,
  TYPE_LABEL,
  OFFER_DOCTYPE_LABEL,
  PROJECT_STATUS_LABEL,
  OFFER_STATUS_LABEL_BY_PHASE,
  CHANGE_ORDER_STATUS_LABEL,
  FUNDING_STATUS_LABEL,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
} from './artifactCardVocab'
import { formatEuro } from '../../lib/shared/formatters'

/**
 * ChatArtifactCardCompact — in-stream rendering of `artifact_card`-typed chat
 * messages (V5 redesign 2026-06-23: now renders through the shared
 * `ArtifactCardShell`, identical look + vocabulary to the project/quote/funding
 * stream-event cards).
 *
 * Tap navigates to the detail screen via `getArtifactRoute`. The card is a
 * historical event: it shows the artifact's CURRENT state, not the send-time
 * state.
 *
 * Architektur-Regel: NO business logic. State lookups via domain selectors;
 * reactive updates via the domain `subscribe*` hooks; snapshot fallback +
 * lifecycle phase from the party-scoped projection (`getThreadArtifacts`)
 * resolved by the screen and passed in — the component never fetches. Inline
 * actions are NOT rendered; the canonical decision surface is the detail screen.
 *
 * Hydration contract:
 *   1. Full entity loaded  → richest card (live status).
 *   2. Entity missing but party-scoped snapshot present → render from snapshot.
 *   3. Neither, still settling → stable skeleton.
 *   4. Neither, after the skeleton ceiling → clear "nicht verfügbar" state.
 *      The skeleton is NEVER indefinite.
 */

/**
 * Upper bound (ms) on the skeleton placeholder. Once it elapses with neither
 * a full entity nor a snapshot resolved, the card settles into the explicit
 * "nicht verfügbar" state instead of spinning forever. Entity / snapshot that
 * arrive later always take priority over this fallback.
 */
const SKELETON_SETTLE_MS = 4000

function useReactiveProject(projectId: string | undefined): Project | undefined {
  const [project, setProject] = useState<Project | undefined>(() =>
    projectId ? getProjectById(projectId) : undefined,
  )
  useEffect(() => {
    if (!projectId) return
    const sync = () => setProject(getProjectById(projectId))
    const unsubscribe = subscribeProjects(sync)
    queueMicrotask(sync)
    // Recipient (e.g. a craftsman) does not have the customer's project in
    // their owner-scoped cache. Lazy-fetch by id — RLS
    // (projects_select_shared_in_chat_thread) grants the read because the
    // owner attached it to this shared thread. On success the repo notifies →
    // `sync` resolves the card. No-op once cached / if forbidden.
    if (!getProjectById(projectId)) {
      void ensureProjectLoaded(projectId)
    }
    return unsubscribe
  }, [projectId])
  return project
}

function useReactiveOffer(offerId: string | undefined): Offer | undefined {
  const [offer, setOffer] = useState<Offer | undefined>(() =>
    offerId ? getOfferById(offerId) : undefined,
  )
  useEffect(() => {
    if (!offerId) return
    const sync = () => setOffer(getOfferById(offerId))
    const unsubscribe = subscribeOffers(sync)
    queueMicrotask(sync)
    return unsubscribe
  }, [offerId])
  return offer
}

function useReactiveChangeOrder(id: string | undefined): ChangeOrder | undefined {
  const [co, setCo] = useState<ChangeOrder | undefined>(() =>
    id ? getChangeOrderById(id) : undefined,
  )
  useEffect(() => {
    if (!id) return
    const sync = () => setCo(getChangeOrderById(id))
    const unsubscribe = subscribeChangeOrders(sync)
    queueMicrotask(sync)
    // Refresh on mount: the counterparty has no change_orders realtime channel,
    // so this keeps the card's status current (pending→accepted/declined/
    // cancelled) each time the thread is opened. A miss falls back to snapshot.
    void ensureChangeOrderLoaded(id)
    return unsubscribe
  }, [id])
  return co
}

function useReactiveFundingRequest(id: string | undefined): FundingRequest | undefined {
  const [fr, setFr] = useState<FundingRequest | undefined>(() =>
    id ? getFundingRequestById(id) : undefined,
  )
  useEffect(() => {
    if (!id) return
    const sync = () => setFr(getFundingRequestById(id))
    const unsubscribe = subscribeFundingRequests(sync)
    queueMicrotask(sync)
    return unsubscribe
  }, [id])
  return fr
}

function useReactiveInvoice(id: string | undefined): Invoice | undefined {
  const [inv, setInv] = useState<Invoice | undefined>(() =>
    id ? getInvoiceById(id) : undefined,
  )
  useEffect(() => {
    if (!id) return
    const sync = () => setInv(getInvoiceById(id))
    const unsubscribe = subscribeInvoices(sync)
    queueMicrotask(sync)
    // Refresh on mount: an invoices realtime channel now exists (R4), so this is
    // a belt-and-suspenders refresh for the resume-in-place / already-mounted
    // window + rows beyond the initial 200-row load. ensureLoaded force-refetches
    // + replaces the cached row; a miss falls back to snapshot.
    void ensureInvoiceLoaded(id)
    return unsubscribe
  }, [id])
  return inv
}

// ── Artifact-projection matching ────────────────────────────────────────────
// The compact card is keyed by the entity id (message.artifactId). Find the
// matching projection in the screen-resolved bundle, preferring the entity id
// but falling back to the snapshot id so a snapshot-only artifact still binds.

function matchOfferArtifact(
  ta: ThreadArtifacts | undefined,
  artifactId: string,
): OfferPaymentArtifact | undefined {
  const a = ta?.offerPaymentArtifact
  if (!a) return undefined
  return (a.offer?.id ?? a.snapshot?.offerId) === artifactId ? a : undefined
}

function matchProjectArtifact(
  ta: ThreadArtifacts | undefined,
  artifactId: string,
): ProjectArtifact | undefined {
  return ta?.projectArtifacts.find(
    (a) => (a.project?.id ?? a.snapshot?.projectId) === artifactId,
  )
}

function matchFundingArtifact(
  ta: ThreadArtifacts | undefined,
  artifactId: string,
): FundingStepArtifact | undefined {
  const a = ta?.fundingStepArtifact
  if (!a) return undefined
  return (a.fundingRequestId || a.snapshot?.fundingRequestId) === artifactId ? a : undefined
}

function matchChangeOrderArtifact(
  ta: ThreadArtifacts | undefined,
  artifactId: string,
): ChangeOrderArtifact | undefined {
  return ta?.changeOrderArtifacts.find(
    (a) => (a.changeOrder?.id ?? a.snapshot?.changeOrderId) === artifactId,
  )
}

function matchInvoiceArtifact(
  ta: ThreadArtifacts | undefined,
  artifactId: string,
): InvoiceArtifact | undefined {
  return ta?.invoiceArtifacts.find(
    (a) => (a.invoice?.id ?? a.snapshot?.invoiceId) === artifactId,
  )
}

/**
 * Offer routing state. The funding deep-link path expects a funding-request
 * id, but the OfferPayment card carries the offer id — so payment phases are
 * mapped onto 'accepted' here (→ `/quotes/{offerId}`, the canonical decision
 * surface with the payment CTA). The happy path keeps the live entity status.
 */
function offerRouteState(
  phase: OfferPaymentPhase | undefined,
  offerStatus: string | undefined,
): string {
  if (offerStatus) return offerStatus
  switch (phase) {
    case 'declined':
      return 'declined'
    case 'accepted':
    case 'payment_due':
    case 'diagnosis_payment_due':
      return 'accepted'
    default:
      return 'sent'
  }
}

function CompactSkeleton({ artifactType }: { artifactType: string }) {
  const typeLabel = TYPE_LABEL[artifactType as keyof typeof TYPE_LABEL] ?? 'Artifact'
  return (
    <div
      data-testid="artifact-card-compact-skeleton"
      className="animate-pulse mx-4 my-1.5 rounded-[14px] bg-white px-3.5 py-3 ring-1 ring-slate-200/60 shadow-[0_4px_12px_-8px_rgba(2,6,23,0.06)]"
    >
      <div className="h-2 w-20 rounded bg-slate-100" />
      <div className="mt-2.5 flex items-center gap-3">
        <div className="h-9 w-9 shrink-0 rounded-xl bg-slate-100" />
        <div className="flex-1">
          <div className="h-3.5 w-32 rounded bg-slate-100" />
          <div className="mt-1.5 h-2.5 w-24 rounded bg-slate-100" />
        </div>
      </div>
      <span className="sr-only">{typeLabel} wird geladen…</span>
    </div>
  )
}

/**
 * Terminal placeholder when neither the entity nor a party-scoped snapshot
 * resolved after the skeleton ceiling. Non-interactive.
 */
function CompactUnavailable({ artifactType }: { artifactType: string }) {
  const typeLabel = TYPE_LABEL[artifactType as keyof typeof TYPE_LABEL] ?? 'Artifact'
  return (
    <div
      data-testid="artifact-card-compact-unavailable"
      className="mx-4 my-1.5 rounded-[14px] border border-dashed border-slate-300 bg-slate-50 px-3.5 py-3"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M5.6 5.6l12.8 12.8" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
            {typeLabel}
          </span>
          <p className="mt-0.5 truncate text-[14px] font-semibold text-slate-500">
            Nicht verfügbar
          </p>
        </div>
      </div>
    </div>
  )
}

function ReconciliationBanner() {
  return (
    <div
      data-testid="artifact-reconciliation-banner"
      className="mx-4 mt-1 -mb-0.5 text-[11px] text-slate-500"
    >
      Angebot durch Zahlung abgelöst
    </div>
  )
}

// ── View builders (entity-backed) ───────────────────────────────────────────

function buildProjectView(project: Project): ArtifactCardView {
  const statusKey = project.status
  return {
    iconKey: 'Project',
    typeLabel: TYPE_LABEL.Project,
    prominent: project.title || 'Projekt',
    prominentKind: 'title',
    subtitle: project.category?.trim() || undefined,
    statusLabel: PROJECT_STATUS_LABEL[statusKey] ?? statusKey,
    statusTone: tone(statusKey),
  }
}

function buildOfferView(offer: Offer, phase: OfferPaymentPhase | undefined): ArtifactCardView {
  const docType: OfferDocumentType = offer.documentType ?? 'binding_offer'
  const typeLabel = OFFER_DOCTYPE_LABEL[docType] ?? TYPE_LABEL.OfferPayment
  // Only the payment phases override the entity status — Offer.status never
  // carries them, so the compact "Zahlung fällig" state would otherwise never
  // surface. For every other state the entity status wins (deriveOfferPhase
  // collapses cancelled→'sent', so phase-dominance would mislabel a cancelled
  // offer as actionable instead of 'Storniert').
  const isPaymentPhase = phase === 'payment_due' || phase === 'diagnosis_payment_due'
  const statusKey = isPaymentPhase ? phase : (offer.status ?? phase ?? 'pending')
  // Decision 1 (2026-06-23): NO price on the Angebot card — prominent line is
  // the project title; the price lives on the detail screen only.
  const title = offer.projectTitleSnapshot?.trim()
    || offer.description?.trim()
    || 'Angebot'
  return {
    iconKey: 'OfferPayment',
    typeLabel,
    prominent: title,
    prominentKind: 'title',
    statusLabel: OFFER_STATUS_LABEL_BY_PHASE[statusKey] ?? statusKey,
    statusTone: tone(statusKey),
  }
}

function buildChangeOrderView(co: ChangeOrder): ArtifactCardView {
  const statusKey: ChangeOrderStatus = co.status
  const amount = co.grossTotal != null
    ? formatCents(co.grossTotal, co.currency || 'EUR', true)
    : (co.price || 'Nachtrag')
  return {
    iconKey: 'ChangeOrder',
    typeLabel: TYPE_LABEL.ChangeOrder,
    prominent: amount,
    prominentKind: 'amount',
    amountNegative: co.grossTotal != null ? co.grossTotal < 0 : /^[-−]/.test((co.price || '').trim()),
    subtitle: co.description?.trim() || undefined,
    statusLabel: CHANGE_ORDER_STATUS_LABEL[statusKey] ?? statusKey,
    statusTone: tone(statusKey),
  }
}

function buildFundingView(fr: FundingRequest): ArtifactCardView {
  const statusKey = fr.status
  return {
    iconKey: 'FundingStep',
    typeLabel: TYPE_LABEL.FundingStep,
    prominent: formatCents(fr.amount, fr.currency || 'EUR', false),
    prominentKind: 'amount',
    statusLabel: FUNDING_STATUS_LABEL[statusKey] ?? statusKey,
    statusTone: tone(statusKey),
  }
}

function buildInvoiceView(invoice: Invoice): ArtifactCardView {
  const statusKey = invoice.status
  return {
    iconKey: 'Invoice',
    typeLabel: TYPE_LABEL.Invoice,
    // Invoice amounts are in EUROS (not cents) — formatEuro, never formatCents.
    prominent: formatEuro(invoice.amounts.grossAmount),
    prominentKind: 'amount',
    // Storno/Gutschrift belege carry a negative gross → rose, like a ChangeOrder credit.
    amountNegative: invoice.amounts.grossAmount < 0,
    subtitle: invoice.invoiceNumber?.trim() || undefined,
    statusLabel: INVOICE_STATUS_LABEL[statusKey] ?? statusKey,
    statusTone: INVOICE_STATUS_TONE[statusKey] ?? 'pending',
  }
}

// ── View builders (snapshot fallback) ───────────────────────────────────────

function buildProjectViewFromSnapshot(s: ProjectSnapshot): ArtifactCardView {
  return {
    iconKey: 'Project',
    typeLabel: TYPE_LABEL.Project,
    prominent: s.title?.trim() || 'Projekt',
    prominentKind: 'title',
    statusLabel: PROJECT_STATUS_LABEL[s.status] ?? s.status,
    statusTone: tone(s.status),
  }
}

function buildOfferViewFromSnapshot(
  s: OfferSnapshot,
  phase: OfferPaymentPhase | undefined,
): ArtifactCardView {
  const docType: OfferDocumentType = s.documentType ?? 'binding_offer'
  const typeLabel = OFFER_DOCTYPE_LABEL[docType] ?? TYPE_LABEL.OfferPayment
  const statusKey = phase ?? 'sent'
  // No price on the card (decision 1): prefer the project summary, never s.price.
  return {
    iconKey: 'OfferPayment',
    typeLabel,
    prominent: s.summary?.trim() || 'Angebot',
    prominentKind: 'title',
    statusLabel: OFFER_STATUS_LABEL_BY_PHASE[statusKey] ?? s.phaseLabel ?? statusKey,
    statusTone: tone(statusKey),
  }
}

function buildFundingViewFromSnapshot(
  s: FundingStepSnapshot,
  phase: FundingStepPhase | undefined,
): ArtifactCardView {
  const statusKey = phase ?? 'sent'
  return {
    iconKey: 'FundingStep',
    typeLabel: TYPE_LABEL.FundingStep,
    prominent: s.amount?.trim() || 'Zahlung',
    prominentKind: 'amount',
    statusLabel: FUNDING_STATUS_LABEL[statusKey] ?? s.phaseLabel ?? statusKey,
    statusTone: tone(statusKey),
  }
}

function buildChangeOrderViewFromSnapshot(
  s: ChangeOrderSnapshot,
  status: ChangeOrderStatus,
): ArtifactCardView {
  const delta = s.deltaAmount?.trim()
  return {
    iconKey: 'ChangeOrder',
    typeLabel: TYPE_LABEL.ChangeOrder,
    prominent: delta || s.description?.trim() || 'Nachtrag',
    prominentKind: delta ? 'amount' : 'title',
    amountNegative: !!delta && /^[-−]/.test(delta),
    subtitle: delta ? s.description?.trim() || undefined : undefined,
    statusLabel: CHANGE_ORDER_STATUS_LABEL[status] ?? status,
    statusTone: tone(status),
  }
}

function buildInvoiceViewFromSnapshot(
  s: InvoiceSnapshot,
  status: string,
): ArtifactCardView {
  return {
    iconKey: 'Invoice',
    typeLabel: TYPE_LABEL.Invoice,
    prominent: s.amount?.trim() || 'Rechnung',
    prominentKind: 'amount',
    amountNegative: /^[-−]/.test((s.amount || '').trim()),
    subtitle: s.invoiceNumber?.trim() || undefined,
    statusLabel: INVOICE_STATUS_LABEL[status] ?? s.phaseLabel ?? status,
    statusTone: INVOICE_STATUS_TONE[status] ?? 'pending',
  }
}

export interface ChatArtifactCardCompactProps {
  message: ChatMessageViewModel
  role: ChatRole
  onNavigate: (path: string) => void
  /**
   * True when an offer in this thread has been superseded by an active funding
   * request. Drives the reconciliation banner above funding cards.
   */
  offerFundingSuperseded?: boolean
  /**
   * Party-scoped artifact projection bundle for this thread (snapshot fallback
   * + lifecycle phase). Optional: when omitted the card falls back to
   * entity-only rendering.
   */
  threadArtifacts?: ThreadArtifacts
}

export function ChatArtifactCardCompact(
  props: ChatArtifactCardCompactProps,
): React.ReactElement | null {
  const { message, role, onNavigate, offerFundingSuperseded, threadArtifacts } = props
  const artifactType = message.artifactType ?? ''
  const artifactId = message.artifactId ?? ''

  // Unconditional reactive subscriptions per type — exactly one feeds into
  // `view` below. Hooks must run in stable order (rules of hooks).
  const project = useReactiveProject(artifactType === 'Project' ? artifactId : undefined)
  const offer = useReactiveOffer(artifactType === 'OfferPayment' ? artifactId : undefined)
  const changeOrder = useReactiveChangeOrder(artifactType === 'ChangeOrder' ? artifactId : undefined)
  const fundingRequest = useReactiveFundingRequest(artifactType === 'FundingStep' ? artifactId : undefined)
  const invoice = useReactiveInvoice(artifactType === 'Invoice' ? artifactId : undefined)

  // Skeleton ceiling: bound the placeholder so a card that resolves neither an
  // entity nor a snapshot settles into a clear unavailable state. Reset whenever
  // the card re-targets a new artifact.
  const settleKey = artifactType + ':' + artifactId
  const [settledKey, setSettledKey] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setSettledKey(settleKey), SKELETON_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [settleKey])
  // Derived, not a synchronous in-effect setState reset: on re-target settledKey
  // still holds the old artifact's key, so `settled` reads false immediately and
  // the skeleton ceiling restarts.
  const settled = settledKey === settleKey

  // Unknown artifactType — skip rendering.
  if (!isKnownArtifactType(artifactType) || !artifactId) {
    return null
  }

  const offerArtifact = artifactType === 'OfferPayment'
    ? matchOfferArtifact(threadArtifacts, artifactId)
    : undefined
  const projectArtifact = artifactType === 'Project'
    ? matchProjectArtifact(threadArtifacts, artifactId)
    : undefined
  const fundingArtifact = artifactType === 'FundingStep'
    ? matchFundingArtifact(threadArtifacts, artifactId)
    : undefined
  const changeOrderArtifact = artifactType === 'ChangeOrder'
    ? matchChangeOrderArtifact(threadArtifacts, artifactId)
    : undefined
  const invoiceArtifact = artifactType === 'Invoice'
    ? matchInvoiceArtifact(threadArtifacts, artifactId)
    : undefined

  // Per-type hydration: prefer the full entity, fall back to the party-scoped
  // snapshot, then to the bounded skeleton / unavailable placeholder.
  let view: ArtifactCardView | null = null
  let routeState: string | null = null
  let routeDocumentType: string | null = null

  if (artifactType === 'Project') {
    if (project) {
      view = buildProjectView(project)
      routeState = project.status
    } else if (projectArtifact?.snapshot) {
      view = buildProjectViewFromSnapshot(projectArtifact.snapshot)
      routeState = projectArtifact.snapshot.status
    }
  } else if (artifactType === 'OfferPayment') {
    const phase = offerArtifact?.phase
    if (offer) {
      view = buildOfferView(offer, phase)
      routeState = offerRouteState(phase, offer.status)
      routeDocumentType = offer.documentType ?? offerArtifact?.documentType ?? null
    } else if (offerArtifact?.snapshot) {
      view = buildOfferViewFromSnapshot(offerArtifact.snapshot, phase)
      routeState = offerRouteState(phase, undefined)
      routeDocumentType = offerArtifact.snapshot.documentType ?? offerArtifact.documentType ?? null
    }
  } else if (artifactType === 'ChangeOrder') {
    if (changeOrder) {
      view = buildChangeOrderView(changeOrder)
      routeState = changeOrder.status
    } else if (changeOrderArtifact?.snapshot) {
      view = buildChangeOrderViewFromSnapshot(changeOrderArtifact.snapshot, changeOrderArtifact.status)
      routeState = changeOrderArtifact.status
    }
  } else if (artifactType === 'FundingStep') {
    const phase = fundingArtifact?.phase
    if (fundingRequest) {
      view = buildFundingView(fundingRequest)
      routeState = fundingRequest.status
    } else if (fundingArtifact?.snapshot) {
      view = buildFundingViewFromSnapshot(fundingArtifact.snapshot, phase)
      routeState = phase ?? 'sent'
    }
  } else if (artifactType === 'Invoice') {
    if (invoice) {
      view = buildInvoiceView(invoice)
      routeState = invoice.status
    } else if (invoiceArtifact?.snapshot) {
      view = buildInvoiceViewFromSnapshot(invoiceArtifact.snapshot, invoiceArtifact.status)
      routeState = invoiceArtifact.status
    }
  }

  if (!view) {
    return settled
      ? <CompactUnavailable artifactType={artifactType} />
      : <CompactSkeleton artifactType={artifactType} />
  }

  const targetPath = getArtifactRoute({
    artifactType,
    artifactId,
    role,
    state: routeState,
    documentType: routeDocumentType,
  })

  const handleTap = () => {
    onNavigate(targetPath)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onNavigate(targetPath)
    }
  }

  const showReconciliation =
    artifactType === 'FundingStep' && offerFundingSuperseded === true

  return (
    <div className="w-full">
      {showReconciliation && <ReconciliationBanner />}
      <div
        role="button"
        tabIndex={0}
        onClick={handleTap}
        onKeyDown={handleKey}
        className="mx-4 my-1.5 cursor-pointer select-none transition hover:-translate-y-px active:translate-y-0"
      >
        <ArtifactCardShell view={view} testid={`artifact-card-compact-${artifactType}`} />
      </div>
    </div>
  )
}
