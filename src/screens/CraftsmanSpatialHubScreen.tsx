/**
 * CraftsmanSpatialHubScreen — Provider Spatial Hub · Dashboard (Phase B · B-1
 * → V1.5 · Phase B-P3)
 *
 * The provider business's central 3-layer spatial workspace (Mockup 18):
 *   Layer 1 · Critical-Actions  — score-priorised, max 4 (or calm card)
 *   Layer 2 · Pipeline-Kanban   — 4 columns, horizontally scrollable
 *   Layer 3 · Activity-Feed     — recent events, actor-filtered
 *
 * V1.5 additions:
 *   - Header Search-Icon  → opens {@link HubSearchSheet} (jobs + presales)
 *   - Header Filter-Icon  → opens {@link HubFilterSheet} (status/date/source)
 *   - emptyKind='presales-only' → Pre-Sales-anchored empty replaces FirstLogin
 *   - FirstLoginEmpty CTAs trigger {@link useStartPresalesRoomScan}
 *   - "Meine Aufmaße" section between Pipeline + Activity when presales rows exist
 *
 * Route: /craftsman/spatial · reached from the Backoffice Spatial card.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Box,
  Camera,
  CheckCircle2,
  ClipboardList,
  Clock,
  Cpu,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  User,
} from 'lucide-react'
import { useSmartBack } from '../hooks/useSmartBack'
import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import {
  HubSearchSheet,
  type HubSearchJob,
} from '../components/spatial/hub/HubSearchSheet'
import { HubFilterSheet } from '../components/spatial/hub/HubFilterSheet'
import {
  DEFAULT_HUB_FILTER,
  isHubFilterActive,
  type HubFilterValue,
} from '../components/spatial/hub/hubFilterModel'
import { SpatialThumbnail } from '../components/spatial/SpatialThumbnail'
import { PresalesProjectThumbnail } from '../components/spatial/PresalesProjectThumbnail'
import PresalesMultiModeViewerHost from '../components/spatial/PresalesMultiModeViewerHost'
import { RoomCreationChoiceSheet } from '../components/spatial/hub/RoomCreationChoiceSheet'
import { useHaptics } from '../hooks/useHaptics'
import { useSession } from '../hooks/useSession'
import { useStartPresalesRoomScan } from '../hooks/useStartPresalesRoomScan'
import {
  useProviderSpatialHub,
  type HubJobWithoutScan,
  type HubTab,
  parseHubTab,
  deriveDefaultHubTab,
} from '../lib/spatial/canonical/workflow/useProviderSpatialHub'
import { HubTabBar } from '../components/spatial/hub/HubTabBar'
import { HubPrivatEmpty } from '../components/spatial/hub/HubPrivatEmpty'
import { HubAnfragenEmpty } from '../components/spatial/hub/HubAnfragenEmpty'
import { ResumePendingScanSheet } from '../components/spatial/recovery/ResumePendingScanSheet'
import { useResumePendingCaptures } from '../hooks/useResumePendingCaptures'
import { useStartEmptyRoomProject } from '../hooks/useStartEmptyRoomProject'
import type {
  HubActivityEvent,
  HubActorKind,
  HubCriticalAction,
  HubCriticalUrgency,
  HubJobCard,
  HubPipelineColumn,
  HubPipelineStage,
  HubUrgency,
} from '../lib/spatial/canonical/workflow/providerHubModel'
import type { PresalesProject } from '../domain/presales/presalesProjectTypes'

// ── colour maps (Mockup 18 design tokens) ───────────────────────────────────

const CRIT_EDGE: Record<HubCriticalUrgency, string> = {
  red: '#DC2626',
  amber: '#F59E0B',
  grey: '#94A3B8',
}
const CRIT_ICON_BG: Record<HubCriticalUrgency, string> = {
  red: '#FEE2E2',
  amber: '#FEF3C7',
  grey: '#ECEFF4',
}
const CRIT_ICON_FG: Record<HubCriticalUrgency, string> = {
  red: '#DC2626',
  amber: '#B45309',
  grey: '#475569',
}
const CARD_EDGE: Record<HubUrgency, string> = {
  red: '#DC2626',
  amber: '#F59E0B',
  green: '#047857',
  grey: '#E2E8F0',
}
const PIPE_DOT: Record<string, string> = {
  neu: '#2563EB',
  quoting: '#F59E0B',
  aktiv: '#2563EB',
  fertig: '#94A3B8',
}
const FEED_AVA: Record<HubActorKind, { bg: string; fg: string }> = {
  kunde: { bg: '#E5EDFB', fg: '#2563EB' },
  team: { bg: '#D1FAE5', fg: '#047857' },
  system: { bg: '#ECEFF4', fg: '#475569' },
}

const FEED_FILTERS: { key: 'all' | HubActorKind; label: string }[] = [
  { key: 'all', label: 'Alle' },
  { key: 'kunde', label: 'Kunde' },
  { key: 'team', label: 'Team' },
  { key: 'system', label: 'System' },
]

// ── glyphs (module-level static components) ─────────────────────────────────

function CritGlyph({ action }: { action: HubCriticalAction }) {
  if (action.ctaLabel === 'Antworten' || action.urgency === 'red')
    return <AlertTriangle size={17} />
  if (action.ctaLabel === 'Angebot') return <Clock size={17} />
  if (action.ctaLabel === 'Review') return <ShieldCheck size={17} />
  return <ClipboardList size={17} />
}

function ActorGlyph({ kind }: { kind: HubActorKind }) {
  if (kind === 'kunde') return <User size={14} />
  if (kind === 'team') return <Activity size={14} />
  return <Cpu size={14} />
}

// ── filter helpers ──────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

function dateWindowMs(window: HubFilterValue['date']): number | null {
  switch (window) {
    case 'today':
      return DAY_MS
    case 'week':
      return 7 * DAY_MS
    case 'month':
      return 30 * DAY_MS
    case 'all':
    default:
      return null
  }
}

function cardLatestMs(card: HubJobCard, fallback: number): number {
  if (card.events.length === 0) return fallback
  return Math.max(...card.events.map((e) => e.atMs))
}

function presalesLatestMs(project: PresalesProject, fallbackMs: number): number {
  const parsed = Date.parse(project.updatedAt)
  return Number.isFinite(parsed) ? parsed : fallbackMs
}

/**
 * Read the current epoch-ms via `useSyncExternalStore` so `react-hooks/purity`
 * stays happy. No subscription tick — value is captured on each render.
 */
