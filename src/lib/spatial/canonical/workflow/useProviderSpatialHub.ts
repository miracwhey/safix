/**
 * Spatial · Canonical · Workflow · useProviderSpatialHub (Phase B · B-1 →
 * Phase C · C-8)
 *
 * React hook backing the Provider Spatial Hub dashboard (Mockup 18/19). It:
 *   1. resolves the signed-in owner's provider-org id (C-0),
 *   2. loads that org's spatial scenes via `listByProviderOrg`,
 *   3. for each scene, fetches edit-history / change-orders / re-scan requests
 *      / pin-reviews and derives the real critical-action signals (C-8),
 *   4. loads the jobs domain to enrich each scene + resolve offer-aware stage,
 *   5. hands the normalised list to {@link buildProviderHubModel}.
 *
 * Phase-C wired (C-8 · Seam 1): the critical-action signals are now real, so
 * the Hub's Layer-1 critical actions + the calm card are live. Two signals
 * have no clean source and stay defaulted (`quoteDeadlineHrs`, `bomError` —
 * see `computeJobSignals`).
 */

import { useEffect, useMemo, useState } from 'react'
import { getJobs, subscribeJobs, getTeamMembers } from '../../../jobs/jobsStore.ts'
import type { Job } from '../../../jobs/types.ts'
import {
  getAcceptedOfferByJobId,
  getActiveOfferForConversation,
  getOfferById,
} from '../../../offers/service.ts'
import { getSpatialSceneRepository } from '../repository/registry.ts'
import type { SpatialScene } from '../repository/SpatialSceneRepository.ts'
import { getPresalesProjectRepository } from '../../../presales/repository/registry'
import type { PresalesProject } from '../../../../domain/presales/presalesProjectTypes'
import {
  buildProviderHubModel,
  computeJobSignals,
  type HubActivityEvent,
  type HubActorKind,
  type HubPipelineStage,
  type ProviderHubJobInput,
  type ProviderHubJobSignals,
  type ProviderHubModel,
} from './providerHubModel.ts'
import { useProviderOrgId } from './resolveProviderOrg.ts'

/** A job that has no spatial scene yet — Mockup 19 State B. */
export interface HubJobWithoutScan {
  jobId: string
  title: string
  customerName: string
  locationLabel: string
  /** Customer device capability — Phase C wires the real value. */
  deviceCapability: 'lidar' | 'photo' | 'unknown'
}

/**
 * L2-C · 3-Tab-Hub-Layout. Each tab owns a distinct slice of the provider's
 * spatial work:
 *
 *  - `projekte`  jobs with a hydrated SpatialScene (the production Hub view)
 *  - `anfragen`  Pre-Sales aufmaße that carry customer-anchor draft data
 *  - `privat`    Pre-Sales aufmaße the provider captured for themselves
 */
export type HubTab = 'anfragen' | 'projekte' | 'privat'

export const HUB_TABS: HubTab[] = ['anfragen', 'projekte', 'privat']

/**
 * `'first-login'` (whole-Hub empty) is now `'all-empty'`. `'presales-only'`
 * (Lane-1 Hotfix #933) is gone — the Privat / Anfragen tabs render that
 * content per-tab instead. `'jobs-without-scan'` and `'none'` remain
 * Projekte-Tab-scoped.
 */
export type HubEmptyKind =
  | 'none'
  | 'jobs-without-scan'
  | 'all-empty'

export interface ProviderSpatialHubState {
  loading: boolean
  error: string | null
  emptyKind: HubEmptyKind
  model: ProviderHubModel
  jobsWithoutScan: HubJobWithoutScan[]
  /** V1.5: provider-pre-sales-projects (jobless 3D aufmaße), newest first. */
  presalesProjects: PresalesProject[]
  /**
   * Pre-Sales-Aufmaße ohne Kundenanker (kein Name/E-Mail/Telefon im Draft).
   * Speist den Privat-Tab (L2-C).
   */
  presalesPrivat: PresalesProject[]
  /**
   * Pre-Sales-Aufmaße mit Kunden-Draft-Daten (Name ODER E-Mail ODER Telefon).
   * Speist den Anfragen-Tab (L2-C).
   */
  presalesAnfragen: PresalesProject[]
  orgLabel: string | null
}

/**
 * Klassifikation: ein Pre-Sales-Aufmaß zählt als Kunden-Anfrage, sobald der
 * Provider einen Anker im Draft gesetzt hat (Name / E-Mail / Telefon).
 * Frontend-only (kein DB-Feld) — sobald der Provider Daten ergänzt, wandert
 * der Row beim nächsten Reload vom Privat- in den Anfragen-Tab.
 */
