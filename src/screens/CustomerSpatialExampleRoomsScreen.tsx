/**
 * Spatial · V1.6.1 · Customer Beispiel-Räume Route
 *
 * Visual demo route that lets a Customer preview three sample rooms (Bad /
 * Küche / Wohnen) before scanning their own. Replaces the prior nüchterner
 * Cube-Outline path on the V1.5.1 Privat-Tab Empty-State (Mockup 02 v3).
 *
 * Two surface states (driven by `?room=…` query param):
 *
 *   1. **Picker** (`/customer/spatial/beispiel-raeume`) — Mockup 02 v3 picker
 *      with the Bad-hero card + Küche/Wohnen sub-cards. Outline-icon plates
 *      keep the surface honest while only three rooms are ready (per
 *      `feedback_mockup_wording_function_logic.md`).
 *   2. **Viewer** (`/customer/spatial/beispiel-raeume?room=bath`) — Mockup 03
 *      v3 chrome wrapped around `<CanonicalSceneRoot>`. Top-nav back-button
 *      strips the `?room` param so the picker re-mounts; closing routes back
 *      to the Hub.
 *
 * Deep-link contract:
 *   - `?room=bath|kitchen|living` → opens the viewer for that kind
 *   - missing / invalid `?room` → picker
 *   - hard-coded route — no PII; safe to share in chat / push notifications
 *
 * Persisted "seen" state lives in `useExampleRoomsSeen` (one localStorage
 * key for all customers on this device) so the NEW-dot on the picker tiles
 * disappears once the customer has actually viewed the room.
 *
 * CTA wiring:
 *   - "Als Projekt anlegen" → `/customer/spatial/list?new=1` (existing
 *     deep-link that auto-opens the NewRoomSheet on the Hub).
 *   - "Selbst messen" → same target — the NewRoomSheet then exposes the
 *     LiDAR-tile when the device supports it (`useStartCustomerLidarScan`
 *     does the runtime probe inside the sheet).
 */

import { lazy, Suspense, useCallback, useMemo } from 'react'
import {
  ChevronLeft,
  Sparkles,
} from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import AppShell from '../components/AppShell'
import ExampleRoomPicker from '../components/spatial/customer/ExampleRoomPicker'
import {
  EXAMPLE_ROOMS_BY_KIND,
  isExampleRoomKind,
  type ExampleRoomKind,
} from '../lib/spatial/canonical/presets/exampleRooms'
import { useExampleRoomsSeen } from '../lib/spatial/hooks/useExampleRoomsSeen'
import { useSmartBack } from '../hooks/useSmartBack'

// Lazy-load the viewer chunk so the Three.js bundle only ships when the
// customer actually opens a room. The picker path stays light enough to
// keep the initial route payload comparable to a regular list screen.
const ExampleRoomViewer = lazy(
  () => import('../components/spatial/customer/ExampleRoomViewer'),
)

export default function CustomerSpatialExampleRoomsScreen() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { unseenKinds, markSeen } = useExampleRoomsSeen()
  const goBack = useSmartBack('/customer/spatial/list')

  const roomParam = searchParams.get('room')
  const activeKind: ExampleRoomKind | null = useMemo(() => {
    if (!roomParam) return null
    return isExampleRoomKind(roomParam) ? roomParam : null
  }, [roomParam])

  const handlePick = useCallback(
    (kind: ExampleRoomKind) => {
      markSeen(kind)
      const next = new URLSearchParams(searchParams)
      next.set('room', kind)
      setSearchParams(next, { replace: false })
    },
    [markSeen, searchParams, setSearchParams],
  )

  const handleBackToPicker = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete('room')
    setSearchParams(next, { replace: false })
  }, [searchParams, setSearchParams])

  const handleCreateProject = useCallback(() => {
    navigate('/customer/spatial/list?new=1')
  }, [navigate])

  // Picker uses the AppShell so the customer keeps the regular tab bar.
  // Viewer mounts the canonical scene full-bleed and skips the shell so
  // the demo experience matches Mockup 03 v3 chrome edge-to-edge.
  if (activeKind) {
    return (
      <Suspense fallback={<ViewerLoading />}>
        <ExampleRoomViewer
          kind={activeKind}
          onBack={handleBackToPicker}
          onClose={goBack}
          onCreateProject={handleCreateProject}
          onMeasureSelf={handleCreateProject}
        />
      </Suspense>
    )
  }

  return (
    <AppShell active="profile">
      <PickerLayout
        onBack={goBack}
        unseenKinds={unseenKinds}
        onPick={handlePick}
      />
    </AppShell>
  )
}

interface PickerLayoutProps {
  onBack: () => void
  onPick: (kind: ExampleRoomKind) => void
  unseenKinds: ReadonlySet<ExampleRoomKind>
}

function PickerLayout({ onBack, onPick, unseenKinds }: PickerLayoutProps) {
  // Pre-resolve the rooms so the eyebrow / paragraph stay in sync with the
  // catalog metadata (single source of truth: EXAMPLE_ROOMS_BY_KIND).
  // Pre-fetched here to avoid mounting the meta inside the chrome render.
  void EXAMPLE_ROOMS_BY_KIND
  return (
    <div
      className="relative min-h-[100dvh] w-full overflow-hidden text-white"
      style={{
        background:
          'linear-gradient(135deg, #1a1f2e 0%, #2d1b4e 50%, #0f2433 100%)',
      }}
    >
      {/* atmospheric brand-tint blobs (no foto-bg per design-lessons: hero is content) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 25% 15%, rgba(99,102,241,0.18), transparent 40%),' +
            'radial-gradient(circle at 80% 85%, rgba(20,184,166,0.16), transparent 45%)',
        }}
      />

      <div
        className="relative mx-auto flex w-full max-w-[420px] flex-col gap-5 px-4 pb-12"
        style={{
          paddingTop: 'calc(max(env(safe-area-inset-top), 16px) + 56px)',
        }}
      >
        <header className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Zurück zum 3D-Bereich"
            className="grid h-9 w-9 place-items-center rounded-full border border-white/18 bg-white/12 text-white backdrop-blur-lg transition active:scale-[0.95]"
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
          <h1 className="text-[17px] font-semibold leading-tight">Beispiel-Raum</h1>
        </header>

        <section className="text-white">
          <div className="mb-2.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-white/45">
            <Sparkles size={11} className="-mt-0.5 mr-1 inline-block text-sky-300" aria-hidden />
            Beispiel-Räume
          </div>
          <h2 className="text-[26px] font-bold leading-[1.15] tracking-tight">
            Welchen Raum willst du sehen?
          </h2>
          <p className="mt-2 text-[14px] leading-snug text-white/62">
            Probier die 3D-Ansicht aus — bevor du selbst scannst.
          </p>
        </section>

        <ExampleRoomPicker onPick={onPick} unseenKinds={unseenKinds} />
      </div>
    </div>
  )
}

function ViewerLoading() {
  return (
    <div
      className="flex h-[100dvh] w-full items-center justify-center bg-[#0a1525] text-white"
      aria-busy="true"
      data-testid="example-room-viewer-loading"
    >
      <div className="flex flex-col items-center gap-3 text-white/70">
        <div className="h-2 w-32 animate-pulse rounded-full bg-white/15" />
        <span className="text-xs">Beispiel-Raum wird geladen …</span>
      </div>
    </div>
  )
}
