/**
 * CraftsmanJobSpatialDetailScreen — Provider Job-Spatial-Detail shell
 * (Phase B · B-2). The compact 5-tab shell (Mockup 20) hosting:
 *   3D-Modell · Stückliste · Pins · Vergleich · Re-Scan
 *
 * The shell owns: job + scene resolution, the header, the tab bar, the
 * conditional "customer changed the model" refresh strip, and tab routing
 * via the `?tab=` query param. Each tab's behaviour lives in its own
 * component (B-3 · B-5 · B-6).
 *
 * Route: /craftsman/jobs/:jobId/spatial
 */

import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Box, ChevronLeft } from 'lucide-react'
import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import { useHaptics } from '../hooks/useHaptics'
import { useSession } from '../hooks/useSession'
import { useSpatialScan } from '../hooks/useSpatialScan'
import { useJobSpatialScene } from '../lib/spatial/canonical/workflow/useJobSpatialScene'
import { useJobScanRealtime } from '../lib/spatial/hooks/useJobScanRealtime'
import type { CustomerVerifyState } from '../lib/spatial/canonical/repository/spatialSceneFsm'
import {
  JOB_SPATIAL_TABS,
  parseJobSpatialTab,
  type JobSpatialTabKey,
  type JobSpatialTabProps,
} from '../components/spatial/provider/jobSpatialTabs'
import JobSpatial3DTab from '../components/spatial/provider/JobSpatial3DTab'
import JobSpatialBomTab from '../components/spatial/provider/JobSpatialBomTab'
import JobSpatialPinsTab from '../components/spatial/provider/JobSpatialPinsTab'
import JobSpatialCompareTab from '../components/spatial/provider/JobSpatialCompareTab'
import JobSpatialRescanTab from '../components/spatial/provider/JobSpatialRescanTab'
import JobSpatialShareToggle from '../components/spatial/provider/JobSpatialShareToggle'
import { useSmartBack } from '../hooks/useSmartBack'

/** Job-status → compact status pill (label + tone). */
function statusPill(status: string): { label: string; bg: string; fg: string } {
  switch (status) {
    case 'new':
      return { label: 'Neu', bg: '#E5EDFB', fg: '#2563EB' }
    case 'completed':
      return { label: 'Fertig', bg: '#D1FAE5', fg: '#047857' }
    case 'cancelled':
      return { label: 'Storniert', bg: '#ECEFF4', fg: '#475569' }
    case 'waiting_payment':
      return { label: 'Zahlung', bg: '#FEF3C7', fg: '#B45309' }
    default:
      return { label: 'Aktiv', bg: '#FEF3C7', fg: '#B45309' }
  }
}

/**
 * Customer-verify-state → header badge (label + tone), or `null` when there is
 * nothing to surface (`not_started`). Distinct from {@link statusPill} (job
 * status) — it reports whether the CUSTOMER has reviewed the measurement.
 * Sourced from `scene.customerVerifyState`, not job status.
 */
function verifyPill(
  state: CustomerVerifyState | undefined,
): { label: string; bg: string; fg: string } | null {
  switch (state) {
    case 'approved':
      return { label: 'Kunde bestätigt', bg: '#D1FAE5', fg: '#047857' }
    case 'rejected':
      return { label: 'Korrektur nötig', bg: '#FEE2E2', fg: '#B91C1C' }
    case 'in_progress':
      return { label: 'Kunde prüft', bg: '#E5EDFB', fg: '#2563EB' }
    case 'expired':
      return { label: 'Prüfung abgelaufen', bg: '#ECEFF4', fg: '#475569' }
    default:
      return null
  }
}

/**
 * Remount the whole subtree when the signed-in user changes so no stale
 * provider-org scene state survives an account switch (Phase C · C-0).
 */
export default function CraftsmanJobSpatialDetailScreen() {
  const { user } = useSession()
  return <CraftsmanJobSpatialDetailScreenInner key={user?.id ?? 'anon'} />
}

