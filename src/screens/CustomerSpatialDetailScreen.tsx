/**
 * Spatial Lane 3 V1.6 Block 3 · Customer Spatial Detail Screen
 *
 * Read-only 3D viewer for one scan the authenticated customer can see.
 * Hierarchy (top-down, scroll):
 *
 *   1. Header (Back + Title + Subtitle)
 *   2. Quick-Answers (Termin / Preis / Was wird gemacht)
 *   3. 3D-Hero (SpatialViewer mode='view', chromeless)
 *   4. Maße-Section (SpatialMeasurementTable)
 *   5. Pins-Section ("Hinweise vom Handwerker" via SpatialPinList,
 *      customer mode — no toggle, no privacy indicator; RLS already filters
 *      out private pins server-side)
 *   6. Footer-Hint when Self-Scan ("Nur für dich sichtbar")
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, Box, Share2 } from 'lucide-react'

import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import { SpatialViewer } from '../components/spatial/SpatialViewer'
import { SpatialMeasurementTable } from '../components/spatial/SpatialMeasurementTable'
import { SpatialPinList } from '../components/spatial/SpatialPinList'
import { CustomerSpatialQuickAnswers } from '../components/spatial/CustomerSpatialQuickAnswers'
import SpatialShareSheet from '../components/spatial/customer/SpatialShareSheet'
import ScanQualityPill from '../components/spatial/customer/ScanQualityPill'
import CustomerReScanCta from '../components/spatial/customer/CustomerReScanCta'
import CaptureDsgvoConsentSheet from '../components/spatial/customer/CaptureDsgvoConsentSheet'
import { useCustomerSpatialDetail } from '../lib/spatial/hooks/useCustomerSpatialDetail'
import { useCustomerSpatialScene } from '../lib/spatial/canonical/workflow/useCustomerSpatialScene'
import { CanonicalSceneRoot } from '../components/spatial/three/canonical/CanonicalSceneRoot'
import { resolveScanAssetUrl } from '../hooks/useScanAssetUrl'
import { useSession } from '../hooks/useSession'
import { useStartCustomerLidarScan } from '../hooks/useStartCustomerLidarScan'
import { useSmartBack } from '../hooks/useSmartBack'

function formatDate(ts: number | null | undefined): string {
  if (!ts) return ''
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

function privacyHint(scan: { jobId: string | null; sharedWithProviderId: string | null }): string {
  if (scan.sharedWithProviderId) {
    return 'Direkt mit einem Handwerker geteilt — er sieht es sofort, ohne Anfrage.'
  }
  if (scan.jobId) {
    return 'An eine Anfrage gehängt — der zugehörige Handwerker kann es nach Annahme sehen.'
  }
  return 'Nur für dich sichtbar — tippe oben auf "Teilen", um es einer Anfrage anzuhängen oder direkt an einen Handwerker zu schicken.'
}

export default function CustomerSpatialDetailScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/customer/spatial/list')
  const { scanId } = useParams<{ scanId: string }>()
  const detail = useCustomerSpatialDetail(scanId ?? null)
  const { user } = useSession()
  const [glbSignedUrl, setGlbSignedUrl] = useState<string | null>(null)
  const [glbError, setGlbError] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  // Re-Scan pipeline (Phase 3 B4-D7) — mounting the hook here means the
  // Detail-Screen owns its own LiDAR-probe + consent gate, independent of
  // whatever the Hub started. RoomPlan.checkAvailability is cheap, the
  // consent flag is shared via localStorage.
  const lidar = useStartCustomerLidarScan()
  // Captures the re-scan request that paused on the consent gate so the
  // post-consent rerun fires with the same `parentScanId`. Reset on consent
  // dismissal so a later self-share doesn't re-trigger a stale rescan.
  const [pendingRescan, setPendingRescan] = useState<{ jobId: string | null; parentScanId: string } | null>(null)

  const glbAsset = useMemo(
    () => detail.assets.find(a => a.kind === 'gltf'),
    [detail.assets],
  )
  const usdzAsset = useMemo(
    () => detail.assets.find(a => a.kind === 'usdz'),
    [detail.assets],
  )

  // V1.6.1 Phase 3b · Canonical scene fallback. Customer-LiDAR Self-Scans
  // produzieren parametric.json (kein GLB). Wenn dieser Scan eine canonical
  // Scene mit gültigem Blob hat, rendert der Detail-Screen sie statt der
  // Box-Icon-Loading-State. GLB bleibt prioritär falls vorhanden (Provider-
  // generierte Scans haben beide). Direkt-Import per `useCustomerSpatialScene`
  // umgeht den spatial-workflow-barrel-session-leak.
  const canonical = useCustomerSpatialScene(scanId ?? null)
  const parametricReady = canonical.blobState === 'ready' && canonical.roomScene != null

  useEffect(() => {
    let alive = true
    const path = glbAsset?.storagePath
    const run = async () => {
      // `await Promise.resolve()` upfront pushes the no-asset reset off the
      // synchronous render path (react-hooks/set-state-in-effect).
      await Promise.resolve()
      if (!alive) return
      if (!path) {
        setGlbSignedUrl(null)
        setGlbError(null)
        return
      }
      try {
        const url = await resolveScanAssetUrl(path)
        if (!alive) return
        setGlbSignedUrl(url)
        setGlbError(null)
      } catch (err) {
        if (!alive) return
        setGlbSignedUrl(null)
        setGlbError(err instanceof Error ? err.message : String(err))
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [glbAsset?.storagePath])

  // Clear any in-flight consent-rescan handshake when the screen navigates
  // to a different scan — otherwise the consent's onConsented could fire
  // triggerRescan with stale ids belonging to the previous detail view.
  // Pushed onto the microtask queue to satisfy `react-hooks/set-state-in-effect`.
  useEffect(() => {
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      setPendingRescan(null)
      setConsentOpen(false)
    })
    return () => {
      alive = false
    }
  }, [scanId])

  const triggerRescan = useCallback(
    (jobId: string | null, parentScanId: string) => {
      void lidar.startCustomerLidarScan({
        jobId: jobId ?? undefined,
        parentScanId,
        onConsentRequired: () => {
          setPendingRescan({ jobId, parentScanId })
          setConsentOpen(true)
        },
        onSuccess: (newScanId) => {
          navigate(`/customer/spatial/scan/${newScanId}`, { replace: true })
        },
      })
    },
    [lidar, navigate],
  )

  if (!detail.isHydrated) {
    return (
      <AppShell active="profile">
        <ScreenSkeleton variant="detail" />
      </AppShell>
    )
  }

  if (!detail.scan) {
    return (
      <AppShell active="profile">
        <section className="px-4 py-6">
          <div className="mx-auto w-full max-w-[420px]">
            <button
              type="button"
              onClick={goBack}
              className="mb-4 flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
            >
              <ChevronLeft size={16} /> Zurück
            </button>
            <div className="rounded-container border border-dashed border-edge bg-slate-50 p-6 text-center">
              <div className="text-[15px] font-semibold text-ink">Aufmaß nicht verfügbar</div>
              <p className="mt-1 text-[13px] text-ink-muted">
                {detail.error ?? 'Dieses Aufmaß ist nicht mehr für dich freigegeben.'}
              </p>
            </div>
          </div>
        </section>
      </AppShell>
    )
  }

  const scan = detail.scan
  const isSelfScan = scan.ownerType === 'customer'
  const title = isSelfScan ? 'Eigenes Aufmaß' : 'Aufmaß vom Handwerker'
  const subtitle = isSelfScan
    ? `Selbst erstellt · ${formatDate(scan.createdAt)}`
    : `Freigegeben · ${formatDate(scan.sharedAt ?? scan.createdAt)}`

  return (
    <AppShell active="profile">
      <section className="px-4 pb-12 pt-5">
        <div className="mx-auto w-full max-w-[480px] space-y-5">
          {/* Header */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goBack}
              aria-label="Zurück"
              className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-slate-100"
            >
              <ChevronLeft size={20} />
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-[20px] font-semibold text-slate-900 truncate">{title}</h1>
                {/* V1.6 Phase 2 — Quality pill (TBD #5: both self + HW-shared). */}
                <ScanQualityPill scan={detail.scan} />
              </div>
              <p className="text-[12px] text-ink-muted">{subtitle}</p>
            </div>
            {isSelfScan && (
              <CustomerReScanCta
                ownerType={scan.ownerType}
                lidarAvailable={lidar.lidarAvailable}
                busy={lidar.busy}
                onConfirm={() => triggerRescan(scan.jobId, scan.id)}
              />
            )}
            {isSelfScan && (
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                aria-label="Aufmaß teilen"
                className="flex h-9 items-center gap-1.5 rounded-full bg-brand px-3 text-[13px] font-semibold text-white shadow-sm transition hover:bg-brand/90 active:scale-95"
              >
                <Share2 size={15} aria-hidden />
                Teilen
              </button>
            )}
          </div>

          {/* Quick-Answers — HW-shared scans only (Self-Scans display the
              "noch keinem Auftrag" hint inside the QuickAnswers component) */}
          <CustomerSpatialQuickAnswers jobId={scan.jobId} />

          {/* 3D-Hero · GLB-Pfad → Parametric-Fallback → Loading-Box */}
          <div className="overflow-hidden rounded-container bg-black/5 ring-1 ring-edge">
            {glbSignedUrl ? (
              <div className="h-[320px]">
                <SpatialViewer
                  gltfUrl={glbSignedUrl}
                  usdzUrl={usdzAsset?.storagePath ?? undefined}
                  mode="view"
                  chromelessMode
                  pins={detail.annotations}
                  measurements={detail.measurements}
                />
              </div>
            ) : parametricReady ? (
              <div className="relative h-[320px] bg-[#0a1525]">
                <CanonicalSceneRoot
                  scene={canonical.roomScene}
                  variants={canonical.variants}
                  overrides={canonical.overrides}
                  cameraSwitcher={false}
                  sectionControls={false}
                  className="absolute inset-0"
                />
              </div>
            ) : glbError ? (
              <div className="flex h-[260px] items-center justify-center text-[13px] text-ink-muted">
                3D-Modell konnte nicht geladen werden ({glbError}).
              </div>
            ) : (
              <div className="flex h-[260px] items-center justify-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10">
                  <Box size={24} className="text-brand" aria-hidden />
                </span>
              </div>
            )}
          </div>

          {/* Maße */}
          <div>
            <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
              Maße
            </div>
            <SpatialMeasurementTable
              measurements={detail.measurements}
              isHydrated
              editable={false}
            />
          </div>

          {/* Pins — "Hinweise vom Handwerker" (RLS already trimmed to
              customer_visible=true for the customer's session) */}
          {detail.annotations.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
                {isSelfScan ? 'Meine Notizen' : 'Hinweise vom Handwerker'}
              </div>
              <SpatialPinList
                annotations={detail.annotations}
                isHydrated
                showWorkTrade={false}
                showVisibilityIndicator={false}
              />
            </div>
          )}

          {/* Self-Scan privacy hint */}
          {isSelfScan && (
            <div className="rounded-container border border-dashed border-edge bg-slate-50 p-3 text-[12px] text-ink-muted">
              <span aria-hidden="true">🔒</span>{' '}
              <span className="ml-1">{privacyHint(scan)}</span>
            </div>
          )}
        </div>
      </section>

      {isSelfScan && user && (
        <SpatialShareSheet
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          scan={scan}
          customerUserId={user.id}
          onLinked={() => void detail.refresh()}
        />
      )}

      <CaptureDsgvoConsentSheet
        open={consentOpen}
        onConsented={() => {
          setConsentOpen(false)
          const pending = pendingRescan
          setPendingRescan(null)
          if (pending) triggerRescan(pending.jobId, pending.parentScanId)
        }}
        onCancel={() => {
          setConsentOpen(false)
          setPendingRescan(null)
        }}
      />
    </AppShell>
  )
}
