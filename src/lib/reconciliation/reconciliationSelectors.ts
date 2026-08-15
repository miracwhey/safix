/**
 * Reconciliation selectors (N13.1) — pure aggregation functions over the
 * existing dispute / media / stripe truth.
 *
 * BOUNDARIES
 * ----------
 * - These functions read; they never write.
 * - They never invent data. Empty fields stay empty (e.g. counterparty
 *   evidence is `[]` until the operator share workflow lands in N13.OPS).
 * - PII redaction runs on every text field that originates from the OPPOSITE
 *   party. Own-authored content is rendered verbatim.
 * - Snapshot drift is acknowledged: `snapshotMissing: true` lets callers
 *   render a fallback rather than crash.
 */

import type { Dispute } from '../disputes/types'
import {
  getDisputeNextStepForRole,
  getDisputeStatusLabelFor,
  getDisputeUrgencyLevel,
  getDisputeAgeDays,
} from '../disputes/disputeSelectors'
import { isTerminalDisputeStatus } from '../disputes/stateMachine'
import { formatAktenzeichen } from './aktenzeichen'
import { redactPII, type RedactionContext } from './piiRedaction'
import type {
  ReconciliationActionId,
  ReconciliationDeadline,
  ReconciliationDecision,
  ReconciliationEvidenceItem,
  ReconciliationEvidenceKind,
  ReconciliationHistoryRow,
  ReconciliationListBuckets,
  ReconciliationListItem,
  ReconciliationMediaRow,
  ReconciliationOperatorComment,
  ReconciliationRole,
  ReconciliationSelectorInput,
  ReconciliationStripeEvent,
  ReconciliationStripeRow,
  ReconciliationTimelineItem,
  ReconciliationTimelineSource,
  ReconciliationView,
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000

// ─── helpers ─────────────────────────────────────────────────────────────

function safeParseMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function buildRedactionContext(
  input: ReconciliationSelectorInput,
): RedactionContext {
  return {
    counterpartyNames: input.counterparty?.displayName
      ? [input.counterparty.displayName]
      : undefined,
    counterpartyEmails: input.counterparty?.emails,
  }
}

function classifyEvidenceKind(row: ReconciliationMediaRow): ReconciliationEvidenceKind {
  const t = row.mediaType?.toLowerCase() ?? ''
  if (t === 'image' || t === 'video') return 'image'
  if (t === 'audio') return 'audio'
  if (t === 'document' || row.fileName.toLowerCase().endsWith('.pdf')) return 'document'
  return 'other'
}

function mapMediaToEvidence(
  rows: ReadonlyArray<ReconciliationMediaRow>,
  viewerUserId: string | undefined,
  filter: 'own' | 'shared',
): ReconciliationEvidenceItem[] {
  const matches = rows.filter((row) => {
    if (filter === 'own') {
      return viewerUserId !== undefined && row.ownerUserId === viewerUserId
    }
    // 'shared' → owner is the counterparty AND operator has flagged it shared
    return (
      viewerUserId !== undefined &&
      row.ownerUserId !== viewerUserId &&
      row.sharedWithCounterparty === true
    )
  })
  return matches
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((row) => ({
      id: row.id,
      kind: classifyEvidenceKind(row),
      name: row.fileName,
      uploadedAt: row.createdAt,
      sizeBytes: row.sizeBytes,
      ownedByViewer: row.ownerUserId === viewerUserId,
      mediaId: row.id,
    }))
}

function mapHistoryToTimeline(
  rows: ReadonlyArray<ReconciliationHistoryRow>,
  viewerUserId: string | undefined,
  ctx: RedactionContext,
): ReconciliationTimelineItem[] {
  return rows
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .flatMap((row): ReconciliationTimelineItem[] => {
      const isOwnClientEvent =
        row.source === 'client' && row.actorUserId === viewerUserId

      // Counterparty client events are suppressed entirely. Operators may
      // surface a neutralised summary on their own admin row instead.
      if (row.source === 'client' && !isOwnClientEvent) {
        return []
      }

      const source: ReconciliationTimelineSource = isOwnClientEvent
        ? 'you'
        : row.source === 'admin'
          ? 'operator'
          : 'system'

      const titleByTransition = describeStatusTransition(row.previousStatus, row.nextStatus, source)
      const note = row.note ?? null
      const body =
        note && !isOwnClientEvent ? redactPII(note, ctx) : note ?? undefined
      const quote = note && isOwnClientEvent ? note : undefined

      return [
        {
          id: row.id,
          source,
          occurredAt: row.createdAt,
          title: titleByTransition,
          body: body && body !== quote ? body : undefined,
          quote,
        },
      ]
    })
}

function describeStatusTransition(
  _previous: ReconciliationHistoryRow['previousStatus'],
  next: ReconciliationHistoryRow['nextStatus'],
  source: ReconciliationTimelineSource,
): string {
  // Most distinctive labels first — fall back to a neutral "Status aktualisiert".
  if (next === 'open') return 'Streitfall eröffnet'
  if (next === 'under_review') return 'Prüfung läuft'
  if (next === 'customer_waiting') return 'Stellungnahme vom Kunden angefragt'
  if (next === 'provider_waiting') return 'Stellungnahme vom Anbieter angefragt'
  if (next === 'resolved') {
    return source === 'operator' ? 'Entscheidung getroffen' : 'Verfahren abgeschlossen'
  }
  if (next === 'closed') return 'Fall geschlossen'
  if (next === 'cancelled') return 'Streitfall zurückgezogen'
  return 'Status aktualisiert'
}

const VISIBLE_STRIPE_EVENT_TYPES = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.refund.updated',
  'transfer.created',
  'transfer.reversed',
  'payout.paused',
  'payout.released',
  'refund.created',
  'refund.succeeded',
  'refund.failed',
  // Canonical aliases written by the SaFix webhook handler:
  'treuhand.held',
  'treuhand.released',
  'decision.split_60_40',
  'decision.split_70_30',
  'decision.split_80_20',
  'decision.refund_full',
  'decision.release_full',
  'decision.reject',
])