function useNowMs(): number {
  return useSyncExternalStore(
    () => () => {},
    () => Date.now(),
    () => Date.now(),
  )
}

// ── screen ──────────────────────────────────────────────────────────────────

/**
 * Remount the whole subtree when the signed-in user changes so no stale
 * provider-org scene state survives an account switch (Phase C · C-0).
 */
export default function CraftsmanSpatialHubScreen() {
  const { user } = useSession()
  return <CraftsmanSpatialHubScreenInner key={user?.id ?? 'anon'} />
}

function CraftsmanSpatialHubScreenInner() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/backoffice')
  const haptics = useHaptics()
  const {
    loading,
    error,
    emptyKind,
    model,
    jobsWithoutScan,
    presalesProjects,
    presalesPrivat,
    presalesAnfragen,
  } = useProviderSpatialHub()
  const { startPresalesScan, busy: presalesScanBusy, lidarAvailable } =
    useStartPresalesRoomScan()
  // Lane-2.5 · Stream B · Manual-Start CTAs on the Privat-tab empty-state.
  const { startEmptyRoom, busy: emptyRoomBusy } = useStartEmptyRoomProject()
  const [feedFilter, setFeedFilter] = useState<'all' | HubActorKind>('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  // "+" → Manuell/Scannen fork (replaces the old direct-scan "+").
  const [creationSheetOpen, setCreationSheetOpen] = useState(false)
  const [filter, setFilter] = useState<HubFilterValue>(DEFAULT_HUB_FILTER)
  // One-tap 3D: the tapped own-room project whose multi-mode viewer is open.
  const [view3dProjectId, setView3dProjectId] = useState<string | null>(null)

  // Lane-2.5 · Stream A · Resume pending captures. The hook lists IDB-cached
  // USDZ blobs that never made it to Supabase Storage (network blip, app kill,
  // tab close). The sheet is auto-shown on first non-empty list per session;
  // the "Später erinnern" / close action sets `resumeSheetDismissed` so a
  // subsequent live event (new failure) doesn't pop the sheet again until the
  // user navigates away and back.
  const {
    entries: resumableCaptures,
    busyScanIds: resumableBusyScanIds,
    resume: resumeCapture,
    discard: discardCapture,
  } = useResumePendingCaptures()
  const [resumeSheetDismissed, setResumeSheetDismissed] = useState(false)
  const showResumeSheet =
    !resumeSheetDismissed && resumableCaptures.length > 0

  // L2-C: Tab-State via URL-Param `?tab=`. `replace: true` beim Switch hält
  // den Back-Button-Stack flach — User navigiert vertikal zum Hub und
  // horizontal zwischen Tabs ohne Browser-History-Pollution.
  const [searchParams, setSearchParams] = useSearchParams()
  const urlTab = parseHubTab(searchParams.get('tab'))
  const defaultTab = useMemo(
    () =>
      deriveDefaultHubTab({
        projektCount: model.totalJobs,
        anfragenCount: presalesAnfragen.length,
      }),
    [model.totalJobs, presalesAnfragen.length],
  )
  const activeTab: HubTab = urlTab ?? defaultTab
  const setActiveTab = useCallback(
    (next: HubTab) => {
      haptics.selection()
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set('tab', next)
          return params
        },
        { replace: true },
      )
    },
    [haptics, setSearchParams],
  )

  const triggerPresalesScan = useCallback(() => {
    haptics.selection()
    void startPresalesScan({
      // L2-E: nach erfolgreichem Scan direkt zum frischen Detail-Screen
      // navigieren statt zur Liste — der User sieht sofort sein 3D-Modell.
      onSuccess: (project) => {
        navigate(`/craftsman/spatial/presales/${project.id}`)
      },
    })
  }, [haptics, startPresalesScan, navigate])

  // Lane-2.5 · Stream B — Manual-Start handlers. Both share a navigation
  // hook into the presales detail screen so the user lands directly in
  // Edit-Mode (B6 wires the origin-aware default).
  const triggerEmptyRoomTemplate = useCallback(() => {
    haptics.selection()
    void startEmptyRoom({
      variant: 'empty_room_2x2',
      onSuccess: (project, _sceneId, scene) => {
        // Optimistic-open handshake: hand the freshly-built RoomScene to the
        // detail screen so it mounts the editable Grundriss/3D/Walk viewer at
        // frame 1 — no wait on a server blob round-trip.
        navigate(`/craftsman/spatial/presales/${project.id}`, {
          state: { initialScene: scene, autoOpen3d: true, editable: true },
        })
      },
    })
  }, [haptics, startEmptyRoom, navigate])

  const triggerEmptyCanvas = useCallback(() => {
    haptics.selection()
    void startEmptyRoom({
      variant: 'empty_canvas',
      onSuccess: (project) => {
        navigate(`/craftsman/spatial/presales/${project.id}`)
      },
    })
  }, [haptics, startEmptyRoom, navigate])

  const openPresalesList = useCallback(() => {
    haptics.selection()
    navigate('/craftsman/spatial/presales')
  }, [haptics, navigate])

  // One-tap 3D from a hub card → open the multi-mode viewer for that own room.
  const openView3d = useCallback(
    (projectId: string) => {
      haptics.selection()
      setView3dProjectId(projectId)
    },
    [haptics],
  )
  const closeView3d = useCallback(() => setView3dProjectId(null), [])
  const openProjectDetailFromView3d = useCallback(
    (projectId: string) => {
      setView3dProjectId(null)
      navigate(`/craftsman/spatial/presales/${projectId}`)
    },
    [navigate],
  )

  const openJobSpatial = useCallback(
    (jobId: string, query = '') => {
      haptics.selection()
      navigate(`/craftsman/jobs/${jobId}/spatial${query}`)
    },
    [haptics, navigate],
  )

  // ── filtered model ─────────────────────────────────────────────────────────
  const dateWindow = dateWindowMs(filter.date)
  const nowMs = useNowMs()
  const filteredPipeline = useMemo<HubPipelineColumn[]>(() => {
    if (filter.source === 'presales') {
      return model.pipeline.map((col) => ({ ...col, count: 0, cards: [] }))
    }
    return model.pipeline.map((col) => {
      const passStatus =
        filter.status === 'all' || filter.status === col.stage
      if (filter.status === 'presales' || !passStatus) {
        return { ...col, count: 0, cards: [] }
      }
      const cards = col.cards.filter((card) => {
        if (dateWindow === null) return true
        return nowMs - cardLatestMs(card, nowMs) <= dateWindow
      })
      return { ...col, count: cards.length, cards }
    })
  }, [model.pipeline, filter.source, filter.status, dateWindow, nowMs])

  const filteredActivityFeed = useMemo<HubActivityEvent[]>(() => {
    if (filter.source === 'presales') return []
    return model.activityFeed.filter((ev) => {
      if (dateWindow !== null && nowMs - ev.atMs > dateWindow) return false
      return true
    })
  }, [model.activityFeed, filter.source, dateWindow, nowMs])

  const showPresalesSection =
    filter.source !== 'job' &&
    (filter.status === 'all' || filter.status === 'presales') &&
    presalesProjects.length > 0

  const filteredPresales = useMemo<PresalesProject[]>(() => {
    if (!showPresalesSection) return []
    return presalesProjects.filter((p) => {
      if (dateWindow === null) return true
      return nowMs - presalesLatestMs(p, nowMs) <= dateWindow
    })
  }, [presalesProjects, showPresalesSection, dateWindow, nowMs])

  const visibleFeed = useMemo(
    () =>
      feedFilter === 'all'
        ? filteredActivityFeed
        : filteredActivityFeed.filter((e) => e.actorKind === feedFilter),
    [filteredActivityFeed, feedFilter],
  )

  // ── search-sheet inputs ────────────────────────────────────────────────────
  const searchJobs: HubSearchJob[] = useMemo(() => {
    const scannedJobs: HubSearchJob[] = model.pipeline.flatMap((col) =>
      col.cards.map((card) => ({
        jobId: card.jobId,
        title: card.title,
        customerName: card.customerName,
        locationLabel: card.locationLabel,
        hasScene: true,
      })),
    )
    const unscanned: HubSearchJob[] = jobsWithoutScan.map((j) => ({
      jobId: j.jobId,
      title: j.title,
      customerName: j.customerName,
      locationLabel: j.locationLabel,
      hasScene: false,
    }))
    return [...scannedJobs, ...unscanned]
  }, [model.pipeline, jobsWithoutScan])

  const onSelectSearchJob = useCallback(
    (jobId: string) => {
      setSearchOpen(false)
      openJobSpatial(jobId)
    },
    [openJobSpatial],
  )
  const onSelectSearchPresales = useCallback(
    (presalesId: string) => {
      setSearchOpen(false)
      // L2-E: Such-Tap auf einen Pre-Sales-Treffer öffnet direkt das
      // Detail (war: Sprung zur Liste).
      navigate(`/craftsman/spatial/presales/${presalesId}`)
    },
    [navigate],
  )

  // ── header (shared across all states) ──────────────────────────────────────
  const filterActive = isHubFilterActive(filter)
  const header = (
    <div className="border-b border-edge bg-canvas px-5 pb-3.5 pt-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goBack}
            aria-label="Zurück"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
          >
            <ArrowLeft size={18} className="text-ink" aria-hidden />
          </button>
          <div className="flex items-baseline gap-2">
          <h1 className="text-[25px] font-bold tracking-tight text-ink">Spatial Hub</h1>
          {model.tabBadgeCount > 0 && (
            <span className="inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-chip bg-brand px-1.5 text-[11px] font-bold text-white">
              {model.tabBadgeCount}
            </span>
          )}
          </div>
        </div>
        <div className="flex gap-2">
          {emptyKind === 'none' && (
            <button
              type="button"
              aria-label="Raum anlegen"
              onClick={() => {
                haptics.selection()
                setCreationSheetOpen(true)
              }}
              disabled={presalesScanBusy || emptyRoomBusy}
              className="flex h-9 w-9 items-center justify-center rounded-[11px] border border-brand bg-brand text-white shadow-brand-glow active:scale-95 disabled:opacity-50"
            >
              <Plus size={16} />
            </button>
          )}
          <button
            type="button"
            aria-label="Suchen"
            onClick={() => {
              haptics.selection()
              setSearchOpen(true)
            }}
            className="flex h-9 w-9 items-center justify-center rounded-[11px] border border-edge bg-surface text-ink-sub shadow-subtle active:scale-95"
          >
            <Search size={16} />
          </button>
          <button
            type="button"
            aria-label={filterActive ? 'Filter aktiv — bearbeiten' : 'Filter'}
            onClick={() => {
              haptics.selection()
              setFilterOpen(true)
            }}
            className={`relative flex h-9 w-9 items-center justify-center rounded-[11px] border bg-surface text-ink-sub shadow-subtle active:scale-95 ${
              filterActive ? 'border-brand text-brand' : 'border-edge'
            }`}
          >
            <SlidersHorizontal size={16} />
            {filterActive && (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand ring-2 ring-canvas"
              />
            )}
          </button>
        </div>
      </div>
      <p className="mt-0.5 text-[12.5px] text-ink-muted">
        {emptyKind === 'none'
          ? `${model.totalJobs} Spatial-Job${model.totalJobs === 1 ? '' : 's'}${
              presalesProjects.length > 0
                ? ` · ${presalesProjects.length} Aufmaß${presalesProjects.length === 1 ? '' : 'e'}`
                : ''
            }`
          : emptyKind === 'jobs-without-scan'
            ? `${jobsWithoutScan.length} Job${jobsWithoutScan.length === 1 ? '' : 's'} · noch kein Kunden-Scan`
            : 'Dein Betrieb'}
      </p>
    </div>
  )

  const sheets = (
    <>
      {searchOpen && (
        <HubSearchSheet
          jobs={searchJobs}
          presales={presalesProjects}
          onSelectJob={onSelectSearchJob}
          onSelectPresales={onSelectSearchPresales}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {filterOpen && (
        <HubFilterSheet
          value={filter}
          onApply={(next) => {
            setFilter(next)
            setFilterOpen(false)
          }}
          onClose={() => setFilterOpen(false)}
        />
      )}
      {showResumeSheet && (
        <ResumePendingScanSheet
          entries={resumableCaptures}
          busyScanIds={resumableBusyScanIds}
          onResume={resumeCapture}
          onDiscard={discardCapture}
          onClose={() => setResumeSheetDismissed(true)}
        />
      )}
      {view3dProjectId && (
        <PresalesMultiModeViewerHost
          presalesProjectId={view3dProjectId}
          onClose={closeView3d}
          onOpenDetail={openProjectDetailFromView3d}
        />
      )}
      {creationSheetOpen && (
        <RoomCreationChoiceSheet
          lidarAvailable={lidarAvailable}
          busy={presalesScanBusy || emptyRoomBusy}
          onChooseManuell={() => {
            setCreationSheetOpen(false)
            triggerEmptyRoomTemplate()
          }}
          onChooseScan={() => {
            setCreationSheetOpen(false)
            triggerPresalesScan()
          }}
          onClose={() => setCreationSheetOpen(false)}
        />
      )}
    </>
  )

  if (loading) {
    return (
      <AppShell active="verwaltung">
        {header}
        <ScreenSkeleton variant="list" />
        {sheets}
      </AppShell>
    )
  }

  const projekteTabContent = (
    <>
      {emptyKind === 'jobs-without-scan' && (
        <JobsWithoutScanEmpty
          jobs={jobsWithoutScan}
          presalesProjects={presalesProjects}
          navigate={navigate}
          haptics={haptics}
          onStartPresales={triggerPresalesScan}
          presalesBusy={presalesScanBusy}
        />
      )}

      {emptyKind === 'all-empty' && (
        <div className="flex flex-col items-center px-6 pt-10 text-center">
          <h2 className="text-[18px] font-bold tracking-tight text-ink">
            Noch keine Projekte
          </h2>
          <p className="mt-2 max-w-[280px] text-[13px] text-ink-sub">
            Sobald ein Kunden-Auftrag mit Aufmaß bei dir landet, erscheint er
            hier. Privat-Aufmaße findest du im Privat-Tab.
          </p>
        </div>
      )}

      {emptyKind === 'none' && (
        <div className="space-y-1.5 pb-5">
          {/* ── Layer 1 · Critical actions ── */}
          <section className="px-5 pt-4">
            <LayerHead title="Dringend" count={model.criticalActionsTotal} />
            {model.criticalActions.length === 0 ? (
              <div className="flex items-center gap-3 rounded-card border border-[#BBF7D0] bg-gradient-to-br from-[#ECFDF5] to-[#F0FDF4] px-3.5 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-[#D1FAE5] text-[#047857]">
                  <CheckCircle2 size={20} />
                </span>
                <div>
                  <div className="text-[14px] font-bold text-[#065F46]">Nichts Dringendes</div>
                  <div className="mt-0.5 text-[12px] text-[#047857]">
                    Alle Kunden- und Team-Aktionen sind beantwortet.
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {model.criticalActions.map((action) => (
                  <CriticalCard
                    key={action.jobId}
                    action={action}
                    onAct={() => openJobSpatial(action.jobId, `?tab=${action.targetTab}`)}
                  />
                ))}
                {model.criticalActionsTotal > model.criticalActions.length && (
                  <p className="px-1 text-[11.5px] font-medium text-ink-muted">
                    Zeigt die {model.criticalActions.length} dringendsten von{' '}
                    {model.criticalActionsTotal} — die weiteren findest du im jeweiligen Job.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* ── Layer 2 · Pipeline ── */}
          <section className="px-5 pt-3">
            <LayerHead title="Pipeline" link="Alle Jobs" onLink={() => navigate('/craftsman/jobs')} />
            <div className="-mx-5 flex gap-3 overflow-x-auto px-5 pb-2 pt-0.5 [scrollbar-width:none]">
              {filteredPipeline.map((col) => (
                <PipelineColumn key={col.stage} col={col} onOpen={openJobSpatial} />
              ))}
            </div>
          </section>

          {/* ── Layer 2b · Pre-Sales (V1.5) ── */}
          {showPresalesSection && filteredPresales.length > 0 && (
            <section className="px-5 pt-3">
              <LayerHead
                title="Meine Aufmaße"
                count={filteredPresales.length}
                link="Alle ansehen"
                onLink={() => {
                  haptics.selection()
                  navigate('/craftsman/spatial/presales')
                }}
              />
              <div className="-mx-5 flex gap-3 overflow-x-auto px-5 pb-2 pt-0.5 [scrollbar-width:none]">
                {filteredPresales.slice(0, 6).map((p) => (
                  <PresalesPreviewCard
                    key={p.id}
                    project={p}
                    // Body-Tap → direkt Vollbild-Multi-Mode (Grundriss/3D/Walk).
                    onOpen={() => openView3d(p.id)}
                    onDetail={() => {
                      haptics.selection()
                      navigate(`/craftsman/spatial/presales/${p.id}`)
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ── Layer 3 · Activity feed ── */}
          {filter.source !== 'presales' && (
            <section className="px-5 pt-3">
              <LayerHead title="Aktivität" />
              <div className="mb-2.5 flex gap-1.5">
                {FEED_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => {
                      haptics.selection()
                      setFeedFilter(f.key)
                    }}
                    className={`rounded-chip border px-2.5 py-[5px] text-[11.5px] font-semibold transition ${
                      feedFilter === f.key
                        ? 'border-ink bg-ink text-white'
                        : 'border-edge bg-surface text-ink-sub'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {visibleFeed.length === 0 ? (
                <div className="rounded-card border border-dashed border-edge px-3 py-6 text-center text-[12px] text-ink-muted">
                  Noch keine Aktivität.
                </div>
              ) : (
                <div className="overflow-hidden rounded-card border border-edge bg-surface shadow-subtle">
                  {visibleFeed.map((ev) => (
                    <FeedRow key={ev.id} ev={ev} onOpen={() => openJobSpatial(ev.jobId)} />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </>
  )

  const anfragenTabContent =
    presalesAnfragen.length === 0 ? (
      <HubAnfragenEmpty onOpenPresalesList={openPresalesList} />
    ) : (
      <div className="flex flex-col gap-2.5 px-5 pt-4 pb-5">
        {presalesAnfragen.map((p) => (
          <PresalesPreviewCard
            key={p.id}
            project={p}
            onOpen={() => openView3d(p.id)}
            onDetail={() => {
              haptics.selection()
              navigate(`/craftsman/spatial/presales/${p.id}`)
            }}
          />
        ))}
      </div>
    )

  const privatTabContent =
    presalesPrivat.length === 0 ? (
      <HubPrivatEmpty
        onStartScan={triggerPresalesScan}
        onStartTemplate={triggerEmptyRoomTemplate}
        onStartCanvas={triggerEmptyCanvas}
        busy={presalesScanBusy}
        manualBusy={emptyRoomBusy}
        lidarAvailable={lidarAvailable}
      />
    ) : (
      <div className="flex flex-col gap-2.5 px-5 pt-4 pb-5">
        {presalesPrivat.map((p) => (
          <PresalesPreviewCard
            key={p.id}
            project={p}
            onOpen={() => openView3d(p.id)}
            onDetail={() => {
              haptics.selection()
              navigate(`/craftsman/spatial/presales/${p.id}`)
            }}
          />
        ))}
      </div>
    )

  return (
    <AppShell active="verwaltung">
      {header}

      {error && (
        <div className="mx-5 mt-4 flex items-start gap-2.5 rounded-card border border-[#FECACA] bg-[#FEE2E2] px-3 py-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
          <p className="text-[12px] leading-snug text-danger">{error}</p>
        </div>
      )}

      <HubTabBar
        activeTab={activeTab}
        onSelect={setActiveTab}
        badges={{
          anfragen: presalesAnfragen.length,
          projekte: model.criticalActionsTotal,
        }}
      />

      <div
        role="tabpanel"
        id={`hub-tabpanel-${activeTab}`}
        aria-labelledby={`hub-tab-${activeTab}`}
        tabIndex={0}
        className="outline-none"
      >
        {activeTab === 'projekte' && projekteTabContent}
        {activeTab === 'anfragen' && anfragenTabContent}
        {activeTab === 'privat' && privatTabContent}
      </div>

      {sheets}
    </AppShell>
  )
}

// ── sub-components ───────────────────────────────────────────────────────────

function LayerHead({
  title,
  count,
  link,
  onLink,
}: {
  title: string
  count?: number
  link?: string
  onLink?: () => void
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <h2 className="text-[12px] font-bold uppercase tracking-[0.7px] text-ink-sub">{title}</h2>
        {count !== undefined && (
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-chip bg-[#ECEFF4] px-1.5 text-[11px] font-bold text-ink-muted">
            {count}
          </span>
        )}
      </div>
      {link && (
        <button type="button" onClick={onLink} className="text-[12px] font-semibold text-brand">
          {link} ›
        </button>
      )}
    </div>
  )
}

function CriticalCard({ action, onAct }: { action: HubCriticalAction; onAct: () => void }) {
  return (
    <div
      className="flex items-center gap-3 rounded-card border border-edge bg-surface px-3 py-2.5 shadow-subtle"
      style={{ borderLeft: `3px solid ${CRIT_EDGE[action.urgency]}` }}
    >
      <span
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]"
        style={{ background: CRIT_ICON_BG[action.urgency], color: CRIT_ICON_FG[action.urgency] }}
      >
        <CritGlyph action={action} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium leading-snug text-ink">{action.text}</div>
        <div className="mt-0.5 text-[11px] text-ink-muted">{action.meta}</div>
      </div>
      <button
        type="button"
        onClick={onAct}
        className={`shrink-0 whitespace-nowrap rounded-[9px] px-3 py-[7px] text-[12px] font-semibold ${
          action.urgency === 'grey' ? 'bg-[#EEF2FB] text-brand' : 'bg-brand text-white'
        }`}
      >
        {action.ctaLabel}
      </button>
    </div>
  )
}

function PipelineColumn({
  col,
  onOpen,
}: {
  col: HubPipelineColumn
  onOpen: (jobId: string, query?: string) => void
}) {
  return (
    <div className="w-[224px] shrink-0">
      <div className="mb-2.5 flex items-center gap-1.5 pl-0.5">
        <span
          className="h-[7px] w-[7px] rounded-chip"
          style={{ background: PIPE_DOT[col.stage as HubPipelineStage] }}
        />
        <span className="text-[11.5px] font-bold uppercase tracking-[0.5px] text-ink-sub">
          {col.label}
        </span>
        <span className="text-[11px] font-bold text-ink-muted">{col.count}</span>
      </div>
      <div className="flex flex-col gap-2.5">
        {col.cards.length === 0 ? (
          <div className="rounded-card border border-dashed border-edge px-2 py-5 text-center text-[11px] font-medium text-ink-muted">
            Keine Jobs
          </div>
        ) : (
          col.cards.map((card) => <JobCard key={card.jobId} card={card} onOpen={onOpen} />)
        )}
      </div>
    </div>
  )
}

function JobCard({
  card,
  onOpen,
}: {
  card: HubJobCard
  onOpen: (jobId: string, query?: string) => void
}) {
  return (
    <div
      className="rounded-card border border-edge bg-surface px-2.5 pb-2.5 pt-2.5 shadow-subtle"
      style={{ borderTop: `3px solid ${CARD_EDGE[card.urgency]}` }}
    >
      <div className="flex items-start gap-2">
        {card.sourceScanId && (
          <SpatialThumbnail
            scanId={card.sourceScanId}
            alt={card.title}
            className="h-9 w-9 shrink-0 overflow-hidden rounded-[8px] bg-canvas"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-bold leading-tight tracking-tight text-ink">
            {card.title}
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-sub">
            {card.customerName} · {card.locationLabel}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] font-medium text-ink-muted">
        {card.areaM2 != null && <span>{card.areaM2} m²</span>}
        {card.roomLabel && (
          <>
            <span className="h-[2px] w-[2px] rounded-chip bg-ink-muted" />
            <span>{card.roomLabel}</span>
          </>
        )}
        <PriorityDots priority={card.priority} />
      </div>
      {card.events.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5 border-t border-[#ECEFF4] pt-2">
          {card.events.map((ev) => (
            <div key={ev.id} className="flex items-start gap-1.5 text-[10.5px] leading-snug">
              <span
                className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-chip"
                style={{ background: FEED_AVA[ev.actorKind].fg }}
              />
              <span className="text-ink-sub">{ev.text}</span>
              <span className="ml-auto whitespace-nowrap text-ink-muted">{ev.agoLabel}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex gap-1.5">
        {card.quickActions.map((qa) => (
          <button
            key={qa.key}
            type="button"
            onClick={() => onOpen(card.jobId, qa.key === 'bom' ? '?tab=bom' : '')}
            className={`min-w-0 flex-1 rounded-[8px] px-1 py-1.5 text-center text-[11px] font-semibold leading-tight ${
              qa.kind === 'primary'
                ? 'bg-brand text-white'
                : qa.kind === 'ghost'
                  ? 'border border-edge bg-canvas text-ink-sub'
                  : 'bg-[#EEF2FB] text-brand'
            }`}
          >
            {qa.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function PriorityDots({ priority }: { priority: 'low' | 'mid' | 'high' }) {
  const lit = priority === 'high' ? 3 : priority === 'mid' ? 2 : 1
  const color = priority === 'high' ? '#DC2626' : priority === 'mid' ? '#F59E0B' : '#94A3B8'
  const label = priority === 'high' ? 'Hoch' : priority === 'mid' ? 'Mittel' : 'Niedrig'
  return (
    <span className="ml-auto flex items-center gap-1">
      <span className="flex gap-[2px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1 w-1 rounded-chip"
            style={{ background: i < lit ? color : '#E2E8F0' }}
          />
        ))}
      </span>
      <span>{label}</span>
    </span>
  )
}

function FeedRow({ ev, onOpen }: { ev: HubActivityEvent; onOpen: () => void }) {
  const ava = FEED_AVA[ev.actorKind]
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2.5 border-b border-[#ECEFF4] px-3 py-2.5 text-left last:border-b-0"
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]"
        style={{ background: ava.bg, color: ava.fg }}
      >
        <ActorGlyph kind={ev.actorKind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-snug text-ink-sub">{ev.text}</div>
        <div className="mt-0.5">
          <span className="rounded-chip bg-[#EEF2FB] px-1.5 py-px text-[10.5px] font-semibold text-brand">
            {ev.jobLabel}
          </span>
        </div>
      </div>
      <span className="whitespace-nowrap text-[11px] font-medium text-ink-muted">{ev.agoLabel}</span>
    </button>
  )
}

// ── presales preview card (Layer 2b) ────────────────────────────────────────

function PresalesPreviewCard({
  project,
  onOpen,
  onDetail,
}: {
  project: PresalesProject
  /** Body tap → open the multi-mode 3D viewer (Grundriss/3D/Walk). The host
   *  shows a graceful "Im Detail öffnen" fallback for drafts without geometry,
   *  so a tap is never a dead end. */
  onOpen: () => void
  /** Secondary "Details" off-ramp → the full detail screen (Stückliste /
   *  Als Projekt anlegen / Archivieren). */
  onDetail?: () => void
}) {
  return (
    <div className="w-[224px] shrink-0 rounded-card border border-edge bg-surface p-2.5 shadow-subtle">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${project.title} in 3D öffnen`}
        className="flex w-full items-center gap-2.5 text-left active:scale-[0.99]"
      >
        <PresalesProjectThumbnail
          presalesProjectId={project.id}
          alt={project.title}
          className="h-10 w-10 shrink-0 overflow-hidden rounded-[10px] bg-[#FEF3C7]"
          fallback={
            <span className="flex h-full w-full items-center justify-center text-[#B45309]">
              <Box size={18} />
            </span>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold text-ink">{project.title}</div>
          <div className="mt-0.5 truncate text-[11px] text-ink-muted">
            {project.customerNameDraft ?? 'Ohne Kunden-Daten'}
          </div>
        </div>
      </button>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10.5px] font-medium text-ink-muted">
        <span className="truncate">{statusLabel(project.status)}</span>
        {onDetail && (
          <button
            type="button"
            onClick={onDetail}
            aria-label="Aufmaß-Details öffnen"
            className="inline-flex shrink-0 items-center gap-1 rounded-[8px] bg-[#EEF2FB] px-2 py-1 text-[11px] font-bold text-brand active:scale-95"
          >
            Details
            <ArrowUpRight size={11} />
          </button>
        )}
      </div>
    </div>
  )
}

function statusLabel(status: PresalesProject['status']): string {
  switch (status) {
    case 'draft':
      return 'Entwurf'
    case 'scanned':
      return 'Gescannt'
    case 'quoted':
      return 'Angebot bereit'
    case 'converted':
      return 'Als Projekt angelegt'
    case 'archived':
      return 'Archiv'
  }
}

// ── empty states (Mockup 19 + V1.5 additions) ──────────────────────────────
//
// L2-C-Deferred: `FirstLoginEmpty` + `PresalesOnlyEmpty` sind nach dem 3-Tab-
// Refactor (`HubTabBar` + `HubPrivatEmpty` + `HubAnfragenEmpty`) nicht mehr im
// Render-Pfad. `void` hält den Bundle-Effekt minimal aber respektiert die
// CLAUDE.md "Defer don't delete"-Regel — finale Aufräumung kommt mit der
// L2-D-Beispiel-Raum-Hero-Integration, die `HubPrivatEmpty` final stylisiert.

function FirstLoginEmpty({
  onStartPresales,
  onOpenPresales,
  presalesBusy,
  lidarAvailable,
}: {
  onStartPresales: () => void
  onOpenPresales: () => void
  presalesBusy: boolean
  lidarAvailable: boolean | null
}) {
  const steps = [
    <>
      <b className="font-semibold text-ink">Du scannst</b> einen Raum vor Ort — ohne Kundenkonto,
      direkt aus der App.
    </>,
    <>
      Du <b className="font-semibold text-ink">annotierst, kalkulierst</b> die Stückliste und
      bereitest dein Angebot vor.
    </>,
    <>
      Wenn der Kunde zusagt, legst du das Aufmaß <b className="font-semibold text-ink">als Projekt an</b>.
    </>,
  ]
  const noLidar = lidarAvailable === false
  return (
    <div className="flex flex-col px-5">
      <div className="mt-9 flex flex-col items-center text-center">
        <div className="mb-5 flex h-[132px] w-[132px] items-center justify-center rounded-[32px] border border-[#D4E0F7] bg-gradient-to-br from-[#EEF2FB] to-[#E0E9FB]">
          <Box size={58} className="text-brand" strokeWidth={1.6} />
        </div>
        <h2 className="text-[21px] font-bold tracking-tight text-ink">Noch keine Aufmaße</h2>
        <p className="mt-2 max-w-[280px] text-[13.5px] text-ink-sub">
          Erstelle dein erstes Aufmaß direkt vor Ort — schneller als jede
          handgeschriebene Notiz.
        </p>
      </div>
      <div className="mt-6 flex flex-col gap-2.5">
        {steps.map((txt, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-card border border-edge bg-surface px-3 py-3 shadow-subtle"
          >
            <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-chip bg-[#EEF2FB] text-[12px] font-bold text-brand">
              {i + 1}
            </span>
            <div className="text-[12.5px] leading-snug text-ink-sub">{txt}</div>
          </div>
        ))}
      </div>
      <div className="mt-6">
        <button
          type="button"
          onClick={onStartPresales}
          disabled={presalesBusy || noLidar}
          className="flex w-full items-center justify-center gap-2 rounded-[13px] bg-brand py-3.5 text-[14.5px] font-bold text-white shadow-brand-glow disabled:opacity-50"
        >
          <Plus size={16} />
          {presalesBusy ? 'Starte Aufmaß …' : 'Erstes Aufmaß aufnehmen'}
        </button>
        <button
          type="button"
          onClick={onOpenPresales}
          className="mt-3 w-full text-center text-[13px] font-semibold text-brand"
        >
          Bereits angelegte Aufmaße ansehen
        </button>
        {noLidar && (
          <p className="mt-3 text-center text-[11.5px] text-amber-700">
            Aufmaß benötigt iPad Pro / iPhone Pro mit LiDAR.
          </p>
        )}
      </div>
    </div>
  )
}

function PresalesOnlyEmpty({
  projects,
  onOpenList,
  onStartScan,
  presalesBusy,
}: {
  projects: PresalesProject[]
  onOpenList: () => void
  onStartScan: () => void
  presalesBusy: boolean
}) {
  return (
    <div className="flex flex-col px-5 pb-6 pt-5">
      <div className="flex items-start gap-2.5 rounded-card bg-[#FFFBEB] px-3 py-3 ring-1 ring-[#FDE68A]">
        <span className="mt-px shrink-0 text-[#B45309]">
          <Cpu size={18} />
        </span>
        <p className="text-[12px] leading-snug text-[#92400E]">
          Noch <b>kein Kunden-Job mit Aufmaß</b> — aber du hast schon Aufmaße angelegt.
          Leg eines als Projekt an, sobald der Kunde zusagt.
        </p>
      </div>

      <h2 className="mb-3 mt-5 text-[12px] font-bold uppercase tracking-[0.7px] text-ink-sub">
        Meine Aufmaße
      </h2>

      <div className="flex flex-col gap-2.5">
        {projects.slice(0, 4).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={onOpenList}
            className="flex items-center gap-3 rounded-card border border-edge bg-surface p-3 text-left shadow-subtle active:scale-[0.99]"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-[#FEF3C7] text-[#B45309]">
              <Box size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-bold text-ink">{p.title}</div>
              <div className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                {p.customerNameDraft ?? 'Ohne Kunden-Daten'}
                {p.locationHint ? ` · ${p.locationHint}` : ''}
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-[#FEF3C7] px-2 py-0.5 text-[10px] font-semibold text-[#B45309]">
              {statusLabel(p.status)}
            </span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onOpenList}
        className="mt-4 text-center text-[13px] font-semibold text-brand"
      >
        Alle {projects.length} Projekte ansehen ›
      </button>

      <button
        type="button"
        onClick={onStartScan}
        disabled={presalesBusy}
        className="mt-5 inline-flex items-center justify-center gap-2 rounded-[13px] bg-brand py-3.5 text-[14px] font-bold text-white shadow-brand-glow disabled:opacity-50"
      >
        <Plus size={16} />
        {presalesBusy ? 'Starte Aufmaß …' : 'Weiteres Aufmaß anlegen'}
      </button>
    </div>
  )
}

function JobsWithoutScanEmpty({
  jobs,
  presalesProjects,
  navigate,
  haptics,
  onStartPresales,
  presalesBusy,
}: {
  jobs: HubJobWithoutScan[]
  presalesProjects: PresalesProject[]
  navigate: ReturnType<typeof useNavigate>
  haptics: ReturnType<typeof useHaptics>
  onStartPresales: () => void
  presalesBusy: boolean
}) {
  return (
    <div className="flex flex-col px-5 pb-5">
      <div className="mt-4 flex items-start gap-2.5 rounded-card bg-[#E5EDFB] px-3 py-3">
        <span className="mt-px shrink-0 text-brand">
          <Cpu size={18} />
        </span>
        <p className="text-[12px] leading-snug text-[#1E40AF]">
          Diese Jobs haben <b className="font-bold">noch keinen 3D-Scan</b>. Fordere mit einem Tap
          ein Aufmaß bei der Kundschaft an — oder nimm direkt vor Ort selbst eines auf.
        </p>
      </div>

      <h2 className="mb-3 mt-5 text-[12px] font-bold uppercase tracking-[0.7px] text-ink-sub">
        Jobs ohne Aufmaß
      </h2>

      <div className="flex flex-col gap-2.5">
        {jobs.map((job) => (
          <div
            key={job.jobId}
            className="rounded-card border border-edge bg-surface p-3 shadow-subtle"
          >
            <div className="flex items-center gap-2.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-edge bg-[#ECEFF4] text-ink-muted">
                <Box size={20} />
              </span>
              <div className="min-w-0">
                <div className="text-[13.5px] font-bold text-ink">{job.title}</div>
                <div className="mt-px text-[11.5px] text-ink-muted">
                  {job.customerName} · {job.locationLabel}
                </div>
              </div>
            </div>
            <div
              className={`mt-2.5 flex items-center gap-2 rounded-[9px] px-2.5 py-2 text-[11px] font-semibold leading-snug ${
                job.deviceCapability === 'lidar'
                  ? 'bg-[#D1FAE5] text-[#047857]'
                  : 'bg-[#ECEFF4] text-ink-sub'
              }`}
            >
              <Cpu size={15} className="shrink-0" />
              <span>
                {job.deviceCapability === 'lidar' ? (
                  <>
                    <b className="font-extrabold">LiDAR-Gerät erkannt</b> · 3D-Scan möglich
                  </>
                ) : job.deviceCapability === 'photo' ? (
                  <>
                    <b className="font-extrabold">Kein LiDAR-Gerät</b> · Foto-Aufmaß möglich
                  </>
                ) : (
                  'Gerät der Kundschaft wird geprüft — Aufmaß anfordern'
                )}
              </span>
            </div>
            <div className="mt-2.5 flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  haptics.selection()
                  navigate('/craftsman/jobs/' + job.jobId)
                }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-brand px-3 py-2.5 text-[12.5px] font-bold text-white shadow-brand-glow"
              >
                {job.deviceCapability === 'photo' ? (
                  <Camera size={14} />
                ) : (
                  <Box size={14} />
                )}
                {job.deviceCapability === 'photo' ? 'Foto-Aufmaß anfordern' : 'Aufmaß anfordern'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-card border border-dashed border-[#D4E0F7] bg-[#F8FAFE] p-3">
        <h3 className="text-[12px] font-bold uppercase tracking-[0.6px] text-brand">
          Aufmaße
        </h3>
        <p className="mt-1 text-[11.5px] text-ink-sub">
          {presalesProjects.length > 0
            ? `${presalesProjects.length} Aufmaß${presalesProjects.length === 1 ? '' : 'e'} ohne Kunden-Job — leg sie als Projekt an.`
            : 'Nimm einen Raum auch ohne Kundenkonto direkt vor Ort auf — leg ihn später als Projekt an.'}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onStartPresales}
            disabled={presalesBusy}
            className="inline-flex items-center gap-1.5 rounded-[10px] bg-brand px-3 py-2 text-[12px] font-bold text-white disabled:opacity-50"
          >
            <Plus size={13} />
            {presalesBusy ? 'Starte …' : 'Aufmaß aufnehmen'}
          </button>
          {presalesProjects.length > 0 && (
            <button
              type="button"
              onClick={() => {
                haptics.selection()
                navigate('/craftsman/spatial/presales')
              }}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-edge bg-surface px-3 py-2 text-[12px] font-semibold text-ink-sub"
            >
              {presalesProjects.length} Projekt{presalesProjects.length === 1 ? '' : 'e'} ansehen
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// L2-C-Deferred — keep the legacy empty-state components alive for the
// upcoming L2-D pass that will re-style HubPrivatEmpty into the Mockup-01
// Beispiel-Raum hero. CLAUDE.md "Defer don't delete" applies.
void FirstLoginEmpty
void PresalesOnlyEmpty