export function hasCustomerData(p: PresalesProject): boolean {
  return Boolean(p.customerNameDraft || p.customerEmailDraft || p.customerPhoneDraft)
}

/**
 * Filtert Presales auf "im 3-Tab-Hub sichtbar". `converted` + `archived`
 * tauchen nur im Pre-Sales-List-Screen auf (L2-E).
 */
function isHubVisible(p: PresalesProject): boolean {
  return p.status !== 'converted' && p.status !== 'archived'
}

/**
 * Parse the `?tab=` query-string value into a {@link HubTab}. Unknown / missing
 * values resolve to `null` so the caller can fall back to the data-aware
 * default.
 */
export function parseHubTab(raw: string | null | undefined): HubTab | null {
  return raw && (HUB_TABS as readonly string[]).includes(raw) ? (raw as HubTab) : null
}

/**
 * Default-Tab-Ableitung wenn kein `?tab=` in der URL steht. Privat ist die
 * Discoverability-Default (D-2): wer 0 Projekte + 0 Anfragen hat, landet
 * automatisch im Privat-Tab und sieht den Beispiel-Raum-Hero (L2-D).
 */
export function deriveDefaultHubTab(state: {
  projektCount: number
  anfragenCount: number
}): HubTab {
  if (state.projektCount > 0) return 'projekte'
  if (state.anfragenCount > 0) return 'anfragen'
  return 'privat'
}

/**
 * Hub-Card-Hydration (Ü-05): translate a `RoomScene.category` string into the
 * short German label rendered on the JobCard. `'other'` and unknown values
 * return `null` so the dot-separator + label span collapse to nothing.
 *
 * Exported for unit tests; not consumed elsewhere yet.
 */
export function categoryToLabel(category: unknown): string | null {
  switch (category) {
    case 'bathroom':
      return 'Bad'
    case 'kitchen':
      return 'Küche'
    case 'living':
      return 'Wohnzimmer'
    case 'bedroom':
      return 'Schlafzimmer'
    case 'hallway':
      return 'Flur'
    case 'office':
      return 'Büro'
    case 'storage':
      return 'Abstellraum'
    default:
      return null
  }
}