function mapStripeToTimeline(
  rows: ReadonlyArray<ReconciliationStripeRow>,
): ReconciliationStripeEvent[] {
  return rows
    .filter((row) => VISIBLE_STRIPE_EVENT_TYPES.has(row.eventType))
    .slice()
    .sort((a, b) => Date.parse(a.processedAt) - Date.parse(b.processedAt))
    .map((row) => ({
      id: row.eventId,
      occurredAt: row.processedAt,
      type: row.eventType,
      amountEur: row.amountEur,
      outcome: row.outcome ?? undefined,
    }))
}

function deriveDeadline(
  iso: string | null | undefined,
  nowMs: number,
): ReconciliationDeadline | null {
  const dueMs = safeParseMs(iso)
  if (dueMs === null) return null
  const breached = dueMs < nowMs
  const remainingMs = dueMs - nowMs
  let urgency: ReconciliationDeadline['urgency']
  if (breached) urgency = 'overdue'
  else if (remainingMs < DAY_MS) urgency = 'today'
  else if (remainingMs < 3 * DAY_MS) urgency = 'soon'
  else urgency = 'later'
  return { dueAt: new Date(dueMs).toISOString(), breached, urgency }
}

function deriveDecision(
  dispute: Dispute,
  history: ReadonlyArray<ReconciliationHistoryRow>,
  ctx: RedactionContext,
): ReconciliationDecision | null {
  if (!isTerminalDisputeStatus(dispute.status) || !dispute.decision) return null
  const adminTransitionToResolved = history
    .slice()
    .reverse()
    .find((row) => row.source === 'admin' && row.nextStatus === 'resolved')
  const rationaleRaw = adminTransitionToResolved?.note ?? null
  const rationale = rationaleRaw ? redactPII(rationaleRaw, ctx) : undefined
  return {
    decision: dispute.decision,
    resolutionType: dispute.resolutionType,
    splitRatio: dispute.splitRatio,
    settlementStatus: dispute.settlementStatus,
    rationale,
    decidedAt: dispute.resolvedAt ?? adminTransitionToResolved?.createdAt,
  }
}

function deriveAvailableActions(
  dispute: Dispute,
  role: ReconciliationRole,
): ReconciliationActionId[] {
  const actions: ReconciliationActionId[] = []
  const isWaitingForViewer =
    (role === 'customer' && dispute.status === 'customer_waiting') ||
    (role === 'craftsman' && dispute.status === 'provider_waiting')
  const lifecycleAcceptsEvidence =
    dispute.status === 'open' ||
    dispute.status === 'under_review' ||
    dispute.status === 'customer_waiting' ||
    dispute.status === 'provider_waiting'

  if (isWaitingForViewer) actions.push('submit_statement')
  if (lifecycleAcceptsEvidence) actions.push('upload_evidence')
  actions.push('open_full_center')
  actions.push('export_case')
  if (actions.length === 0) actions.push('view_only')
  return actions
}

