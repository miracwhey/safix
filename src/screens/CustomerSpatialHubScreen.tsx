/**
 * Spatial · V1.6.1 Hub-Refactor · CustomerSpatialHubScreen
 *
 * Customer Full-Bleed-3D Hub gegen Mockup 02 v8
 * (`~/.claude/plans/mockups/spatial-v151/02-spatial-hub.html`, binding).
 * Replaces the V1.6.0 list-over-3D layout, which buried the viewer beneath
 * a scrollable list of scan-cards and produced the user-reported "Liste
 * statt 3D-Hub"-Symptom.
 *
 * Refactor-Lessons (Device-Test 2026-05-27):
 *   - Der Hub IST der 3D-Viewer — Multi-Raum-Navigation läuft via Room-
 *     Picker-Popover im ⋯-Menü, nicht über eine Scan-Card-Liste
 *     (Architektur-Inversion gegenüber V1.6.0).
 *   - 7 unabhängige Sheet-States ohne zentralen Lock → Sheet-Stack-Reducer
 *     (`activeSheet`) ersetzt sieben Booleans. Maximal 1 Sheet ist
 *     interaktiv, der Rest bleibt unmounted bis es seine Welle ist.
 *   - `<AppShell active="profile" noSafeTop>` damit der Floating-Header
 *     nicht doppelt mit Safe-Area gepaddet wird.
 *   - URL-Sync-Effects (3 Stück, mutually re-triggernd) konsolidiert in
 *     einen Effect mit functional setSearchParams.
 *   - Card-Tap-Multi-Click-Guard war auf Listen-Karten-Links nötig — die
 *     Karten sind weg, das Problem löst sich von selbst.
 *
 * Decisions binding:
 *   - L151-2 Hub-Architektur: Full-Bleed-3D + Liquid-Glass v3 Pills · 2 Tabs
 *   - L151-6 View-Modes: 2D / 3D / Walk (Functional kommt mit Phase 3)
 *   - L151-7 Tool-Bar: Single-Container-Morph "Auswahl"
 *   - B.2-D7 Customer = HW feature parity (Walk + Edit-Pins identisch)
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { Box, ChevronLeft, MoreHorizontal, Sparkles } from 'lucide-react'

import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import CustomerNewRoomSheet from '../components/spatial/customer/CustomerNewRoomSheet'
import CustomerCustomCanvasSheet from '../components/spatial/customer/CustomerCustomCanvasSheet'
import CustomerOnboardingTour, {
  ONBOARDING_TOUR_STORAGE_KEY,
} from '../components/spatial/customer/CustomerOnboardingTour'
import ScanErrorRecoverySheet, {
  type ScanErrorRecoveryVariant,
} from '../components/spatial/customer/ScanErrorRecoverySheet'
import { useSpatialFirstRunFlag } from '../hooks/useSpatialFirstRunFlag'
import { useSpatialFirstSuccessToast } from '../hooks/useSpatialFirstSuccessToast'
import CustomerSpatialHubShell from '../components/spatial/customer/CustomerSpatialHubShell'
import CustomerViewModeSwitcher, {
  type CustomerViewMode,
} from '../components/spatial/customer/CustomerViewModeSwitcher'
import CustomerSpatialToolBar, {
  type CustomerSpatialTool,
} from '../components/spatial/customer/CustomerSpatialToolBar'
import CustomerRoomPickerPopover from '../components/spatial/customer/CustomerRoomPickerPopover'
import CustomerPinDetailSheet from '../components/spatial/customer/CustomerPinDetailSheet'
import CustomerSpatialContextSheet from '../components/spatial/customer/CustomerSpatialContextSheet'
import CustomerWallEditSheet, {
  type CustomerWallEditSheetSaveInput,
} from '../components/spatial/customer/CustomerWallEditSheet'
import { MaterialUndoToast } from '../components/spatial/edit/MaterialUndoToast'
import { VerifySheet } from '../components/spatial/verify/VerifySheet'
import type { TappedSurfaceKind } from '../components/spatial/three/canonical/surfaceTap'
import CaptureDsgvoConsentSheet from '../components/spatial/customer/CaptureDsgvoConsentSheet'
import CaptureResumeSheet from '../components/spatial/customer/CaptureResumeSheet'
import { SpatialViewer, type SpatialViewerViewMode } from '../components/spatial/SpatialViewer'
import { CanonicalSceneRoot } from '../components/spatial/three/canonical/CanonicalSceneRoot'
import { DimensionMeasureBar } from '../components/spatial/edit/DimensionMeasureBar'
import type { DimensionInputSheetValues } from '../components/spatial/edit/DimensionInputSheet'
import { deriveCustomerToolCounts } from '../components/spatial/deriveCustomerToolCounts'
import { polygonAreaM2 } from '../lib/spatial/canonical/geometry/footprint'
import { useCanonicalSceneStore } from '../lib/spatial/canonical/store/sceneStore'
import { useCustomerSceneHistoryStore } from '../lib/spatial/canonical/store/customerSceneHistoryStore'
import { useCustomerSpatialScene } from '../lib/spatial/canonical/workflow/useCustomerSpatialScene'
import { useStartCustomerLidarScan } from '../hooks/useStartCustomerLidarScan'
import { useDetectPendingCustomerCapture } from '../hooks/useDetectPendingCustomerCapture'
import { useToast } from '../hooks/useToast'
import { useHaptics } from '../hooks/useHaptics'
import { useSmartBack } from '../hooks/useSmartBack'
import { useCustomerSpatialScans } from '../lib/spatial/hooks/useCustomerSpatialScans'
import { useCustomerActiveScanGltf } from '../lib/spatial/hooks/useCustomerActiveScanGltf'
import { useCustomerSpatialMultiScan } from '../lib/spatial/hooks/useCustomerSpatialMultiScan'
import { attachPinPhoto, createCustomerPin } from '../lib/spatial/workflow/pinWorkflow'
import { isCustomerPinType } from '../lib/spatial/canonical/pins/pinTypeSystem'
import { buildWallLabels } from '../lib/spatial/canonical/geometry/wallLabels'
import {
  addOpeningToWall,
  addWallMountedObjectToWall,
  buildDefaultOpening,
  buildDefaultWallMountedObject,
  removeOpeningFromWall,
  removeWallMountedObjectFromWall,
  setWallMaterial,
  updateOpeningInWall,
  updateWallMountedObjectInWall,
  type CustomerWallMountedKind,
} from '../lib/spatial/canonical/mutations/customerObjectMutator'
import { getCatalogMaterialsBySurface } from '../lib/spatial/canonical/catalog/material-catalog'
import {
  findWallObjectAtOffset,
  wallLengthMeters,
  worldPointToWallLocalOffset,
} from '../lib/spatial/canonical/geometry/wallCoords'
import {
  aabbForOpening,
  aabbForWallMounted,
  validateObjectPosition,
} from '../lib/spatial/canonical/validator/objectPositionValidator'
import {
  evaluateWallObjectDin,
  snapWallObjectVerticalToDin,
  summarizeDinWarnings,
  type DinWarning,
} from '../lib/spatial/canonical/validator/wallObjectDinValidator'
import { AssetPickerSheet } from '../components/spatial/customer/AssetPickerSheet'
import { FurnitureEditActionBar } from '../components/spatial/customer/FurnitureEditActionBar'
import { getCatalogAsset } from '../lib/spatial/canonical/catalog/asset-catalog'
import type { CatalogAsset } from '../lib/spatial/canonical/catalog/types'
import {
  resolveSelectedFurnitureTap,
  rotateFurniture,
  scaleFurniture,
  duplicateFurniture,
  deleteFurniture,
} from '../lib/spatial/canonical/workflow/customerFurnitureOrchestrator'
import { deleteCeilingObject } from '../lib/spatial/canonical/workflow/customerCeilingObjectOrchestrator'
import {
  setWallDims,
  setEdgeLength,
  setAllWallsHeight,
  insertWallCorner,
} from '../lib/spatial/canonical/workflow/wallPointOrchestrator'
import { scaleLimitsForCategory } from '../lib/spatial/canonical/types/objects'
import { placeCatalogAsset } from '../lib/spatial/canonical/workflow/customerPlacementOrchestrator'
import { persistCustomerSceneMutation } from '../lib/spatial/workflow/persistCustomerSceneMutation'
import CustomerObjectEditSheet, {
  type CustomerObjectToolKind,
  type CustomerObjectEditSheetValue,
} from '../components/spatial/customer/CustomerObjectEditSheet'
import ElectricalSubPickerSheet, {
  type ElectricalKind,
} from '../components/spatial/customer/ElectricalSubPickerSheet'
import CustomerWallFinishSheet from '../components/spatial/customer/CustomerWallFinishSheet'
import type { WallOpening } from '../lib/spatial/canonical/types/geometry'
import { supabase } from '../lib/supabase'
import {
  clearPerfMarks,
  mark,
  measure,
  reportMeasureAsSpan,
} from '../lib/observability/perf'
import type { CustomerPinType, Scan } from '../lib/spatial/types'

type TabKey = 'vermessen' | 'vom-hw'

interface TabOption {
  key: TabKey
  label: string
  match: (s: Scan) => boolean
}

const TABS: TabOption[] = [
  {
    key: 'vermessen',
    label: 'Meine Räume',
    match: s => s.ownerType === 'customer',
  },
  {
    key: 'vom-hw',
    label: 'Vom HW',
    match: s => s.ownerType === 'craftsman' && s.sharedWithCustomer,
  },
]

const HW_SEEN_KEY = 'spatial.customer.hw.lastSeenCount'

/**
 * Sheet-Stack-Reducer: maximal 1 Sheet ist gleichzeitig aktiv. Versuch,
 * ein zweites zu öffnen während eines aktiv ist, wird silent gedroppt
 * (statt zwei stacked-Sheets zu produzieren). Pin-Detail ist die einzige
 * Ausnahme — sie öffnet aus einem Pin-Tool heraus mit eigenem
 * `pendingPlacement`-State, nicht via Sheet-Reducer.
 */
type SheetKey =
  | 'new-room'
  | 'custom-canvas'
  | 'dsgvo'
  | 'tour'
  | 'recovery'
  | 'room-picker'

type SheetAction =
  | { type: 'open'; sheet: SheetKey }
  | { type: 'close' }
  | { type: 'replace'; sheet: SheetKey }

interface SheetState {
  active: SheetKey | null
}

function sheetReducer(state: SheetState, action: SheetAction): SheetState {
  switch (action.type) {
    case 'open':
      // Lock: wenn schon ein Sheet aktiv ist, ignorieren wir den neuen
      // Open-Request — der User muss erst das aktive Sheet schließen.
      if (state.active !== null) return state
      return { active: action.sheet }
    case 'replace':
      // Replace ist die explizite Action für Sheet-Übergänge (z.B.
      // NewRoom → CustomCanvas), wo der Aufrufer weiß was er tut.
      return { active: action.sheet }
    case 'close':
      return { active: null }
    default:
      return state
  }
}

function formatDate(ts: number): string {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(ts))
  } catch {
    return ''
  }
}

function scanTitle(s: Scan): string {
  if (s.ownerType === 'customer') return 'Eigenes Aufmaß'
  return 'Aufmaß vom Handwerker'
}

/**
 * V1.6.1 Phase 3b · Map Customer-Mode auf SpatialViewer-Mode (Legacy-
 * Fallback). `<SpatialViewer>` kennt nur `'2d' | '3d' | 'walk'`; der
 * Customer-Switcher arbeitet mit `dollhouse / floorplan / walk` (Provider-
 * Parität). Mapping ist 1:1 weil SpatialViewer's "3d" der gleiche Orbit-
 * View ist wie Dollhouse, nur ohne den canonical Scene-Tree.
 */
function customerToSpatialViewerMode(
  mode: CustomerViewMode,
): SpatialViewerViewMode {
  if (mode === 'floorplan') return '2d'
  if (mode === 'walk') return 'walk'
  return '3d'
}

function parseTab(value: string | null): TabKey {
  return value === 'vom-hw' ? 'vom-hw' : 'vermessen'
}

// Per-customer "what HW-count have I already seen" — keyed by user id so a
// shared device works correctly. Returns 0 when no record exists yet.
function readHwLastSeen(userId: string | null): number {
  if (!userId || typeof window === 'undefined') return 0
  try {
    const raw = window.localStorage.getItem(`${HW_SEEN_KEY}.${userId}`)
    if (raw == null) return 0
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : 0
  } catch {
    return 0
  }
}

