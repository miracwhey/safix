/**
 * Spatial · Canonical · Workflow · Provider Hub Model (Phase B · B-1)
 *
 * Pure aggregation logic for the Provider Spatial Hub dashboard (Mockup 18 ·
 * provider-hub-spec §3). Zero React / three.js / Supabase imports — takes a
 * normalised list of {@link ProviderHubJobInput} and produces the 3-layer
 * view model (Critical-Actions / Pipeline-Kanban / Activity-Feed).
 *
 * The critical-action score algorithm mirrors provider-hub-spec §3.2 exactly.
 *
 * Cross-domain note (Phase C): the *signals* on {@link ProviderHubJobInput}
 * (customer-waiting, quote-deadline, …) are populated by the hook layer from
 * the jobs / offers / disputes domains. This module only scores + groups them
 * — it never reaches into another domain itself.
 */

import type {
  PinReview,
  SpatialChangeOrder,
  SpatialEditHistoryEntry,
  SpatialRescanRequest,
} from '../repository/SpatialSceneRepository.ts'
import { deriveAnnotationSeverity } from './annotationGrouping.ts'

// ── stage / actor / urgency vocab ────────────────────────────────────────────

/** Pipeline column a job sits in (provider-hub-spec §3.3). */
export type HubPipelineStage = 'neu' | 'quoting' | 'aktiv' | 'fertig'

/** Activity-feed actor class — drives the avatar colour (Mockup 18 Layer 3). */
export type HubActorKind = 'kunde' | 'team' | 'system'

/** Job-card top-border urgency hint (provider-hub-spec §4.3). */
export type HubUrgency = 'red' | 'amber' | 'green' | 'grey'

/** Critical-action left-edge urgency (provider-hub-spec §3.2 · Mockup 18 legend). */
export type HubCriticalUrgency = 'red' | 'amber' | 'grey'

/** Job-Spatial-Detail tab a critical-action CTA routes to (`?tab=`). */
export type HubTargetTab = '3d' | 'bom' | 'pins' | 'compare' | 'rescan'

// ── inputs ───────────────────────────────────────────────────────────────────

/** One activity-feed event, pre-formatted by the hook layer. */
export interface HubActivityEvent {
  id: string
  jobId: string
  /** Short job label shown as the feed chip (e.g. "Altbau-Bad"). */
  jobLabel: string
  actorKind: HubActorKind
  /** Already-localised one-line summary. */
  text: string
  /** Event time — unix ms. Used only for ordering; display label is `agoLabel`. */
  atMs: number
  /** Pre-formatted relative time ("8 Min", "gestern"). */
  agoLabel: string
}

/**
 * Cross-domain signals that feed the critical-action score (spec §3.2).
 * Every field is nullable / zero-safe so a job with no open issue scores 0.
 */
export interface ProviderHubJobSignals {
  /** Hours the customer has been waiting on a provider answer; null = not waiting. */
  customerWaitingHrs: number | null
  /** Hours until the quote deadline; null = no deadline / not in quoting. */
  quoteDeadlineHrs: number | null
  /** True once the quote has been sent (suppresses the deadline signal). */
  quoteSent: boolean
  /** Count of worker pins not yet reviewed by a foreman. */
  workerPinsUnreviewed: number
  /** Age in hours of the oldest unreviewed worker pin; null = none. */
  workerPinsUnreviewedHrs: number | null
  /** Hours a customer re-scan response has been pending; null = none. */
  rescanResponsePendingHrs: number | null
  /** A customer pin of severity 'high' the provider has not read. */
  highSeverityPinUnread: boolean
  /** A change-order is pending the provider's acceptance. */
  changeOrderPending: boolean
  /** The BoM generator failed / needs recompute. */
  bomError: boolean
  /** Count of scene-validator warnings on the current variant. */
  validatorWarnings: number
}

