/**
 * WorkerFieldWalkScreen — Worker-Field Walk-Mode (Mockup 25 · B-7 → Phase C · C-11)
 *
 * Route: /worker/jobs/:jobId/spatial-walk
 *
 * Object-first interaction: tap a wall / object → a context sheet of actions.
 *
 * Phase C (C-11): the action stubs are wired to real capture flows.
 *   - The job's spatial scene is loaded (loading / empty / error states) — a
 *     worker opening the walk for a scan-less job no longer sees a fake room.
 *   - Each context action opens the matching leaf editor (Maß / Annotation);
 *     a successful capture confirms ("Erfasst — geht ans Büro") and is added
 *     to a session walk-log so the worker sees what they captured.
 *   - An offline banner warns when captures cannot be saved.
 *   - Photo captures upload to Storage via the Annotation editor (Seam 12).
 *
 * Phase-C seam still open: `Scene2DPlaceholder` is a 2D stand-in; the real 3D
 * hit-test engine replaces it later. The object-selection model is final.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Layers,
  MapPin,
  AlertTriangle,
  RefreshCw,
  Move,
  DoorOpen,
  CheckCircle2,
  WifiOff,
  Box,
  ScanLine,
} from 'lucide-react'
import { useStartRoomScan } from '../hooks/useStartRoomScan'
import { useToast } from '../hooks/useToast'
import Spinner from '../components/system/Spinner'
import AppShell from '../components/AppShell'
import BottomSheet from '../components/ui/BottomSheet'
import { useHaptics } from '../hooks/useHaptics'
import { useJobSpatialScene } from '../lib/spatial/canonical/workflow/useJobSpatialScene'
import { useSpatialEditPermissions } from '../lib/spatial/hooks/useSpatialEditPermissions'
import { MeasurementEditorSheet } from '../components/spatial/provider/MeasurementEditorSheet'
import {
  AnnotationEditorSheet,
  type AnnotationType,
} from '../components/spatial/provider/AnnotationEditorSheet'
import {
  ACTIONS_BY_KIND,
  INITIAL_WALK_SESSION,
  selectElement,
  deselect,
  type WalkableElement,
  type WalkAction,
  type WalkActionId,
} from '../lib/spatial/canonical/workflow/spatialWalkModel'
import type { WalkSessionState } from '../lib/spatial/canonical/workflow/spatialWalkModel'
import { useSmartBack } from '../hooks/useSmartBack'

// ─────────────────────────────────────────────────────────────────────────────
// Icon map
// ─────────────────────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ComponentType<{ size?: number }>> = {
  Pencil,
  Layers,
  Camera,
  MapPin,
  AlertTriangle,
  RefreshCw,
  Move,
  DoorOpen,
}

function ActionIcon({ name, size = 17 }: { name: string; size?: number }) {
  const Comp = ICON_MAP[name]
  if (!Comp) return <span className="text-xs text-ink-muted">{name[0]}</span>
  return <Comp size={size} />
}

const ACCENT_CLASSES: Record<WalkAction['accent'], { bg: string; text: string }> = {
  edit: { bg: 'bg-[#E5EDFB]', text: 'text-brand' },
  material: { bg: 'bg-[#F1ECFB]', text: 'text-[#7C3AED]' },
  photo: { bg: 'bg-[#E7F6EF]', text: 'text-ok' },
  pin: { bg: 'bg-[#EEF2FB]', text: 'text-[#1D4ED8]' },
  problem: { bg: 'bg-[#FEE2E2]', text: 'text-danger' },
  replace: { bg: 'bg-[#FEF3C7]', text: 'text-warn' },
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture-flow routing — maps a WalkAction to a leaf editor
// ─────────────────────────────────────────────────────────────────────────────

/** Which leaf editor a context action opens. */
type CaptureKind = 'measure' | 'note' | 'photo' | 'issue'

function captureKindFor(id: WalkActionId): CaptureKind {
  if (id === 'edit_dimensions' || id === 'edit_opening_dimensions') return 'measure'
  if (id === 'add_photo_pin') return 'photo'
  if (id === 'report_problem') return 'issue'
  return 'note' // materials / pin-note / replace / reposition / opening-type
}