// ─── public API ──────────────────────────────────────────────────────────

export function selectReconciliationView(
  input: ReconciliationSelectorInput,
): ReconciliationView | null {
  const aktenzeichen = formatAktenzeichen(input.dispute.id, input.dispute.createdAt)
  if (!aktenzeichen) return null

  const ctx = buildRedactionContext(input)
  const nowMs = input.nowMs ?? Date.now()
  const viewerUserId = input.viewer?.userId

  const timeline = mapHistoryToTimeline(input.history, viewerUserId, ctx)
  const sharedEvidenceIds = readSharedEvidenceIds(input.dispute)
  const mediaWithSharing = sharedEvidenceIds.size === 0
    ? input.media
    : input.media.map((row) =>
        sharedEvidenceIds.has(row.id) && row.sharedWithCounterparty !== true
          ? { ...row, sharedWithCounterparty: true }
          : row,
      )
  const ownEvidence = mapMediaToEvidence(mediaWithSharing, viewerUserId, 'own')
  const sharedCounterpartyEvidence = mapMediaToEvidence(mediaWithSharing, viewerUserId, 'shared')
  const stripeTimeline = mapStripeToTimeline(input.stripeEvents)
  const operatorComments = readOperatorComments(input.dispute)
  const decision = deriveDecision(input.dispute, input.history, ctx)
  const deadline = deriveDeadline(input.statementDeadlineAt ?? null, nowMs)

  return {
    disputeId: input.dispute.id,
    aktenzeichen,
    jobId: input.dispute.jobId,
    role: input.role,
    status: input.dispute.status,
    statusLabel: getDisputeStatusLabelFor(input.dispute),
    nextStepLabel: getDisputeNextStepForRole(
      input.dispute.status,
      input.role,
      input.dispute.decision,
      input.dispute.settlementStatus,
      input.dispute.resolutionType,
    ),
    snapshot: input.dispute.contextSnapshot ?? null,
    snapshotMissing: !input.dispute.contextSnapshot,
    timeline,
    ownEvidence,
    sharedCounterpartyEvidence,
    stripeTimeline,
    operatorComments,
    deadline,
    decision,
    availableActions: deriveAvailableActions(input.dispute, input.role),
    dispute: input.dispute,
  }
}

// ─── operator-write helpers (N13.OPS) ────────────────────────────────────

function readOperatorComments(dispute: Dispute): ReconciliationOperatorComment[] {
  const meta = (dispute as { metadata?: unknown }).metadata
  if (!meta || typeof meta !== 'object') return []
  const raw = (meta as { operator_comments?: unknown }).operator_comments
  if (!Array.isArray(raw)) return []
  const items: ReconciliationOperatorComment[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.body !== 'string') continue
    const writtenAt =
      typeof e.written_at === 'string'
        ? e.written_at
        : typeof e.writtenAt === 'string'
          ? e.writtenAt
          : null
    if (!writtenAt) continue
    items.push({ id: e.id, body: e.body, writtenAt })
  }
  // Stable order: oldest first.
  return items
    .slice()
    .sort((a, b) => Date.parse(a.writtenAt) - Date.parse(b.writtenAt))
}

function readSharedEvidenceIds(dispute: Dispute): Set<string> {
  const meta = (dispute as { metadata?: unknown }).metadata
  if (!meta || typeof meta !== 'object') return new Set()
  const raw = (meta as { shared_evidence_ids?: unknown }).shared_evidence_ids
  if (!Array.isArray(raw)) return new Set()
  const ids = new Set<string>()
  for (const entry of raw) {
    if (typeof entry === 'string') ids.add(entry)
  }
  return ids
}

// ─── list aggregation ────────────────────────────────────────────────────

export type ReconciliationListSelectorInput = {
  role: ReconciliationRole
  viewerUserId: string
  /** All disputes the viewer is a party to (already RLS-filtered). */
  disputes: ReadonlyArray<Dispute>
  /**
   * Resolver that gives the selector access to per-dispute context — payment
   * amount, deadline, refunded amount. Selectors stay pure; callers wire the
   * resolver against the active store snapshot.
   */
  resolveContext?: (dispute: Dispute) => {
    jobTitle?: string
    amountEur?: number | null
    statementDeadlineAt?: string | null
    refundedAmountEur?: number | null
  } | null
  nowMs?: number
}