/** A job + its spatial scene + signals, normalised for the Hub. */
export interface ProviderHubJobInput {
  jobId: string
  /** The job's primary spatial scene id; null when the job has no scan yet. */
  sceneId: string | null
  /**
   * The source `scans.id` behind {@link sceneId}; null when the job has no
   * scan yet. Drives the JobCard thumbnail (Ü-01) by resolving the scan's
   * USDZ / glTF assets without re-walking the scenes list.
   */
  sourceScanId: string | null
  title: string
  customerName: string
  /** "Hamburg-Altona" — city / district. */
  locationLabel: string
  /** Computed room area; null when unknown. */
  areaM2: number | null
  /** "Bad" / "Küche" / "WC" — null when unknown. */
  roomLabel: string | null
  priority: 'low' | 'mid' | 'high'
  stage: HubPipelineStage
  signals: ProviderHubJobSignals
  /** All recent events for this job (newest first); the model keeps the top 2. */
  recentEvents: HubActivityEvent[]
}

// ── outputs ──────────────────────────────────────────────────────────────────

export interface HubCriticalAction {
  jobId: string
  score: number
  urgency: HubCriticalUrgency
  /** One-line action text (the dominant signal). */
  text: string
  /** Supporting meta line. */
  meta: string
  /** Quick-action button label routed to the relevant screen. */
  ctaLabel: string
  /** Job-Spatial-Detail tab the CTA opens — never a blanket `?tab=3d`. */
  targetTab: HubTargetTab
}

export interface HubQuickAction {
  key: string
  label: string
  kind: 'primary' | 'soft' | 'ghost'
}

export interface HubJobCard {
  jobId: string
  sceneId: string | null
  /** Source scan behind {@link sceneId}; drives the card thumbnail (Ü-01). */
  sourceScanId: string | null
  title: string
  customerName: string
  locationLabel: string
  areaM2: number | null
  roomLabel: string | null
  priority: 'low' | 'mid' | 'high'
  urgency: HubUrgency
  /** Last ≤2 events for the card body. */
  events: HubActivityEvent[]
  quickActions: HubQuickAction[]
}

export interface HubPipelineColumn {
  stage: HubPipelineStage
  label: string
  count: number
  cards: HubJobCard[]
}

export interface ProviderHubModel {
  /** Top ≤4 critical actions, score-descending. */
  criticalActions: HubCriticalAction[]
  /**
   * Total jobs with ≥1 critical signal — `criticalActions` is capped at 4, so
   * `criticalActionsTotal` may exceed it. The Hub shows "4 von N" + overflow.
   */
  criticalActionsTotal: number
  /** Fixed 4-column pipeline (neu / quoting / aktiv / fertig). */
  pipeline: HubPipelineColumn[]
  /** Merged activity feed, newest first, capped. */
  activityFeed: HubActivityEvent[]
  /** Spatial tab badge count (spec §13 PH-8). */
  tabBadgeCount: number
  /** Total spatial jobs across all columns. */
  totalJobs: number
}

// ── scoring (provider-hub-spec §3.2) ─────────────────────────────────────────

interface ScoredSignal {
  points: number
  urgency: HubCriticalUrgency
  text: string
  meta: string
  ctaLabel: string
  targetTab: HubTargetTab
}

/**
 * Evaluate every signal for a job and return the contributing ones, score-
 * descending. The first entry is the *dominant* signal that titles the
 * critical-action card.
 */