/** Context label shown in the editor for a given action + element. */
function captureLabelFor(id: WalkActionId, element: WalkableElement): string {
  switch (id) {
    case 'edit_dimensions':
    case 'edit_opening_dimensions':
      return element.label
    case 'add_photo_pin':
      return `Foto · ${element.label}`
    case 'add_pin_note':
      return `Pin · ${element.label}`
    case 'report_problem':
      return `Problem · ${element.label}`
    case 'change_wall_material':
    case 'change_floor_material':
    case 'change_ceiling_material':
      return `Belag · ${element.label}`
    case 'change_opening_type':
      return `Öffnungstyp · ${element.label}`
    case 'replace_object':
      return `Austausch · ${element.label}`
    case 'reposition_object':
      return `Position · ${element.label}`
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2D scene placeholder (Phase-C seam — real 3D engine replaces this)
// ─────────────────────────────────────────────────────────────────────────────

function Scene2DPlaceholder({
  selectedId,
  onTap,
}: {
  selectedId: string | null
  onTap: (el: WalkableElement) => void
}) {
  const leftWallSelected = selectedId === 'wall-left'
  const backWallSelected = selectedId === 'wall-back'
  const rightWallSelected = selectedId === 'wall-right'
  const floorSelected = selectedId === 'floor-main'
  const toiletSelected = selectedId === 'obj-toilet'

  return (
    <svg
      viewBox="0 0 368 822"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-label="2D-Szene-Platzhalter (Phase-C: echte 3D-Ansicht)"
    >
      <defs>
        <linearGradient id="floorG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#C4CDDB" />
          <stop offset="1" stopColor="#9AA6B8" />
        </linearGradient>
        <linearGradient id="ceilG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#EFF2F7" />
          <stop offset="1" stopColor="#E2E7EF" />
        </linearGradient>
        <linearGradient id="lwallG" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#AEB9C9" />
          <stop offset="1" stopColor="#D7DEE8" />
        </linearGradient>
        <linearGradient id="rwallG" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#D7DEE8" />
          <stop offset="1" stopColor="#AEB9C9" />
        </linearGradient>
        <linearGradient id="backG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E8EDF4" />
          <stop offset="1" stopColor="#D3DBE6" />
        </linearGradient>
      </defs>

      <rect width="368" height="822" fill="#1A2433" />
      <polygon points="0,0 368,0 246,300 122,300" fill="url(#ceilG)" />

      <polygon
        points="122,520 246,520 368,822 0,822"
        fill={floorSelected ? '#2563EB' : 'url(#floorG)'}
        fillOpacity={floorSelected ? 0.35 : 1}
        stroke={floorSelected ? '#3B82F6' : 'none'}
        strokeWidth={floorSelected ? 3 : 0}
        onClick={() =>
          onTap({
            id: 'floor-main',
            kind: 'floor',
            label: 'Boden',
            subtitle: '8,2 m² · Feinsteinzeug grau',
          })
        }
        className="cursor-pointer"
      />
      <polygon
        points="0,0 122,300 122,520 0,822"
        fill={leftWallSelected ? '#2563EB' : 'url(#lwallG)'}
        fillOpacity={leftWallSelected ? 0.3 : 1}
        stroke={leftWallSelected ? '#3B82F6' : 'none'}
        strokeWidth={leftWallSelected ? 3.5 : 0}
        onClick={() =>
          onTap({
            id: 'wall-left',
            kind: 'wall',
            label: 'Wand West',
            subtitle: '2,80 m breit · 2,55 m hoch · 7,1 m²',
          })
        }
        className="cursor-pointer"
      />
      <polygon
        points="368,0 246,300 246,520 368,822"
        fill={rightWallSelected ? '#2563EB' : 'url(#rwallG)'}
        fillOpacity={rightWallSelected ? 0.3 : 1}
        stroke={rightWallSelected ? '#3B82F6' : 'none'}
        strokeWidth={rightWallSelected ? 3.5 : 0}
        onClick={() =>
          onTap({
            id: 'wall-right',
            kind: 'wall',
            label: 'Wand Ost',
            subtitle: '2,80 m breit · 2,55 m hoch · 7,1 m²',
          })
        }
        className="cursor-pointer"
      />
      <rect
        x="122"
        y="300"
        width="124"
        height="220"
        fill={backWallSelected ? '#2563EB' : 'url(#backG)'}
        fillOpacity={backWallSelected ? 0.3 : 1}
        stroke={backWallSelected ? '#3B82F6' : 'none'}
        strokeWidth={backWallSelected ? 3 : 0}
        onClick={() =>
          onTap({
            id: 'wall-back',
            kind: 'wall',
            label: 'Wand Nord',
            subtitle: '2,80 m breit · 2,55 m hoch · 6,2 m²',
          })
        }
        className="cursor-pointer"
      />

      <g stroke="#8b97a8" strokeWidth="1" opacity="0.5">
        <line x1="122" y1="520" x2="0" y2="822" />
        <line x1="246" y1="520" x2="368" y2="822" />
        <line x1="160" y1="520" x2="92" y2="822" />
        <line x1="208" y1="520" x2="276" y2="822" />
        <line x1="100" y1="600" x2="268" y2="600" />
        <line x1="70" y1="700" x2="298" y2="700" />
      </g>
      <line x1="122" y1="520" x2="246" y2="520" stroke="#7c8a9c" strokeWidth="3" />

      <polygon points="34,150 96,200 96,330 34,360" fill="#CBE0F7" stroke="#8FB4DE" strokeWidth="2" />
      <line x1="65" y1="175" x2="65" y2="345" stroke="#8FB4DE" strokeWidth="1.6" />

      <g
        transform="translate(150 452)"
        onClick={() =>
          onTap({
            id: 'obj-toilet',
            kind: 'object',
            label: 'WC',
            subtitle: 'Wand-WC · Tiefspüler · 0,36 × 0,54 m',
          })
        }
        className="cursor-pointer"
      >
        <ellipse
          cx="14"
          cy="50"
          rx="20"
          ry="11"
          fill={toiletSelected ? '#93C5FD' : '#fff'}
          stroke={toiletSelected ? '#2563EB' : '#9AA7BC'}
          strokeWidth="1.6"
        />
        <path
          d="M2 50 Q2 22 14 22 Q26 22 26 50Z"
          fill={toiletSelected ? '#93C5FD' : '#fff'}
          stroke={toiletSelected ? '#2563EB' : '#9AA7BC'}
          strokeWidth="1.6"
        />
        <rect
          x="6"
          y="2"
          width="18"
          height="22"
          rx="3"
          fill={toiletSelected ? '#93C5FD' : '#fff'}
          stroke={toiletSelected ? '#2563EB' : '#9AA7BC'}
          strokeWidth="1.6"
        />
      </g>
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Slim glass toolbar (State A)
// ─────────────────────────────────────────────────────────────────────────────

function GlassToolbar({ onFreePhoto }: { onFreePhoto: () => void }) {
  return (
    <div
      className="absolute bottom-[26px] left-[14px] right-[14px] z-40 flex items-center gap-[10px] rounded-full border border-white/16 px-[14px] py-[8px]"
      style={{
        background: 'rgba(18,26,38,0.34)',
        backdropFilter: 'blur(34px) saturate(200%)',
        WebkitBackdropFilter: 'blur(34px) saturate(200%)',
        boxShadow: '0 10px 30px -10px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.1)',
      }}
      aria-label="Walk-Toolbar"
    >
      <span className="flex-1 text-[11.5px] font-semibold text-white/82">
        Tippe eine Wand oder ein Objekt zum Bearbeiten
      </span>
      <button
        type="button"
        onClick={onFreePhoto}
        aria-label="Freies Foto aufnehmen"
        className="flex h-[40px] w-[40px] flex-shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/12 text-white"
      >
        <Camera size={17} />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Context action row
// ─────────────────────────────────────────────────────────────────────────────

function ActionRow({
  action,
  currentValue,
  isFirst,
  onTap,
}: {
  action: WalkAction
  currentValue?: string
  isFirst: boolean
  onTap: (id: WalkActionId) => void
}) {
  const { bg, text } = ACCENT_CLASSES[action.accent]
  return (
    <button
      type="button"
      onClick={() => onTap(action.id)}
      className={[
        'flex w-full items-center gap-[12px] px-[8px] py-[11px] text-left',
        !isFirst ? 'border-t border-edge' : '',
      ].join(' ')}
    >
      <span
        className={`flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[10px] ${bg} ${text}`}
      >
        <ActionIcon name={action.icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-[650] text-ink">{action.label}</span>
        <span className="block text-[11px] text-ink-muted">{action.hint}</span>
      </span>
      {currentValue && (
        <span className="flex-shrink-0 text-[12px] font-bold text-ink-sub">{currentValue}</span>
      )}
      <ChevronRight size={15} className="flex-shrink-0 text-ink-muted" />
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Context BottomSheet (State B)
// ─────────────────────────────────────────────────────────────────────────────

function ElementContextSheet({
  element,
  onClose,
  onActionSelected,
}: {
  element: WalkableElement
  onClose: () => void
  onActionSelected: (id: WalkActionId) => void
}) {
  const actions = useMemo(() => ACTIONS_BY_KIND[element.kind], [element.kind])

  return (
    <BottomSheet open onClose={onClose} hideHandle={false} maxWidth={480}>
      <div className="flex items-start gap-[10px] pb-[12px]">
        <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-[11px] bg-[#EEF2FB] text-brand">
          <Box size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-[750] leading-tight tracking-[-0.3px] text-ink">
            {element.label}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">{element.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Schließen"
          className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-full bg-canvas text-ink-sub"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div>
        {actions.map((action, idx) => (
          <ActionRow
            key={action.id}
            action={action}
            currentValue={element.currentValues?.[action.id]}
            isFirst={idx === 0}
            onTap={onActionSelected}
          />
        ))}
      </div>
    </BottomSheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

/** One captured action in the current walk session. */
interface WalkLogEntry {
  id: string
  label: string
}

export default function WorkerFieldWalkScreen() {
  const { jobId } = useParams<{ jobId: string }>()
  const haptics = useHaptics()
  const handleBack = useSmartBack('/worker/einsaetze')

  // C-11: load the job's spatial scene — a scan-less job no longer shows a
  // fake room.
  const { loading, error, scene, refetch } = useJobSpatialScene(jobId)
  const { writableVariantId } = useSpatialEditPermissions()
  const toast = useToast()
  // B9 · D3 — worker can self-measure a scan-less job from the walk-screen
  // empty state. Multi-tenant safe: bucket RLS uses auth.uid() (the worker's
  // own id) for the foldername; the spatial_create_scene RPC validates job
  // access via team_members through spatial_user_provider_org.
  const { startScan, busy: scanBusy, lidarAvailable } = useStartRoomScan()

  const [session, setSession] = useState<WalkSessionState>(INITIAL_WALK_SESSION)
  const [walkLog, setWalkLog] = useState<WalkLogEntry[]>([])
  const [savedFlash, setSavedFlash] = useState<string | null>(null)
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )

  // Capture-editor state.
  const [measureOpen, setMeasureOpen] = useState(false)
  const [annotationOpen, setAnnotationOpen] = useState(false)
  const [annotationType, setAnnotationType] = useState<AnnotationType>('note')
  const [captureElement, setCaptureElement] = useState<WalkableElement | null>(null)
  const [captureLabel, setCaptureLabel] = useState('')

  // Online / offline tracking (building sites have unreliable signal).
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  // Auto-clear the capture-success flash.
  useEffect(() => {
    if (!savedFlash) return
    const t = setTimeout(() => setSavedFlash(null), 2800)
    return () => clearTimeout(t)
  }, [savedFlash])

  const handleElementTap = useCallback(
    (el: WalkableElement) => {
      haptics.medium()
      setSession((prev) => selectElement(prev, el))
    },
    [haptics],
  )

  const handleSheetClose = useCallback(() => {
    haptics.light()
    setSession((prev) => deselect(prev))
  }, [haptics])

  const handleActionSelected = useCallback(
    (id: WalkActionId) => {
      const element = session.selectedElement
      if (!element) return
      haptics.heavy()
      setSession((prev) => deselect(prev)) // close the context sheet
      setCaptureElement(element)
      const kind = captureKindFor(id)
      setCaptureLabel(captureLabelFor(id, element))
      if (kind === 'measure') {
        setMeasureOpen(true)
      } else {
        setAnnotationType(kind === 'photo' ? 'photo' : kind === 'issue' ? 'issue' : 'note')
        setAnnotationOpen(true)
      }
    },
    [session.selectedElement, haptics],
  )

  const handleFreePhoto = useCallback(() => {
    haptics.light()
    setCaptureElement(null)
    setCaptureLabel('Freies Foto')
    setAnnotationType('photo')
    setAnnotationOpen(true)
  }, [haptics])

  // A successful capture (the editor calls onSave only after a confirmed
  // persistence — C-10) → walk-log entry + success flash.
  const recordCapture = useCallback(() => {
    haptics.success()
    setWalkLog((prev) => [
      { id: `log-${Date.now()}-${prev.length}`, label: captureLabel || 'Aufnahme' },
      ...prev,
    ])
    setSavedFlash('Erfasst — geht ans Büro')
  }, [haptics, captureLabel])

  const { selectedElement } = session

  // ── Loading / empty / error gates ──────────────────────────────────────────

  if (loading) {
    return (
      <AppShell active="worker-einsaetze" hideBottomNav noSafeTop>
        <div className="flex h-[100dvh] items-center justify-center bg-[#1A2433]">
          <Spinner size="md" tone="onDark" />
        </div>
      </AppShell>
    )
  }

  if (error || !scene) {
    // Scan-less + no error → offer the worker self-measure flow (B9).
    // LiDAR-gated: a non-iOS / non-LiDAR device gets a hint instead of the
    // CTA (useStartRoomScan itself surfaces the same fallback toast, but we
    // keep the button off-screen so the empty state stays clean).
    const canSelfMeasure = !error && jobId && lidarAvailable !== false

    const handleSelfMeasure = () => {
      if (!jobId) return
      void startScan({
        jobId,
        onSuccess: (_r, newScene) => {
          if (newScene) {
            // Lift the empty state so the worker can immediately walk the
            // freshly-captured room (no full page reload needed).
            refetch()
          } else {
            // Scan persisted but promotion failed — show the regular
            // hub-style toast; useStartRoomScan already surfaces an error.
            toast.info('Scan gespeichert — 3D-Aufmaß wird im Hintergrund erstellt.')
          }
        },
      })
    }

    return (
      <AppShell active="worker-einsaetze" hideBottomNav noSafeTop>
        <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-[#1A2433] px-8 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-white/10 text-white/80">
            <Box size={26} />
          </span>
          <p className="text-[15px] font-bold text-white">
            {error ? 'Aufmaß konnte nicht geladen werden' : 'Kein 3D-Aufmaß für diesen Job'}
          </p>
          <p className="max-w-[260px] text-[12.5px] text-white/60">
            {error
              ? error
              : 'Für diesen Auftrag liegt noch kein Kunden-Scan vor. Du kannst den Raum direkt selbst aufmessen.'}
          </p>
          {canSelfMeasure && (
            <button
              type="button"
              disabled={scanBusy}
              onClick={handleSelfMeasure}
              className="mt-2 flex items-center justify-center gap-2 rounded-[12px] bg-brand px-4 py-2.5 text-[13.5px] font-bold text-white shadow-[0_6px_16px_-6px_rgba(37,99,235,0.6)] disabled:opacity-50"
            >
              <ScanLine size={16} />
              {scanBusy ? 'Aufnahme läuft …' : 'Selbst aufmessen'}
            </button>
          )}
          <button
            type="button"
            onClick={handleBack}
            className="mt-1 rounded-[10px] bg-white/15 px-4 py-2 text-[13px] font-semibold text-white"
          >
            Zurück
          </button>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell active="worker-einsaetze" hideBottomNav noSafeTop>
      <div className="relative h-[100dvh] w-full overflow-hidden bg-[#1A2433]">
        <Scene2DPlaceholder selectedId={selectedElement?.id ?? null} onTap={handleElementTap} />

        {selectedElement && (
          <div className="absolute inset-0 z-[38] bg-[rgba(10,15,24,0.32)]" aria-hidden="true" />
        )}

        {/* Top bar */}
        <div className="absolute left-[12px] right-[12px] top-[max(50px,calc(env(safe-area-inset-top,0px)+8px))] z-40 flex items-center gap-[8px]">
          <button
            type="button"
            onClick={handleBack}
            aria-label="Zurück"
            className="flex h-[36px] w-[36px] flex-shrink-0 items-center justify-center rounded-full text-white"
            style={{
              background: 'rgba(20,28,40,0.5)',
              backdropFilter: 'blur(22px) saturate(180%)',
              WebkitBackdropFilter: 'blur(22px) saturate(180%)',
              border: '1px solid rgba(255,255,255,0.14)',
            }}
          >
            <ChevronLeft size={18} />
          </button>

          <div
            className="flex items-center gap-[7px] rounded-full px-[12px] py-[8px]"
            style={{
              background: 'rgba(20,28,40,0.5)',
              backdropFilter: 'blur(22px) saturate(180%)',
              WebkitBackdropFilter: 'blur(22px) saturate(180%)',
              border: '1px solid rgba(255,255,255,0.14)',
            }}
          >
            <span className="h-[7px] w-[7px] rounded-full bg-[#34D399] shadow-[0_0_0_3px_rgba(52,211,153,0.3)]" />
            <span className="text-[12px] font-[650] text-white">Walk · Inspektion</span>
          </div>

          <div className="flex-1" />

          {/* Walk-log counter — the worker sees what they've captured */}
          {walkLog.length > 0 && (
            <div
              className="flex items-center gap-[6px] rounded-full px-[11px] py-[7px] text-white"
              style={{
                background: 'rgba(20,28,40,0.5)',
                backdropFilter: 'blur(22px) saturate(180%)',
                WebkitBackdropFilter: 'blur(22px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.14)',
              }}
            >
              <CheckCircle2 size={13} className="text-[#34D399]" />
              <span className="text-[12px] font-[700]">{walkLog.length}</span>
              <span className="text-[10.5px] text-white/60">erfasst</span>
            </div>
          )}
        </div>

        {/* Offline banner */}
        {!online && (
          <div className="absolute left-[12px] right-[12px] top-[max(96px,calc(env(safe-area-inset-top,0px)+54px))] z-40 flex items-center gap-2 rounded-[11px] bg-[#FEF3C7] px-3 py-2">
            <WifiOff size={15} className="flex-shrink-0 text-warn" />
            <span className="text-[11.5px] font-[600] leading-snug text-[#92400E]">
              Offline — Aufnahmen können gerade nicht gespeichert werden. Warte auf
              Empfang, bevor du erfasst.
            </span>
          </div>
        )}

        {/* Capture-success flash */}
        {savedFlash && (
          <div className="absolute left-1/2 top-[max(96px,calc(env(safe-area-inset-top,0px)+54px))] z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[#047857] px-3.5 py-2 text-[12px] font-bold text-white shadow-[0_8px_24px_-6px_rgba(4,120,87,0.6)]">
            <CheckCircle2 size={14} />
            {savedFlash}
          </div>
        )}

        {/* State A: slim glass toolbar */}
        {!selectedElement && <GlassToolbar onFreePhoto={handleFreePhoto} />}

        {/* State B: element context sheet */}
        {selectedElement && (
          <ElementContextSheet
            element={selectedElement}
            onClose={handleSheetClose}
            onActionSelected={handleActionSelected}
          />
        )}

        {/* Capture editors — opened by a context action (C-11). */}
        {writableVariantId && (
          <MeasurementEditorSheet
            open={measureOpen}
            onClose={() => setMeasureOpen(false)}
            scene={scene}
            elementLabel={captureLabel}
            baseNodeId={captureElement?.id}
            currentWidthCm={null}
            currentHeightCm={null}
            scanWidthCm={null}
            scanHeightCm={null}
            variantId={writableVariantId}
            onSave={() => recordCapture()}
          />
        )}
        {writableVariantId && (
          <AnnotationEditorSheet
            open={annotationOpen}
            onClose={() => setAnnotationOpen(false)}
            scene={scene}
            elementLabel={captureLabel}
            baseNodeId={captureElement?.id}
            initialType={annotationType}
            variantId={writableVariantId}
            onSave={() => recordCapture()}
          />
        )}
      </div>
    </AppShell>
  )
}