function writeHwLastSeen(userId: string | null, count: number): void {
  if (!userId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${HW_SEEN_KEY}.${userId}`, String(count))
  } catch {
    /* localStorage unavailable — ignore */
  }
}

/**
 * Display-Name für die Room-Info-Pill (links oben). `Scan` selbst hat
 * keine `metadata`-Spalte (die liegt auf `spatial_scenes`, eigener Fetch).
 * Bis ein Multi-Room-Sub-Fetch in einer separaten Welle dazukommt
 * reichen owner-bucket Labels mit Sequenz-Index für die Hub-Surface.
 */
function roomLabelForActiveScan(
  scan: Scan | null,
  allScans: ReadonlyArray<Scan>,
): string {
  if (!scan) return 'Raum'
  if (scan.ownerType === 'customer') {
    const own = allScans.filter(s => s.ownerType === 'customer')
    if (own.length <= 1) return 'Eigener Raum'
    const sorted = [...own].sort((a, b) => a.createdAt - b.createdAt)
    const idx = sorted.findIndex(s => s.id === scan.id)
    return idx >= 0 ? `Eigener Raum ${idx + 1}` : 'Eigener Raum'
  }
  const hwShared = allScans.filter(
    s => s.ownerType === 'craftsman' && s.sharedWithCustomer,
  )
  if (hwShared.length <= 1) return 'Vom HW'
  const sorted = [...hwShared].sort((a, b) => a.createdAt - b.createdAt)
  const idx = sorted.findIndex(s => s.id === scan.id)
  return idx >= 0 ? `Vom HW · Raum ${idx + 1}` : 'Vom HW'
}

export default function CustomerSpatialHubScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/profile')
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { scans, status, isHydrated, error, reload } = useCustomerSpatialScans()

  // V1.6.1 Phase 3b · Full-Bleed-3D: the native status bar (fullscreen overlay
  // + Light glyphs over the dark scene) is now owned globally by
  // StatusBarController, keyed on the `/customer/spatial/list` route — the old
  // per-screen mount-on/unmount-off toggle is gone (it raced with Reels and
  // left the bar stuck).
  // Phase 4 · First-success celebration toast — fires once when the customer
  // lands their first own scan (count 0 → 1).
  useSpatialFirstSuccessToast({ scans, isHydrated })

  const initialTab = parseTab(searchParams.get('tab'))
  const [tab, setTab] = useState<TabKey>(initialTab)

  // Sheet-Stack-Reducer ersetzt 6 unabhängige Booleans aus V1.6.0. Mutual
  // exclusion verhindert die User-Klage "App springt überall hin" — der
  // Tap auf "+ Neuer Raum" während Onboarding-Tour läuft wird silent
  // gedroppt statt 2 Sheets übereinander zu stapeln.
  const [sheetState, dispatchSheet] = useReducer(sheetReducer, { active: null })

  const onboardingFlag = useSpatialFirstRunFlag(ONBOARDING_TOUR_STORAGE_KEY)

  // Tour auto-open: nur wenn der Flag NICHT seen ist und kein anderes Sheet
  // im Weg ist (post-hydrate). Der Effect feuert nur EINMAL beim hydrate
  // ohne sich selbst neu zu triggern.
  const tourBootRef = useRef(false)
  useEffect(() => {
    if (!isHydrated || tourBootRef.current) return
    tourBootRef.current = true
    if (!onboardingFlag.seen && sheetState.active === null) {
      dispatchSheet({ type: 'open', sheet: 'tour' })
    }
    // intentionally ignore future onboardingFlag updates — auto-open is
    // a one-shot at first hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHydrated])

  // Cross-tab sync für die Tour-Flag — wenn ein anderer Tab die Tour fertig
  // macht, schließe sie hier ohne den Reducer-Lock zu öffnen.
  useEffect(() => {
    if (onboardingFlag.seen && sheetState.active === 'tour') {
      dispatchSheet({ type: 'close' })
    }
  }, [onboardingFlag.seen, sheetState.active])

  const [recoveryVariant, setRecoveryVariant] = useState<ScanErrorRecoveryVariant>('cancelled')
  const recoveryAttemptsRef = useRef(0)
  const MAX_RECOVERY_ATTEMPTS = 3
  const [userId, setUserId] = useState<string | null>(null)
  const {
    startCustomerLidarScan,
    busy: lidarBusy,
    lidarAvailable,
  } = useStartCustomerLidarScan()
  const toast = useToast()
  const haptics = useHaptics()
  const {
    pending: pendingCapture,
    shouldShow: showResumeSheet,
    resuming: resumeBusy,
    discarding: discardBusy,
    resume: runResume,
    discard: runDiscard,
    dismissForSession: dismissResumeForSession,
  } = useDetectPendingCustomerCapture({ userId })
  const [hwLastSeen, setHwLastSeen] = useState<number>(0)
  const [viewMode, setViewMode] = useState<CustomerViewMode>('dollhouse')

  const multiScanScopeKey = userId ? `user:${userId}` : null
  const { activeScanId, setActiveScanId } = useCustomerSpatialMultiScan({
    scans,
    scopeKey: multiScanScopeKey,
  })
  const { gltfUrl: activeGltfUrl, error: gltfError } =
    useCustomerActiveScanGltf(activeScanId)
  // V1.6.1 Phase 3b: canonical Scene-Hydration. Wenn parametric.json für
  // den aktiven Scan verfügbar ist, mounten wir `<CanonicalSceneRoot>` mit
  // den 3 Modi (Dollhouse / Floorplan / Walk). Legacy Customer-LiDAR-Scans
  // ohne parametric bleiben auf dem `<SpatialViewer>`-Fallback und der
  // Switcher locked alle 3 Modi mit Toast.
  const {
    roomScene,
    variants: sceneVariants,
    overrides: sceneOverrides,
    blobState,
    scene: spatialScene,
  } = useCustomerSpatialScene(activeScanId)
  const setStoreScene = useCanonicalSceneStore(s => s.setScene)
  // L4.a Undo/Redo: Snapshot-History (kein Command-Pattern — der Customer-Hub
  // mutiert direkt die volle Scene, siehe customerSceneHistoryStore). canUndo/
  // canRedo treiben die Header-Buttons; pushHistory/undo/redo/reset steuern den
  // Stack. Coalescing (600ms) macht aus einem Drag/Pinch genau einen Undo-Schritt.
  const pushHistory = useCustomerSceneHistoryStore((s) => s.push)
  const historyUndo = useCustomerSceneHistoryStore((s) => s.undo)
  const historyRedo = useCustomerSceneHistoryStore((s) => s.redo)
  const historyReset = useCustomerSceneHistoryStore((s) => s.reset)
  const canUndo = useCustomerSceneHistoryStore((s) => s.canUndo)
  const canRedo = useCustomerSceneHistoryStore((s) => s.canRedo)
  const lastEditTsRef = useRef(0)
  // Cluster A: Live-Store-Scene als reaktive Mutations-/Selektions-Basis. Der
  // `roomScene`-Hook ist nach Blob-Load eingefroren (refetch feuert nicht
  // mid-session) und taugt nur als Hydration-Seed + Readiness-Check.
  const liveScene = useCanonicalSceneStore((s) => s.scene)
  const storeCameraMode = useCanonicalSceneStore(s => s.cameraMode)
  const setStoreCameraMode = useCanonicalSceneStore(s => s.setCameraMode)
  const parametricReady = blobState === 'ready' && roomScene != null
  const effectiveViewMode: CustomerViewMode = parametricReady
    ? // canonical store ist source of truth — Provider-Parität
      ((storeCameraMode === 'ar_compare' ? 'dollhouse' : storeCameraMode) as CustomerViewMode)
    : viewMode
  const [gltfErrorDismissed, setGltfErrorDismissed] = useState(false)
  useEffect(() => {
    if (!gltfError) return
    setGltfErrorDismissed(false)
  }, [gltfError])

  // Perf-KPI — mount-start mark on glb URL flip, sweep all spatial.* marks
  // on unmount. Identical to V1.6.0; behaviour preserved.
  useEffect(() => {
    if (!activeGltfUrl) return
    mark('spatial.hub.mount-start')
  }, [activeGltfUrl])
  useEffect(() => {
    return () => {
      clearPerfMarks('spatial.')
    }
  }, [])

  // Tool-Bar + Pin-placement state — unverändert aus V1.6.0.
  const [activeTool, setActiveTool] = useState<CustomerSpatialTool | null>(null)
  const [pendingPlacement, setPendingPlacement] = useState<{
    surfaceExternalId: string
    uv: [number, number]
    worldXyz?: { x: number; y: number; z: number }
    pinType: CustomerPinType
  } | null>(null)
  const [pinSaveError, setPinSaveError] = useState<string | null>(null)
  const [pinSaving, setPinSaving] = useState(false)

  // Phase 4 Möbel-Place: Picker-Sheet + das gewählte Asset, das beim nächsten
  // Boden-Tap platziert wird. `activeTool='furniture'` ist scharf, sobald ein
  // Asset gewählt wurde (Picker → Weiter).
  // #8: bewusst standalone (nicht über den sheetReducer) — zweite dokumentierte
  // Ausnahme neben Pin-Detail. Sicher, weil `pickerOpen` nur über die Tool-Bar
  // (`handleToolSelect`) geöffnet wird, die ausgeblendet ist solange ein
  // Reducer-Sheet aktiv ist → faktische Mutual-Exclusion ohne Reducer-Kopplung.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingAsset, setPendingAsset] = useState<CatalogAsset | null>(null)
  // L4.b · Verify-Sheet (Aufmaß prüfen / korrigieren). Standalone-Boolean wie die
  // übrigen Edit-Sheets (nicht über den sheetReducer). Self-contained — alle
  // DB-Writes (Korrekturen + Verify-State via column-scoped RPC) laufen in
  // useVerifyFlow. Wird für renderbare Szenen gezeigt (HW-geteilt ODER Self-Scan),
  // NICHT auf activeSceneCanEdit gegated (das würde die CTA genau auf HW-Szenen
  // verstecken, wo Verify der Sinn ist).
  const [verifyOpen, setVerifyOpen] = useState(false)
  // Pin the verify session to the scene it opened on. VerifySheet is permanently
  // mounted and fed the LIVE active scene; activeScanId can flip mid-flow without
  // user action (a realtime HW-share lands, or a newer self-scan completes) →
  // sceneId would silently change and a Stage-5 confirm would mark the WRONG,
  // unreviewed scene. Abandon the open session on any active-scan change instead.
  useEffect(() => {
    if (verifyOpen) setVerifyOpen(false)
    // Intentionally depends ONLY on activeScanId — adding verifyOpen would close
    // the sheet the instant it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScanId])
  // V1.6.1 Gesten-Rework: globaler Ansehen↔Einrichten-Toggle. Default Ansehen
  // (false) → Möbel inert, alle Gesten = Kamera, kein Fehlgriff beim Umschauen.
  // Einrichten armt die Möbel-Gesten-Layer (dollhouse + walk) + zeigt die
  // Tool-Bar. Ref-Spiegel, damit handlePinPlaced den Live-Wert ohne Dep-Churn
  // liest.
  const [arrangeMode, setArrangeMode] = useState(false)
  const arrangeModeRef = useRef(arrangeMode)
  useEffect(() => {
    arrangeModeRef.current = arrangeMode
  }, [arrangeMode])
  // L0-#2: Elektro-Subtyp (Steckdose vs Schalter), gewählt im Sub-Picker bevor
  // der Wand-Tap platziert. Mirror des furniture-pickerOpen-Patterns.
  const [electricalPickerOpen, setElectricalPickerOpen] = useState(false)
  const [selectedElectricalKind, setSelectedElectricalKind] = useState<ElectricalKind>('electrical_outlet')

  // R11-B Hybrid Context-Sheet (Object-First): wenn der Customer eine
  // Surface antippt OHNE vorher ein Tool gewählt zu haben, zeigen wir die
  // kontext-relevanten Aktionen statt silent zu ignorieren. State hält das
  // tapped surface bis User entweder eine Aktion wählt oder closet.
  const [contextTap, setContextTap] = useState<{
    surfaceExternalId: string
    uv: [number, number]
    worldXyz?: { x: number; y: number; z: number }
    kind: TappedSurfaceKind
  } | null>(null)

  // #5a One-Step-Selection: ein Tap auf eine Surface highlightet sie (Store-
  // `selectedSurface`, von WallAdapter gelesen) UND öffnet direkt das Context-
  // Sheet. Tap-vs-Drag-Klassifikation lebt im SurfaceTapLayer (8px/350ms), ein
  // bewusster Tap meint also „handeln". Nur der Setter wird hier gebraucht — der
  // Store-Wert wird im Screen nicht mehr gelesen (das Highlight liest der Adapter).
  const setSelectedSurface = useCanonicalSceneStore((s) => s.setSelectedSurface)
  // V1.6.1 Partial-Focus-Unify: EIN Fokus (id + host) ersetzt das alte floor-only
  // selectedObjectId + den separaten wand-`editingObject`-State. Host gibt an,
  // welche Edit-UI greift (floor → Aktionsleiste/Dreh/Drag, wall → EditSheet,
  // ceiling → Decken-Drag/Aktionsleiste). Mutual exclusion ist jetzt strukturell.
  const focusedObjectId = useCanonicalSceneStore((s) => s.focusedObjectId)
  const focusedHost = useCanonicalSceneStore((s) => s.focusedHost)
  const setFocus = useCanonicalSceneStore((s) => s.setFocus)
  const clearFocus = useCanonicalSceneStore((s) => s.clearFocus)
  const setObjectInteractionLocked = useCanonicalSceneStore((s) => s.setObjectInteractionLocked)
  // Floor-only Sicht auf den Fokus — treibt `editingFurniture` + alle Möbel-Handler
  // (Drehen/Skalieren/Duplizieren/Löschen/Tap-to-Move), die floor-Semantik annehmen.
  // Bei Wand-/Decken-Fokus null → diese Pfade no-op, der Host-Layer/-Sheet übernimmt.
  const selectedObjectId = focusedHost === 'floor' ? focusedObjectId : null
  // V1.6.1 Partial-Focus-Unify: das wand-gehostete Edit-Objekt ist ABGELEITET aus
  // dem globalen Fokus statt eigener State. `focusedHost==='wall'` + die id genügen;
  // toolKind/wallId rekonstruieren wir per Scan über openings/wall_mounted (dieselbe
  // Auflösung, die die alten Re-Edit-Branches inline machten). Treibt
  // CustomerObjectEditSheet. Setzen via `setFocus(id,'wall')`, Schließen via `clearFocus()`.
  const editingObject = useMemo<{
    toolKind: CustomerObjectToolKind
    wallId: string
    openingId: string
  } | null>(() => {
    if (focusedHost !== 'wall' || !focusedObjectId || !liveScene) return null
    for (const wall of liveScene.walls) {
      const op = wall.openings.find((o) => o.id === focusedObjectId)
      if (op) {
        return { toolKind: op.type === 'window' ? 'window' : 'door', wallId: wall.id, openingId: op.id }
      }
      const wm = wall.wall_mounted.find((o) => o.id === focusedObjectId)
      if (wm) {
        return {
          toolKind: wm.category === 'radiator' ? 'heating' : 'electrical',
          wallId: wall.id,
          openingId: wm.id,
        }
      }
    }
    return null
  }, [focusedHost, focusedObjectId, liveScene])
  const [objectSaveHint, setObjectSaveHint] = useState<string | undefined>(undefined)
  // L0-#3 + Lane-1: harte Overlap-Kollision der letzten Slider-Änderung (rot,
  // Änderung verworfen) + nicht-blockierende DIN/VDE-Soft-Hinweise (amber) für
  // das EditSheet-Banner.
  const [editConflict, setEditConflict] = useState<string | null>(null)
  const [editDinWarnings, setEditDinWarnings] = useState<DinWarning[]>([])
  const objectPersistTimer = useRef<number | null>(null)

  // Cluster D RBAC: nur eigene Customer-Scans (ownerType='customer') sind
  // editierbar; HW-geteilte Aufmaße bleiben read-only (Customer kommentiert nur
  // via Pins). Einziger Truth-Wert für alle Geometrie-Guards + den Persist-
  // Chokepoint. Früh deklariert, damit Callbacks ihn im Dep-Array führen können.
  const activeSceneCanEdit = useMemo(() => {
    if (!activeScanId) return false
    const scan = scans.find((s) => s.id === activeScanId)
    return scan?.ownerType === 'customer'
  }, [scans, activeScanId])

  // Persistierung des aktuellen RoomScene gegen Supabase — debounced damit
  // Slider-Drags nicht jeden 60Hz-Tick uploaden. Schreibt Blob neu + updated
  // scene-record. Bei Failure: toast.info, lokaler State bleibt.
  const schedulePersistScene = useCallback(
    (latestScene: typeof roomScene) => {
      // RBAC-Chokepoint: kein Write für fremde HW-Aufmaße (Daten-Integrität).
      if (!activeSceneCanEdit) return
      if (!latestScene || !spatialScene?.id || !userId) return
      if (objectPersistTimer.current) {
        window.clearTimeout(objectPersistTimer.current)
      }
      setObjectSaveHint('Speichert…')
      objectPersistTimer.current = window.setTimeout(() => {
        objectPersistTimer.current = null
        void persistCustomerSceneMutation({
          sceneId: spatialScene.id,
          userId,
          callerCanEdit: activeSceneCanEdit,
          roomScene: latestScene,
        }).then((result) => {
          if (result.ok) {
            setObjectSaveHint('Gespeichert')
            // Hint nach 2s abblenden — kein UI-Lärm.
            window.setTimeout(() => setObjectSaveHint(undefined), 2000)
          } else {
            setObjectSaveHint(undefined)
            toast.info(
              'Änderung übernommen — Speichern fehlgeschlagen. Versuch beim nächsten Tap erneut.',
            )
          }
        })
      }, 450)
    },
    [activeSceneCanEdit, spatialScene?.id, userId, toast],
  )

  // L4.a: ein Edit committen — pre-Edit-Scene in die Undo-History, dann Store +
  // Persist. Zeit-Coalescing: aufeinanderfolgende Commits innerhalb von 600 ms
  // (Finger-Drag, Pinch, Slider-Zug, Button-Mashing) teilen sich EINEN Undo-
  // Schritt — die History bekommt nur die Scene VOR Gesten-Beginn. Genau hier
  // (nicht in setStoreScene) kapseln wir History, weil setStoreScene auch für die
  // Hydration genutzt wird — die soll keinen Undo-Eintrag erzeugen.
  const HISTORY_COALESCE_MS = 600
  const commitSceneEdit = useCallback(
    (nextScene: NonNullable<typeof liveScene>) => {
      const prev = useCanonicalSceneStore.getState().scene
      const now = Date.now()
      if (prev && prev !== nextScene && now - lastEditTsRef.current > HISTORY_COALESCE_MS) {
        pushHistory(prev)
      }
      lastEditTsRef.current = now
      setStoreScene(nextScene)
      schedulePersistScene(nextScene)
    },
    [setStoreScene, schedulePersistScene, pushHistory],
  )

  // L4.a: Undo/Redo. Restore-Pfade gehen NICHT durch commitSceneEdit (sonst
  // würde das Wiederherstellen selbst einen History-Eintrag erzeugen) — der
  // Store verschiebt die Scenes intern zwischen past/future. lastEditTsRef wird
  // genullt, damit der nächste echte Edit sauber einen neuen Schritt startet.
  const handleUndo = useCallback(() => {
    const current = useCanonicalSceneStore.getState().scene
    if (!current) return
    const restore = historyUndo(current)
    if (!restore) return
    lastEditTsRef.current = 0
    clearFocus()
    setStoreScene(restore)
    schedulePersistScene(restore)
  }, [historyUndo, clearFocus, setStoreScene, schedulePersistScene])

  const handleRedo = useCallback(() => {
    const current = useCanonicalSceneStore.getState().scene
    if (!current) return
    const restore = historyRedo(current)
    if (!restore) return
    lastEditTsRef.current = 0
    clearFocus()
    setStoreScene(restore)
    schedulePersistScene(restore)
  }, [historyRedo, clearFocus, setStoreScene, schedulePersistScene])

  // ── Footprint-Editing (2D Grundriss) ──────────────────────────────────────
  // Wand-Kante ziehen + „Ecke einfügen" + exakte Maße. 1:1-Port der HW-Pipeline
  // (SpatialMultiModeViewer). Gilt für JEDE eigene Customer-Szene (manual UND
  // LiDAR) via `activeSceneCanEdit`; der FloorplanDragLayer wird in
  // CanonicalSceneRoot zusätzlich auf `cameraMode==='floorplan'` gegated.
  // LiDAR-Edits sind nicht-destruktiv abgesichert: sie erben Undo/Redo
  // (commitSceneEdit) und der Original-Scan bleibt in scans/scan_assets erhalten.
  const [footprintWallId, setFootprintWallId] = useState<string | null>(null)
  const footprintWall = useMemo(
    () =>
      footprintWallId && liveScene
        ? (liveScene.walls.find((w) => w.id === footprintWallId) ?? null)
        : null,
    [footprintWallId, liveScene],
  )

  // Crypto-strong id (mirror der bestehenden Inline-Generatoren im Hub).
  const freshId = useCallback(
    () =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `obj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    [],
  )

  const clearFootprintWallSelection = useCallback(() => {
    setFootprintWallId(null)
    setSelectedSurface(null)
  }, [setSelectedSurface])

  const handleFootprintWallSelect = useCallback(
    (id: string | null) => {
      setFootprintWallId(id)
      setSelectedSurface(id ? `wall-${id}` : null)
      if (id) haptics.selection()
    },
    [setSelectedSurface, haptics],
  )

  const handleFootprintInvalid = useCallback(
    (message: string) => {
      toast.info(message)
    },
    [toast],
  )

  // 2D-Objekt/Öffnung-Tap → dieselbe Edit-Sheet wie ein 3D-Tap (Wand-Selektion
  // räumen + Focus setzen + Surface-Highlight droppen).
  const handleFootprintObjectSelect = useCallback(
    (sel: { host: 'floor' | 'wall'; id: string }) => {
      clearFootprintWallSelection()
      setFocus(sel.id, sel.host)
      setSelectedSurface(null)
    },
    [clearFootprintWallSelection, setFocus, setSelectedSurface],
  )

  // „Ecke einfügen" → rechtwinkliger Knick in die gewählte Wand (L/U-Form),
  // danach den herausgeschobenen Abschnitt selektieren, damit der nächste Slide
  // die L vertieft. RBAC: nur eigene Szenen.
  const handleSplitWall = useCallback(() => {
    if (!activeSceneCanEdit) return
    const scene = useCanonicalSceneStore.getState().scene
    const id = footprintWallId
    if (!scene || !id) return
    const right = freshId()
    const r = insertWallCorner({
      scene,
      wallId: id,
      newWallIdLeft: freshId(),
      newWallIdRiser: freshId(),
      newWallIdRight: right,
      generatedAt: new Date().toISOString(),
    })
    if (r.kind === 'updated') {
      commitSceneEdit(r.scene)
      handleFootprintWallSelect(right)
      haptics.success()
    } else {
      toast.info(r.message)
      haptics.warning()
    }
  }, [
    activeSceneCanEdit,
    footprintWallId,
    freshId,
    commitSceneEdit,
    handleFootprintWallSelect,
    toast,
    haptics,
  ])

  // Maß-Bar LIVE durch den footprint-first Orchestrator (Länge = Corner-Cascade,
  // Höhe/Dicke = footprint-safe). Mirror von `applyDim` im HW-Viewer.
  const applyFootprintDim = useCallback(
    (values: DimensionInputSheetValues) => {
      if (!activeSceneCanEdit) return
      const scene = useCanonicalSceneStore.getState().scene
      const wall = scene?.walls.find((w) => w.id === footprintWallId)
      if (!scene || !footprintWallId || !wall) return
      let working = scene
      const curLen =
        wall.length_m ??
        Math.hypot(
          wall.end_point.x - wall.start_point.x,
          wall.end_point.z - wall.start_point.z,
        )
      if (Math.abs(values.lengthM - curLen) > 1e-4) {
        const r = setEdgeLength({ scene: working, wallId: footprintWallId, lengthM: values.lengthM })
        if (r.kind === 'rejected') {
          toast.info(r.message)
          return
        }
        working = r.scene
      }
      if (values.applyHeightToAllWalls) {
        const r = setAllWallsHeight({ scene: working, heightM: values.heightM })
        if (r.kind === 'rejected') {
          toast.info(r.message)
          return
        }
        working = r.scene
      }
      const rDims = setWallDims({
        scene: working,
        wallId: footprintWallId,
        heightM: values.heightM,
        thicknessM: values.thicknessM,
      })
      if (rDims.kind === 'rejected') {
        toast.info(rDims.message)
        return
      }
      working = rDims.scene
      if (working !== scene) commitSceneEdit(working)
    },
    [activeSceneCanEdit, footprintWallId, commitSceneEdit, toast],
  )

  // Verlässt der User den 2D-Grundriss, Wand-Selektion + Highlight räumen (die
  // Maß-Bar ist floorplan-only; sonst hinge der Glow im 3D/Walk).
  useEffect(() => {
    if (effectiveViewMode !== 'floorplan' && footprintWallId) {
      clearFootprintWallSelection()
    }
  }, [effectiveViewMode, footprintWallId, clearFootprintWallSelection])

  // ── Mess-Readout-Politur ───────────────────────────────────────────────────
  // Live-Raummetrik (Fläche + Wandzahl) für die RoomInfoPill: aus der LIVE-Szene
  // neu berechnet (polygonAreaM2), damit der m²-Wert beim Wand-Ziehen mitläuft —
  // nicht der gecachte computed_area_m2, der erst beim Re-Derive aktualisiert.
  const roomMetrics = useMemo(() => {
    const s = liveScene ?? roomScene
    return {
      wallCount: s?.walls.length ?? 0,
      areaM2: s ? polygonAreaM2(s.floor?.polygon ?? []) : 0,
    }
  }, [liveScene, roomScene])

  // Tool-Count-Badges: „wie viele Türen/Fenster/… habe ich markiert". Live aus
  // der Szene projiziert (kein Glow-Pulse — das Badge inkrementiert ohnehin
  // sichtbar bei jeder Platzierung, da liveScene aktualisiert).
  const toolCounts = useMemo(() => {
    const s = liveScene ?? roomScene
    return s ? deriveCustomerToolCounts(s) : {}
  }, [liveScene, roomScene])

  const handlePinPlaced = useCallback(
    (input: {
      kind?: TappedSurfaceKind
      surfaceExternalId: string
      uv: [number, number]
      worldXyz?: { x: number; y: number; z: number }
    }) => {
      mark('spatial.pin.raycast-start')
      // Cluster A: Mutations-/Selektions-Basis IMMER aus der Live-Store-Scene
      // lesen — sonst baut jede Platzierung/Selektion auf der eingefrorenen
      // `roomScene` auf (stale Base → 2. Möbel löscht 1., Edit-Modus tot).
      const scene = useCanonicalSceneStore.getState().scene
      // Cluster D RBAC: auf fremden HW-Aufmaßen ist jede Geometrie-Mutation
      // gesperrt (Platzieren/Verschieben/Editieren/Selektieren). Pins/Kommentare
      // laufen über einen eigenen Pfad (createCustomerPin) und bleiben für den
      // Review-Flow erlaubt — nur Geometrie wird hier geblockt.
      const wantsGeometryEdit =
        selectedObjectId != null ||
        (!activeTool && input.kind === 'object') ||
        activeTool === 'furniture' ||
        activeTool === 'door' ||
        activeTool === 'window' ||
        activeTool === 'heating' ||
        activeTool === 'electrical'
      if (!activeSceneCanEdit && wantsGeometryEdit) {
        toast.info('Aufmaße vom Handwerker sind schreibgeschützt')
        return
      }
      // Tap auf ein editierbares Objekt → Host auflösen + fokussieren. true bei
      // Treffer (floor/ceiling/wall-mounted). Geteilt vom „Fokus wechseln während
      // etwas fokussiert ist"-Pfad und vom Frisch-Select-Pfad, damit ein Tap auf
      // IRGENDEIN Objekt es fokussiert — keine Host-Falle (Review #3).
      const focusTappedObject = (sc: NonNullable<typeof scene>, id: string): boolean => {
        if (sc.floor.floor_mounted.some((o) => o.id === id)) {
          setFocus(id, 'floor')
          return true
        }
        if (sc.ceiling.ceiling_mounted.some((o) => o.id === id)) {
          setFocus(id, 'ceiling')
          return true
        }
        for (const wall of sc.walls) {
          if (wall.wall_mounted.some((o) => o.id === id)) {
            setFocus(id, 'wall')
            setSelectedSurface(null)
            return true
          }
        }
        return false
      }
      // Phase 5/6 Edit-Modus: ein FLOOR-Möbel ist fokussiert (kein Tool aktiv).
      //   - Tap auf anderes Boden-Möbel → Selektion wechseln
      //   - Boden-Tap → #5b Abwählen (Verschieben läuft nur noch per Finger-Drag;
      //     Tap-to-Move teleportierte das Möbel bei jedem Fehlgriff daneben)
      //   - Tap auf anderes Objekt (Decke/Wand) → Fokus dorthin wechseln
      //   - sonst (selbes Möbel / leere Wand) → im Edit-Modus bleiben
      if (selectedObjectId && scene) {
        const result = resolveSelectedFurnitureTap({
          scene,
          selectedObjectId,
          tap: {
            kind: input.kind,
            surfaceExternalId: input.surfaceExternalId,
            worldXyz: input.worldXyz,
          },
        })
        if (result.kind === 'select-object') {
          setFocus(result.objectId, 'floor')
          return
        }
        if (result.kind === 'deselect') {
          clearFocus()
          return
        }
        // 'ignore': nicht als Abwählen/Wechsel behandelt. Tippte der User auf
        // ein ANDERES editierbares Objekt (Decken-Leuchte / Wand-Objekt), Fokus
        // dorthin wechseln statt ihn auf dem Boden-Möbel zu fangen.
        if (input.kind === 'object' && focusTappedObject(scene, input.surfaceExternalId)) return
        return
      }
      // Enter Edit-Modus: nur in Einrichten + kein Tool aktiv + Tap auf ein
      // editierbares Objekt (floor/ceiling/wall-mounted). In Ansehen inert.
      // Decken-/Wand-Objekte resolven ebenfalls als kind 'object' (PickProxy):
      // Decke → Decken-Fokus (Drag), Wand → Wand-Fokus (Edit-Sheet leitet ab).
      if (arrangeModeRef.current && !activeTool && input.kind === 'object' && scene) {
        if (focusTappedObject(scene, input.surfaceExternalId)) return
      }
      // Re-Edit: Tap auf eine platzierte Tür/Fenster. Openings rendern in CSG-
      // Wänden ohne eigenen Pick-Proxy → der Tap kommt als kind 'wall'. Geo-
      // metrischer Hit-Test auf dem Wall-Treffer (worldXyz → wall-local) →
      // liegt der Punkt in einer Opening/wall_mounted-Rect, Edit-Sheet öffnen.
      // Nur mit Edit-Rechten (Geometrie-Edit); sonst fällt es auf die Wand-
      // Context-Logik unten durch (read-only-sicher).
      if (arrangeModeRef.current && !activeTool && input.kind === 'wall' && input.worldXyz && scene && activeSceneCanEdit) {
        const wall = scene.walls.find((w) => w.id === input.surfaceExternalId)
        if (wall) {
          const local = worldPointToWallLocalOffset(
            wall,
            input.worldXyz,
            wallLengthMeters(wall),
            wall.height_m,
          )
          const hit = findWallObjectAtOffset(wall, local)
          if (hit) {
            // Wand-Fokus — toolKind/wallId leitet `editingObject` aus der id ab.
            setFocus(hit.id, 'wall')
            setSelectedSurface(null)
            return
          }
        }
      }
      // R11-C Tool-First Wand-Edit: activeTool='wall' + Wand getappt →
      // direkt Edit-Sheet, kein Context-Sheet als Zwischenstation.
      if (activeTool === 'wall' && input.kind === 'wall') {
        setEditingWallId(input.surfaceExternalId)
        setSelectedSurface(null)
        return
      }
      // L0 Customer-Hub object-placement: Tür/Fenster (opening) OR Heizung/
      // Elektro (wall-mounted) — both must-succeed paths (Plan §L0.2-L0.5).
      // Tap-X uses worldPointToWallLocalOffset (Plan §L0.1) instead of always
      // centering. Pre-flight validator (Plan §L0.6) blocks out-of-wall +
      // ceiling/floor-breach + AABB-overlap with a clear toast.
      if (
        activeTool === 'door' ||
        activeTool === 'window' ||
        activeTool === 'heating' ||
        activeTool === 'electrical'
      ) {
        if (input.kind !== 'wall') {
          console.warn('[L0] tap wrong-kind', { activeTool, kind: input.kind })
          toast.info('Bitte direkt auf eine Wand tippen')
          return
        }
        if (!scene) {
          console.warn('[L0] scene null', {
            activeTool,
            blobState,
            scanId: activeScanId,
            hasScene: spatialScene != null,
          })
          toast.info('Raum wird noch geladen — bitte kurz warten')
          return
        }
        const wall = scene.walls.find((w) => w.id === input.surfaceExternalId)
        if (!wall) {
          console.warn('[L0] wall not found in scene', {
            surfaceExternalId: input.surfaceExternalId,
            wallCount: scene.walls.length,
          })
          toast.info('Wand nicht erkannt — bitte erneut tippen')
          return
        }
        const wallLengthM = wallLengthMeters(wall)
        // Tap-X-/Y-Projection (L0.1) — wenn raycast-hit gegeben, projeziere
        // auf wall-local; sonst fallback auf mid-wall (legacy R13 path).
        const tapLocal = input.worldXyz
          ? worldPointToWallLocalOffset(wall, input.worldXyz, wallLengthM, wall.height_m)
          : undefined

        const newId =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `obj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

        // Build the candidate + run pre-flight validator BEFORE committing.
        if (activeTool === 'door' || activeTool === 'window') {
          const newOpening: WallOpening = buildDefaultOpening({
            id: newId,
            wallId: wall.id,
            wallLengthM,
            wallHeightM: wall.height_m,
            type: activeTool,
            variantId: 'customer_corrections',
            generatedAt: new Date().toISOString(),
            tapOffsetAlongWallM: tapLocal?.offset_along_wall_m,
          })
          const validation = validateObjectPosition({
            wall,
            wallLengthM,
            candidate: aabbForOpening(newOpening),
          })
          if (!validation.ok) {
            console.warn('[L0] opening rejected', { reason: validation.reason })
            toast.info(validation.message)
            return
          }
          const nextScene = addOpeningToWall(scene, {
            wallId: wall.id,
            opening: newOpening,
          })
          commitSceneEdit(nextScene)
          setFocus(newOpening.id, 'wall')
          setActiveTool(null)
          setSelectedSurface(`wall-${wall.id}`)
          return
        }

        // L0.4 / L0.5 — wall-mounted SpatialObject (heating / electrical_outlet).
        // The toolbar currently exposes a single 'electrical' tool which drops
        // a Schuko outlet by default; switching to a light_switch happens via
        // a follow-up category-picker (deferred to Phase L1 DIN sub-picker).
        const wallMountedKind: CustomerWallMountedKind =
          activeTool === 'heating' ? 'heating' : selectedElectricalKind
        // Kind → ObjectCategory für den DIN-Snap (Schalter→light_switch→1,05 m).
        const snapCategory =
          wallMountedKind === 'heating'
            ? 'radiator'
            : wallMountedKind === 'electrical_switch'
              ? 'light_switch'
              : 'electrical_outlet'
        // DIN-Vertikal-Snap auf die Tap-Höhe (Schalter→1,05 / Steckdose→0,30|1,10 m),
        // damit ein grob platziertes Elektro-Objekt direkt auf Norm-Höhe einrastet.
        const snappedTapFromFloorM =
          tapLocal?.offset_from_floor_m != null
            ? snapWallObjectVerticalToDin(snapCategory, tapLocal.offset_from_floor_m)
            : undefined
        const newObject = buildDefaultWallMountedObject({
          id: newId,
          wallId: wall.id,
          wallLengthM,
          wallHeightM: wall.height_m,
          kind: wallMountedKind,
          variantId: 'customer_corrections',
          generatedAt: new Date().toISOString(),
          tapOffsetAlongWallM: tapLocal?.offset_along_wall_m,
          tapOffsetFromFloorM: snappedTapFromFloorM,
        })
        const wmAabb = aabbForWallMounted(newObject)
        if (wmAabb) {
          const validation = validateObjectPosition({
            wall,
            wallLengthM,
            candidate: wmAabb,
          })
          if (!validation.ok) {
            console.warn('[L0] wall_mounted rejected', { reason: validation.reason })
            toast.info(validation.message)
            return
          }
        }
        const nextScene = addWallMountedObjectToWall(scene, {
          wallId: wall.id,
          object: newObject,
        })
        commitSceneEdit(nextScene)
        setFocus(newObject.id, 'wall')
        setActiveTool(null)
        setSelectedSurface(`wall-${wall.id}`)
        return
      }
      // Phase 4 Möbel-Place: activeTool='furniture' + ein gewähltes Asset →
      // Boden-Tap platziert es am Tap-Punkt (worldXyz.x/z) in
      // `floor.floor_mounted`. Hard-Bounds-Check (point-in-polygon) blockt
      // out-of-floor. Edit-Modus (Drehen/Verschieben/Skalieren) kommt in
      // Phase 5/6 — hier wird nur platziert + persistiert.
      if (activeTool === 'furniture') {
        // #6: Platzierung nur im Dollhouse — in Walk fightet der nipplejs-Joystick
        // den Tap, in Floorplan (ortho top-down) bricht die scale-aware Floor-Y-
        // Annahme. Gilt für Boden/Wand/Decke gleichermaßen.
        if (storeCameraMode !== 'dollhouse' && storeCameraMode !== 'walk') {
          toast.info('Objekte platzieren nur in der 3D- oder Begehen-Ansicht')
          return
        }
        if (!scene) {
          console.warn('[place] scene null', { blobState, scanId: activeScanId })
          toast.info('Raum wird noch geladen — bitte kurz warten')
          return
        }
        if (!pendingAsset) {
          // Tool scharf, aber kein Asset (z.B. Picker ohne Auswahl geschlossen).
          setActiveTool(null)
          return
        }
        const newId =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `obj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        // Host-aware: der autoritative Host (snapRule.target_host, inkl. Overrides
        // wie Stehlampe→floor) entscheidet, ob der Tap auf Boden/Wand/Decke gültig
        // ist. Keine „gehört an Wand"-Sackgasse mehr — falsche Fläche → Hinweis +
        // Tool bleibt scharf, bis die richtige Fläche getappt wird.
        const result = placeCatalogAsset({
          scene,
          asset: {
            slug: pendingAsset.slug,
            objectCategory: pendingAsset.objectCategory,
            dimensions: pendingAsset.dimensions,
            host: pendingAsset.snapRule.target_host,
            displayName: pendingAsset.displayName,
          },
          newId,
          generatedAt: new Date().toISOString(),
          tappedKind: input.kind,
          surfaceId: input.surfaceExternalId,
          worldXyz: input.worldXyz,
        })
        if (result.kind === 'wrong-surface' || result.kind === 'rejected') {
          // Tool BLEIBT scharf → User tippt einfach die richtige Fläche an.
          toast.info(result.message)
          return
        }
        if (result.kind === 'unsupported') {
          toast.info(result.message)
          setActiveTool(null)
          setPendingAsset(null)
          return
        }
        commitSceneEdit(result.scene)
        // Tool entschärfen — nächste Platzierung erfordert neue Picker-Wahl.
        setActiveTool(null)
        setPendingAsset(null)
        setSelectedSurface(null)
        // Auto-Fokus → Outline als Platzierungs-Bestätigung. Host aus dem
        // AUTORITATIVEN result.host (Orchestrator normalisiert free→floor), nicht
        // aus dem Asset re-abgeleitet. Floor/Ceiling werden fokussiert (Drag/Dreh/
        // Skalieren bzw. Decken-Drag). Wand-Katalog-Assets (Spiegel/Regal/…) NICHT
        // auto-fokussieren — das generische Wand-EditSheet ist auf Tür/Fenster/
        // Heizung/Elektro zugeschnitten, ein beliebiges Wand-Möbel würde fehlrouten.
        if (result.host === 'ceiling') {
          setFocus(result.objectId, 'ceiling')
        } else if (result.host === 'floor') {
          setFocus(result.objectId, 'floor')
        }
        // A1: bei substanzieller Überlappung den Hinweis statt der reinen
        // Platzierungs-Bestätigung zeigen (kein Fehler — Platzierung steht).
        toast.info(result.overlapNotice ?? `${pendingAsset.displayName} platziert`)
        return
      }
      // Tool-First Pfad: Pin-Tool ist vorgewählt → direkter Pin-Drop,
      // Detail-Sheet bestätigt nur noch Notiz + Typ. Match V1.6 verhalten.
      if (isCustomerPinType(activeTool)) {
        setPendingPlacement({
          surfaceExternalId: input.surfaceExternalId,
          uv: input.uv,
          worldXyz: input.worldXyz,
          pinType: activeTool,
        })
        setSelectedSurface(null)
        return
      }
      // Object-First Pfad (kein Tool, kind bekannt). #5a One-Step: der ERSTE
      // Tap auf eine Surface öffnet direkt das Context-Sheet (Material/Aktionen)
      // statt nur zu highlighten. Tap-vs-Drag ist im SurfaceTapLayer bereits
      // getrennt (8px / 350ms) → ein bewusster Tap meint immer „handeln", der
      // zweite Tap-Umweg kostete nur Zeit. selectedSurface bleibt fürs Highlight
      // gesetzt und wird beim Schließen des Sheets / Tap ins Leere gecleart.
      // Legacy-GLTF-Pfad (input.kind === undefined) bleibt no-op — der braucht
      // ein Tool um zu funktionieren.
      if (!input.kind) return
      setSelectedSurface(`${input.kind}-${input.surfaceExternalId}`)
      setContextTap({
        surfaceExternalId: input.surfaceExternalId,
        uv: input.uv,
        worldXyz: input.worldXyz,
        kind: input.kind,
      })
    },
    [
      activeTool,
      activeSceneCanEdit,
      storeCameraMode,
      setSelectedSurface,
      commitSceneEdit,
      toast,
      blobState,
      activeScanId,
      spatialScene,
      pendingAsset,
      selectedElectricalKind,
      selectedObjectId,
      setFocus,
      clearFocus,
    ],
  )

  // Tool-Auswahl: 'furniture' öffnet den Asset-Picker statt direkt ein
  // Tap-Tool scharf zu schalten (das passiert erst nach der Picker-Wahl).
  // Alle anderen Tools sind wie gehabt direkt-scharf.
  const handleToolSelect = useCallback(
    (tool: CustomerSpatialTool) => {
      // Tool wählen beendet einen aktiven Edit-Fokus (mutually exclusive).
      clearFocus()
      if (tool === 'furniture') {
        setPickerOpen(true)
        return
      }
      // Elektro öffnet erst den Sub-Picker (Steckdose/Schalter), dann scharf.
      if (tool === 'electrical') {
        setElectricalPickerOpen(true)
        return
      }
      setActiveTool(tool)
      setPendingAsset(null)
    },
    [clearFocus],
  )

  const handleElectricalKindSelected = useCallback(
    (kind: ElectricalKind) => {
      setSelectedElectricalKind(kind)
      setElectricalPickerOpen(false)
      setActiveTool('electrical')
      setPendingAsset(null)
      toast.info(
        kind === 'electrical_switch'
          ? 'Tippe auf eine Wand, um den Schalter zu setzen'
          : 'Tippe auf eine Wand, um die Steckdose zu setzen',
      )
    },
    [toast],
  )

  // Picker → "Weiter": Asset gemerkt, Picker zu, Platzier-Tool scharf, host-aware
  // Hinweis (richtige Fläche). Counter/Ecke noch nicht unterstützt → nicht scharf.
  const handleAssetSelected = useCallback(
    (asset: CatalogAsset) => {
      const host = asset.snapRule.target_host
      if (host === 'counter' || host === 'corner') {
        setPickerOpen(false)
        toast.info(`${asset.displayName} braucht eine Ablage/Ecke — kommt mit dem nächsten Update.`)
        return
      }
      setPendingAsset(asset)
      setPickerOpen(false)
      setActiveTool('furniture')
      const hint =
        host === 'wall'
          ? `Tippe auf eine Wand, um ${asset.displayName} zu platzieren`
          : host === 'ceiling'
            ? `Tippe auf den Boden unter die gewünschte Deckenposition für ${asset.displayName}`
            : `Tippe auf den Boden, um ${asset.displayName} zu platzieren`
      toast.info(hint)
    },
    [toast],
  )

  // ── Phase 5/6 Möbel-Edit-Modus: selektiertes Möbel + Aktions-Handler ──────
  // Reaktiv aus der Live-Store-Scene — rekomputiert bei jeder Mutation, sodass
  // Action-Bar/Slider das gerade platzierte/editierte Möbel sofort sehen.
  const editingFurniture = useMemo(
    () =>
      selectedObjectId && liveScene
        ? (liveScene.floor.floor_mounted.find((o) => o.id === selectedObjectId) ?? null)
        : null,
    [selectedObjectId, liveScene],
  )

  // V1.6.1 Ceiling Re-Edit: das fokussierte Decken-Objekt (Leuchte/Pendel).
  // Treibt die (auf Löschen/Fertig reduzierte) Aktionsleiste; Verschieben läuft
  // über den CustomerCeilingObjectEditLayer-Drag.
  const editingCeilingObject = useMemo(
    () =>
      focusedHost === 'ceiling' && focusedObjectId && liveScene
        ? (liveScene.ceiling.ceiling_mounted.find((o) => o.id === focusedObjectId) ?? null)
        : null,
    [focusedHost, focusedObjectId, liveScene],
  )

  const handleFurnitureRotate = useCallback(() => {
    if (!selectedObjectId) return
    const scene = useCanonicalSceneStore.getState().scene
    if (!scene) return
    const next = rotateFurniture({ scene, objectId: selectedObjectId })
    if (!next) return
    commitSceneEdit(next)
  }, [selectedObjectId, commitSceneEdit])

  const handleFurnitureScale = useCallback(
    (delta: number) => {
      if (!selectedObjectId) return
      const scene = useCanonicalSceneStore.getState().scene
      if (!scene) return
      const next = scaleFurniture({ scene, objectId: selectedObjectId, delta })
      if (!next) return
      commitSceneEdit(next)
    },
    [selectedObjectId, commitSceneEdit],
  )

  const handleFurnitureDuplicate = useCallback(() => {
    if (!selectedObjectId) return
    const scene = useCanonicalSceneStore.getState().scene
    if (!scene) return
    const newId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `obj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const result = duplicateFurniture({
      scene,
      objectId: selectedObjectId,
      newId,
      generatedAt: new Date().toISOString(),
    })
    if (result.kind === 'rejected') {
      toast.info(result.message)
      return
    }
    if (result.kind !== 'duplicated') return
    commitSceneEdit(result.scene)
    setFocus(result.objectId, 'floor')
    if (result.overlapNotice) toast.info(result.overlapNotice)
  }, [selectedObjectId, commitSceneEdit, setFocus, toast])

  const handleFurnitureDelete = useCallback(() => {
    if (!selectedObjectId) return
    const scene = useCanonicalSceneStore.getState().scene
    if (!scene) return
    const next = deleteFurniture({ scene, objectId: selectedObjectId })
    commitSceneEdit(next)
    clearFocus()
    toast.info('Möbel gelöscht')
  }, [selectedObjectId, commitSceneEdit, clearFocus, toast])

  const handleFurnitureDone = useCallback(() => {
    clearFocus()
    setObjectInteractionLocked(false)
  }, [clearFocus, setObjectInteractionLocked])

  // V1.6.1 Ceiling: Löschen eines fokussierten Decken-Objekts (eigener Pfad —
  // deleteFurniture greift nur floor_mounted).
  const handleCeilingDelete = useCallback(() => {
    if (focusedHost !== 'ceiling' || !focusedObjectId) return
    const scene = useCanonicalSceneStore.getState().scene
    if (!scene) return
    const next = deleteCeilingObject({ scene, objectId: focusedObjectId })
    commitSceneEdit(next)
    clearFocus()
    toast.info('Objekt gelöscht')
  }, [focusedHost, focusedObjectId, commitSceneEdit, clearFocus, toast])

  // Phase 5 Gesten-Layer: Drag verlässt den Raum → Möbel bleibt am letzten
  // gültigen Punkt (Orchestrator hält die Pose), der Layer signalisiert einmal
  // pro Drag und wir toasten. Wording-Lock: „Außerhalb des Raums".
  const handleFurnitureOutOfBounds = useCallback(() => {
    toast.info('Außerhalb des Raums')
  }, [toast])

  // R12.3: Tap ins Leere (Canvas-onPointerMissed) → Selection clearen +
  // Möbel-Edit-Modus verlassen.
  const handleBackgroundTap = useCallback(() => {
    setSelectedSurface(null)
    clearFocus()
    setObjectInteractionLocked(false)
  }, [setSelectedSurface, clearFocus, setObjectInteractionLocked])

  // Stale-Selection-Guard: wenn der User den aktiven Scan wechselt oder
  // den Screen verlässt, die Selektion zurücksetzen — sonst hängt sie als
  // Glow auf einer Wand im neu geladenen Raum (die Wand-IDs sind nicht
  // scanübergreifend stabil, aber falls doch, ist die Selection auch
  // irrelevant für den anderen Scan).
  useEffect(() => {
    setSelectedSurface(null)
    clearFocus()
    setObjectInteractionLocked(false)
    // L4.a: Undo/Redo-History ist scan-lokal — beim Scan-Wechsel/Unmount leeren,
    // sonst spielt ein „Rückgängig" eine fremde (vorige) Scene in den aktiven
    // Scan zurück.
    historyReset()
    return () => {
      setSelectedSurface(null)
      clearFocus()
      setObjectInteractionLocked(false)
      historyReset()
    }
  }, [activeScanId, setSelectedSurface, clearFocus, setObjectInteractionLocked, historyReset])

  // Split-Brain-Guard: Möbel-Edit (Selektion + Gesten-Layer + RotationDial +
  // FurnitureEditActionBar) ist dollhouse-only (`furnitureEditEnabled`). Wechselt
  // der User mid-edit auf 2D/Walk, blieb die Action-Bar sichtbar (rendert nur auf
  // `selectedObjectId`, NICHT auf cameraMode), während die In-Canvas-Gesten
  // unmounten → Bar steuert ein nicht greifbares Objekt + der Kamera-Lock kann
  // stranden. Beim Verlassen von Dollhouse Selektion + Lock hart räumen.
  useEffect(() => {
    // Möbel-Edit läuft jetzt in dollhouse UND walk (Einrichten). Beim Wechsel in
    // einen Nicht-Edit-Modus (2D/AR) Selektion räumen; bei dollhouse↔walk bleibt
    // die Selektion (in 3D wählen, in Begehen hinlaufen). Lock immer lösen, damit
    // die Kamera nie strandet.
    if (storeCameraMode === 'floorplan' || storeCameraMode === 'ar_compare') {
      // Nur Gesten-basierte Hosts (floor/ceiling) räumen — deren Edit-Layer
      // unmounten in 2D/AR, die Aktionsleiste würde sonst ein nicht-greifbares
      // Objekt steuern. Wand-Fokus (Slider-Sheet) ist kamera-unabhängig → bleibt.
      if (focusedHost === 'floor' || focusedHost === 'ceiling') {
        clearFocus()
      }
    }
    setObjectInteractionLocked(false)
  }, [storeCameraMode, focusedHost, clearFocus, setObjectInteractionLocked])

  // #5b Move-Discoverability: Verschieben läuft jetzt per Finger-DRAG (Tap-to-
  // Move entfernt — er teleportierte das Möbel bei jedem Fehlgriff daneben).
  // Einmaliger Hinweis bei der ersten Selektion macht das transparent; ein
  // Boden-Tap wählt jetzt ab. Die SelectionOutline (Block 4) zeigt zusätzlich,
  // welches Objekt selektiert ist.
  const moveHintShownRef = useRef(false)
  useEffect(() => {
    if (selectedObjectId && !moveHintShownRef.current) {
      moveHintShownRef.current = true
      toast.info('Ziehe das Möbel zum Verschieben · tippe auf den Boden zum Abwählen')
    }
  }, [selectedObjectId, toast])

  // Decken-Fokus: Verschieben läuft per Finger-Drag (kein Tap-to-Move wie am
  // Boden). Einmaliger Hinweis macht das transparent.
  const ceilingHintShownRef = useRef(false)
  useEffect(() => {
    if (focusedHost === 'ceiling' && focusedObjectId && !ceilingHintShownRef.current) {
      ceilingHintShownRef.current = true
      toast.info('Ziehe die Leuchte, um sie an der Decke zu verschieben')
    }
  }, [focusedHost, focusedObjectId, toast])

  // R11-B: Context-Sheet "Pin setzen"-Aktion (egal welcher Typ) — übernimmt
  // den zwischen-gespeicherten tap und springt direkt in den Detail-Sheet-
  // Flow. Setzt zusätzlich activeTool, damit der `viewerMode='edit'`-Switch
  // konsistent bleibt falls der User direkt weitere Pins setzen will.
  const handleContextPickPinType = useCallback(
    (pinType: CustomerPinType) => {
      if (!contextTap) return
      setActiveTool(pinType)
      setPendingPlacement({
        surfaceExternalId: contextTap.surfaceExternalId,
        uv: contextTap.uv,
        worldXyz: contextTap.worldXyz,
        pinType,
      })
      setContextTap(null)
    },
    [contextTap],
  )

  const handleContextClose = useCallback(() => {
    setContextTap(null)
  }, [])

  // R12.5 Wall-Cardinal-Labels: einmal pro Scene berechnen, danach im Context-
  // Sheet + Wall-Edit-Sheet zeigen statt UUID. Memoized per roomScene-Identität.
  const wallLabels = useMemo(
    () => (liveScene ? buildWallLabels(liveScene.walls) : null),
    [liveScene],
  )
  const wallLabelFor = useCallback(
    (wallId: string | undefined | null): string | undefined => {
      if (!wallId || !wallLabels) return undefined
      return wallLabels.get(wallId)?.label
    },
    [wallLabels],
  )

  // R11-C Wall-Edit (UI komplett, Save-Persistence Phase 1e).
  const [editingWallId, setEditingWallId] = useState<string | null>(null)
  const editingWall = useMemo(() => {
    if (!editingWallId || !liveScene) return null
    return liveScene.walls.find(w => w.id === editingWallId) ?? null
  }, [editingWallId, liveScene])
  const editingWallLength = useMemo(() => {
    if (!editingWall) return undefined
    const dx = editingWall.end_point.x - editingWall.start_point.x
    const dz = editingWall.end_point.z - editingWall.start_point.z
    return Math.hypot(dx, dz)
  }, [editingWall])
  const handleContextEditWall = useCallback(() => {
    if (!contextTap || contextTap.kind !== 'wall') return
    setEditingWallId(contextTap.surfaceExternalId)
    setContextTap(null)
  }, [contextTap])

  // Wandmaterial-Picker: id der Wand, deren Finish gerade gewählt wird. Öffnet
  // aus dem Context-Sheet ("Wandmaterial wählen") — nur mit Edit-Rechten.
  const [editingWallFinishId, setEditingWallFinishId] = useState<string | null>(null)
  const handleContextPickFinish = useCallback(() => {
    if (!contextTap || contextTap.kind !== 'wall') return
    setEditingWallFinishId(contextTap.surfaceExternalId)
    setContextTap(null)
  }, [contextTap])
  const editingWallFinishMaterialId = useMemo<string | null>(() => {
    if (!editingWallFinishId || !liveScene) return null
    const wall = liveScene.walls.find((w) => w.id === editingWallFinishId)
    return wall?.material_id ?? null
  }, [editingWallFinishId, liveScene])
  // S2 · slug → display-name lookup for the surface-local undo toast.
  const wallMaterialNames = useMemo(
    () => new Map(getCatalogMaterialsBySurface('wall').map((m) => [m.slug, m.displayName])),
    [],
  )
  // S2 · surface-local Undo-Toast state. The finish sheet unmounts on apply, so
  // the toast lives here in the parent. `nonce` remounts MaterialUndoToast to
  // reset its 8 s timer per apply; `prevMaterialId` enables a TRUE revert (not
  // just a reset to room-default). This is in addition to the global Undo/Redo
  // (which is only reachable in Einrichten-Mode), giving an immediate inline
  // "Rückgängig" right where the change happened.
  const [wallFinishUndo, setWallFinishUndo] = useState<{
    wallId: string
    prevMaterialId: string | null
    materialName: string
    nonce: number
  } | null>(null)
  const wallFinishUndoNonce = useRef(0)
  // Core wall-finish mutation — shared by the user apply and the toast undo.
  // Goes through commitSceneEdit so persistence + global-undo history stay
  // single-sourced (no second persistence path).
  const setWallFinish = useCallback(
    (wallId: string, materialId: string | null) => {
      const scene = useCanonicalSceneStore.getState().scene
      if (!scene) return
      commitSceneEdit(setWallMaterial(scene, { wallId, materialId }))
    },
    [commitSceneEdit],
  )
  const applyWallFinish = useCallback(
    (materialId: string | null) => {
      if (!editingWallFinishId) return
      const wallId = editingWallFinishId
      const scene = useCanonicalSceneStore.getState().scene
      if (!scene) return
      const prevMaterialId = scene.walls.find((w) => w.id === wallId)?.material_id ?? null
      setWallFinish(wallId, materialId)
      setEditingWallFinishId(null)
      // No-op apply (re-selecting the current material): setWallMaterial returns
      // the same scene ref and commitSceneEdit skips history — so skip the toast
      // too, otherwise its "Rückgängig" would be a no-op.
      if (prevMaterialId === materialId) return
      setWallFinishUndo({
        wallId,
        prevMaterialId,
        materialName: materialId ? (wallMaterialNames.get(materialId) ?? 'Material') : 'Standard',
        nonce: wallFinishUndoNonce.current++,
      })
    },
    [editingWallFinishId, setWallFinish, wallMaterialNames],
  )
  const handleWallFinishUndo = useCallback(() => {
    if (!wallFinishUndo) return
    setWallFinish(wallFinishUndo.wallId, wallFinishUndo.prevMaterialId)
    setWallFinishUndo(null)
  }, [wallFinishUndo, setWallFinish])
  const handleWallFinishSelect = useCallback(
    (slug: string) => applyWallFinish(slug),
    [applyWallFinish],
  )
  const handleWallFinishReset = useCallback(() => applyWallFinish(null), [applyWallFinish])

  const handleWallEditSave = useCallback(
    (input: CustomerWallEditSheetSaveInput) => {
      // Footprint-first un-stub (Lane-2.5): apply height + thickness through the
      // shared wallPointOrchestrator (validate → floor/ceiling re-derive) and
      // commit via the same Blob-persist + undo path as every other scene edit.
      const scene = useCanonicalSceneStore.getState().scene
      if (!editingWallId || !scene) {
        setEditingWallId(null)
        return
      }
      if (!activeSceneCanEdit) {
        toast.info('Dieses Aufmaß gehört dem Handwerker — Bearbeitung nur lesend.')
        setEditingWallId(null)
        return
      }
      const result = setWallDims({
        scene,
        wallId: editingWallId,
        heightM: input.heightM,
        thicknessM: input.thicknessM,
      })
      if (result.kind === 'rejected') {
        toast.info(result.message)
        setEditingWallId(null)
        return
      }
      commitSceneEdit(result.scene)
      setEditingWallId(null)
    },
    [editingWallId, activeSceneCanEdit, commitSceneEdit, toast],
  )

  const handleWallEditCancel = useCallback(() => {
    setEditingWallId(null)
  }, [])

  // L0 Object-Edit-Sheet handlers — Live-Slider-Mutationen + Delete + Close.
  // editingObject.openingId is the id of the thing being edited regardless of
  // toolKind (legacy R13 field name — covers WallOpening and wall-mounted
  // SpatialObject alike under V1.6.1 L0).
  const editingObjectIsWallMounted = useMemo<boolean>(
    () => editingObject?.toolKind === 'heating' || editingObject?.toolKind === 'electrical',
    [editingObject?.toolKind],
  )
  const editingOpening = useMemo<WallOpening | null>(() => {
    if (!editingObject || !liveScene || editingObjectIsWallMounted) return null
    const wall = liveScene.walls.find((w) => w.id === editingObject.wallId)
    return wall?.openings.find((o) => o.id === editingObject.openingId) ?? null
  }, [editingObject, liveScene, editingObjectIsWallMounted])
  const editingWallMounted = useMemo(() => {
    if (!editingObject || !liveScene || !editingObjectIsWallMounted) return null
    const wall = liveScene.walls.find((w) => w.id === editingObject.wallId)
    return wall?.wall_mounted.find((o) => o.id === editingObject.openingId) ?? null
  }, [editingObject, liveScene, editingObjectIsWallMounted])
  // toolKind='electrical' deckt Steckdose UND Schalter ab — das echte Header-
  // Label kommt aus der object.category, damit ein Schalter nicht fälschlich
  // „Steckdose" anzeigt (gilt für frische Platzierung UND Re-Edit gleich).
  const editingObjectHeaderLabel = useMemo<string | undefined>(() => {
    const cat = editingWallMounted?.category
    if (cat === 'light_switch') return 'Schalter'
    if (cat === 'electrical_outlet') return 'Steckdose'
    return undefined
  }, [editingWallMounted?.category])
  const editingObjectWallLengthM = useMemo<number | undefined>(() => {
    if (!editingObject || !liveScene) return undefined
    const wall = liveScene.walls.find((w) => w.id === editingObject.wallId)
    if (!wall) return undefined
    return wallLengthMeters(wall)
  }, [editingObject, liveScene])
  const editingObjectWallHeightM = useMemo<number | undefined>(() => {
    if (!editingObject || !liveScene) return undefined
    const wall = liveScene.walls.find((w) => w.id === editingObject.wallId)
    return wall?.height_m
  }, [editingObject, liveScene])
  const editingObjectValue = useMemo<CustomerObjectEditSheetValue | null>(() => {
    if (editingOpening) {
      const centerM = editingOpening.offset_along_wall_m + editingOpening.width_m / 2
      return {
        positionAlongWallM: centerM,
        widthM: editingOpening.width_m,
        heightM: editingOpening.height_m,
        offsetFromFloorM: editingOpening.offset_from_floor_m,
      }
    }
    if (editingWallMounted) {
      const offset = editingWallMounted.offset_along_wall_m ?? 0
      const centerM = offset + editingWallMounted.dimensions.width_m / 2
      return {
        positionAlongWallM: centerM,
        widthM: editingWallMounted.dimensions.width_m,
        heightM: editingWallMounted.dimensions.height_m,
        offsetFromFloorM: editingWallMounted.height_from_floor_m ?? 0,
      }
    }
    return null
  }, [editingOpening, editingWallMounted])

  // Beim Öffnen/Wechseln des Edit-Sheets: Konflikt zurücksetzen + DIN-Hinweise
  // für die aktuelle Pose initial berechnen (Banner zeigt sofort den Ist-Stand).
  // Keyed nur auf das editierte Objekt — der onChange-Handler hält die Hinweise
  // während der Edits frisch, also kein Re-Run pro Slider-Tick nötig.
  useEffect(() => {
    setEditConflict(null)
    const scene = useCanonicalSceneStore.getState().scene
    if (!editingObject || !scene) {
      setEditDinWarnings([])
      return
    }
    const wall = scene.walls.find((w) => w.id === editingObject.wallId)
    if (!wall) {
      setEditDinWarnings([])
      return
    }
    const wallLengthM = wallLengthMeters(wall)
    if (editingObjectIsWallMounted) {
      const obj = wall.wall_mounted.find((o) => o.id === editingObject.openingId)
      setEditDinWarnings(
        obj
          ? evaluateWallObjectDin({
              wall,
              wallLengthM,
              candidate: { kind: 'wall_mounted', object: obj },
              excludeId: obj.id,
              roomCategory: scene.category,
            })
          : [],
      )
    } else {
      const op = wall.openings.find((o) => o.id === editingObject.openingId)
      setEditDinWarnings(
        op
          ? evaluateWallObjectDin({
              wall,
              wallLengthM,
              candidate: { kind: 'opening', opening: op },
              excludeId: op.id,
              roomCategory: scene.category,
            })
          : [],
      )
    }
    // Primitive deps: `editingObject` ist jetzt ein aus dem Live-Scene abgeleitetes
    // Memo (neue Identität pro Scene-Mutation). Auf die id-Primitives keyen, damit
    // der Effekt nur bei Wechsel des bearbeiteten Objekts läuft (Erst-Compute beim
    // Öffnen) — sonst würde er pro Slider-Tick `setEditConflict(null)` feuern und
    // ein gerade gesetztes Konflikt-Banner sofort wieder löschen. `editingObject`
    // selbst NICHT in die Deps: wallId/openingId sind seine Identität (openingId ===
    // focusedObjectId), also kein Stale-Closure-Risiko.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingObject?.wallId, editingObject?.openingId, editingObjectIsWallMounted])

  const handleObjectEditChange = useCallback(
    (next: CustomerObjectEditSheetValue) => {
      if (!editingObject) return
      const scene = useCanonicalSceneStore.getState().scene
      if (!scene) return
      const wall = scene.walls.find((w) => w.id === editingObject.wallId)
      if (!wall) return
      const wallLengthM = wallLengthMeters(wall)
      const offsetAlongWallM = Math.max(0, next.positionAlongWallM - next.widthM / 2)

      if (editingObjectIsWallMounted) {
        const obj = wall.wall_mounted.find((o) => o.id === editingObject.openingId)
        if (!obj) return
        // DIN-Vertikal-Snap (Schalter→1,05 / Steckdose→0,30|1,10) magnetisiert
        // nahe der Referenzhöhe — identisch zur Drag-Geste.
        const fromFloor = snapWallObjectVerticalToDin(obj.category, next.offsetFromFloorM)
        // L0-#3: harte Overlap-Validierung beim Slider-Drag (vorher nur Clamp).
        const validation = validateObjectPosition({
          wall,
          wallLengthM,
          candidate: {
            left: offsetAlongWallM,
            right: offsetAlongWallM + next.widthM,
            bottom: fromFloor,
            top: fromFloor + next.heightM,
          },
          excludeId: obj.id,
        })
        if (!validation.ok) {
          setEditConflict(validation.message)
          return
        }
        const updated = updateWallMountedObjectInWall(scene, {
          wallId: editingObject.wallId,
          objectId: editingObject.openingId,
          patch: {
            offset_along_wall_m: offsetAlongWallM,
            height_from_floor_m: fromFloor,
            dimensions: {
              width_m: next.widthM,
              depth_m: obj.dimensions.depth_m,
              height_m: next.heightM,
            },
          },
        })
        commitSceneEdit(updated)
        setEditConflict(null)
        const nextWall = updated.walls.find((w) => w.id === editingObject.wallId)
        const nextObj = nextWall?.wall_mounted.find((o) => o.id === editingObject.openingId)
        setEditDinWarnings(
          nextWall && nextObj
            ? evaluateWallObjectDin({
                wall: nextWall,
                wallLengthM,
                candidate: { kind: 'wall_mounted', object: nextObj },
                excludeId: nextObj.id,
                roomCategory: scene.category,
              })
            : [],
        )
        return
      }

      const validation = validateObjectPosition({
        wall,
        wallLengthM,
        candidate: {
          left: offsetAlongWallM,
          right: offsetAlongWallM + next.widthM,
          bottom: next.offsetFromFloorM,
          top: next.offsetFromFloorM + next.heightM,
        },
        excludeId: editingObject.openingId,
      })
      if (!validation.ok) {
        setEditConflict(validation.message)
        return
      }
      const updated = updateOpeningInWall(scene, {
        wallId: editingObject.wallId,
        openingId: editingObject.openingId,
        patch: {
          offset_along_wall_m: offsetAlongWallM,
          offset_from_floor_m: next.offsetFromFloorM,
          width_m: next.widthM,
          height_m: next.heightM,
        },
      })
      commitSceneEdit(updated)
      setEditConflict(null)
      const nextWall = updated.walls.find((w) => w.id === editingObject.wallId)
      const nextOpening = nextWall?.openings.find((o) => o.id === editingObject.openingId)
      setEditDinWarnings(
        nextWall && nextOpening
          ? evaluateWallObjectDin({
              wall: nextWall,
              wallLengthM,
              candidate: { kind: 'opening', opening: nextOpening },
              excludeId: nextOpening.id,
              roomCategory: scene.category,
            })
          : [],
      )
    },
    [editingObject, editingObjectIsWallMounted, commitSceneEdit],
  )

  const handleObjectEditDelete = useCallback(() => {
    if (!editingObject) return
    const scene = useCanonicalSceneStore.getState().scene
    if (!scene) return
    const updated = editingObjectIsWallMounted
      ? removeWallMountedObjectFromWall(scene, {
          wallId: editingObject.wallId,
          objectId: editingObject.openingId,
        })
      : removeOpeningFromWall(scene, {
          wallId: editingObject.wallId,
          openingId: editingObject.openingId,
        })
    commitSceneEdit(updated)
    clearFocus()
  }, [editingObject, editingObjectIsWallMounted, commitSceneEdit, clearFocus])

  const handleObjectEditClose = useCallback(() => {
    // Flush pending debounce-Persist sofort, damit ein schließendes Sheet keine
    // dangling save-ops hinterlässt. Wenn die Timer-Ref leer ist, ist schon
    // alles gespeichert.
    if (objectPersistTimer.current) {
      window.clearTimeout(objectPersistTimer.current)
      objectPersistTimer.current = null
      const scene = useCanonicalSceneStore.getState().scene
      if (scene && spatialScene?.id && userId) {
        void persistCustomerSceneMutation({
          sceneId: spatialScene.id,
          userId,
          callerCanEdit: activeSceneCanEdit,
          roomScene: scene,
        })
      }
    }
    clearFocus()
    setObjectSaveHint(undefined)
  }, [activeSceneCanEdit, spatialScene?.id, userId, clearFocus])

  // Cleanup pending persist timer on unmount + activeScanId change. #3: vor dem
  // Clear noch flushen — sonst geht die letzte <450ms-Edit vor Tab-Wechsel/
  // Background verloren. Aus der Live-Store-Scene flushen (die Cleanup-Closure
  // hätte sonst nur eine stale Scene-Referenz).
  useEffect(() => {
    return () => {
      if (objectPersistTimer.current) {
        window.clearTimeout(objectPersistTimer.current)
        objectPersistTimer.current = null
        const scene = useCanonicalSceneStore.getState().scene
        if (scene && spatialScene?.id && userId) {
          void persistCustomerSceneMutation({
            sceneId: spatialScene.id,
            userId,
            callerCanEdit: activeSceneCanEdit,
            roomScene: scene,
          })
        }
      }
    }
  }, [activeScanId, activeSceneCanEdit, spatialScene?.id, userId])

  // Cluster A (1b): KEIN mid-session refetch mehr. Der frühere Effect re-fetchte
  // scene-record + blob beim Edit-Session-Ende → `roomScene` bekam eine neue
  // Referenz → `useHydrateStore` re-seedete den Store von der Disk und wischte
  // alle in-Session platzierten Möbel weg (Datenverlust, Cross-Feature-Clobber).
  // Die Live-Store-Scene IST die Wahrheit; persist schreibt sie auf Disk, der
  // nächste Hub-Mount lädt den frischen Blob über den Hook ohnehin neu.

  const handlePinSheetCancel = useCallback(() => {
    setPendingPlacement(null)
  }, [])

  const handlePinSheetSave = useCallback(
    async ({
      customerPinType,
      note,
      photo,
    }: {
      customerPinType: CustomerPinType
      note: string | null
      photo: File | null
    }) => {
      if (!pendingPlacement || !activeScanId || !userId) return
      if (pinSaving) return
      setPinSaving(true)
      setPinSaveError(null)
      mark('spatial.pin.detail-save')
      try {
        const annotation = await createCustomerPin({
          scanId: activeScanId,
          userId,
          customerPinType,
          placement: {
            surfaceExternalId: pendingPlacement.surfaceExternalId,
            uv: pendingPlacement.uv,
            worldXyz: pendingPlacement.worldXyz,
          },
          note,
        })
        // R11-E: Foto-Anhang läuft SEQUENTIELL nach Pin-Insert — die Foto-
        // ID landet im annotation.photoAssetId, was den Pin im Reviewer mit
        // einer Thumbnail-Pille markiert. Fehler beim Upload werden geloggt
        // aber blockieren den Pin nicht (der Pin ist bereits persistiert,
        // Foto kann der User später nochmal versuchen).
        if (photo && annotation?.id) {
          try {
            await attachPinPhoto({
              scanId: activeScanId,
              annotationId: annotation.id,
              userId,
              file: photo,
            })
          } catch (photoErr) {
            console.error('[Pin] Foto-Upload fehlgeschlagen', photoErr)
            toast.error(
              'Pin gespeichert, aber Foto-Upload fehlgeschlagen. Du kannst es später hinzufügen.',
            )
          }
        }
        setPendingPlacement(null)
        setActiveTool(null)
        mark('spatial.pin.persisted')
        const duration = measure(
          'spatial.pin.save-roundtrip',
          'spatial.pin.detail-save',
          'spatial.pin.persisted',
        )
        if (duration !== undefined) {
          reportMeasureAsSpan('spatial.pin.save-roundtrip', 'ui.action', duration, {
            pinType: customerPinType,
          })
        }
      } catch (err) {
        setPinSaveError(err instanceof Error ? err.message : String(err))
      } finally {
        setPinSaving(false)
      }
    },
    [pendingPlacement, activeScanId, userId, pinSaving, toast],
  )

  const isPinTool = isCustomerPinType(activeTool)
  const viewerMode: 'view' | 'edit' = isPinTool ? 'edit' : 'view'
  // R11-B: Parametric Surface-Tap-Layer ist IMMER aktiv im Hub — der Customer
  // soll auch ohne vorher gewähltes Tool eine Wand antippen können und das
  // Context-Sheet bekommen (Object-First). Tool-First bleibt parallel über
  // die Tool-Bar erreichbar; beide flowen in `handlePinPlaced` zusammen, der
  // dann routet (Tool gesetzt → direkt Pin, sonst → Context-Sheet).
  const parametricEditMode = true

  const startLidarFlow = useCallback(() => {
    if (lidarBusy) return
    void startCustomerLidarScan({
      onConsentRequired: () => dispatchSheet({ type: 'open', sheet: 'dsgvo' }),
      onSuccess: scanId => {
        recoveryAttemptsRef.current = 0
        void reload()
        setTab('vermessen')
        navigate(`/customer/spatial/scan/${scanId}`)
      },
      onRecoverableError: kind => {
        const next = Math.min(recoveryAttemptsRef.current + 1, MAX_RECOVERY_ATTEMPTS)
        recoveryAttemptsRef.current = next
        setRecoveryVariant(next >= MAX_RECOVERY_ATTEMPTS ? 'max-retries' : kind)
        dispatchSheet({ type: 'open', sheet: 'recovery' })
      },
    })
  }, [lidarBusy, navigate, reload, startCustomerLidarScan])

  const handleResumeCapture = useCallback(async () => {
    const result = await runResume()
    if (!result) return
    if (result.ok) {
      void reload()
      setTab('vermessen')
      navigate(`/customer/spatial/scan/${result.newScanId}`)
    } else {
      toast.error(
        result.message ?? 'Konnte den Scan nicht fortsetzen. Versuche einen neuen Scan.',
      )
    }
  }, [runResume, reload, navigate, toast])

  const handleDiscardCapture = useCallback(async () => {
    const result = await runDiscard()
    if (!result.ok) {
      toast.error('Konnte den Scan nicht verwerfen.')
    }
  }, [runDiscard, toast])

  // Auth-User-Resolution — unverändert.
  useEffect(() => {
    let alive = true
    void supabase.auth.getUser().then(({ data }) => {
      if (!alive) return
      const id = data.user?.id ?? null
      setUserId(id)
      setHwLastSeen(readHwLastSeen(id))
    })
    return () => {
      alive = false
    }
  }, [])

  // ?new=1 Deep-Link → öffnet das NewRoom-Sheet einmalig. URL-Strip
  // läuft via Promise-Microtask damit der setSearchParams-Race aus
  // V1.6.0 nicht wieder auftaucht.
  useEffect(() => {
    if (searchParams.get('new') !== '1') return
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      dispatchSheet({ type: 'open', sheet: 'new-room' })
      const next = new URLSearchParams(searchParams)
      next.delete('new')
      setSearchParams(next, { replace: true })
    })
    return () => {
      alive = false
    }
  }, [searchParams, setSearchParams])

  // Konsolidierter Tab → URL-Sync. Ein Effect statt drei mutually-
  // triggernde aus V1.6.0. `setSearchParams` ist stable, dependency-list
  // hält nur den Tab.
  useEffect(() => {
    const current = parseTab(searchParams.get('tab'))
    if (current === tab) return
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('tab', tab)
        return next
      }, { replace: true })
    })
    return () => {
      alive = false
    }
    // searchParams is intentionally omitted — we only read it for the
    // diff-check above; we never write through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, setSearchParams])

  const active = TABS.find(t => t.key === tab) ?? TABS[0]
  const filtered = useMemo(() => scans.filter(active.match), [scans, active])
  const activeScan = useMemo(
    () => scans.find(s => s.id === activeScanId) ?? null,
    [scans, activeScanId],
  )

  const hwCount = useMemo(
    () =>
      scans.filter(s => s.ownerType === 'craftsman' && s.sharedWithCustomer)
        .length,
    [scans],
  )
  const hwDelta = Math.max(0, hwCount - hwLastSeen)
  const hwHasNew = hwDelta > 0

  useEffect(() => {
    if (tab !== 'vom-hw' || !isHydrated || !hwHasNew) return
    let alive = true
    writeHwLastSeen(userId, hwCount)
    void Promise.resolve().then(() => {
      if (!alive) return
      setHwLastSeen(hwCount)
    })
    return () => {
      alive = false
    }
  }, [tab, isHydrated, hwHasNew, hwCount, userId])

  if (!isHydrated) {
    return (
      <AppShell active="profile" noSafeTop>
        <ScreenSkeleton variant="detail" />
      </AppShell>
    )
  }

  if (status === 'unauthenticated') {
    return (
      <AppShell active="profile">
        <section className="px-4 py-6">
          <div className="mx-auto w-full max-w-[420px] text-center text-sm text-ink-muted">
            Bitte melde dich an, um deine Aufmaße zu sehen.
            <div className="mt-3">
              <Link
                to={`/login?redirect=${encodeURIComponent(
                  location.pathname + location.search,
                )}`}
                className="rounded-card bg-brand px-4 py-2 text-sm font-semibold text-white"
              >
                Anmelden
              </Link>
            </div>
          </div>
        </section>
      </AppShell>
    )
  }

  const hasAnyScan = scans.length > 0

  const sceneSlot: ReactNode = parametricReady ? (
    // V1.6.1 Phase 3b · canonical Scene mit 3-Modi-Switcher (Dollhouse /
    // Floorplan / Walk). Provider-Pipeline 1:1 — Customer = HW feature
    // parity (Decision B.2-D7). Built-in Provider-Switcher + Section-
    // Controls werden ausgeblendet, weil der Customer-Hub den eigenen
    // Liquid-Glass-v3-Switcher in `topRight` mounted.
    <>
    <CanonicalSceneRoot
      scene={roomScene}
      variants={sceneVariants}
      overrides={sceneOverrides}
      cameraSwitcher={false}
      sectionControls={false}
      className="absolute inset-0"
      editMode={parametricEditMode}
      onPinPlaced={handlePinPlaced}
      onBackgroundTap={handleBackgroundTap}
      canEdit={activeSceneCanEdit}
      arrangeMode={arrangeMode}
      footprintEditEnabled={activeSceneCanEdit}
      onFootprintWallSelect={handleFootprintWallSelect}
      onFootprintObjectSelect={handleFootprintObjectSelect}
      selectedFootprintWallId={footprintWallId}
      footprintPreferWallSelection
      onFootprintInvalid={handleFootprintInvalid}
      onTransformCommit={schedulePersistScene}
      onFurnitureOutOfBounds={handleFurnitureOutOfBounds}
      onEditReject={(msg) => toast.info(msg)}
      onDinWarning={(warnings) => {
        const summary = summarizeDinWarnings(warnings)
        if (summary) toast.info(summary)
      }}
    />
      {/* Footprint-Maß-Bar: Wand im 2D-Grundriss antippen → Länge/Höhe/Dicke +
          „Ecke einfügen". Non-modal, nur eigene Szenen, floorplan-only. */}
      {activeSceneCanEdit && footprintWall && effectiveViewMode === 'floorplan' && (
        <DimensionMeasureBar
          key={footprintWallId}
          wall={footprintWall}
          onApply={applyFootprintDim}
          onSplitWall={handleSplitWall}
          onClose={clearFootprintWallSelection}
          // Über der Bodennav halten (gleiche Clearance wie die Tool-Bar im Shell).
          bottomGapCss="calc(var(--bottom-nav-h, 96px) + 16px)"
        />
      )}
    </>
  ) : activeGltfUrl ? (
    <SpatialViewer
      gltfUrl={activeGltfUrl}
      mode={viewerMode}
      chromelessMode
      fullBleed
      viewMode={customerToSpatialViewerMode(effectiveViewMode)}
      className="h-full w-full"
      onPinPlaced={handlePinPlaced}
      onReady={() => {
        mark('spatial.hub.gltf-ready')
        const duration = measure(
          'spatial.hub.load',
          'spatial.hub.mount-start',
          'spatial.hub.gltf-ready',
        )
        if (duration !== undefined) {
          reportMeasureAsSpan('spatial.hub.load', 'ui.load', duration)
        }
      }}
    />
  ) : null

  /* R8-A 2026-05-28: Tool-Bar war disabled wenn `!activeGltfUrl`. Customer-
     Scans sind aber PARAMETRIC-only (kein GLTF) → activeGltfUrl IMMER null
     → Tool-Bar IMMER disabled (grauer Look, kein Tap) — User: "Auswahl-Button
     funktioniert nicht". Jetzt: enable sobald irgendein Viewer-Pfad ready
     ist (parametric oder GLTF). Wenn weder, war sceneSlot eh null → Hub
     zeigt Empty-State, Tool-Bar hat nichts zu tun. */
  const viewerReady = parametricReady || Boolean(activeGltfUrl)
  // Im Möbel-Edit-Modus ersetzt die FurnitureEditActionBar die Tool-Bar.
  const toolBarSlot: ReactNode =
    arrangeMode && hasAnyScan && filtered.length > 0 && selectedObjectId == null ? (
      <CustomerSpatialToolBar
        activeTool={activeTool}
        onToolSelect={handleToolSelect}
        counts={toolCounts}
        disabled={!viewerReady}
      />
    ) : null

  // Empty-State: kein Scan in der aktuellen Tab-Welt. Empty-Hub-Hero wird
  // ALS Overlay über die (leere) 3D-Scene gelegt — kein eigener Body-Slot
  // mehr, weil der Hub jetzt 100% Viewer-Surface ist.
  const showEmptyHero = status === 'ready' && filtered.length === 0
  const emptyStateSlot: ReactNode = showEmptyHero ? (
    <EmptyHubHero
      tab={tab}
      lidarAvailable={lidarAvailable}
      onExamples={() => navigate('/customer/spatial/beispiel-raeume')}
      onScan={() => {
        if (lidarAvailable === true) {
          startLidarFlow()
        } else {
          dispatchSheet({ type: 'open', sheet: 'new-room' })
        }
      }}
      onPreset={() => dispatchSheet({ type: 'open', sheet: 'new-room' })}
      onCustom={() => dispatchSheet({ type: 'open', sheet: 'custom-canvas' })}
    />
  ) : null

  const showRoomPicker = sheetState.active === 'room-picker'

  return (
    /* R7-A 2026-05-28: active war "profile" — falsch, Hub ist kein Profile-
       Tab. Mit active=undefined returnt useSwipeNavigation auch dann früh
       wenn das immersive-Flag mal nicht greifen sollte (currentIndex===-1).
       Defense-in-Depth gegen den Tab-Switch-Leak. */
    <AppShell active={undefined} immersive>
      <CustomerSpatialHubShell
        sceneSlot={sceneSlot}
        emptyState={emptyStateSlot}
        toolBar={toolBarSlot}
        dimmed={sheetState.active != null && sheetState.active !== 'room-picker'}
        topLeft={
          <GlassPill
            kind="cluster"
            ariaLabel="Mein 3D-Bereich"
          >
            <button
              type="button"
              onClick={goBack}
              aria-label="Zurück"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white/14 text-white transition active:scale-95 hover:bg-white/22"
            >
              <ChevronLeft size={14} aria-hidden />
            </button>
            <div className="pr-2">
              <div className="text-[12.5px] font-bold leading-tight text-white">
                Mein 3D-Bereich
              </div>
            </div>
          </GlassPill>
        }
        tabs={
          <TabPills
            tab={tab}
            scans={scans}
            hwHasNew={hwHasNew}
            hwDelta={hwDelta}
            onSelect={setTab}
          />
        }
        topRight={
          hasAnyScan ? (
            <GlassRoundButton
              ariaLabel="Räume wechseln"
              active={showRoomPicker}
              onClick={() => {
                if (showRoomPicker) {
                  dispatchSheet({ type: 'close' })
                } else {
                  dispatchSheet({ type: 'replace', sheet: 'room-picker' })
                }
              }}
            >
              <MoreHorizontal size={18} aria-hidden />
            </GlassRoundButton>
          ) : null
        }
        floatingOverlay={
          hasAnyScan ? (
            <>
              {activeScan && (
                <RoomInfoPill
                  name={roomLabelForActiveScan(activeScan, scans)}
                  ownerType={activeScan.ownerType}
                  sharedWithCustomer={activeScan.sharedWithCustomer}
                  areaM2={roomMetrics.areaM2}
                  wallCount={roomMetrics.wallCount}
                />
              )}
              {/* V1.6.1 Gesten-Rework · globaler Ansehen↔Einrichten-Toggle.
                  Links gespiegelt zum ViewMode-Switcher rechts. Nur mit Edit-
                  Rechten + ready. Beim Verlassen Selektion + Lock räumen. */}
              {activeSceneCanEdit && parametricReady && (
                <div
                  className="pointer-events-auto absolute left-[14px]"
                  style={{ top: 'calc(max(env(safe-area-inset-top), 16px) + 162px)' }}
                >
                  <button
                    type="button"
                    aria-pressed={arrangeMode}
                    onClick={() => {
                      setArrangeMode((v) => {
                        const next = !v
                        if (!next) {
                          clearFocus()
                          setObjectInteractionLocked(false)
                        }
                        return next
                      })
                    }}
                    className={[
                      'flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-bold transition active:scale-95',
                      arrangeMode
                        ? 'bg-blue-600 text-white'
                        : 'bg-white/14 text-white hover:bg-white/22',
                    ].join(' ')}
                    style={{
                      backdropFilter: 'blur(20px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                      border: '1px solid rgba(255,255,255,0.16)',
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width={15}
                      height={15}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      {arrangeMode ? (
                        <path d="M20 6 9 17l-5-5" />
                      ) : (
                        <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      )}
                    </svg>
                    {arrangeMode ? 'Fertig' : 'Einrichten'}
                  </button>
                </div>
              )}
              {/* L4.a Undo/Redo — nur im Einrichten-Modus mit Edit-Rechten. Spiegelt
                  links unter dem Einrichten-Toggle. Buttons disabled wenn der
                  jeweilige Stack leer ist (canUndo/canRedo treiben das). */}
              {activeSceneCanEdit && parametricReady && arrangeMode && (
                <div
                  className="pointer-events-auto absolute left-[14px] flex gap-1.5"
                  style={{ top: 'calc(max(env(safe-area-inset-top), 16px) + 210px)' }}
                >
                  {([
                    { key: 'undo', label: 'Rückgängig', enabled: canUndo, onClick: handleUndo, d: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-1' },
                    { key: 'redo', label: 'Wiederholen', enabled: canRedo, onClick: handleRedo, d: 'm15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h1' },
                  ] as const).map((b) => (
                    <button
                      key={b.key}
                      type="button"
                      aria-label={b.label}
                      disabled={!b.enabled}
                      onClick={b.onClick}
                      className={[
                        'flex h-9 w-9 items-center justify-center rounded-full transition active:scale-95',
                        b.enabled ? 'bg-white/14 text-white hover:bg-white/22' : 'bg-white/[0.06] text-white/30',
                      ].join(' ')}
                      style={{
                        backdropFilter: 'blur(20px) saturate(180%)',
                        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                        border: '1px solid rgba(255,255,255,0.16)',
                      }}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width={16}
                        height={16}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d={b.d} />
                      </svg>
                    </button>
                  ))}
                </div>
              )}
              {/* Mockup 02 v8 `float-view-mode`: vertikaler Stack, top:220 right:14. */}
              <div
                className="pointer-events-auto absolute right-[14px]"
                style={{
                  top: 'calc(max(env(safe-area-inset-top), 16px) + 162px)',
                }}
              >
                <CustomerViewModeSwitcher
                  value={effectiveViewMode}
                  onChange={mode => {
                    // Local state für SpatialViewer-Fallback (legacy Scans
                    // ohne parametric.json). Store für CanonicalSceneRoot
                    // (parametric ready). Beide schreiben damit ein Wechsel
                    // zwischen Scans den state synchron hält.
                    setViewMode(mode)
                    setStoreCameraMode(mode)
                  }}
                  disabled={!hasAnyScan}
                  // V1.6.1 Phase 3b: Legacy Customer-LiDAR-Scans haben kein
                  // parametric.json (vor Lane-1-Deploy aufgenommen) — alle 3
                  // Modi locked mit ehrlichem Toast. Nach Re-Scan greift die
                  // neue Pipeline (createCustomerLidarScene → promoteScan-
                  // ToScene) und der Switcher wird unlocked.
                  lockedModes={
                    parametricReady ? [] : ['dollhouse', 'floorplan', 'walk']
                  }
                  onLockedTap={mode => {
                    const labels: Record<CustomerViewMode, string> = {
                      dollhouse: '3D Dollhouse',
                      floorplan: '2D Grundriss',
                      walk: 'Begehen',
                    }
                    toast.info(
                      `${labels[mode]} braucht ein Aufmaß — bitte neu scannen, dann sind alle 3 Ansichten verfügbar.`,
                    )
                  }}
                />
              </div>
              {/* L4.b · Verify-CTA — "Aufmaß prüfen". Sichtbar für jede
                  renderbare Szene (HW-geteilt ODER Self-Scan), bewusst NICHT auf
                  activeSceneCanEdit gegated: das würde die CTA genau auf den
                  HW-geteilten Szenen verstecken, für die der Verify-Flow gebaut
                  ist. Position adaptiv — ohne Edit-Rechte oben (wo sonst der
                  Einrichten-Toggle sitzt), mit Edit-Rechten unter dem Cluster. */}
              {parametricReady && spatialScene?.id != null && (
                <div
                  className="pointer-events-auto absolute left-[14px]"
                  style={{
                    top: `calc(max(env(safe-area-inset-top), 16px) + ${
                      activeSceneCanEdit ? 258 : 162
                    }px)`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      // Dismiss any lingering wall-finish toast — it renders at
                      // z-[60], above the verify sheet, and would overlap its CTAs.
                      setWallFinishUndo(null)
                      setVerifyOpen(true)
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-white/14 px-3.5 py-2 text-[12.5px] font-bold text-white transition active:scale-95 hover:bg-white/22"
                    style={{
                      backdropFilter: 'blur(20px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                      border: '1px solid rgba(255,255,255,0.16)',
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width={15}
                      height={15}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M9 11l3 3L22 4" />
                      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                    Aufmaß prüfen
                  </button>
                </div>
              )}
            </>
          ) : null
        }
        /* V1.6.1 Round 6 (2026-05-28): Floating "+ Neuer Raum" entfernt.
           Funktion lebt im ⋯-Menu-Popover Footer ("Neuen Raum anlegen") —
           User: "Neuer Raum Button muss raus, drei Punkte hätte er haben
           müssen". Doppel-CTA war Redundanz gegen die IA-Spec Mockup 02 v8. */
        cta={null}
      />

      {/* Inline-Banner-Layer — Fehler & GltfError sind keine Sheets, sie
          rendern als floating Card oben links auf der Scene, damit sie
          den 3D-Viewer nicht komplett überdecken. */}
      <InlineBannerLayer
        pinSaveError={pinSaveError}
        onDismissPinError={() => setPinSaveError(null)}
        gltfError={gltfError && !gltfErrorDismissed ? gltfError : null}
        onDismissGltfError={() => setGltfErrorDismissed(true)}
        statusError={status === 'error' ? (error ?? 'unbekannter Fehler') : null}
        onRetryStatus={() => void reload()}
      />

      {/* Room-Picker-Popover · ⋯-Menu */}
      <CustomerRoomPickerPopover
        open={showRoomPicker}
        scans={filtered}
        activeScanId={activeScanId}
        onSelect={scanId => setActiveScanId(scanId)}
        onAddRoom={() => dispatchSheet({ type: 'replace', sheet: 'new-room' })}
        onClose={() => dispatchSheet({ type: 'close' })}
      />

      {/* Sheets — mutually exclusive über sheetState.active */}
      <CustomerNewRoomSheet
        open={sheetState.active === 'new-room'}
        onClose={() => dispatchSheet({ type: 'close' })}
        onCreated={result => {
          dispatchSheet({ type: 'close' })
          void reload()
          setTab('vermessen')
          navigate(`/customer/spatial/scan/${result.scan.id}`)
        }}
        lidarAvailable={lidarAvailable}
        onCustomCanvasTap={() => {
          dispatchSheet({ type: 'replace', sheet: 'custom-canvas' })
        }}
        onLidarTap={() => {
          dispatchSheet({ type: 'close' })
          startLidarFlow()
        }}
      />

      <CustomerCustomCanvasSheet
        open={sheetState.active === 'custom-canvas'}
        onClose={() => dispatchSheet({ type: 'close' })}
        onCreated={result => {
          dispatchSheet({ type: 'close' })
          void reload()
          setTab('vermessen')
          navigate(`/customer/spatial/scan/${result.scan.id}`)
        }}
      />

      <CaptureDsgvoConsentSheet
        open={sheetState.active === 'dsgvo'}
        onCancel={() => dispatchSheet({ type: 'close' })}
        onConsented={() => {
          dispatchSheet({ type: 'close' })
          // Consent persisted — re-launch LiDAR via the shared flow which
          // re-checks the storage flag.
          startLidarFlow()
        }}
      />

      <CustomerOnboardingTour
        open={sheetState.active === 'tour'}
        onDone={() => {
          onboardingFlag.markSeen()
          dispatchSheet({ type: 'close' })
        }}
      />

      <ScanErrorRecoverySheet
        open={sheetState.active === 'recovery'}
        variant={recoveryVariant}
        attempt={Math.max(recoveryAttemptsRef.current, 1)}
        onClose={() => dispatchSheet({ type: 'close' })}
        onRetry={() => {
          if (recoveryVariant === 'max-retries') recoveryAttemptsRef.current = 0
          dispatchSheet({ type: 'close' })
          startLidarFlow()
        }}
        onSwitchToPreset={() => {
          recoveryAttemptsRef.current = 0
          dispatchSheet({ type: 'replace', sheet: 'new-room' })
        }}
      />

      {/* Resume-Sheet ist eigener Stack — hat eigene Session-Dismiss-Logik
          und konfligiert per Design nicht mit den anderen Sheets (es
          rendert nur wenn `pending` aus dem Hook auflöst). */}
      <CaptureResumeSheet
        open={showResumeSheet && sheetState.active !== 'tour'}
        roomLabel={pendingCapture?.scan ? scanTitle(pendingCapture.scan) : null}
        startedLabel={
          pendingCapture ? formatDate(pendingCapture.entry.capturedAt) : null
        }
        resuming={resumeBusy}
        discarding={discardBusy}
        onResume={() => void handleResumeCapture()}
        onDiscard={() => void handleDiscardCapture()}
        onDismiss={dismissResumeForSession}
      />

      <CustomerPinDetailSheet
        open={pendingPlacement != null}
        pinType={pendingPlacement?.pinType ?? null}
        saving={pinSaving}
        onCancel={handlePinSheetCancel}
        onSave={input => void handlePinSheetSave(input)}
      />

      {/* R11-B Hybrid Object-First Context-Sheet — öffnet bei Tap auf Surface
          ohne aktives Tool. Wand-Edit wired (R11-C). */}
      <CustomerSpatialContextSheet
        open={contextTap != null}
        surfaceKind={contextTap?.kind ?? null}
        surfaceLabel={
          contextTap?.kind === 'wall'
            ? wallLabelFor(contextTap?.surfaceExternalId)
            : undefined
        }
        onPickPinType={handleContextPickPinType}
        onEditWall={handleContextEditWall}
        onPickFinish={activeSceneCanEdit ? handleContextPickFinish : undefined}
        onClose={handleContextClose}
      />

      {/* Wandmaterial-Picker — Farbe/Putz/Fliesen/Holz/Tapete (Live-Preview). */}
      <CustomerWallFinishSheet
        open={editingWallFinishId != null}
        currentMaterialId={editingWallFinishMaterialId}
        wallLabel={wallLabelFor(editingWallFinishId)}
        onSelect={handleWallFinishSelect}
        onReset={handleWallFinishReset}
        onClose={() => setEditingWallFinishId(null)}
      />

      {/* S2 · surface-local Undo-Toast — lebt außerhalb des Finish-Sheets, das
          beim Anwenden unmountet. key={nonce} resettet den 8s-Timer pro Apply. */}
      <MaterialUndoToast
        key={wallFinishUndo?.nonce ?? 'idle'}
        visible={wallFinishUndo != null}
        materialName={wallFinishUndo?.materialName ?? ''}
        onUndo={handleWallFinishUndo}
        onDismiss={() => setWallFinishUndo(null)}
      />

      {/* L4.b · Verify-Sheet (Aufmaß prüfen / korrigieren). Self-contained —
          Korrekturen + Verify-State-Persistenz laufen in useVerifyFlow; die
          Verify-State-Spalten schreiben über den column-scoped SECDEF-RPC, der
          auch auf HW-geteilten Szenen greift (wo spatial_can_edit_scene=false).
          onRequestProvider bewusst weggelassen (DEFER — Face-A-Inquiry separat). */}
      <VerifySheet
        key={spatialScene?.id ?? 'no-scene'}
        open={verifyOpen}
        onClose={() => setVerifyOpen(false)}
        sceneId={spatialScene?.id ?? null}
        scene={roomScene}
        variants={sceneVariants}
        overrides={sceneOverrides}
        verifyState={spatialScene?.customerVerifyState ?? 'not_started'}
        lastStage={spatialScene?.customerVerifyLastStage ?? null}
        ownerUserId={userId ?? null}
        onSubmitted={() => setVerifyOpen(false)}
      />

      {/* R11-C Wall-Edit-Sheet — UI komplett, Save-Persistence Phase 1e
          (Toast statt false-positive). */}
      {/* R13 Customer-Tür/Fenster/etc. EditSheet — Slider mit Live-Preview. */}
      <CustomerObjectEditSheet
        open={editingObject != null && editingObjectValue != null}
        toolKind={editingObject?.toolKind ?? null}
        headerLabelOverride={editingObjectHeaderLabel}
        wallLabel={wallLabelFor(editingObject?.wallId)}
        wallLengthM={editingObjectWallLengthM}
        wallHeightM={editingObjectWallHeightM}
        value={
          editingObjectValue ?? {
            positionAlongWallM: 0,
            widthM: 0,
            heightM: 0,
            offsetFromFloorM: 0,
          }
        }
        onChange={handleObjectEditChange}
        saveHint={objectSaveHint}
        conflict={editConflict}
        dinWarnings={editDinWarnings}
        onDelete={handleObjectEditDelete}
        onClose={handleObjectEditClose}
      />

      <CustomerWallEditSheet
        open={editingWall != null}
        wallLabel={wallLabelFor(editingWall?.id)}
        currentLengthM={editingWallLength}
        currentThicknessM={editingWall?.thickness_m}
        currentHeightM={editingWall?.height_m}
        canEdit={activeSceneCanEdit}
        onSave={handleWallEditSave}
        onCancel={handleWallEditCancel}
      />

      {/* Phase 4 Möbel-Picker — mounted + open-toggle (Reset bei jedem Öffnen). */}
      <AssetPickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelectAsset={handleAssetSelected}
      />

      <ElectricalSubPickerSheet
        open={electricalPickerOpen}
        onSelect={handleElectricalKindSelected}
        onClose={() => setElectricalPickerOpen(false)}
      />

      {/* Phase 5/6 Möbel-Edit-Modus — Aktionsleiste, wenn ein Möbel selektiert. */}
      {editingFurniture && (() => {
        const scale = editingFurniture.transform?.scale?.x ?? 1
        const fmt = (n: number) =>
          n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')
        const w = editingFurniture.dimensions.width_m * scale
        const d = editingFurniture.dimensions.depth_m * scale
        return (
          <FurnitureEditActionBar
            open
            name={
              (editingFurniture.asset_id
                ? getCatalogAsset(editingFurniture.asset_id)?.displayName
                : undefined) ?? 'Möbel'
            }
            footprintLabel={`${fmt(w)} × ${fmt(d)} m`}
            rotationDeg={editingFurniture.rotation_around_y_deg ?? 0}
            scalePct={Math.round(scale * 100)}
            canScaleDown={scale > scaleLimitsForCategory(editingFurniture.category).min + 1e-6}
            canScaleUp={scale < scaleLimitsForCategory(editingFurniture.category).max - 1e-6}
            saveHint={objectSaveHint}
            onRotate={handleFurnitureRotate}
            onScaleDown={() => handleFurnitureScale(-0.1)}
            onScaleUp={() => handleFurnitureScale(0.1)}
            onDuplicate={handleFurnitureDuplicate}
            onDelete={handleFurnitureDelete}
            onDone={handleFurnitureDone}
          />
        )
      })()}

      {/* V1.6.1 Ceiling Re-Edit — reduzierte Aktionsleiste (Verschieben per Drag,
          kein Dreh/Skalieren/Duplizieren für Decken-Leuchten in diesem MVP). */}
      {editingCeilingObject && (() => {
        const so = editingCeilingObject
        const fmt = (n: number) =>
          n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')
        return (
          <FurnitureEditActionBar
            open
            name={
              (so.asset_id ? getCatalogAsset(so.asset_id)?.displayName : undefined) ?? 'Objekt'
            }
            footprintLabel={`${fmt(so.dimensions.width_m)} × ${fmt(so.dimensions.depth_m)} m`}
            saveHint={objectSaveHint}
            onDelete={handleCeilingDelete}
            onDone={handleFurnitureDone}
          />
        )
      })()}
    </AppShell>
  )
}

function GlassPill({
  children,
  ariaLabel,
}: {
  children: ReactNode
  ariaLabel?: string
  kind?: 'cluster' | 'standalone'
}) {
  return (
    <div
      role={ariaLabel ? 'group' : undefined}
      aria-label={ariaLabel}
      className="flex items-center gap-2.5 rounded-full px-2.5 py-1.5"
      style={{
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%)',
        backdropFilter: 'blur(96px) saturate(240%)',
        WebkitBackdropFilter: 'blur(96px) saturate(240%)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow:
          '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 0 rgba(255,255,255,0.04)',
      }}
    >
      {children}
    </div>
  )
}

function GlassRoundButton({
  children,
  ariaLabel,
  active,
  onClick,
}: {
  children: ReactNode
  ariaLabel: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-expanded={active}
      onClick={onClick}
      className="flex h-[42px] w-[42px] items-center justify-center rounded-full text-white transition active:scale-95"
      style={{
        background: active
          ? 'linear-gradient(180deg, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0.08) 100%)'
          : 'linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%)',
        backdropFilter: 'blur(96px) saturate(240%)',
        WebkitBackdropFilter: 'blur(96px) saturate(240%)',
        border: active
          ? '1px solid rgba(255,255,255,0.32)'
          : '1px solid rgba(255,255,255,0.14)',
        boxShadow:
          '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 0 rgba(255,255,255,0.04)',
      }}
    >
      {children}
    </button>
  )
}

function RoomInfoPill({
  name,
  ownerType,
  sharedWithCustomer,
  areaM2,
  wallCount,
}: {
  name: string
  ownerType: 'customer' | 'craftsman'
  sharedWithCustomer: boolean
  areaM2: number
  wallCount: number
}) {
  const isCustomer = ownerType === 'customer'
  const dotColor = isCustomer ? '#10b981' : '#fbbf24'
  const dotGlow = isCustomer ? '0 0 5px #10b981' : '0 0 5px #fbbf24'
  const ownerLabel = isCustomer
    ? 'Selbst erstellt'
    : sharedWithCustomer
      ? 'Vom HW geteilt'
      : 'Vom HW'
  // Live-Maßzahl: Fläche (1 Nachkommastelle) · Wandzahl. Nur zeigen, wenn die
  // Geometrie schon steht (area > 0), sonst kein „0,0 m²"-Rauschen vor Hydration.
  const areaLabel = areaM2 > 0 ? `${areaM2.toFixed(1).replace('.', ',')} m²` : null
  const metricsLabel = areaLabel
    ? `${areaLabel} · ${wallCount} ${wallCount === 1 ? 'Wand' : 'Wände'}`
    : null
  return (
    <div
      className="pointer-events-auto absolute left-[14px] rounded-[12px] px-3 py-1.5"
      style={{
        top: 'calc(max(env(safe-area-inset-top), 16px) + 110px)',
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
        backdropFilter: 'blur(96px) saturate(240%)',
        WebkitBackdropFilter: 'blur(96px) saturate(240%)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow:
          '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 0 rgba(255,255,255,0.04)',
      }}
    >
      <div className="text-[12.5px] font-bold leading-tight tracking-tight text-white">
        {name}
      </div>
      <div className="mt-[2px] flex items-center gap-[5px] text-[10px] leading-tight text-white/72">
        <span
          aria-hidden
          className="inline-block h-[5px] w-[5px] rounded-full"
          style={{ background: dotColor, boxShadow: dotGlow }}
        />
        {ownerLabel}
      </div>
      {metricsLabel && (
        <div className="mt-[2px] text-[10px] font-semibold tabular-nums leading-tight text-white/85">
          {metricsLabel}
        </div>
      )}
    </div>
  )
}

function InlineBannerLayer({
  pinSaveError,
  onDismissPinError,
  gltfError,
  onDismissGltfError,
  statusError,
  onRetryStatus,
}: {
  pinSaveError: string | null
  onDismissPinError: () => void
  gltfError: string | null
  onDismissGltfError: () => void
  statusError: string | null
  onRetryStatus: () => void
}) {
  if (!pinSaveError && !gltfError && !statusError) return null
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-[55] flex flex-col items-center gap-2 px-4"
      style={{
        top: 'calc(max(env(safe-area-inset-top), 16px) + 180px)',
      }}
    >
      {pinSaveError && (
        <div
          className="pointer-events-auto w-full max-w-[420px] rounded-2xl border p-3 text-sm"
          style={{
            background: 'rgba(239,68,68,0.16)',
            borderColor: 'rgba(239,68,68,0.42)',
            color: '#fecaca',
            backdropFilter: 'blur(28px) saturate(180%)',
            WebkitBackdropFilter: 'blur(28px) saturate(180%)',
          }}
        >
          Pin konnte nicht gespeichert werden ({pinSaveError}).{' '}
          <button type="button" onClick={onDismissPinError} className="underline">
            Verstanden
          </button>
        </div>
      )}
      {gltfError && (
        <div
          className="pointer-events-auto w-full max-w-[420px] rounded-2xl border p-3 text-sm"
          style={{
            background: 'rgba(250,204,21,0.14)',
            borderColor: 'rgba(250,204,21,0.42)',
            color: '#fde68a',
            backdropFilter: 'blur(28px) saturate(180%)',
            WebkitBackdropFilter: 'blur(28px) saturate(180%)',
          }}
        >
          3D-Modell konnte nicht geladen werden ({gltfError}). Du siehst den
          dunklen Hintergrund stattdessen.{' '}
          <button type="button" onClick={onDismissGltfError} className="underline">
            Verstanden
          </button>
        </div>
      )}
      {statusError && (
        <div
          className="pointer-events-auto w-full max-w-[420px] rounded-2xl border p-3 text-sm"
          style={{
            background: 'rgba(239,68,68,0.16)',
            borderColor: 'rgba(239,68,68,0.42)',
            color: '#fecaca',
            backdropFilter: 'blur(28px) saturate(180%)',
            WebkitBackdropFilter: 'blur(28px) saturate(180%)',
          }}
        >
          Aufmaße konnten nicht geladen werden ({statusError}).
          <button
            type="button"
            onClick={onRetryStatus}
            className="ml-2 underline"
          >
            Neu versuchen
          </button>
        </div>
      )}
    </div>
  )
}

function TabPills({
  tab,
  scans,
  hwHasNew,
  hwDelta,
  onSelect,
}: {
  tab: TabKey
  scans: Scan[]
  hwHasNew: boolean
  hwDelta: number
  onSelect: (key: TabKey) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Aufmaß-Bereiche"
      className="inline-flex items-center gap-1 rounded-full p-1"
      style={{
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%)',
        backdropFilter: 'blur(96px) saturate(240%)',
        WebkitBackdropFilter: 'blur(96px) saturate(240%)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow:
          '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 0 rgba(255,255,255,0.04)',
      }}
    >
      {TABS.map(opt => {
        const isActive = opt.key === tab
        const count = scans.filter(opt.match).length
        const showNewDot = opt.key === 'vom-hw' && hwHasNew && !isActive
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(opt.key)}
            className={
              'relative flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-bold tracking-tight transition ' +
              (isActive
                ? 'text-ink shadow-[0_4px_10px_rgba(0,0,0,0.22),inset_0_1px_1px_rgba(255,255,255,0.92)]'
                : 'text-white/78 hover:text-white')
            }
            style={
              isActive
                ? {
                    background: 'rgba(255,255,255,0.95)',
                  }
                : undefined
            }
          >
            <span>{opt.label}</span>
            <span
              className="rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold"
              style={
                isActive
                  ? {
                      background: 'rgba(37,99,235,0.16)',
                      color: '#2563EB',
                    }
                  : {
                      background: 'rgba(255,255,255,0.16)',
                      color: 'rgba(255,255,255,0.78)',
                    }
              }
            >
              {count}
            </span>
            {showNewDot && (
              <span
                aria-label={`${hwDelta} neu`}
                className="absolute right-1 top-1 h-[6px] w-[6px] rounded-full bg-rose-400 shadow-[0_0_6px_rgba(248,113,113,0.85)]"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

function EmptyHubHero({
  tab,
  lidarAvailable,
  onScan,
  onPreset,
  onCustom,
  onExamples,
}: {
  tab: TabKey
  lidarAvailable: boolean | null
  onScan: () => void
  onPreset: () => void
  onCustom: () => void
  onExamples: () => void
}) {
  if (tab === 'vom-hw') {
    return (
      <div
        className="rounded-2xl p-6 text-center"
        style={{
          background:
            'linear-gradient(180deg, rgba(15,21,37,0.55) 0%, rgba(15,21,37,0.72) 100%)',
          backdropFilter: 'blur(28px) saturate(200%)',
          WebkitBackdropFilter: 'blur(28px) saturate(200%)',
          border: '1px solid rgba(255,255,255,0.14)',
        }}
      >
        <div
          className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: 'rgba(255,255,255,0.08)' }}
        >
          <Box size={22} className="text-white/70" aria-hidden />
        </div>
        <div className="text-[15px] font-semibold text-white">
          Noch keine Aufmaße vom Handwerker
        </div>
        <p className="mt-1 text-[13px] text-white/65">
          Sobald dein Handwerker dir ein 3D-Aufmaß freigibt, erscheint es hier.
        </p>
      </div>
    )
  }

  return (
    <div
      className="rounded-3xl p-6 text-center"
      style={{
        background:
          'linear-gradient(180deg, rgba(20,32,56,0.72) 0%, rgba(15,21,37,0.86) 100%)',
        backdropFilter: 'blur(28px) saturate(200%)',
        WebkitBackdropFilter: 'blur(28px) saturate(200%)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow:
          '0 18px 40px rgba(0,0,0,0.45), inset 0 1px 1px rgba(255,255,255,0.18)',
      }}
    >
      <div
        className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
        style={{
          background:
            'linear-gradient(135deg, rgba(37,99,235,0.32) 0%, rgba(37,99,235,0.12) 100%)',
          border: '1px solid rgba(96,165,250,0.40)',
        }}
      >
        <Sparkles size={28} className="text-brand-light" aria-hidden />
      </div>
      <h2 className="text-[22px] font-bold leading-tight tracking-tight text-white">
        Dein erster 3D-Raum
      </h2>
      <p className="mx-auto mt-2 max-w-[300px] text-[13px] leading-snug text-white/70">
        In 1–2 Minuten vermessen — wir bauen das 3D-Modell. Du wählst, wie.
      </p>

      <div className="mt-5 grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={onScan}
          disabled={lidarAvailable === null}
          aria-busy={lidarAvailable === null}
          aria-label={lidarAvailable === null ? 'LiDAR wird geprüft' : 'Scannen'}
          className="flex flex-col items-center gap-1 rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 px-2 py-3 text-[12px] font-bold text-white shadow-lg shadow-sky-900/40 transition active:scale-[0.98] disabled:animate-pulse disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-sky-300/60"
        >
          <span aria-hidden className="text-lg leading-none">📐</span>
          Scannen
          <span aria-hidden className="text-[9.5px] font-normal text-white/75">
            1–2 Min
          </span>
        </button>
        <button
          type="button"
          onClick={onPreset}
          className="flex flex-col items-center gap-1 rounded-2xl border border-white/15 bg-white/[0.06] px-2 py-3 text-[12px] font-bold text-white/90 transition active:scale-[0.98] hover:bg-white/[0.10] focus:outline-none focus:ring-2 focus:ring-sky-300/60"
        >
          <span aria-hidden className="text-lg leading-none">📋</span>
          Vorlage
          <span aria-hidden className="text-[9.5px] font-normal text-white/55">
            30 Sek
          </span>
        </button>
        <button
          type="button"
          onClick={onCustom}
          className="flex flex-col items-center gap-1 rounded-2xl border border-dashed border-white/20 bg-transparent px-2 py-3 text-[12px] font-bold text-white/80 transition active:scale-[0.98] hover:border-white/40 hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-sky-300/60"
        >
          <span aria-hidden className="text-lg leading-none">✨</span>
          Leer
          <span aria-hidden className="text-[9.5px] font-normal text-white/55">
            2–3 Min
          </span>
        </button>
      </div>
      <p className="mt-3 text-[11px] text-white/45">
        Auch ohne Pro-iPhone — die Vorlage geht auf jedem Gerät.
      </p>

      <button
        type="button"
        onClick={onExamples}
        data-testid="empty-hub-hero-examples"
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/[0.04] px-3 py-2.5 text-[12.5px] font-semibold text-white/85 transition active:scale-[0.98] hover:border-white/25 hover:bg-white/[0.08] focus:outline-none focus:ring-2 focus:ring-sky-300/60"
      >
        <span aria-hidden className="text-base leading-none">👀</span>
        <span>Beispiel-Räume ansehen</span>
        <span aria-hidden className="text-[10px] font-normal text-white/45">
          · Bad, Küche, Wohnen
        </span>
      </button>
    </div>
  )
}