function scoreSignals(job: ProviderHubJobInput): ScoredSignal[] {
  const s = job.signals
  const out: ScoredSignal[] = []

  if (s.customerWaitingHrs !== null && s.customerWaitingHrs > 24) {
    out.push({
      points: 100,
      urgency: 'red',
      text: `${job.customerName} wartet auf deine Antwort`,
      meta: `${job.title} · seit ${Math.round(s.customerWaitingHrs)} Std`,
      ctaLabel: 'Antworten',
      targetTab: 'rescan',
    })
  }
  if (s.quoteDeadlineHrs !== null && s.quoteDeadlineHrs < 48 && !s.quoteSent) {
    out.push({
      points: 80,
      urgency: 'amber',
      text: `Angebot ${job.title} — Frist in ${Math.max(0, Math.round(s.quoteDeadlineHrs))} Std`,
      meta: 'Angebot noch nicht gesendet',
      ctaLabel: 'Angebot',
      targetTab: 'bom',
    })
  }
  if (
    s.workerPinsUnreviewed > 0 &&
    s.workerPinsUnreviewedHrs !== null &&
    s.workerPinsUnreviewedHrs > 12
  ) {
    out.push({
      points: 70,
      urgency: 'amber',
      text: `${s.workerPinsUnreviewed} Worker-Pins ungereviewt`,
      meta: `${job.title} · seit ${Math.round(s.workerPinsUnreviewedHrs)} Std`,
      ctaLabel: 'Review',
      targetTab: 'pins',
    })
  }
  if (s.rescanResponsePendingHrs !== null && s.rescanResponsePendingHrs > 24) {
    out.push({
      points: 60,
      urgency: 'red',
      text: `Re-Scan-Antwort von ${job.customerName} ausstehend`,
      meta: `${job.title} · seit ${Math.round(s.rescanResponsePendingHrs)} Std`,
      ctaLabel: 'Öffnen',
      targetTab: 'rescan',
    })
  }
  if (s.highSeverityPinUnread) {
    out.push({
      points: 50,
      urgency: 'amber',
      text: `Kritischer Kunden-Pin in ${job.title}`,
      meta: 'Severity hoch · noch nicht geprüft',
      ctaLabel: 'Ansehen',
      targetTab: 'pins',
    })
  }
  if (s.changeOrderPending) {
    out.push({
      points: 40,
      urgency: 'grey',
      text: `Änderungsauftrag wartet auf Freigabe`,
      meta: `${job.title} · ${job.customerName}`,
      ctaLabel: 'Prüfen',
      targetTab: '3d',
    })
  }
  if (s.bomError) {
    out.push({
      points: 30,
      urgency: 'grey',
      text: `Stückliste konnte nicht berechnet werden`,
      meta: `${job.title} · Neuberechnung nötig`,
      ctaLabel: 'Stückliste',
      targetTab: 'bom',
    })
  }
  if (s.validatorWarnings > 0) {
    out.push({
      points: 20,
      urgency: 'grey',
      text: `${s.validatorWarnings} neue Scan-Warnung${s.validatorWarnings > 1 ? 'en' : ''}`,
      meta: `${job.title} · Validator`,
      ctaLabel: 'Öffnen',
      targetTab: '3d',
    })
  }

  return out.sort((a, b) => b.points - a.points)
}

/** Total critical score for a job (sum of all contributing signals). */
function jobScore(job: ProviderHubJobInput): number {
  return scoreSignals(job).reduce((sum, sig) => sum + sig.points, 0)
}

// ── quick-actions per stage (provider-hub-spec §4.2) ─────────────────────────

function quickActionsForStage(stage: HubPipelineStage): HubQuickAction[] {
  switch (stage) {
    case 'neu':
      // C-9: the Phase-B 'walk' action routed `?mode=walk`, which nothing
      // reads — dropped. Camera-mode switching lives in CanonicalSceneRoot's
      // built-in CameraModeSwitcher, not a Hub deep-link.
      return [{ key: 'open', label: 'Öffnen', kind: 'primary' }]
    case 'quoting':
      return [
        { key: 'quote', label: 'Angebot', kind: 'primary' },
        { key: 'bom', label: 'Stückliste', kind: 'soft' },
      ]
    case 'aktiv':
      return [
        { key: 'open', label: 'Öffnen', kind: 'primary' },
        { key: 'photo', label: 'Foto', kind: 'ghost' },
      ]
    case 'fertig':
      return [
        { key: 'open', label: 'Prüfen', kind: 'primary' },
        { key: 'archive', label: 'Archiv', kind: 'ghost' },
      ]
  }
}

const STAGE_LABEL: Record<HubPipelineStage, string> = {
  neu: 'Neu',
  quoting: 'Angebot',
  aktiv: 'Aktiv',
  fertig: 'Fertig',
}

const STAGE_ORDER: HubPipelineStage[] = ['neu', 'quoting', 'aktiv', 'fertig']