/** Type-guarded read of `scene.metadata.computed_area_m2`. Backward-compat: pre-Ü-05 rows have an empty metadata object → `null`. */
function readAreaM2(metadata: Record<string, unknown>): number | null {
  const v = metadata.computed_area_m2
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const ZERO_SIGNALS: ProviderHubJobSignals = {
  customerWaitingHrs: null,
  quoteDeadlineHrs: null,
  quoteSent: false,
  workerPinsUnreviewed: 0,
  workerPinsUnreviewedHrs: null,
  rescanResponsePendingHrs: null,
  highSeverityPinUnread: false,
  changeOrderPending: false,
  bomError: false,
  validatorWarnings: 0,
}

const EMPTY_MODEL: ProviderHubModel = {
  criticalActions: [],
  criticalActionsTotal: 0,
  pipeline: [
    { stage: 'neu', label: 'Neu', count: 0, cards: [] },
    { stage: 'quoting', label: 'Angebot', count: 0, cards: [] },
    { stage: 'aktiv', label: 'Aktiv', count: 0, cards: [] },
    { stage: 'fertig', label: 'Fertig', count: 0, cards: [] },
  ],
  activityFeed: [],
  tabBadgeCount: 0,
  totalJobs: 0,
}

/** Per-scene signal payload computed by the loading effect. */
interface SceneSignals {
  sceneId: string
  signals: ProviderHubJobSignals
  feed: HubActivityEvent[]
}

/** True when the job carries a sent-but-not-accepted quote (offers domain). */
function hasPendingQuote(job: Job): boolean {
  if (job.sourceOfferId) {
    const offer = getOfferById(job.sourceOfferId)
    if (offer?.status === 'pending') return true
  }
  if (job.sourceConversationId && getActiveOfferForConversation(job.sourceConversationId)) {
    return true
  }
  return false
}

/** True when a quote (pending or accepted) exists for the job. */
function quoteSentForJob(job: Job): boolean {
  return hasPendingQuote(job) || getAcceptedOfferByJobId(job.id) !== undefined
}

/**
 * Map a SaFix job onto a Hub pipeline column — offer-aware (C-8): a job with a
 * sent-but-not-accepted quote sits in `quoting`, otherwise an active job is
 * `aktiv`. Without this the `quoting` column never fills.
 */
function stageForJob(job: Job): HubPipelineStage {
  if (job.status === 'new') return 'neu'
  if (job.status === 'completed' || job.status === 'cancelled') return 'fertig'
  return hasPendingQuote(job) ? 'quoting' : 'aktiv'
}

/** auth uids of the org's worker team members — drives the worker-pin signal. */
function workerActorIdSet(): Set<string> {
  const ids = new Set<string>()
  for (const m of getTeamMembers()) {
    if (m.role === 'worker' && m.userId) ids.add(m.userId)
  }
  return ids
}

/** Relative-time label for the activity feed ("8 Min", "3 Std", "gestern"). */
function agoLabel(fromMs: number, nowMs: number): string {
  const min = Math.max(0, Math.round((nowMs - fromMs) / 60_000))
  if (min < 1) return 'gerade eben'
  if (min < 60) return `${min} Min`
  const hrs = Math.round(min / 60)
  if (hrs < 24) return `${hrs} Std`
  const days = Math.round(hrs / 24)
  return days === 1 ? 'gestern' : `${days} Tage`
}

/** First clause of a location string ("Hamburg-Altona, …" → "Hamburg-Altona"). */
function shortLocation(location: string): string {
  return location.split(',')[0]?.trim() ?? location
}

/** Build the activity feed for one scene from its (already fetched) history. */
function feedFromHistory(
  history: { id: string; command: string; createdAt: string; actorId: string | null }[],
  job: Job,
  nowMs: number,
): HubActivityEvent[] {
  return history.map((h) => {
    const actorKind: HubActorKind = h.actorId === null ? 'system' : 'team'
    const atMs = Date.parse(h.createdAt)
    const at = Number.isNaN(atMs) ? nowMs : atMs
    return {
      id: h.id,
      jobId: job.id,
      jobLabel: job.title,
      actorKind,
      text:
        h.command === 'delete'
          ? 'Element entfernt'
          : h.command === 'restore'
            ? 'Änderung zurückgenommen'
            : 'Szene bearbeitet',
      atMs: at,
      agoLabel: agoLabel(at, nowMs),
    }
  })
}

/**
 * Edit-history fetch bound for signal computation. The repository's Supabase
 * impl defaults to 100 rows — too low: `computeJobSignals` counts distinct
 * unreviewed worker pins across the FULL history, so the 100-newest cap would
 * undercount (and mis-age) signals on a busy scene. Big enough to cover any
 * realistic single-scene history.
 */
const SIGNAL_EDIT_HISTORY_LIMIT = 2000

export function useProviderSpatialHub(): ProviderSpatialHubState {
  const [jobs, setJobs] = useState<Job[]>(() => getJobs())
  const [scenes, setScenes] = useState<SpatialScene[] | null>(null)
  const [feed, setFeed] = useState<HubActivityEvent[]>([])
  const [signalsByScene, setSignalsByScene] = useState<Map<string, ProviderHubJobSignals>>(
    () => new Map(),
  )
  const [presalesFromServer, setPresalesFromServer] = useState<PresalesProject[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Keep the jobs snapshot live.
  useEffect(() => subscribeJobs(() => setJobs(getJobs())), [])

  const { orgId: providerOrgId, resolving: orgResolving } = useProviderOrgId()

  // V1.5: load provider's presales projects (jobless 3D aufmaße). When no
  // provider-org is resolved yet, presalesProjects is derived to [] below
  // (see `presalesProjects` memo) so the loading-gate doesn't deadlock.
  useEffect(() => {
    if (!providerOrgId) return
    let cancelled = false
    void getPresalesProjectRepository()
      .list({ providerOrgId, excludeArchived: true })
      .then((rows) => {
        if (!cancelled) setPresalesFromServer(rows)
      })
      .catch(() => {
        if (!cancelled) setPresalesFromServer([])
      })
    return () => {
      cancelled = true
    }
  }, [providerOrgId])

  // Load this org's scenes + per-scene signals + activity feed.
  useEffect(() => {
    if (!providerOrgId) return
    let cancelled = false
    const repo = getSpatialSceneRepository()
    repo
      .listByProviderOrg(providerOrgId)
      .then(async (loaded) => {
        if (cancelled) return
        const nowMs = Date.now()
        const jobById = new Map(getJobs().map((j) => [j.id, j]))
        const workerActorIds = workerActorIdSet()

        const perScene: SceneSignals[] = await Promise.all(
          loaded.map(async (scene): Promise<SceneSignals> => {
            const job = scene.sourceJobId ? jobById.get(scene.sourceJobId) : undefined
            const [editHistory, changeOrders, rescanRequests, pinReviews] =
              await Promise.all([
                repo.listEditHistory(scene.id, SIGNAL_EDIT_HISTORY_LIMIT).catch(() => []),
                repo.listChangeOrders(scene.id).catch(() => []),
                repo.listRescanRequests(scene.id).catch(() => []),
                repo.listPinReviews(scene.id).catch(() => []),
              ])
            const signals = computeJobSignals({
              scene: {
                validationState: scene.validationState,
                customerVerifyState: scene.customerVerifyState,
                customerVerifyLastActiveAt: scene.customerVerifyLastActiveAt,
              },
              editHistory,
              changeOrders,
              rescanRequests,
              pinReviews,
              workerActorIds,
              quoteSent: job ? quoteSentForJob(job) : false,
              nowMs,
            })
            const feedEvents = job
              ? feedFromHistory(editHistory.slice(0, 10), job, nowMs)
              : []
            return { sceneId: scene.id, signals, feed: feedEvents }
          }),
        )

        if (cancelled) return
        setError(null)
        setScenes(loaded)
        setFeed(perScene.flatMap((p) => p.feed))
        setSignalsByScene(new Map(perScene.map((p) => [p.sceneId, p.signals])))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setScenes([])
        setFeed([])
        setSignalsByScene(new Map())
        setError(
          err instanceof Error ? err.message : 'Spatial-Jobs konnten nicht geladen werden',
        )
      })
    return () => {
      cancelled = true
    }
  }, [providerOrgId])

  return useMemo<ProviderSpatialHubState>(() => {
    // When no provider-org has resolved yet, presales is implicitly empty
    // (the loader effect is gated on `providerOrgId`).
    const presalesProjects: PresalesProject[] | null = providerOrgId
      ? presalesFromServer
      : []
    const loading =
      orgResolving ||
      (providerOrgId !== null && (scenes === null || presalesProjects === null))
    const sceneList = scenes ?? []
    const presalesList = presalesProjects ?? []

    const sceneByJob = new Map<string, SpatialScene>()
    for (const scene of sceneList) {
      if (scene.sourceJobId) sceneByJob.set(scene.sourceJobId, scene)
    }
    const feedByJob = new Map<string, HubActivityEvent[]>()
    for (const ev of feed) {
      const list = feedByJob.get(ev.jobId) ?? []
      list.push(ev)
      feedByJob.set(ev.jobId, list)
    }

    const scannedJobs = jobs.filter((j) => sceneByJob.has(j.id))
    const unscannedJobs = jobs.filter(
      (j) => !sceneByJob.has(j.id) && j.status !== 'completed' && j.status !== 'cancelled',
    )

    const inputs: ProviderHubJobInput[] = scannedJobs.map((job) => {
      const scene = sceneByJob.get(job.id)!
      const events = (feedByJob.get(job.id) ?? []).sort((a, b) => b.atMs - a.atMs)
      return {
        jobId: job.id,
        sceneId: scene.id,
        sourceScanId: scene.sourceScanId,
        title: job.title,
        customerName: job.customer,
        locationLabel: shortLocation(job.location),
        areaM2: readAreaM2(scene.metadata),
        roomLabel: categoryToLabel(scene.metadata.category),
        priority: 'mid',
        stage: stageForJob(job),
        signals: signalsByScene.get(scene.id) ?? ZERO_SIGNALS,
        recentEvents: events,
      }
    })

    const model = inputs.length > 0 ? buildProviderHubModel(inputs) : EMPTY_MODEL

    // L2-C: split the Pre-Sales list along the customer-anchor seam so the
    // Privat / Anfragen tabs can render distinct content without a second
    // round-trip. `converted` + `archived` rows live exclusively in the
    // Pre-Sales list screen (L2-E).
    const hubVisiblePresales = presalesList.filter(isHubVisible)
    const presalesPrivat = hubVisiblePresales.filter((p) => !hasCustomerData(p))
    const presalesAnfragen = hubVisiblePresales.filter(hasCustomerData)

    let emptyKind: HubEmptyKind = 'none'
    if (!loading && inputs.length === 0) {
      if (unscannedJobs.length > 0) emptyKind = 'jobs-without-scan'
      else if (presalesList.length === 0) emptyKind = 'all-empty'
      // Otherwise the Projekte-Tab is empty but Privat / Anfragen carry rows
      // — `emptyKind` stays `'none'`; the screen falls back to the
      // jobs-without-scan placeholder inside the Projekte tab specifically.
    }

    const jobsWithoutScan: HubJobWithoutScan[] = unscannedJobs.map((job) => ({
      jobId: job.id,
      title: job.title,
      customerName: job.customer,
      locationLabel: shortLocation(job.location),
      deviceCapability: 'unknown',
    }))

    return {
      loading,
      error,
      emptyKind,
      model,
      jobsWithoutScan,
      presalesProjects: presalesList,
      presalesPrivat,
      presalesAnfragen,
      orgLabel: null,
    }
  }, [providerOrgId, orgResolving, scenes, presalesFromServer, jobs, feed, signalsByScene, error])
}
