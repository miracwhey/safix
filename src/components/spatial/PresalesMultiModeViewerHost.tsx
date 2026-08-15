/**
 * Spatial · PresalesMultiModeViewerHost
 *
 * One-tap bridge from the Spatial-Hub into the multi-mode 3D viewer
 * (Grundriss / Dollhouse / Begehen) for a provider's OWN room (presales /
 * privat). The hub card list never hydrates the heavy parametric scene; this
 * host does it on demand for the single tapped project, then mounts
 * {@link SpatialMultiModeViewer} once the blob is ready and the scene has real
 * geometry ({@link canRenderMultiMode}).
 *
 * For an owner-held `origin='manual'` room it arms the SAME footprint editor the
 * detail screen exposes (wall-drag + DimensionInputSheet), gated through the
 * shared {@link canEditPresalesFootprint} helper so the two entry points can
 * never drift into an authorisation gap. Edits persist via the debounced
 * blob-re-upload path (RLS `spatial_can_edit_scene` + workflow `callerCanEdit`
 * back the write); a pending edit is flushed before the viewer closes so a
 * quick tap-and-close never drops the last drag.
 *
 * It is mounted only while a project is selected (`{id && <Host .../>}`), so the
 * `usePresalesDetail` hydration only runs on an explicit tap. States:
 *   - hydrating            → dark loading overlay (auto-transitions to viewer)
 *   - ready + renderable   → SpatialMultiModeViewer (its own fullscreen portal)
 *   - ready, not renderable / blob error → fallback overlay → "Im Detail öffnen"
 *     so a tap is never a dead end (e.g. a still-converting or empty draft).
 */

import { lazy, Suspense, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Box } from 'lucide-react'

import Spinner from '../system/Spinner'
import SpatialSceneErrorBoundary from './SpatialSceneErrorBoundary'
import { canRenderMultiMode } from '../../lib/spatial/canonical/viewer/canRenderMultiMode'
import { canEditPresalesFootprint } from '../../lib/spatial/workflow/canEditPresalesFootprint'
import { persistCustomerSceneMutation } from '../../lib/spatial/workflow/persistCustomerSceneMutation'
import { usePresalesDetail } from '../../lib/presales/workflow/usePresalesDetail'
import { useSession } from '../../hooks/useSession'
import { useToast } from '../../hooks/useToast'
import type { RoomScene } from '../../lib/spatial/canonical/types/scene-graph'

// Lazy: pulls the r3f / three.js chunk only when a 3D tap actually lands.
const SpatialMultiModeViewer = lazy(() => import('./SpatialMultiModeViewer'))

export interface PresalesMultiModeViewerHostProps {
  presalesProjectId: string
  /** Optional title shown in the loading overlay before the project hydrates. */
  fallbackTitle?: string
  /** Close the quick-viewer (host unmounts via `{id && <Host/>}`). */
  onClose: () => void
  /** Open the full project detail screen when 3D cannot render. */
  onOpenDetail: (presalesProjectId: string) => void
}

function Overlay({
  children,
  onClose,
}: {
  children: React.ReactNode
  onClose: () => void
}) {
  const target = typeof document !== 'undefined' ? document.body : null
  if (!target) return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-black/92 px-8 text-center">
      <button
        type="button"
        onClick={onClose}
        aria-label="3D-Ansicht schließen"
        className="absolute right-4 top-[max(12px,env(safe-area-inset-top))] flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white active:scale-95"
      >
        <X size={20} />
      </button>
      {children}
    </div>,
    target,
  )
}