/** Map a job's dominant critical urgency onto the card top-border hint. */
function cardUrgency(job: ProviderHubJobInput, dominant: ScoredSignal | null): HubUrgency {
  if (job.stage === 'fertig' && !dominant) return 'grey'
  if (dominant?.urgency === 'red') return 'red'
  if (dominant?.urgency === 'amber') return 'amber'
  if (dominant) return 'grey'
  return 'green'
}

// ── public builder ───────────────────────────────────────────────────────────

/** Max critical-action cards on the dashboard (provider-hub-spec §3.2). */
export const HUB_CRITICAL_MAX = 4
/** Activity-feed cap on the dashboard (provider-hub-spec §3.4 — last 20). */
export const HUB_FEED_MAX = 20

/**
 * Build the full 3-layer Provider-Hub view model from the normalised job list.
 * Pure + deterministic — identical input yields identical output.
 */
export function buildProviderHubModel(jobs: ProviderHubJobInput[]): ProviderHubModel {
  // Layer 1 — critical actions: dominant signal per job, top 4 by job score.
  const scored = jobs
    .map((job) => ({ job, signals: scoreSignals(job), total: jobScore(job) }))
    .filter((e) => e.signals.length > 0)
    .sort((a, b) => b.total - a.total)

  const criticalActions: HubCriticalAction[] = scored
    .slice(0, HUB_CRITICAL_MAX)
    .map((e) => {
      const dom = e.signals[0]
      return {
        jobId: e.job.jobId,
        score: e.total,
        urgency: dom.urgency,
        text: dom.text,
        meta: dom.meta,
        ctaLabel: dom.ctaLabel,
        targetTab: dom.targetTab,
      }
    })

  // Layer 2 — pipeline: fixed 4 columns, urgency-sorted within each.
  const dominantByJob = new Map<string, ScoredSignal | null>()
  for (const job of jobs) {
    const sigs = scoreSignals(job)
    dominantByJob.set(job.jobId, sigs[0] ?? null)
  }

  const pipeline: HubPipelineColumn[] = STAGE_ORDER.map((stage) => {
    const stageJobs = jobs.filter((j) => j.stage === stage)
    const cards: HubJobCard[] = stageJobs
      .map((job) => {
        const dom = dominantByJob.get(job.jobId) ?? null
        return {
          jobId: job.jobId,
          sceneId: job.sceneId,
          sourceScanId: job.sourceScanId,
          title: job.title,
          customerName: job.customerName,
          locationLabel: job.locationLabel,
          areaM2: job.areaM2,
          roomLabel: job.roomLabel,
          priority: job.priority,
          urgency: cardUrgency(job, dom),
          events: job.recentEvents.slice(0, 2),
          quickActions: quickActionsForStage(stage),
        }
      })
      .sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency))
    return { stage, label: STAGE_LABEL[stage], count: cards.length, cards }
  })

  // Layer 3 — activity feed: merge every job's events, newest first.
  const activityFeed = jobs
    .flatMap((j) => j.recentEvents)
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, HUB_FEED_MAX)

  return {
    criticalActions,
    criticalActionsTotal: scored.length,
    pipeline,
    activityFeed,
    // Spec §13 PH-8: critical-action count + jobs awaiting a worker-pin review.
    tabBadgeCount:
      criticalActions.length +
      jobs.filter(
        (j) =>
          j.signals.workerPinsUnreviewed > 0 &&
          !criticalActions.some((c) => c.jobId === j.jobId),
      ).length,
    totalJobs: jobs.length,
  }
}

/** Sort weight so urgent cards float to the top of a pipeline column. */
function urgencyRank(u: HubUrgency): number {
  return { red: 0, amber: 1, green: 2, grey: 3 }[u]
}

/** True when nothing is urgent — Hub Layer 1 collapses to the calm card. */
export function isHubCalm(model: ProviderHubModel): boolean {
  return model.criticalActions.length === 0
}

// ── signal computation (Phase C · C-8 · Seam 1) ──────────────────────────────

/** Scene fields the signal computation reads (structural subset of SpatialScene). */
export interface JobSignalScene {
  validationState: string
  customerVerifyState: string
  customerVerifyLastActiveAt: string | null
}

