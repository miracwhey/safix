/**
 * JobSpatial3DTab — Job-Spatial-Detail · Tab "3D-Modell" (Mockup 20).
 *
 * B-3/B-4 built the EditModeViewerHost mount, the RBAC toolbar, the 5 tools
 * and the panel-based TransformGizmoPanel.
 *
 * Phase C (C-2): the real parametric blob is hydrated and mounted.
 * Phase C (C-3): 3D hit-testing is wired. EditModeViewerHost reports a tapped
 * scene-graph node via `onNodeSelect`; this tab maps it to the gizmo's
 * `GizmoSelectedNode` and the leaf editors receive the REAL node id. Tapping
 * empty space deselects; tapping a non-editable surface (floor / ceiling)
 * shows a hint chip instead of a silent no-op. The Phase-B debug-stub button
 * and the dead local camera picker are gone — camera switching is owned by
 * CanonicalSceneRoot's built-in CameraModeSwitcher.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { AlertTriangle, Boxes, Camera, MapPinned, Ruler, SwatchBook, Triangle } from 'lucide-react'

import Spinner from '../../system/Spinner'
import type { JobSpatialTabProps } from './jobSpatialTabs'
import { useSpatialProviderRole } from '../../../lib/spatial/canonical/workflow/useSpatialProviderRole'
import { useSpatialEditPermissions } from '../../../lib/spatial/hooks/useSpatialEditPermissions'
import { useScanConvertStatus } from '../../../hooks/useScanConvertStatus'
import { SpatialQuickLookButton } from '../SpatialQuickLookButton'
import { MeasurementEditorSheet } from './MeasurementEditorSheet'
import { AnnotationEditorSheet, type AnnotationType } from './AnnotationEditorSheet'
import {
  TransformGizmoPanel,
  type GizmoNodeKind,
  type GizmoSelectedNode,
} from './TransformGizmoPanel'
import { EditModeViewerHost, type SceneNodeSelection } from '../edit/EditModeViewerHost'
import type { Node, SpatialObject, Wall } from '../../../lib/spatial/canonical/types/scene-graph'

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

type ToolKey = 'pin' | 'measure' | 'photo' | 'material' | 'issue'

const TOOLS: { key: ToolKey; label: string; danger?: boolean }[] = [
  { key: 'pin', label: 'Pin' },
  { key: 'measure', label: 'Maß' },
  { key: 'photo', label: 'Foto' },
  { key: 'material', label: 'Material' },
  { key: 'issue', label: 'Problem', danger: true },
]

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers (react-hooks/static-components rule)
// ─────────────────────────────────────────────────────────────────────────────

function ToolGlyph({ toolKey }: { toolKey: ToolKey }) {
  switch (toolKey) {
    case 'pin':
      return <MapPinned size={16} />
    case 'measure':
      return <Ruler size={16} />
    case 'photo':
      return <Camera size={16} />
    case 'material':
      return <SwatchBook size={16} />
    default:
      return <Triangle size={16} />
  }
}

/**
 * Map a hit-tested scene-graph node onto the transform-gizmo descriptor.
 * Floor / ceiling are not gizmo-editable → `null` (the caller shows a hint).
 */
function selectionToGizmoNode(
  sel: Extract<SceneNodeSelection, { kind: 'node' }>,
): GizmoSelectedNode | null {
  if (sel.surfaceKind === 'floor' || sel.surfaceKind === 'ceiling') return null

  const node: Node | null = sel.node
  const pos = node?.transform.position
  const rot = node?.transform.rotation
  const kind: GizmoNodeKind = sel.surfaceKind === 'wall' ? 'wall' : 'object'

  const gizmo: GizmoSelectedNode = {
    nodeId: sel.nodeId,
    label: node?.name ?? (kind === 'wall' ? 'Wand' : 'Objekt'),
    kind,
    positionM: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined,
    rotation: rot ? { x: rot.x, y: rot.y, z: rot.z, w: rot.w } : undefined,
  }

  if (node && node.type === 'wall') {
    const wall = node as Wall
    gizmo.wallDimensions = { heightM: wall.height_m, thicknessM: wall.thickness_m }
    gizmo.measuredWidthM = wall.length_m
    gizmo.measuredHeightM = wall.height_m
  } else if (node && node.type === 'object') {
    const obj = node as SpatialObject
    gizmo.measuredWidthM = obj.dimensions.width_m
    gizmo.measuredHeightM = obj.dimensions.height_m
  }

  return gizmo
}

