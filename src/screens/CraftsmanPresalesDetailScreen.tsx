/**
 * CraftsmanPresalesDetailScreen — Provider · Pre-Sales-Detail (V1.5.1 · L2-E)
 *
 * Route: `/craftsman/spatial/presales/:presalesProjectId`
 *
 * Single-Card-Layout für ein einzelnes Pre-Sales-Projekt:
 *   1. TopNav (Back + Titel + Kunde/Ort + FSM-Pill)
 *   2. 3D-Preview-Card (240px) — `SpatialQuickCard` wenn Asset vorhanden,
 *      sonst Loading-/Empty-/Error-Card mit Retry
 *   3. Quick-Actions-Strip (3er) — BoM · 3D-Fullscreen · Re-Scan
 *      (USER-Override gegen Mockup-04 2×2-Grid, binding §3.1 HANDOVER)
 *   4. Status-Hinweis (FSM-`nextStep`-Copy aus `presalesFsmConfig`)
 *   5. Footer-CTA — "Als Projekt anlegen" (öffnet `PresalesJobConversionModal`)
 *      oder "Zum Auftrag" (status='converted') oder "Archivieren" (sonst)
 *   6. Modal mounted conditionally (`convertOpen && <Modal />`)
 *   7. SpatialFullscreenViewer mounted conditionally (`fullscreenOpen && <Viewer />`)
 *
 * Wording-Glossar-Lock (D-5):
 *   - "Aufmaß" für das File, "Projekt" für die Akte, "Anfrage" extern
 *   - kein "Pre-Sales" sichtbar in der UI
 *   - "Als Projekt anlegen" (nicht "konvertieren")
 *
 * Asset-Resolution-Pfad spiegelt `PresalesProjectThumbnail` (Lane-2 Ü-01):
 *   scan → scan_assets[kind=usdz|gltf] → useScanAssetUrl
 *
 * Layer-Boundary: keine Repo-Calls in der UI — alle Reads über
 * `usePresalesDetail`-Hook (Workflow-Layer), alle Writes über bestehende
 * Workflows (`PresalesJobConversionModal` + `useStartPresalesRoomScan`).
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Archive,
  Box,
  Camera,
  CheckCircle2,
  Expand,
  Info,
  PencilRuler,
  RefreshCcw,
  RulerDimensionLine,
  ScanLine,
} from 'lucide-react'

import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import Spinner from '../components/system/Spinner'
import { PresalesJobConversionModal } from '../components/spatial/PresalesJobConversionModal'
import { SpatialQuickCard } from '../components/spatial/SpatialQuickCard'
import { SpatialFullscreenViewer } from '../components/spatial/SpatialFullscreenViewer'
import SpatialSceneErrorBoundary from '../components/spatial/SpatialSceneErrorBoundary'
import { canRenderMultiMode } from '../lib/spatial/canonical/viewer/canRenderMultiMode'
import { canEditPresalesFootprint } from '../lib/spatial/workflow/canEditPresalesFootprint'
import {
  persistCustomerSceneMutation,
  type PersistCustomerSceneMutationResult,
} from '../lib/spatial/workflow/persistCustomerSceneMutation'
import { useHaptics } from '../hooks/useHaptics'
import { useSession } from '../hooks/useSession'
import { useToast } from '../hooks/useToast'
import { useStartPresalesRoomScan } from '../hooks/useStartPresalesRoomScan'
import { useScanAssetUrl } from '../hooks/useScanAssetUrl'
import { useScanConvertStatus } from '../hooks/useScanConvertStatus'
import { useSmartBack } from '../hooks/useSmartBack'
import { usePresalesDetail } from '../lib/presales/workflow/usePresalesDetail'
import { getPresalesProjectRepository } from '../lib/presales/repository/registry'
import { getPresalesFsmMeta } from '../lib/presales/ui/presalesFsmConfig'
import { logError } from '../lib/observability'
import type { PresalesProjectStatus } from '../domain/presales/presalesProjectTypes'
import type { RoomScene } from '../lib/spatial/canonical/types/scene-graph'

// Lazy: the canonical multi-mode viewer pulls the r3f/three.js chunk. Keep it
// out of the presales-route bundle until the user actually opens 3D.
const SpatialMultiModeViewer = lazy(
  () => import('../components/spatial/SpatialMultiModeViewer'),
)

/**
 * One-shot optimistic-open handshake passed via `navigate(state)` from the hub's
 * "+ Raum anlegen → Manuell" flow. `createEmptyRoomProject` already returns a
 * fully-hydrated RoomScene, so the hub hands it straight into this screen — the
 * viewer mounts on it from frame 1 (`localScene`) instead of waiting for the
 * server blob to round-trip (which can briefly 404 on replication lag). The
 * screen consumes the state once on mount and strips it (replace) so a reload /
 * back-nav never re-opens the editor.
 */
interface PresalesDetailNavState {
  initialScene?: RoomScene
  autoOpen3d?: boolean
  editable?: boolean
}

export default function CraftsmanPresalesDetailScreen() {
  const { user } = useSession()
  // Remount on user-change so kein stale provider-org Daten den Detail-Screen
  // erreicht (spiegelt CraftsmanJobSpatialDetailScreen-Pattern).
  return <CraftsmanPresalesDetailScreenInner key={user?.id ?? 'anon'} />
}