/** Everything {@link computeJobSignals} needs — all fetched by the hook layer. */
export interface ComputeJobSignalsInput {
  scene: JobSignalScene
  editHistory: SpatialEditHistoryEntry[]
  changeOrders: SpatialChangeOrder[]
  rescanRequests: SpatialRescanRequest[]
  pinReviews: PinReview[]
  /** auth uids of the org's worker team members. */
  workerActorIds: ReadonlySet<string>
  /** True when a quote (offer) has been sent for the job. */
  quoteSent: boolean
  /** `Date.now()` — injected for deterministic tests. */
  nowMs: number
}

const HOUR_MS = 3_600_000

/**
 * Compute the cross-domain critical-action signals for one job from data the
 * hook layer has already fetched. Pure + deterministic.
 *
 * Two signals have no clean persisted source and stay at a safe default
 * (documented inline): `quoteDeadlineHrs` (no per-job quote-send deadline is
 * stored) and `bomError` (the BoM is computed client-side).
 */
export function computeJobSignals(input: ComputeJobSignalsInput): ProviderHubJobSignals {
  const {
    scene,
    editHistory,
    changeOrders,
    rescanRequests,
    pinReviews,
    workerActorIds,
    quoteSent,
    nowMs,
  } = input

  const reviewedNodes = new Set(pinReviews.map((r) => r.annotationNodeId))

  // Worker pins not yet reviewed — distinct by node, tracking the oldest.
  const unreviewedWorkerNodes = new Map<string, number>()
  for (const e of editHistory) {
    if (!e.actorId || !workerActorIds.has(e.actorId)) continue
    if (reviewedNodes.has(e.baseNodeId)) continue
    const ts = Date.parse(e.createdAt)
    const at = Number.isFinite(ts) ? ts : nowMs
    const prev = unreviewedWorkerNodes.get(e.baseNodeId)
    if (prev === undefined || at < prev) unreviewedWorkerNodes.set(e.baseNodeId, at)
  }
  const workerPinsUnreviewed = unreviewedWorkerNodes.size
  const workerPinsUnreviewedHrs =
    unreviewedWorkerNodes.size > 0
      ? (nowMs - Math.min(...unreviewedWorkerNodes.values())) / HOUR_MS
      : null

  // A high-severity customer pin whose node has not been reviewed.
  const highSeverityPinUnread = editHistory.some((e) => {
    if (e.actorId && workerActorIds.has(e.actorId)) return false
    if (reviewedNodes.has(e.baseNodeId)) return false
    const sev = deriveAnnotationSeverity(e)
    return sev === 'high' || sev === 'critical'
  })

  // Oldest pending re-scan request still awaiting the customer.
  const pendingRescans = rescanRequests
    .filter((r) => r.status === 'pending')
    .map((r) => Date.parse(r.createdAt))
    .filter((t) => Number.isFinite(t))
  const rescanResponsePendingHrs =
    pendingRescans.length > 0 ? (nowMs - Math.min(...pendingRescans)) / HOUR_MS : null

  // The customer approved the scan and no quote is out yet → they are waiting.
  let customerWaitingHrs: number | null = null
  if (
    scene.customerVerifyState === 'approved' &&
    !quoteSent &&
    scene.customerVerifyLastActiveAt
  ) {
    const since = Date.parse(scene.customerVerifyLastActiveAt)
    if (Number.isFinite(since)) customerWaitingHrs = (nowMs - since) / HOUR_MS
  }

  return {
    customerWaitingHrs,
    // No per-job quote-send deadline is persisted — left null deliberately.
    quoteDeadlineHrs: null,
    quoteSent,
    workerPinsUnreviewed,
    workerPinsUnreviewedHrs,
    rescanResponsePendingHrs,
    highSeverityPinUnread,
    changeOrderPending: changeOrders.some((c) => c.status === 'proposed'),
    // The BoM is computed client-side — there is no persisted failure state.
    bomError: false,
    validatorWarnings: scene.validationState === 'passed_with_warnings' ? 1 : 0,
  }
}