/** cm value for a Maß-editor scan reference, from a measured meter value. */
function metersToScanCm(m: number | undefined): number | null {
  return m != null && Number.isFinite(m) && m > 0 ? m * 100 : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function JobSpatial3DTab({
  job,
  scene,
  roomScene,
  variants,
  overrides,
  blobState,
  blobError,
  onRetry,
}: JobSpatialTabProps) {
  const { role, permissions } = useSpatialProviderRole()
  // C-3: the writable variant id is the role-correct session variant
  // (`provider_{uid}_annotations` etc.) — drives the gizmo + leaf-editor audit.
  const { writableVariantId } = useSpatialEditPermissions()

  // V-13: surface a Quick-Look AR shortcut next to the variant-strip when the
  // underlying scan has a USDZ asset. iOS-only at runtime; the button itself
  // gates platform + asset presence.
  const { assets: scanAssets } = useScanConvertStatus(scene.sourceScanId)
  const usdzStoragePath = useMemo(
    () => scanAssets.find((a) => a.kind === 'usdz')?.storagePath ?? null,
    [scanAssets],
  )

  // ── Sheet state ───────────────────────────────────────────────────────────
  const [measureOpen, setMeasureOpen] = useState(false)
  const [annotationOpen, setAnnotationOpen] = useState(false)
  const [annotationType, setAnnotationType] = useState<AnnotationType>('note')
  const [annotationLabel, setAnnotationLabel] = useState<string | undefined>()

  // ── Hit-test selection state (C-3) ────────────────────────────────────────
  const [selectedNode, setSelectedNode] = useState<GizmoSelectedNode | null>(null)
  // Transient chip when the user taps a non-editable surface (floor / ceiling).
  const [nonEditableHint, setNonEditableHint] = useState<string | null>(null)

  // Auto-clear the non-editable hint after a short while.
  useEffect(() => {
    if (!nonEditableHint) return
    const t = setTimeout(() => setNonEditableHint(null), 2800)
    return () => clearTimeout(t)
  }, [nonEditableHint])

  // F-10 (L2-F): degrade the loading message + surface a Retry button when
  // the parametric blob takes uncomfortably long. `slowPhase` only climbs
  // upward while the hook is in `loading`; the visible phase below short-
  // circuits back to `initial` whenever `blobState` leaves `loading`, so no
  // synchronous reset-setState in this effect.
  const [slowPhase, setSlowPhase] = useState<'initial' | 'slow' | 'very-slow'>('initial')
  useEffect(() => {
    if (blobState !== 'loading') return
    let cancelled = false
    // Defer the reset onto the next macrotask so this effect body doesn't
    // call setState synchronously (`react-hooks/set-state-in-effect`).
    const resetTimer = setTimeout(() => {
      if (!cancelled) setSlowPhase('initial')
    }, 0)
    const slowTimer = setTimeout(() => {
      if (!cancelled) setSlowPhase('slow')
    }, 5_000)
    const verySlowTimer = setTimeout(() => {
      if (!cancelled) setSlowPhase('very-slow')
    }, 15_000)
    return () => {
      cancelled = true
      clearTimeout(resetTimer)
      clearTimeout(slowTimer)
      clearTimeout(verySlowTimer)
    }
  }, [blobState])
  const loadingPhase = blobState === 'loading' ? slowPhase : 'initial'

  const canUseTool =
    permissions.canAddOwnPin ||
    permissions.canAddMeasurementOverride ||
    permissions.canAddMaterialSuggestion

  // V-02 (L2-F): keep an explicit Tool-Mode in the tab. The toolbar buttons
  // are toggles — selecting one arms the next surface tap; tapping the same
  // button again clears it. While `activeTool` is set the surface-tap path
  // routes to the matching editor sheet instead of opening the gizmo. `null`
  // restores the legacy gizmo-selection behaviour so existing flows keep
  // working without explicit tool selection.
  const [activeTool, setActiveTool] = useState<ToolKey | null>(null)

  const toggleTool = useCallback(
    (toolKey: ToolKey) => {
      if (!canUseTool) return
      setActiveTool((prev) => (prev === toolKey ? null : toolKey))
    },
    [canUseTool],
  )

  /**
   * Backwards-compat path (V-02): if no surface is selected yet, tapping a
   * toolbar button opens its editor sheet directly. This keeps the legacy
   * quick-tap workflow alive — power users that already know the tool layout
   * shouldn't be forced through a two-step surface-tap dance.
   */
  const handleToolTap = useCallback(
    (toolKey: ToolKey) => {
      if (!canUseTool) return
      if (selectedNode) {
        toggleTool(toolKey)
        return
      }
      switch (toolKey) {
        case 'measure':
          if (!permissions.canAddMeasurementOverride) return
          setMeasureOpen(true)
          break
        case 'pin':
          if (!permissions.canAddOwnPin) return
          setAnnotationType('note')
          setAnnotationLabel('Pin · ' + job.title)
          setAnnotationOpen(true)
          break
        case 'photo':
          if (!permissions.canAddOwnPin) return
          setAnnotationType('photo')
          setAnnotationLabel('Foto · ' + job.title)
          setAnnotationOpen(true)
          break
        case 'material':
          if (!permissions.canAddMaterialSuggestion) return
          setAnnotationType('note')
          setAnnotationLabel('Material-Vorschlag · ' + job.title)
          setAnnotationOpen(true)
          break
        case 'issue':
          if (!permissions.canAddOwnPin) return
          setAnnotationType('issue')
          setAnnotationLabel('Problem · ' + job.title)
          setAnnotationOpen(true)
          break
      }
    },
    [canUseTool, selectedNode, toggleTool, permissions, job.title],
  )

  // ── Hit-test → selection (C-3) ────────────────────────────────────────────

  const handleNodeSelect = useCallback((sel: SceneNodeSelection) => {
    if (sel.kind === 'cleared') {
      setSelectedNode(null)
      setNonEditableHint(null)
      return
    }
    const gizmo = selectionToGizmoNode(sel)
    if (!gizmo) {
      // Floor / ceiling — not gizmo-editable. Hint instead of a silent no-op.
      setSelectedNode(null)
      setNonEditableHint(sel.surfaceKind === 'floor' ? 'Boden' : 'Decke')
      return
    }
    setNonEditableHint(null)
    setSelectedNode(gizmo)

    // V-02: when a tool is armed, route the surface tap into the matching
    // editor sheet immediately and drop the tool so the next tap behaves
    // normally. `material` keeps falling through to `EditModeViewerHost`'s
    // MaterialPickerSheet (separate code path — left untouched here).
    switch (activeTool) {
      case 'pin':
        if (permissions.canAddOwnPin) {
          setAnnotationType('note')
          setAnnotationLabel(gizmo.label ?? 'Pin · ' + job.title)
          setAnnotationOpen(true)
          setActiveTool(null)
        }
        break
      case 'photo':
        if (permissions.canAddOwnPin) {
          setAnnotationType('photo')
          setAnnotationLabel(gizmo.label ?? 'Foto · ' + job.title)
          setAnnotationOpen(true)
          setActiveTool(null)
        }
        break
      case 'issue':
        if (permissions.canAddOwnPin) {
          setAnnotationType('issue')
          setAnnotationLabel(gizmo.label ?? 'Problem · ' + job.title)
          setAnnotationOpen(true)
          setActiveTool(null)
        }
        break
      case 'measure':
        if (permissions.canAddMeasurementOverride) {
          setMeasureOpen(true)
          setActiveTool(null)
        }
        break
      default:
        break
    }
  }, [activeTool, permissions.canAddOwnPin, permissions.canAddMeasurementOverride, job.title])

  // ── Save handlers (no-op stubs — persistence handled inside each sheet) ───

  const handleMeasureSave = useCallback(
    (_widthCm: number | null, _heightCm: number | null, _reason: string) => {
      // Best-effort audit append happens inside MeasurementEditorSheet.
    },
    [],
  )

  const handleAnnotationSave = useCallback(
    (_annotation: {
      type: AnnotationType
      text: string
      urgency: 'low' | 'medium' | 'high' | null
      isPublic: boolean
    }) => {
      // Best-effort audit append happens inside AnnotationEditorSheet.
    },
    [],
  )

  // ── Viewer area — drives off the blob-hydration lifecycle (C-2) ───────────

  let viewer: ReactElement
  if (!scene.isRenderable || blobState === 'absent') {
    viewer = (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-ink-muted">
          <Boxes size={40} strokeWidth={1.4} />
          <span className="text-[12px] font-medium">Modell wird vorbereitet</span>
        </div>
      </div>
    )
  } else if (blobState === 'loading') {
    const message =
      loadingPhase === 'initial'
        ? 'Aufmaß wird geladen …'
        : loadingPhase === 'slow'
          ? 'Lade 3D-Geometrie … (kann einen Moment dauern)'
          : 'Großes Modell — noch ein Moment …'
    viewer = (
      <div
        className="flex h-full items-center justify-center"
        aria-live="polite"
      >
        <div className="flex flex-col items-center gap-2 text-center text-ink-muted">
          <Spinner size="lg" tone="current" />
          <span className="max-w-[260px] text-[12px] font-medium">{message}</span>
          {loadingPhase === 'very-slow' && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-[10px] border border-edge bg-surface px-3 py-1.5 text-[12px] font-semibold text-brand"
            >
              Neu versuchen
            </button>
          )}
        </div>
      </div>
    )
  } else if (blobState === 'error') {
    viewer = (
      <div className="flex h-full items-center justify-center px-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <AlertTriangle size={34} className="text-danger" strokeWidth={1.6} />
          <span className="text-[13px] font-semibold text-ink">
            Aufmaß konnte nicht geladen werden
          </span>
          {blobError && (
            <span className="max-w-[260px] text-[11.5px] text-ink-muted">{blobError}</span>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 rounded-[10px] border border-edge bg-surface px-3 py-1.5 text-[12px] font-semibold text-brand"
            >
              Neu versuchen
            </button>
          )}
        </div>
      </div>
    )
  } else {
    // blobState === 'ready' — the real RoomScene is mounted into the editor.
    // `onNodeSelect` turns the host into a node-selection surface for the gizmo.
    viewer = (
      <EditModeViewerHost
        sceneId={scene.id}
        scene={roomScene}
        variants={variants}
        overrides={overrides}
        onNodeSelect={handleNodeSelect}
        joystickSuppressed={measureOpen || annotationOpen}
        className="absolute inset-0"
      />
    )
  }

  return (
    <div className="relative flex-1 overflow-hidden bg-gradient-to-b from-[#EEF1F6] to-[#E3E8F0]">
      {/* ── Viewer area ─────────────────────────────────────────────────── */}
      <div className="absolute inset-0">{viewer}</div>

      {/* ── Gizmo panel — bottom-right, above the toolbar ───────────────── */}
      {selectedNode && (
        <TransformGizmoPanel
          selectedNode={selectedNode}
          writableVariantId={writableVariantId}
          onClose={() => setSelectedNode(null)}
          className="absolute bottom-36 right-3 z-35"
        />
      )}

      {/* ── Read-only hint chip ──────────────────────────────────────────── */}
      {role === 'read_only' && (
        <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-chip bg-black/50 px-3 py-1.5 text-[11px] font-medium text-white backdrop-blur-xl">
          Leseansicht — keine Bearbeitungsrechte
        </div>
      )}

      {/* ── Non-editable-surface hint (C-3) ──────────────────────────────── */}
      {nonEditableHint && (
        <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-chip bg-black/55 px-3 py-1.5 text-[11px] font-medium text-white backdrop-blur-xl">
          {nonEditableHint} lässt sich nicht verschieben
        </div>
      )}

      {/* ── Bottom tool panel ────────────────────────────────────────────── */}
      <div className="absolute inset-x-0 bottom-0 z-40 border-t border-edge bg-white/95 px-2.5 pb-[max(20px,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl">
        {/* Variant line — shown only when the user has a writable layer.
            Layer switching itself lives in EditModeViewerHost's VariantSwitcher.
            V-13: the AR Quick-Look button shares this row, right-aligned, when
            a USDZ asset exists. Hidden if no USDZ — no empty slot. */}
        {(writableVariantId || usdzStoragePath) && (
          <div className="flex items-center gap-1.5 px-1.5 pb-2">
            {writableVariantId && (
              <>
                <span className="h-2 w-2 rounded-chip bg-brand-deep" />
                <span className="text-[11px] font-medium text-ink-sub">
                  Du bearbeitest · <b className="font-bold text-ink">Dein Arbeitsstand</b>
                </span>
              </>
            )}
            {usdzStoragePath && (
              <SpatialQuickLookButton
                usdzStoragePath={usdzStoragePath}
                iconOnly
                className="ml-auto"
              />
            )}
          </div>
        )}

        {/* Tool row (V-02: WAI-toolbar with toggleable tools) */}
        <div role="toolbar" aria-label="Editor-Werkzeuge" className="flex gap-1">
          {TOOLS.map((tool) => {
            const toolEnabled =
              tool.key === 'measure'
                ? permissions.canAddMeasurementOverride
                : tool.key === 'material'
                  ? permissions.canAddMaterialSuggestion
                  : permissions.canAddOwnPin
            const active = activeTool === tool.key

            return (
              <button
                key={tool.key}
                type="button"
                disabled={!toolEnabled}
                onClick={() => handleToolTap(tool.key)}
                aria-label={tool.label}
                aria-pressed={active}
                aria-disabled={!toolEnabled}
                className={[
                  'flex flex-1 flex-col items-center gap-1 rounded-[11px] py-1.5 transition',
                  toolEnabled ? 'active:bg-canvas' : 'opacity-35',
                  active ? 'bg-brand/10 ring-1 ring-brand' : '',
                ].join(' ')}
              >
                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-[9px] ${
                    tool.danger ? 'bg-[#FEE2E2] text-danger' : 'bg-[#EEF2FB] text-brand'
                  }`}
                >
                  <ToolGlyph toolKey={tool.key} />
                </span>
                <span className="text-[9.5px] font-semibold text-ink-sub">{tool.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Sheets ──────────────────────────────────────────────────────────*/}

      {/* Maß-Editor — Breite + Höhe, scan reference from the selected node */}
      {writableVariantId && (
        <MeasurementEditorSheet
          open={measureOpen}
          onClose={() => setMeasureOpen(false)}
          scene={scene}
          elementLabel={selectedNode?.label ?? job.title}
          baseNodeId={selectedNode?.nodeId}
          currentWidthCm={null}
          currentHeightCm={null}
          scanWidthCm={metersToScanCm(selectedNode?.measuredWidthM)}
          scanHeightCm={metersToScanCm(selectedNode?.measuredHeightM)}
          variantId={writableVariantId}
          onSave={handleMeasureSave}
        />
      )}

      {/* Annotation-Editor (Pin / Foto / Problem / Material) */}
      {writableVariantId && (
        <AnnotationEditorSheet
          open={annotationOpen}
          onClose={() => setAnnotationOpen(false)}
          scene={scene}
          elementLabel={annotationLabel}
          baseNodeId={selectedNode?.nodeId}
          initialType={annotationType}
          variantId={writableVariantId}
          onSave={handleAnnotationSave}
        />
      )}
    </div>
  )
}