function CraftsmanPresalesDetailScreenInner() {
  const { presalesProjectId } = useParams<{ presalesProjectId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const haptics = useHaptics()
  const toast = useToast()
  const { user } = useSession()

  const {
    loading,
    error,
    project,
    scan,
    scene,
    roomScene,
    variants,
    overrides,
    blobState,
    blobError,
    refetch,
  } = usePresalesDetail(presalesProjectId)
  const isManualScene =
    scene?.origin === 'manual' || scene?.origin === 'example_room'

  // ── Optimistic-open handshake (hub "+ Manuell" → land in editor at frame 1) ─
  // Captured ONCE from the entry navigation; we strip location.state right after
  // (see effect below) so a reload/back loads as a normal server-backed detail.
  const initialNav = useRef<PresalesDetailNavState | null>(
    (location.state as PresalesDetailNavState | null) ?? null,
  )
  const navEditable = initialNav.current?.editable === true
  const [localScene, setLocalScene] = useState<RoomScene | null>(
    initialNav.current?.initialScene ?? null,
  )

  // Mount source for the viewer: the optimistic local scene takes precedence so
  // the prop identity stays STABLE across the optimistic session. A mid-session
  // swap to the server roomScene would re-hydrate CanonicalSceneRoot and discard
  // unsaved wall-drags. closeFullscreen clears localScene → server truth wins.
  const effectiveRoomScene = localScene ?? roomScene

  // View-only canonical 3D (Grundriss/Dollhouse/Begehen) is available once the
  // parametric blob is hydrated and the scene has real geometry (≥3 walls).
  // empty_canvas drafts (0 walls) stay on the stats card until walls are drawn.
  const canRender3D = canRenderMultiMode(roomScene, blobState)

  // Footprint-Editing (Lane-2.5): the provider may DRAW + reshape walls in the
  // 2D Grundriss of their OWN manual room. The authoritative gate (shared with
  // the hub quick-viewer via canEditPresalesFootprint) needs the SERVER scene —
  // it carries provider_id, which authorises the persist write.
  const canEditFootprint = canEditPresalesFootprint(
    scene,
    user?.id,
    project?.status,
    roomScene?.walls.length ?? 0,
  )

  // Optimistic editability: a freshly-created manual 2×2 lands here before the
  // server scene hydrates (canEditFootprint=false until then). We still arm the
  // editor immediately — but the actual persist stays gated on the server gate
  // above (provider_id known), so an early drag is held locally and flushed the
  // moment authority arrives (see the blobState='ready' effect below).
  const optimisticEditable =
    Boolean(localScene) &&
    navEditable &&
    (localScene?.walls.length ?? 0) >= 3 &&
    // Once the server blob has fully hydrated, defer to the authoritative gate:
    // if it STILL says no (not owner / not manual / sealed), the scene can never
    // persist — stop arming the editor so an edit isn't silently accepted into
    // local-only state. Before 'ready' we keep the fast optimistic-open UX.
    (blobState !== 'ready' || canEditFootprint)
  const editableForViewer = canEditFootprint || optimisticEditable

  // Blob-Persist for footprint edits — debounced so a corner-drag does not upload
  // every 60 Hz frame. The workflow callerCanEdit guard + the RLS
  // spatial_can_edit_scene policy back the write (provider_id = auth.uid()).
  const footprintPersistTimer = useRef<number | null>(null)
  // Newest geometry seen — kept so a flush (modal close / authority arriving)
  // never drops the user's last drag, even one made before the write was allowed.
  const pendingFootprintScene = useRef<RoomScene | null>(null)
  // Authorisation captured at edit-time alongside the pending scene, so the
  // close-flush can still attempt the write while the live canEditFootprint
  // snapshot is false (optimistic-open window). RLS stays the final authority.
  const pendingAuthorized = useRef(false)
  // One persist may be in flight at a time: both the debounce timer and the
  // close-flush chain through this so the scene-record update never races itself
  // (optimistic-concurrency CAS → no false CONFLICT toast / no double write).
  const persistInFlight = useRef<Promise<PersistCustomerSceneMutationResult | null> | null>(null)
  // The scene last handed to persistFootprintNow. The unmount flush below skips
  // a scene that is already on its way to the server (fired debounce / running
  // close-flush) so it never double-persists the same geometry.
  const lastPersistRequestScene = useRef<RoomScene | null>(null)

  // `callerCanEdit` is passed in (captured at edit-time, see schedulePersistFootprint)
  // — NOT closed over here — so a later canEditFootprint flip can't downgrade an
  // already-authorised edit to a forbidden no-op that silently drops the work.
  const persistFootprintNow = useCallback(
    (
      latestScene: RoomScene,
      callerCanEdit: boolean,
    ): Promise<PersistCustomerSceneMutationResult | null> => {
      // Mark the scene as handed to a write — but only when it can actually be
      // written: a pre-hydration call returns null inside run() and must stay
      // flushable (closeFullscreen keeps it pending for the ready-effect).
      if (scene?.id && user?.id) lastPersistRequestScene.current = latestScene
      const run = async (): Promise<PersistCustomerSceneMutationResult | null> => {
        if (!scene?.id || !user?.id) return null
        const result = await persistCustomerSceneMutation({
          sceneId: scene.id,
          userId: user.id,
          callerCanEdit,
          roomScene: latestScene,
        })
        if (!result.ok) {
          // Never lose work silently: surface a hard error + re-sync from the
          // server so the next edit starts from persisted truth (covers a CONFLICT
          // where the scene moved under us). The success confirmation is owned by
          // the close-flush so a debounced corner-drag never spams 'Raum gespeichert'.
          toast.error(
            'Speichern fehlgeschlagen — Aufmaß neu geladen. Bitte die letzte Änderung erneut vornehmen.',
          )
          void refetch()
        }
        return result
      }
      // Serialize onto any in-flight persist so two writes never hit the scene
      // record concurrently (single in-flight persist).
      const chained = (persistInFlight.current ?? Promise.resolve(null)).then(run, run)
      persistInFlight.current = chained
      void chained.finally(() => {
        if (persistInFlight.current === chained) persistInFlight.current = null
      })
      return chained
    },
    [scene?.id, user?.id, toast, refetch],
  )

  const schedulePersistFootprint = useCallback(
    (latestScene: RoomScene) => {
      pendingFootprintScene.current = latestScene
      // Capture the edit-time authorisation alongside the pending scene so the
      // close-flush can still attempt the write during the optimistic-open window
      // (canEditFootprint not yet true). RLS spatial_can_edit_scene stays final.
      pendingAuthorized.current = editableForViewer
      // Pre-ready hold: before the server scene hydrates we have no provider_id
      // to authorise the in-session debounced write — hold the edit locally; the
      // ready-effect + the close-flush flush it.
      if (!canEditFootprint || blobState !== 'ready') return
      // Capture authorisation at edit-time: if canEditFootprint later flips (e.g.
      // the project is converted mid-session) the in-flight edit stays sent as
      // authorised — RLS spatial_can_edit_scene remains the final authority.
      const authorized = canEditFootprint
      if (footprintPersistTimer.current) window.clearTimeout(footprintPersistTimer.current)
      footprintPersistTimer.current = window.setTimeout(() => {
        footprintPersistTimer.current = null
        const pending = pendingFootprintScene.current
        if (pending) void persistFootprintNow(pending, authorized)
      }, 450)
    },
    [canEditFootprint, blobState, persistFootprintNow, editableForViewer],
  )

  // Flush held edits the instant the write path becomes authorised (server scene
  // hydrated). Covers the optimistic-mount window where the user drew walls
  // before blobState flipped to 'ready'.
  useEffect(() => {
    if (canEditFootprint && blobState === 'ready' && pendingFootprintScene.current) {
      schedulePersistFootprint(pendingFootprintScene.current)
    }
  }, [canEditFootprint, blobState, schedulePersistFootprint])

  // Unmount flush (resume-robustness Block 3): back-nav / route change unmounts
  // this screen WITHOUT closeFullscreen — without a flush the last wall/corner
  // drag inside the 450 ms debounce window would silently drop. Latest-ref
  // because the []-deps cleanup below would otherwise capture the FIRST-render
  // persistFootprintNow, whose scene?.id/user?.id are still undefined (silent
  // no-op inside run()). Mirrors closeFullscreen semantics: authorisation is
  // the edit-time snapshot (pendingAuthorized), RLS stays the final authority.
  // No double-persist: lastPersistRequestScene marks geometry the close-flush /
  // fired debounce already sent, and the in-flight chain serialises the write.
  const unmountFlushRef = useRef<() => void>(() => {})
  useEffect(() => {
    unmountFlushRef.current = () => {
      const pending = pendingFootprintScene.current
      if (!pending || pending === lastPersistRequestScene.current) return
      pendingFootprintScene.current = null
      const authorized = pendingAuthorized.current
      pendingAuthorized.current = false
      void persistFootprintNow(pending, authorized)
    }
  }, [persistFootprintNow])

  // Cancel a pending debounce on unmount so the timer never fires against a
  // detached component (BLOCKER-1: the timer used to leak), then flush any
  // still-pending geometry fire-and-forget (see unmountFlushRef above).
  useEffect(
    () => () => {
      if (footprintPersistTimer.current) {
        window.clearTimeout(footprintPersistTimer.current)
        footprintPersistTimer.current = null
      }
      unmountFlushRef.current()
    },
    [],
  )

  const { startPresalesScan, busy: scanBusy, lidarAvailable } = useStartPresalesRoomScan()

  // ── Asset-Resolution-Pfad (Ü-01-Pattern) ───────────────────────────────────
  const {
    assets,
    convertStuck,
    convertRetryBusy,
    convertRetriesExhausted,
    retryConvert,
  } = useScanConvertStatus(scan?.id ?? null)
  const usdzPath = useMemo(
    () => assets.find((a) => a.kind === 'usdz')?.storagePath ?? null,
    [assets],
  )
  const gltfPath = useMemo(
    () => assets.find((a) => a.kind === 'gltf')?.storagePath ?? null,
    [assets],
  )
  const { url: usdzUrl } = useScanAssetUrl(usdzPath)
  const { url: gltfUrl } = useScanAssetUrl(gltfPath)
  const hasAsset = Boolean(usdzUrl || gltfUrl)

  // Lane-2.5 Stream A5: 3D-Modell hängt — Retry-Button verdrahten.
  const handleConvertRetry = useCallback(async () => {
    haptics.selection()
    const result = await retryConvert()
    if (!result) return
    if (result.ok) {
      toast.success('3D-Konvertierung neu gestartet — das kann ein paar Minuten dauern.')
    } else {
      toast.error(result.message ?? 'Konvertierung konnte nicht neu gestartet werden.')
    }
  }, [haptics, retryConvert, toast])

  // ── Local UI State ─────────────────────────────────────────────────────────
  const [convertOpen, setConvertOpen] = useState(false)
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)

  // Consume the optimistic-open handshake once: open the viewer immediately and
  // strip the nav-state so a reload / back-nav doesn't re-trigger it.
  useEffect(() => {
    if (initialNav.current?.autoOpen3d) {
      setFullscreenOpen(true)
      if (presalesProjectId) {
        navigate(`/craftsman/spatial/presales/${presalesProjectId}`, {
          replace: true,
          state: null,
        })
      }
    }
    // run once on mount — initialNav is a frozen snapshot of the entry nav.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Aktionen ───────────────────────────────────────────────────────────────
  const goBack = useSmartBack('/craftsman/spatial/presales')

  const openConvert = useCallback(() => {
    haptics.selection()
    setConvertOpen(true)
  }, [haptics])

  const closeConvert = useCallback(() => setConvertOpen(false), [])

  const openFullscreen = useCallback(() => {
    if (!canRender3D && !editableForViewer && !gltfUrl) {
      toast.info(
        blobState === 'error'
          ? 'Modell konnte nicht geladen werden — bitte neu scannen.'
          : '3D-Modell wird noch vorbereitet — bitte gleich erneut versuchen.',
      )
      return
    }
    haptics.selection()
    setFullscreenOpen(true)
  }, [canRender3D, editableForViewer, gltfUrl, blobState, haptics, toast])

  const closeFullscreen = useCallback(() => {
    setFullscreenOpen(false)
    // Cancel a queued debounce so its 450 ms timer can't fire a second write
    // after the close-flush below (an already-fired in-flight persist is awaited
    // through the persistInFlight chain instead).
    if (footprintPersistTimer.current) {
      window.clearTimeout(footprintPersistTimer.current)
      footprintPersistTimer.current = null
    }
    const pending = pendingFootprintScene.current
    const authorized = pendingAuthorized.current
    if (!pending) {
      // No unsaved geometry → drop the optimistic mirror so the next mount
      // re-syncs from the persisted server blob.
      setLocalScene(null)
      return
    }
    // Unsaved geometry — including a switch / wall-drag made during the
    // optimistic-open window while canEditFootprint was still false. ALWAYS
    // attempt the flush (authorisation captured at edit-time; RLS is the final
    // authority) and AWAIT it before dropping the local mirror, so the save is
    // confirmed and an edit is never silently lost on close.
    void persistFootprintNow(pending, authorized).then((result) => {
      if (result == null) {
        // Scene record not hydrated yet (no sceneId) → can't write. Leave the
        // edit pending + the local mirror in place so the ready-effect flushes
        // it the instant authority arrives; nothing is dropped.
        return
      }
      if (pendingFootprintScene.current === pending) {
        pendingFootprintScene.current = null
        pendingAuthorized.current = false
      }
      if (result.ok) {
        haptics.success()
        toast.success('Raum gespeichert')
        void refetch()
      }
      // result.ok === false already surfaced the error + refetch inside
      // persistFootprintNow.
      setLocalScene(null)
    })
  }, [persistFootprintNow, refetch, haptics, toast])

  // Safety: if the modal is open but nothing can render anymore — e.g. a manual
  // scene's blob errored after opening and there is no GLB fallback — close it
  // so the user is never stranded with an invisible, open modal. Includes the
  // optimistic-editable path so a freshly-created room stays open while the
  // server scene is still hydrating.
  useEffect(() => {
    if (fullscreenOpen && !canRender3D && !editableForViewer && !gltfUrl) {
      setFullscreenOpen(false)
    }
  }, [fullscreenOpen, canRender3D, editableForViewer, gltfUrl])

  const triggerReScan = useCallback(() => {
    if (!project) return
    haptics.selection()
    void startPresalesScan({
      existingProjectId: project.id,
      onSuccess: () => {
        refetch()
      },
    })
  }, [project, haptics, startPresalesScan, refetch])

  const openBom = useCallback(() => {
    if (!project) return
    if (project.status !== 'converted' || !project.convertedToJobId) {
      toast.info('Stückliste wird nach dem Anlegen als Projekt verfügbar.')
      return
    }
    haptics.selection()
    navigate(`/craftsman/jobs/${project.convertedToJobId}/spatial?tab=bom`)
  }, [project, haptics, toast, navigate])

  const openJob = useCallback(() => {
    if (!project?.convertedToJobId) return
    haptics.selection()
    navigate(`/craftsman/jobs/${project.convertedToJobId}/spatial?tab=3d`)
  }, [project, haptics, navigate])

  const archive = useCallback(async () => {
    if (!project || archiving) return
    const confirmed = window.confirm(
      `Aufmaß „${project.title}" archivieren? Es bleibt im Archiv sichtbar, aber wird in der Liste ausgeblendet.`,
    )
    if (!confirmed) return
    setArchiving(true)
    try {
      await getPresalesProjectRepository().update(project.id, { status: 'archived' })
      haptics.success()
      toast.success('Aufmaß archiviert.')
      navigate('/craftsman/spatial/presales')
    } catch (err) {
      logError('presales.archive_failed', err, { projectId: project.id })
      haptics.error()
      toast.error('Archivieren fehlgeschlagen.')
    } finally {
      setArchiving(false)
    }
  }, [project, archiving, haptics, toast, navigate])

  const onConvertSuccess = useCallback(
    (jobId: string, alreadyExisted: boolean) => {
      setConvertOpen(false)
      if (alreadyExisted) {
        toast.info('Auftrag existierte bereits — öffne ihn.')
      } else {
        toast.success('Projekt angelegt.')
      }
      navigate(`/craftsman/jobs/${jobId}/spatial?tab=3d`)
    },
    [navigate, toast],
  )

  // ── Header (shared) ────────────────────────────────────────────────────────
  const header = (
    <div className="border-b border-edge bg-canvas px-5 pb-3.5 pt-1">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Zurück zur Liste"
          onClick={goBack}
          className="-ml-1 flex h-9 w-9 items-center justify-center rounded-[11px] text-ink-sub hover:bg-slate-100"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[20px] font-bold tracking-tight text-ink">
            {project?.title ?? (loading ? 'Lade Aufmaß …' : 'Aufmaß')}
          </h1>
          <p className="mt-0.5 truncate text-[12px] text-ink-muted">
            {project?.customerNameDraft ??
              project?.locationHint ??
              (project ? formatDate(project.createdAt) : ' ')}
          </p>
        </div>
      </div>
    </div>
  )

  // ── Loading-State ──────────────────────────────────────────────────────────
  if (loading && !project) {
    return (
      <AppShell active="verwaltung">
        {header}
        <ScreenSkeleton variant="detail" />
      </AppShell>
    )
  }

  // ── Hard-Error-State (Project not found / Repo throw) ─────────────────────
  if (!project) {
    return (
      <AppShell active="verwaltung">
        {header}
        <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-8 text-center">
          <AlertTriangle size={32} className="text-danger" />
          <p className="text-[14px] font-semibold text-ink">Aufmaß nicht gefunden</p>
          {error && <p className="text-[12px] text-ink-muted">{error}</p>}
          <button
            type="button"
            onClick={goBack}
            className="mt-2 rounded-[10px] bg-brand px-4 py-2 text-[13px] font-semibold text-white"
          >
            Zurück zur Liste
          </button>
        </div>
      </AppShell>
    )
  }

  const fsmMeta = getPresalesFsmMeta(project.status)
  const canConvert = project.status === 'scanned' || project.status === 'quoted'
  const isDraft = project.status === 'draft'
  const isConverted = project.status === 'converted'
  const canReScan = !isConverted && project.status !== 'archived'

  return (
    <AppShell active="verwaltung">
      {header}

      <div className="flex flex-col gap-4 px-5 pb-8 pt-4">
        {/* 1. FSM-Pill row */}
        <div className="flex items-center gap-2">
          <FsmPill status={project.status} />
          <span className="text-[12px] text-ink-muted">
            Erstellt {formatDate(project.createdAt)}
          </span>
        </div>

        {/* 2. 3D-Preview-Card (Lane-2.5 · Stream B: manual scenes show a
            dedicated card with the room footprint + an Edit-in-Vorbereitung
            hint, because they ship without USDZ/glb assets and the regular
            "Scan jetzt starten" CTA would be misleading.) */}
        {isManualScene ? (
          <ManualScenePreviewCard
            roomScene={effectiveRoomScene}
            origin={scene?.origin ?? 'manual'}
            canView3D={canRender3D || editableForViewer}
            canEditFootprint={editableForViewer}
            onView3D={openFullscreen}
          />
        ) : (
        <Preview3DCard
          hasAsset={hasAsset}
          gltfUrl={gltfUrl}
          usdzUrl={usdzUrl}
          title={project.title}
          scanMissing={!scan}
          blobError={blobError}
          isDraft={isDraft}
          scanBusy={scanBusy}
          onRetry={refetch}
          onReScan={triggerReScan}
        />
        )}

        {/* 2b. Lane-2.5 A5 — Convert-Stuck-Card. USDZ liegt > 5 Min ohne glb,
            Cloud-Run-Pipeline hängt vermutlich. Manueller Retry; bei
            Exhausted-Cap zeigen wir Support-Hinweis statt Button. */}
        {convertStuck && (
          <div className="rounded-card border border-amber-200 bg-amber-50 px-3.5 py-3">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0 text-amber-700">
                <AlertTriangle size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-semibold text-amber-900">
                  3D-Modell hängt
                </p>
                <p className="mt-0.5 text-[11.5px] leading-snug text-amber-800">
                  Die Konvertierung deines Scans ist seit über 5 Minuten in der
                  Warteschlange. Du kannst sie hier neu starten.
                </p>
                {!convertRetriesExhausted ? (
                  <button
                    type="button"
                    onClick={handleConvertRetry}
                    disabled={convertRetryBusy}
                    className="mt-2.5 inline-flex items-center gap-1.5 rounded-[10px] bg-amber-900 px-3 py-2 text-[12px] font-bold text-white shadow-md active:scale-[0.98] disabled:opacity-50"
                  >
                    <RefreshCcw size={13} />
                    {convertRetryBusy ? 'Starte neu …' : 'Erneut versuchen'}
                  </button>
                ) : (
                  <p className="mt-2 text-[11px] font-medium text-amber-800">
                    Mehrfach-Versuche aufgebraucht. Bitte den Support
                    kontaktieren oder neu scannen.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 3. Quick-Actions Strip (3er) — USER-Override §3.1 binding */}
        <QuickActionsStrip
          onBom={openBom}
          onFullscreen={openFullscreen}
          onReScan={triggerReScan}
          bomReady={isConverted && Boolean(project.convertedToJobId)}
          fullscreenReady={canRender3D || (hasAsset && Boolean(gltfUrl))}
          // Lane-2.5 · Stream B — manual scenes have no LiDAR scan to retake,
          // so we hide the Re-Scan affordance for them. The user re-runs the
          // workflow from the Hub if they want a different preset.
          reScanReady={!isManualScene && canReScan && lidarAvailable !== false}
          scanBusy={scanBusy}
        />

        {/* 4. Status-Hinweis (FSM-nextStep) */}
        {fsmMeta.nextStep && (
          <p className="rounded-card border border-edge bg-surface px-3.5 py-2.5 text-[12.5px] leading-snug text-ink-sub">
            {fsmMeta.nextStep}
          </p>
        )}

        {/* 5. Footer-CTA */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {isDraft && !isManualScene && (
            <button
              type="button"
              onClick={triggerReScan}
              disabled={scanBusy || lidarAvailable === false}
              className="flex items-center gap-1.5 rounded-[12px] bg-brand px-4 py-3 text-[13.5px] font-bold text-white shadow-brand-glow active:scale-[0.98] disabled:opacity-50"
            >
              <Camera size={15} />
              {scanBusy ? 'Starte …' : 'Scan jetzt starten'}
            </button>
          )}
          {canConvert && (
            <button
              type="button"
              onClick={openConvert}
              className="flex items-center gap-1.5 rounded-[12px] bg-brand px-4 py-3 text-[13.5px] font-bold text-white shadow-brand-glow active:scale-[0.98]"
            >
              <CheckCircle2 size={15} />
              Als Projekt anlegen
            </button>
          )}
          {isConverted && project.convertedToJobId && (
            <button
              type="button"
              onClick={openJob}
              className="flex items-center gap-1.5 rounded-[12px] bg-[#D1FAE5] px-4 py-3 text-[13.5px] font-bold text-[#047857] active:scale-[0.98]"
            >
              <ArrowUpRight size={15} />
              Zum Auftrag
            </button>
          )}
          {!isConverted && project.status !== 'archived' && (
            <button
              type="button"
              onClick={archive}
              disabled={archiving}
              className="ml-auto flex items-center gap-1.5 rounded-[12px] border border-edge bg-canvas px-3.5 py-3 text-[12.5px] font-semibold text-ink-sub active:scale-[0.98] disabled:opacity-50"
            >
              <Archive size={13} />
              {archiving ? 'Archiviere …' : 'Archivieren'}
            </button>
          )}
        </div>

        {/* LiDAR-Banner (gleiche UX-Logik wie der Listen-Screen) */}
        {lidarAvailable === false && (
          <p className="rounded-[10px] bg-[#FEF3C7] px-3 py-2 text-[11.5px] text-[#92400E]">
            Re-Scan und neue Aufmaße brauchen ein iPad Pro / iPhone Pro mit LiDAR.
          </p>
        )}
      </div>

      {convertOpen && (
        <PresalesJobConversionModal
          project={project}
          onClose={closeConvert}
          onSuccess={onConvertSuccess}
        />
      )}

      {/* Multi-mode canonical viewer (Grundriss/Dollhouse/Begehen) once the
          parametric scene is hydrated; GLB fullscreen stays the fallback. */}
      {fullscreenOpen && (canRender3D || editableForViewer) && effectiveRoomScene && (
        <SpatialSceneErrorBoundary context="PresalesMultiModeViewer" fallback={null}>
          <Suspense fallback={null}>
            <SpatialMultiModeViewer
              roomScene={effectiveRoomScene}
              overrides={overrides}
              variants={variants}
              usdzStoragePath={usdzPath}
              title={project.title}
              editable={editableForViewer}
              onPersist={schedulePersistFootprint}
              onClose={closeFullscreen}
            />
          </Suspense>
        </SpatialSceneErrorBoundary>
      )}

      {fullscreenOpen && !canRender3D && gltfUrl && (
        <SpatialFullscreenViewer
          gltfUrl={gltfUrl}
          usdzStoragePath={usdzPath}
          roomScene={roomScene}
          title={project.title}
          onClose={closeFullscreen}
        />
      )}
    </AppShell>
  )
}

// ── Sub-Components ───────────────────────────────────────────────────────────

function FsmPill({ status }: { status: PresalesProjectStatus }) {
  const meta = getPresalesFsmMeta(status)
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
      style={{ background: meta.bg, color: meta.fg }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: meta.fg }}
      />
      {meta.label}
    </span>
  )
}

interface Preview3DCardProps {
  hasAsset: boolean
  gltfUrl: string | null
  usdzUrl: string | null
  title: string
  scanMissing: boolean
  blobError: string | null
  isDraft: boolean
  scanBusy: boolean
  onRetry: () => void
  onReScan: () => void
}

function Preview3DCard({
  hasAsset,
  gltfUrl,
  usdzUrl,
  title,
  scanMissing,
  blobError,
  isDraft,
  scanBusy,
  onRetry,
  onReScan,
}: Preview3DCardProps) {
  // 1. Asset ready → SpatialQuickCard rendert model-viewer
  if (hasAsset) {
    return (
      <div className="overflow-hidden rounded-card border border-edge bg-surface shadow-subtle">
        <SpatialQuickCard
          gltfUrl={gltfUrl ?? undefined}
          usdzUrl={usdzUrl ?? undefined}
          alt={`3D-Vorschau ${title}`}
          className="h-[240px] w-full !rounded-none"
        />
      </div>
    )
  }

  // 2. Draft (kein Scan) → Re-Scan-CTA
  if (isDraft || scanMissing) {
    return (
      <div className="flex h-[240px] flex-col items-center justify-center gap-3 rounded-card border border-dashed border-[#D4E0F7] bg-[#F8FAFF] px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-[#EEF2FB]">
          <ScanLine size={28} className="text-brand" strokeWidth={1.6} />
        </div>
        <div>
          <p className="text-[13.5px] font-semibold text-ink">Aufmaß noch nicht aufgenommen</p>
          <p className="mt-1 text-[12px] text-ink-muted">
            Starte den Scan direkt vor Ort — du brauchst ein iPad Pro / iPhone Pro.
          </p>
        </div>
        <button
          type="button"
          onClick={onReScan}
          disabled={scanBusy}
          className="rounded-[10px] bg-brand px-4 py-2 text-[12.5px] font-bold text-white shadow-brand-glow disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-1.5">
            <Camera size={14} />
            {scanBusy ? 'Starte …' : 'Scan starten'}
          </span>
        </button>
      </div>
    )
  }

  // 3. Blob-Load-Fehler → Retry
  if (blobError) {
    return (
      <div className="flex h-[240px] flex-col items-center justify-center gap-3 rounded-card border border-[#FECACA] bg-[#FEF2F2] px-6 text-center">
        <AlertTriangle size={28} className="text-danger" />
        <div>
          <p className="text-[13.5px] font-semibold text-ink">3D-Modell konnte nicht geladen werden</p>
          <p className="mt-1 text-[12px] text-ink-muted">{blobError}</p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-[10px] border border-edge bg-canvas px-3 py-2 text-[12.5px] font-semibold text-ink-sub"
        >
          <span className="inline-flex items-center gap-1.5">
            <RefreshCcw size={13} />
            Erneut versuchen
          </span>
        </button>
      </div>
    )
  }

  // 4. Asset wird konvertiert → Loading-State (F-10 time-based phases)
  return (
    <div className="flex h-[240px] flex-col items-center justify-center gap-3 rounded-card border border-edge bg-surface px-6 text-center">
      <Spinner size="md" tone="brand" />
      <div>
        <p className="text-[13.5px] font-semibold text-ink">3D-Modell wird vorbereitet</p>
        <p className="mt-1 text-[12px] text-ink-muted">
          Wir konvertieren das Aufmaß — das dauert bis zu einer Minute.
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-[10px] border border-edge bg-canvas px-3 py-1.5 text-[11.5px] font-semibold text-ink-sub"
      >
        <span className="inline-flex items-center gap-1.5">
          <RefreshCcw size={12} />
          Aktualisieren
        </span>
      </button>
    </div>
  )
}

interface QuickActionsStripProps {
  onBom: () => void
  onFullscreen: () => void
  onReScan: () => void
  bomReady: boolean
  fullscreenReady: boolean
  reScanReady: boolean
  scanBusy: boolean
}

function QuickActionsStrip({
  onBom,
  onFullscreen,
  onReScan,
  bomReady,
  fullscreenReady,
  reScanReady,
  scanBusy,
}: QuickActionsStripProps) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <ActionTile
        label="Stückliste"
        icon={<Box size={18} />}
        onClick={onBom}
        disabled={false}
        muted={!bomReady}
        hint={bomReady ? undefined : 'Nach Projekt-Anlage'}
      />
      <ActionTile
        label="Vollbild"
        icon={<Expand size={18} />}
        onClick={onFullscreen}
        disabled={!fullscreenReady}
        muted={!fullscreenReady}
        hint={fullscreenReady ? undefined : 'Asset folgt'}
      />
      <ActionTile
        label={scanBusy ? 'Starte …' : 'Re-Scan'}
        icon={<RefreshCcw size={18} />}
        onClick={onReScan}
        disabled={!reScanReady || scanBusy}
        muted={!reScanReady}
        hint={reScanReady ? undefined : 'Nicht verfügbar'}
      />
    </div>
  )
}

interface ActionTileProps {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled: boolean
  muted: boolean
  hint?: string
}

function ActionTile({ label, icon, onClick, disabled, muted, hint }: ActionTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'flex flex-col items-center gap-1.5 rounded-card border border-edge bg-surface px-2 py-3 text-[12px] font-semibold transition active:scale-[0.97] disabled:cursor-not-allowed ' +
        (muted ? 'text-ink-muted opacity-70' : 'text-ink')
      }
      aria-disabled={disabled}
    >
      <span className={muted ? 'text-ink-muted' : 'text-brand'}>{icon}</span>
      <span>{label}</span>
      {hint && <span className="text-[10px] font-normal text-ink-muted">{hint}</span>}
    </button>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

// ── Lane-2.5 · Stream B · Manual-Scene Preview ──────────────────────────────
//
// Manual scenes (origin='manual' / 'example_room') have no USDZ + glb pipeline,
// so the regular Preview3DCard would land on the "Scan jetzt starten" empty
// state, which is misleading. This card surfaces the room footprint that the
// preset/workflow wrote so the user has something concrete to look at, and
// signals that visual edit ships in the next iteration. The DimensionInputSheet
// (B4) + AddWall / DeleteWall commands (B3) are wired in the canonical layer
// but the 3D-Viewer integration that selects a wall + opens the sheet is the
// remaining Lane-3 step.

interface ManualScenePreviewCardProps {
  roomScene: RoomScene | null
  origin: 'manual' | 'example_room' | 'roomplan'
  /** True once the scene can be opened in the view-only multi-mode 3D viewer. */
  canView3D?: boolean
  /** Opens the multi-mode 3D viewer (shared with the Quick-Actions "Vollbild"). */
  onView3D?: () => void
  /** True when the provider may DRAW + reshape walls (own manual scene) — relabels
   *  the CTA + hint from view-only to "Grundriss bearbeiten". */
  canEditFootprint?: boolean
}

function ManualScenePreviewCard({
  roomScene,
  origin,
  canView3D = false,
  canEditFootprint = false,
  onView3D,
}: ManualScenePreviewCardProps) {
  const wallCount = roomScene?.walls.length ?? 0
  const areaM2 = roomScene?.computed_area_m2 ?? 0
  const ceilingM = roomScene?.ceiling?.height_m ?? 0
  const presetVariant = readPresetVariant(roomScene)

  const headline =
    presetVariant === 'empty_canvas'
      ? 'Leerer Raum angelegt'
      : presetVariant === 'empty_room_2x2'
        ? 'Vorlage 2 × 2 m angelegt'
        : origin === 'example_room'
          ? 'Beispiel-Raum'
          : 'Manuelles Aufmaß'

  return (
    <div className="overflow-hidden rounded-card border border-edge bg-surface shadow-subtle">
      <div className="flex h-[180px] items-center justify-center bg-gradient-to-br from-[#EEF2FB] via-[#E8EEFA] to-[#E0E9FB]">
        <PencilRuler size={56} strokeWidth={1.4} className="text-brand/80" />
      </div>
      <div className="px-3.5 py-3">
        <h3 className="text-[14px] font-bold text-ink">{headline}</h3>
        <ul className="mt-2 grid grid-cols-3 gap-2 text-[11.5px] text-ink-sub">
          <ManualStat
            icon={<Box size={13} />}
            label="Wände"
            value={String(wallCount)}
          />
          <ManualStat
            icon={<RulerDimensionLine size={13} />}
            label="Grundfläche"
            value={areaM2 > 0 ? `${areaM2.toFixed(1)} m²` : '—'}
          />
          <ManualStat
            icon={<RulerDimensionLine size={13} />}
            label="Höhe"
            value={ceilingM > 0 ? `${ceilingM.toFixed(2)} m` : '—'}
          />
        </ul>
        {canView3D && onView3D && (
          <button
            type="button"
            onClick={onView3D}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[12px] bg-brand px-4 py-2.5 text-[13px] font-bold text-white shadow-brand-glow active:scale-[0.98]"
          >
            {canEditFootprint ? <PencilRuler size={15} /> : <Expand size={15} />}
            {canEditFootprint ? 'Grundriss bearbeiten' : '3D ansehen'}
          </button>
        )}
        <div className="mt-3 flex items-start gap-2 rounded-[10px] bg-[#F1F4FA] px-2.5 py-2 text-[11.5px] leading-snug text-ink-sub">
          <Info size={13} className="mt-0.5 shrink-0 text-brand" />
          <span>
            {canEditFootprint
              ? 'Tippe „Grundriss bearbeiten" und zieh die Wand-Ecken im 2D-Plan auf das echte Maß — Änderungen werden automatisch gespeichert.'
              : 'Visuelle Bearbeitung folgt in der nächsten Iteration. Bis dahin bleibt das Aufmaß als Skizze gespeichert und kann als Projekt angelegt oder archiviert werden.'}
          </span>
        </div>
      </div>
    </div>
  )
}

function ManualStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <li className="flex flex-col gap-0.5 rounded-[10px] bg-[#F8FAFE] px-2 py-2">
      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-ink-muted">
        <span className="text-brand">{icon}</span>
        {label}
      </span>
      <span className="text-[13px] font-bold text-ink">{value}</span>
    </li>
  )
}

function readPresetVariant(roomScene: RoomScene | null): string | null {
  if (!roomScene) return null
  const metadata = (roomScene as unknown as { metadata?: Record<string, unknown> })
    .metadata
  if (metadata && typeof metadata === 'object') {
    const variant = metadata['preset_variant']
    if (typeof variant === 'string') return variant
  }
  return null
}