function CraftsmanJobSpatialDetailScreenInner() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const haptics = useHaptics()
  const goBack = useSmartBack('/craftsman/spatial')
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    loading,
    error,
    job,
    scene,
    roomScene,
    variants,
    overrides,
    blobState,
    blobError,
    refetch,
  } = useJobSpatialScene(jobId)

  // Block 2 — read the latest scan row separately (the canonical-scene hook
  // above works on `spatial_scenes`, not `scans`). The share-toggle column
  // lives on `scans.shared_with_customer`, so we hydrate the scan here.
  //
  // `isHydrated` is the truthy signal for "the first fetch settled" — until
  // then `scan === null` is ambiguous (pre-fetch vs genuinely empty), so the
  // share-toggle must NOT render the D5 empty-state during that window.
  const {
    scan,
    isHydrated: scanHydrated,
    refresh: refreshScan,
  } = useSpatialScan(jobId ? { jobId } : null)

  // Block 2 (D1) — separate Realtime hook drives `useSpatialScan.refresh()`
  // on every server-side UPDATE so the toggle reflects the truth across
  // multi-tab HW + cross-device (e.g. customer-app push fires after share).
  useJobScanRealtime(jobId, refreshScan)

  // C-9: the active tab is derived from `?tab=` directly — a push-dispatched
  // `?tab=pins` switches the tab even when the shell is already mounted (no
  // mount-only useState snapshot).
  const tab = parseJobSpatialTab(searchParams.get('tab'))

  const selectTab = (next: JobSpatialTabKey) => {
    haptics.selection()
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  const pill = useMemo(() => statusPill(job?.status ?? ''), [job?.status])
  const verify = useMemo(() => verifyPill(scene?.customerVerifyState), [scene?.customerVerifyState])

  if (loading) {
    return (
      <AppShell active="verwaltung" hideBottomNav noSafeTop>
        <ScreenSkeleton variant="detail" />
      </AppShell>
    )
  }

  if (!job) {
    return (
      <AppShell active="verwaltung" hideBottomNav noSafeTop>
        <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 px-8 text-center">
          <AlertTriangle size={32} className="text-danger" />
          <p className="text-[14px] font-semibold text-ink">Job nicht gefunden</p>
          {error && <p className="text-[12px] text-ink-muted">{error}</p>}
          <button
            type="button"
            onClick={goBack}
            className="mt-2 rounded-[10px] bg-brand px-4 py-2 text-[13px] font-semibold text-white"
          >
            Zurück zum Hub
          </button>
        </div>
      </AppShell>
    )
  }

  // The shell hydrates the scene + blob once; every tab renders from the same
  // `JobSpatialTabProps`. Non-null only while `scene` exists (`job` is already
  // narrowed by the `!job` guard above).
  const tabProps: JobSpatialTabProps | null = scene
    ? {
        job,
        scene,
        roomScene,
        variants,
        overrides,
        blobState,
        blobError,
        onRetry: refetch,
        onSelectTab: selectTab,
      }
    : null

  return (
    <AppShell active="verwaltung" hideBottomNav noSafeTop>
      <div className="flex min-h-[100dvh] flex-col bg-canvas">
        {/* ── shell header ── */}
        <div className="shrink-0 bg-surface px-3 pb-2 pt-[max(8px,env(safe-area-inset-top))]">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Zurück"
              onClick={() => {
                haptics.selection()
                goBack()
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-ink-sub"
            >
              <ChevronLeft size={19} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-bold leading-tight tracking-tight text-ink">
                {job.title}
              </div>
              <div className="mt-px flex items-center gap-1.5">
                <span
                  className="rounded-chip px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide"
                  style={{ background: pill.bg, color: pill.fg }}
                >
                  {pill.label}
                </span>
                {verify && (
                  <span
                    className="rounded-chip px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide"
                    style={{ background: verify.bg, color: verify.fg }}
                  >
                    {verify.label}
                  </span>
                )}
                <span className="text-[11px] text-ink-muted">{job.customer}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Block 2 · HW Share-Toggle — sits between header + tab strip.
            Gated on `scanHydrated` so we never render the D5 "Noch kein
            Aufmaß" empty-state during the first-fetch window. A subtle
            placeholder row keeps the layout stable while the scan resolves. ── */}
        {jobId && scanHydrated && (
          <JobSpatialShareToggle
            scan={scan}
            jobId={jobId}
            customerLabel={job.customer ?? null}
            onSuccess={() => refreshScan()}
          />
        )}
        {jobId && !scanHydrated && (
          <div
            aria-hidden="true"
            className="mx-3 mb-2 h-[52px] animate-pulse rounded-[14px] border border-edge bg-surface"
          />
        )}

        {/* ── tab bar — WAI-ARIA Tabs Pattern (E5 A11y) ── */}
        <div
          role="tablist"
          aria-label="Spatial-Detail-Tabs"
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-edge bg-surface px-2.5 pt-0.5 [scrollbar-width:none]"
          onKeyDown={(event) => {
            // WAI-ARIA Authoring Practices: ←/→ cycle, Home/End jump to first/last.
            const currentIndex = JOB_SPATIAL_TABS.findIndex((t) => t.key === tab)
            const lastIndex = JOB_SPATIAL_TABS.length - 1
            let nextIndex: number | null = null
            if (event.key === 'ArrowLeft') {
              nextIndex = (currentIndex - 1 + JOB_SPATIAL_TABS.length) % JOB_SPATIAL_TABS.length
            } else if (event.key === 'ArrowRight') {
              nextIndex = (currentIndex + 1) % JOB_SPATIAL_TABS.length
            } else if (event.key === 'Home') {
              nextIndex = 0
            } else if (event.key === 'End') {
              nextIndex = lastIndex
            }
            if (nextIndex === null) return
            event.preventDefault()
            selectTab(JOB_SPATIAL_TABS[nextIndex].key)
          }}
        >
          {JOB_SPATIAL_TABS.map((t) => {
            const isActive = tab === t.key
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`spatial-tab-${t.key}`}
                aria-controls={`spatial-tabpanel-${t.key}`}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => selectTab(t.key)}
                className={`shrink-0 whitespace-nowrap border-b-[2.5px] px-2.5 pb-2 pt-1.5 text-[12px] transition ${
                  isActive
                    ? 'border-brand font-bold text-brand'
                    : 'border-transparent font-semibold text-ink-muted'
                }`}
              >
                {t.label}
              </button>
            )
          })}
        </div>

        {/* The "customer changed the model" refresh strip (Mockup 20) needs a
            cross-domain change signal — wired in Phase C. */}

        {/* ── tab content ── */}
        {!scene ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-[#EEF2FB] text-brand">
              <Box size={30} />
            </span>
            <p className="text-[15px] font-bold text-ink">Noch kein 3D-Aufmaß</p>
            <p className="max-w-[260px] text-[12.5px] text-ink-sub">
              Dieser Job hat noch keinen Kunden-Scan. Bitte die Kundin im Auftrag um eine
              Raum-Aufnahme — oder nimm den Raum selbst vor Ort auf.
            </p>
            <button
              type="button"
              onClick={() => {
                haptics.selection()
                navigate(`/craftsman/jobs/${jobId}`)
              }}
              className="mt-1 rounded-[10px] bg-brand px-4 py-2.5 text-[13px] font-semibold text-white"
            >
              Im Auftrag nachfragen
            </button>
          </div>
        ) : (
          <div
            role="tabpanel"
            id={`spatial-tabpanel-${tab}`}
            aria-labelledby={`spatial-tab-${tab}`}
            className="flex flex-1 flex-col overflow-hidden"
          >
            {tabProps && tab === '3d' && <JobSpatial3DTab {...tabProps} />}
            {tabProps && tab === 'bom' && <JobSpatialBomTab {...tabProps} />}
            {tabProps && tab === 'pins' && <JobSpatialPinsTab {...tabProps} />}
            {tabProps && tab === 'compare' && <JobSpatialCompareTab {...tabProps} />}
            {tabProps && tab === 'rescan' && <JobSpatialRescanTab {...tabProps} />}
          </div>
        )}
      </div>
    </AppShell>
  )
}