export default function PresalesMultiModeViewerHost({
  presalesProjectId,
  fallbackTitle,
  onClose,
  onOpenDetail,
}: PresalesMultiModeViewerHostProps) {
  const { user } = useSession()
  const toast = useToast()
  const { project, scene, roomScene, variants, overrides, blobState, blobError, refetch } =
    usePresalesDetail(presalesProjectId)

  const title = project?.title ?? fallbackTitle
  const canRender = canRenderMultiMode(roomScene, blobState)

  // 1-Tap-Edit from the hub: an own manual room arms the footprint editor. The
  // gate is shared with the detail screen so they never drift. Scanned /
  // example / non-owned scenes stay view-only (canEdit=false).
  const canEdit = canEditPresalesFootprint(
    scene,
    user?.id,
    project?.status,
    roomScene?.walls.length ?? 0,
  )

  // Blob-Persist for footprint edits — debounced so a corner-drag does not
  // upload every 60 Hz frame. `pendingFootprintScene` keeps the newest geometry
  // so a flush (viewer close) never drops the user's last drag.
  const footprintPersistTimer = useRef<number | null>(null)
  const pendingFootprintScene = useRef<RoomScene | null>(null)
  // The scene last handed to persistFootprintNow. The unmount flush below
  // skips a scene that is already on its way to the server (fired debounce /
  // running close-flush) so it never double-persists the same geometry.
  const lastPersistRequestScene = useRef<RoomScene | null>(null)
  const sceneId = scene?.id ?? null
  const userId = user?.id ?? null

  // `callerCanEdit` is passed in (captured at edit-time) rather than closed over,
  // so a later canEdit flip can't downgrade an already-authorised edit to a
  // forbidden no-op that silently drops the work. RLS stays the final authority.
  const persistFootprintNow = useCallback(
    async (latestScene: RoomScene, callerCanEdit: boolean) => {
      if (!sceneId || !userId) return null
      lastPersistRequestScene.current = latestScene
      const result = await persistCustomerSceneMutation({
        sceneId,
        userId,
        callerCanEdit,
        roomScene: latestScene,
      })
      if (!result.ok) {
        toast.error(
          'Speichern fehlgeschlagen — Aufmaß neu geladen. Bitte die letzte Änderung erneut vornehmen.',
        )
        void refetch()
      }
      return result
    },
    [sceneId, userId, toast, refetch],
  )

  const schedulePersistFootprint = useCallback(
    (latestScene: RoomScene) => {
      pendingFootprintScene.current = latestScene
      if (!canEdit || blobState !== 'ready') return
      // Capture authorisation at edit-time so a later canEdit flip cannot drop an
      // edit the user made while authorised.
      const authorized = canEdit
      if (footprintPersistTimer.current) window.clearTimeout(footprintPersistTimer.current)
      footprintPersistTimer.current = window.setTimeout(() => {
        footprintPersistTimer.current = null
        const pending = pendingFootprintScene.current
        if (pending) void persistFootprintNow(pending, authorized)
      }, 450)
    },
    [canEdit, blobState, persistFootprintNow],
  )

  // Flush a pending debounce synchronously before tearing the viewer down, so a
  // quick edit-then-close never loses the last drag.
  const handleClose = useCallback(() => {
    if (footprintPersistTimer.current) {
      window.clearTimeout(footprintPersistTimer.current)
      footprintPersistTimer.current = null
    }
    const pending = pendingFootprintScene.current
    pendingFootprintScene.current = null
    if (canEdit && blobState === 'ready' && pending) {
      // The viewer no longer fires its own success toast (it lied — fired
      // regardless of persist). Confirm 'Raum gespeichert' only once the flush
      // actually resolves ok; the error path is handled in persistFootprintNow.
      void persistFootprintNow(pending, canEdit).then((result) => {
        if (result?.ok) toast.success('Raum gespeichert')
      })
    }
    onClose()
  }, [canEdit, blobState, persistFootprintNow, onClose, toast])

  // Unmount flush (resume-robustness Block 3): a route change / parent unmount
  // tears the host down WITHOUT handleClose — without this flush the last
  // wall/corner drag inside the 450 ms debounce window would silently drop.
  // Latest-ref because the []-deps cleanup below would otherwise capture the
  // FIRST-render persistFootprintNow, whose sceneId/userId are still null
  // (silent no-op). No double-persist: handleClose nulls pendingFootprintScene
  // synchronously and lastPersistRequestScene marks a fired debounce write.
  const unmountFlushRef = useRef<() => void>(() => {})
  useEffect(() => {
    unmountFlushRef.current = () => {
      const pending = pendingFootprintScene.current
      if (!pending || pending === lastPersistRequestScene.current) return
      // Mirror handleClose's gate: only an authorised, hydrated scene may write.
      if (!canEdit || blobState !== 'ready') return
      pendingFootprintScene.current = null
      void persistFootprintNow(pending, canEdit)
    }
  }, [canEdit, blobState, persistFootprintNow])

  // Cancel a pending debounce on unmount so the timer never fires detached,
  // then fire-and-forget-flush any still-pending geometry (see unmountFlushRef).
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

  // Ready + real geometry → mount the multi-mode viewer (its own portal).
  if (canRender && roomScene) {
    return (
      <SpatialSceneErrorBoundary context="HubPresalesMultiMode" fallback={null}>
        <Suspense
          fallback={
            <Overlay onClose={handleClose}>
              <Spinner size="md" tone="onDark" />
              <p className="text-[14px] font-semibold text-white">3D wird geladen …</p>
            </Overlay>
          }
        >
          <SpatialMultiModeViewer
            roomScene={roomScene}
            overrides={overrides}
            variants={variants}
            usdzStoragePath={null}
            title={title}
            editable={canEdit}
            onPersist={schedulePersistFootprint}
            onClose={handleClose}
          />
        </Suspense>
      </SpatialSceneErrorBoundary>
    )
  }

  // Still hydrating → spinner that auto-transitions to the viewer when ready.
  const stillLoading = blobState === 'absent' || blobState === 'loading'
  if (stillLoading) {
    return (
      <Overlay onClose={handleClose}>
        <Spinner size="md" tone="onDark" />
        <p className="text-[14px] font-semibold text-white">3D wird geladen …</p>
        {title && <p className="-mt-2 text-[12px] text-white/70">{title}</p>}
      </Overlay>
    )
  }

  // Ready but not renderable (no parametric geometry yet) or a blob error →
  // never strand the user: offer the full detail where the right state shows.
  return (
    <Overlay onClose={handleClose}>
      <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-white/10 text-white/80">
        <Box size={26} />
      </span>
      <p className="max-w-[260px] text-[14px] font-semibold text-white">
        {blobState === 'error' || blobError
          ? '3D-Modell konnte nicht geladen werden'
          : '3D-Ansicht noch nicht verfügbar'}
      </p>
      <p className="-mt-2 max-w-[260px] text-[12px] text-white/70">
        {blobState === 'error' || blobError
          ? 'Bitte im Aufmaß-Detail erneut versuchen.'
          : 'Dieses Aufmaß hat noch keine begehbare Geometrie.'}
      </p>
      <button
        type="button"
        onClick={() => onOpenDetail(presalesProjectId)}
        className="mt-1 rounded-[12px] bg-brand px-4 py-2.5 text-[13px] font-bold text-white active:scale-[0.98]"
      >
        Im Aufmaß-Detail öffnen
      </button>
    </Overlay>
  )
}