function deriveListItem(
  dispute: Dispute,
  role: ReconciliationRole,
  _viewerUserId: string,
  context: ReturnType<NonNullable<ReconciliationListSelectorInput['resolveContext']>> | null,
  nowMs: number,
): ReconciliationListItem | null {
  const aktenzeichen = formatAktenzeichen(dispute.id, dispute.createdAt)
  if (!aktenzeichen) return null

  const isWaitingForViewer =
    (role === 'customer' && dispute.status === 'customer_waiting') ||
    (role === 'craftsman' && dispute.status === 'provider_waiting')

  const ageDays = getDisputeAgeDays(dispute.createdAt, nowMs)
  const baseUrgency = getDisputeUrgencyLevel(dispute.status, ageDays)
  const urgencyLevel = isWaitingForViewer ? 'critical' : baseUrgency

  const amountEur =
    context?.amountEur ?? dispute.contextSnapshot?.paymentTotalAmount ?? null

  const jobTitle =
    context?.jobTitle ?? dispute.contextSnapshot?.jobTitle ?? dispute.title ?? ''

  const deadline = deriveDeadline(context?.statementDeadlineAt ?? null, nowMs)

  const decisionSummary = isTerminalDisputeStatus(dispute.status)
    ? buildDecisionSummary(dispute)
    : null

  return {
    disputeId: dispute.id,
    aktenzeichen,
    jobId: dispute.jobId,
    jobTitle,
    status: dispute.status,
    statusLabel: getDisputeStatusLabelFor(dispute),
    summary: dispute.description?.split('\n')[0] ?? '',
    amountEur,
    updatedAt: dispute.updatedAt,
    createdAt: dispute.createdAt,
    resolvedAt: dispute.resolvedAt ?? null,
    deadline,
    requiresAction: isWaitingForViewer,
    urgencyLevel,
    decisionSummary,
    refundedAmountEur: context?.refundedAmountEur ?? null,
  }
}

function buildDecisionSummary(dispute: Dispute): string | null {
  if (!dispute.decision) return null
  if (dispute.decision === 'release') {
    if (dispute.resolutionType === 'release_partial') return 'Teilfreigabe entschieden'
    return 'Vollständige Freigabe'
  }
  if (dispute.decision === 'refund') {
    if (dispute.resolutionType === 'refund_partial') return 'Teilrückerstattung entschieden'
    return 'Vollständige Rückerstattung'
  }
  if (dispute.decision === 'split') {
    if (typeof dispute.splitRatio === 'number') {
      const craftsmanPct = Math.round(dispute.splitRatio * 100)
      return `Aufteilung ${craftsmanPct}/${100 - craftsmanPct}`
    }
    return 'Aufteilung'
  }
  if (dispute.decision === 'reject') return 'Streitfall abgelehnt'
  return null
}

function compareForActive(a: ReconciliationListItem, b: ReconciliationListItem): number {
  // Critical first, then deadline ascending (overdue → today → soon → later),
  // then most recent activity.
  const urgencyOrder = { critical: 0, elevated: 1, normal: 2 } as const
  const urgencyDiff = urgencyOrder[a.urgencyLevel] - urgencyOrder[b.urgencyLevel]
  if (urgencyDiff !== 0) return urgencyDiff
  const aDue = a.deadline ? Date.parse(a.deadline.dueAt) : Number.POSITIVE_INFINITY
  const bDue = b.deadline ? Date.parse(b.deadline.dueAt) : Number.POSITIVE_INFINITY
  if (aDue !== bDue) return aDue - bDue
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
}

function compareForResolved(a: ReconciliationListItem, b: ReconciliationListItem): number {
  const aRef = a.resolvedAt ?? a.updatedAt
  const bRef = b.resolvedAt ?? b.updatedAt
  return Date.parse(bRef) - Date.parse(aRef)
}

export function selectReconciliationList(
  input: ReconciliationListSelectorInput,
): ReconciliationListBuckets {
  const nowMs = input.nowMs ?? Date.now()
  const items: ReconciliationListItem[] = []

  for (const dispute of input.disputes) {
    const context = input.resolveContext ? input.resolveContext(dispute) : null
    const item = deriveListItem(dispute, input.role, input.viewerUserId, context, nowMs)
    if (item) items.push(item)
  }

  const active = items
    .filter((item) => !isTerminalDisputeStatus(item.status))
    .sort(compareForActive)
  const resolved = items
    .filter((item) => isTerminalDisputeStatus(item.status))
    .sort(compareForResolved)

  return {
    active,
    resolved,
    counts: {
      active: active.length,
      awaitingViewer: active.filter((item) => item.requiresAction).length,
      resolved: resolved.length,
    },
  }
}
