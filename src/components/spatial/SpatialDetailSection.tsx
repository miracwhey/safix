/**
 * Spatial Core · Block E3 · Detail-Screen Spatial Section
 *
 * Single section consumed by `CraftsmanJobDetailScreen` +
 * `CustomerProjectDetailScreen`. Renders the full Spatial surface in one
 * collapsible block:
 *
 *   - Viewer (E2 web) with section-cut + asset signed-URL resolve
 *   - Quality card (Block C)
 *   - Pin list (Block E3)
 *   - Measurement table (Block E3 read; F edits)
 *   - Download + Convert buttons (Block E3)
 *
 * The component is layer-pure — all business decisions (verify, edit, etc.)
 * stay in `src/lib/spatial/workflow/*`. This file orchestrates rendering
 * and dispatches user-intent up to the parent screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ScreenSkeleton from '../system/ScreenSkeleton'
import { useToast } from '../../hooks/useToast'
import { useSpatialScan } from '../../hooks/useSpatialScan'
import { useScanQualityReport } from '../../hooks/useScanQualityReport'
import { useScanConvertStatus } from '../../hooks/useScanConvertStatus'
import { useSpatialAnnotations } from '../../hooks/useSpatialAnnotations'
import { useSpatialMeasurements } from '../../hooks/useSpatialMeasurements'
import { useScanAssetUrl } from '../../hooks/useScanAssetUrl'
import { useSession } from '../../hooks/useSession'
import { SpatialViewer } from './SpatialViewer'
import { SpatialQualityCard } from './SpatialQualityCard'
import { SpatialMeasurementTable } from './SpatialMeasurementTable'
import { SpatialPinList, type PinVisibilityFilter } from './SpatialPinList'
import { setPinCustomerVisible } from '../../lib/spatial/workflow/pinWorkflow'
import { SpatialAssetDownloadButtons } from './SpatialAssetDownloadButtons'
import { PinDetailSheet } from './pin/PinDetailSheet'
import { ConfidenceSummaryBanner } from './pin/PinConfidenceBadge'
import { SpatialQuickLookButton } from './SpatialQuickLookButton'
import { SpatialEmptyState } from './SpatialEmptyState'
import { ScanCoachingOverlay } from './coaching/ScanCoachingOverlay'
import { RescanCTA } from './diff/RescanCTA'
import { DownloadCenter } from './download/DownloadCenter'
import {
  SectionCutController,
  DEFAULT_SECTION_CUT_STATE,
  type SectionCutState,
} from './SectionCutController'
import type { AnchorUv, ScanAnnotation } from '../../lib/spatial/types'

export type SpatialRole = 'customer' | 'craftsman' | 'worker' | 'operator'

export interface SpatialDetailSectionProps {
  scope: { jobId: string; projectId?: undefined } | { projectId: string; jobId?: undefined }
  role: SpatialRole
  /** Callback for "Raum scannen" empty-state CTA — parent triggers
   *  `RoomPlan.startScan()` + `captureScan()` workflow. */
  onStartScan?: () => void
  /** Callback for pin edit / measurement edit — parent opens BottomSheet
   *  (Block F wires the actual sheet). */
  onEditPin?: (annotationId: string) => void
  onEditMeasurement?: (measurementId: string) => void
}

export function SpatialDetailSection(props: SpatialDetailSectionProps) {
  const { scan, assets, isHydrated: scanHydrated, error: scanError, refresh: refreshScan } =
    useSpatialScan(props.scope)
  const scanId = scan?.id ?? null
  const { report, isHydrated: qualityHydrated, rerun: rerunQuality } =
    useScanQualityReport(scanId)
  const {
    hasUsdz,
    hasGltf,
    isHydrated: convertHydrated,
    refresh: refreshConvert,
    assets: convertAssets,
  } = useScanConvertStatus(scanId)
  const { annotations, isHydrated: pinsHydrated, refresh: refreshAnnotations } =
    useSpatialAnnotations(scanId, { subscribe: true })
  const { measurements, isHydrated: measurementsHydrated } = useSpatialMeasurements(scanId, {
    subscribe: true,
  })
  const usdzAsset = useMemo(() => assets.find(a => a.kind === 'usdz'), [assets])
  const gltfAsset = useMemo(() => assets.find(a => a.kind === 'gltf'), [assets])
  const { url: gltfUrl, isHydrated: gltfUrlHydrated } = useScanAssetUrl(
    gltfAsset?.storagePath ?? null,
  )
  const { url: usdzUrl } = useScanAssetUrl(usdzAsset?.storagePath ?? null)

  const [selectedPinId, setSelectedPinId] = useState<string | null>(null)
  const [pinVisibilityFilter, setPinVisibilityFilter] = useState<PinVisibilityFilter>('all')
  const [sectionCut, setSectionCut] = useState<SectionCutState>(DEFAULT_SECTION_CUT_STATE)
  const session = useSession()
  const sessionUserId = session.user?.id ?? null
  const toast = useToast()
  const previouslyHadGltfRef = useRef<boolean | null>(null)

  // Block G.2 — toast on the false → true transition of hasGltf. The first
  // hydration write (null → false or null → true) is intentionally silent;
  // we only want to greet the user after a fresh convert lands.
  //
  // Hard-review post-#926 fix H1: gate the entire effect on `convertHydrated`
  // so the ref seeds from the first POST-hydration read, not the first
  // pre-hydration render. Previous code seeded with the unhydrated `false`,
  // then the async asset load flipped to `true` → spurious
  // "3D-Modell ist bereit" toast on every reload of a project that already
  // had a model. Now the toast fires only on a real false→true transition
  // observed AFTER hydration.
  useEffect(() => {
    if (!convertHydrated) return
    if (previouslyHadGltfRef.current === null) {
      previouslyHadGltfRef.current = hasGltf
      return
    }
    if (!previouslyHadGltfRef.current && hasGltf) {
      toast.success('Dein 3D-Modell ist bereit.')
    }
    previouslyHadGltfRef.current = hasGltf
  }, [convertHydrated, hasGltf, toast])

  interface PinSheetState {
    open: boolean
    annotation: ScanAnnotation | null
    placement: {
      scanId: string
      anchorUv: AnchorUv | null
      worldXyz?: { x: number; y: number; z: number } | null
    } | null
  }
  const [pinSheet, setPinSheet] = useState<PinSheetState>({
    open: false,
    annotation: null,
    placement: null,
  })

  const closePinSheet = useCallback(() => {
    setPinSheet({ open: false, annotation: null, placement: null })
  }, [])

  const openEditPin = useCallback(
    (annotationId: string) => {
      setSelectedPinId(annotationId)
      const annotation = annotations.find(a => a.id === annotationId) ?? null
      setPinSheet({ open: true, annotation, placement: null })
      props.onEditPin?.(annotationId)
    },
    [annotations, props],
  )

  const openCreatePin = useCallback(
    (input: {
      surfaceExternalId: string
      uv: [number, number]
      worldXyz?: { x: number; y: number; z: number }
    }) => {
      if (!scanId) return
      const anchorUv: AnchorUv = {
        surfaceExternalId: input.surfaceExternalId,
        uv: input.uv,
      }
      setPinSheet({
        open: true,
        annotation: null,
        placement: {
          scanId,
          anchorUv,
          worldXyz: input.worldXyz ?? null,
        },
      })
    },
    [scanId],
  )

  const confidenceCounts = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0, lost: 0 }
    for (const a of annotations) counts[a.confidence] += 1
    return counts
  }, [annotations])

  // Loading state — wait for the scan hydration before showing anything else.
  if (!scanHydrated) {
    return (
      <section aria-label="3D-Aufmaß" className="mt-6">
        <ScreenSkeleton variant="detail" eyebrow="Aufmaß lädt" lines={3} />
      </section>
    )
  }

  if (scanError) {
    return (
      <section aria-label="3D-Aufmaß" className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
        Aufmaß konnte nicht geladen werden: {scanError.message}
        <button
          type="button"
          onClick={refreshScan}
          className="ml-2 underline"
        >
          erneut versuchen
        </button>
      </section>
    )
  }

  // Empty-state — no scan yet.
  if (!scan) {
    return (
      <section aria-label="3D-Aufmaß" className="mt-6 space-y-4">
        <h2 className="text-base font-semibold text-neutral-900">3D-Aufmaß</h2>
        <SpatialEmptyState
          onPrimaryCta={props.onStartScan}
          hideCta={props.role === 'customer'}
        />
        {props.role === 'craftsman' || props.role === 'operator' ? (
          <ScanCoachingOverlay />
        ) : null}
      </section>
    )
  }

  // Hydrated, but the convert pipeline hasn't produced a glb yet — the
  // viewer needs glb to render; show a placeholder + the convert CTA.
  const showViewer = Boolean(gltfUrl && gltfUrlHydrated)
  const showWorkTrade = props.role !== 'customer'
  const editableMeasurements = props.role === 'craftsman' || props.role === 'operator'
  const isCustomerScope = props.role === 'customer'

  return (
    <section aria-label="3D-Aufmaß" className="mt-6 space-y-4">
      <div className="flex items-start justify-between">
        <h2 className="text-base font-semibold text-neutral-900">3D-Aufmaß</h2>
        <span className="text-[11px] text-neutral-500">
          Scan {scan.id.slice(0, 8)} · Status {scan.status}
        </span>
      </div>

      {showViewer && gltfUrl ? (
        <>
          <SpatialViewer
            gltfUrl={gltfUrl}
            usdzUrl={usdzUrl ?? undefined}
            mode={props.role === 'craftsman' ? 'edit' : 'view'}
            pins={annotations}
            measurements={measurements}
            selectedPinId={selectedPinId}
            onPinSelected={openEditPin}
            onPinPlaced={openCreatePin}
            sectionEnabled={true}
            sectionCut={sectionCut}
          />
          <SectionCutController value={sectionCut} onChange={setSectionCut} />
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-500">
          Webansicht noch nicht erzeugt. Lade den USDZ-Scan herunter oder
          starte die Konvertierung unten.
        </div>
      )}

      <ConfidenceSummaryBanner
        counts={confidenceCounts}
        onStartSweep={
          props.role === 'craftsman' || props.role === 'operator'
            ? () => {
                const first = annotations.find(a => a.confidence !== 'high')
                if (first) openEditPin(first.id)
              }
            : undefined
        }
      />

      <SpatialQualityCard
        report={report}
        isHydrated={qualityHydrated}
        onRerun={rerunQuality}
        showRerun={props.role === 'craftsman' || props.role === 'operator'}
      />

      {showWorkTrade && pinsHydrated && annotations.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Pins
          </span>
          {(
            [
              { key: 'all', label: 'Alle' },
              { key: 'visible', label: 'Sichtbar' },
              { key: 'private', label: 'Privat' },
            ] as const
          ).map(opt => {
            const active = pinVisibilityFilter === opt.key
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => setPinVisibilityFilter(opt.key)}
                aria-pressed={active}
                className={
                  'rounded-full px-3 py-1 text-xs font-medium transition ' +
                  (active
                    ? 'bg-neutral-900 text-white'
                    : 'border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100')
                }
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      ) : null}

      <SpatialPinList
        annotations={annotations}
        isHydrated={pinsHydrated}
        selectedId={selectedPinId}
        onSelect={openEditPin}
        showWorkTrade={showWorkTrade}
        filter={showWorkTrade ? pinVisibilityFilter : 'all'}
        showVisibilityIndicator={showWorkTrade}
        onToggleVisibility={
          showWorkTrade && scanId
            ? async (annotationId, next) => {
                try {
                  await setPinCustomerVisible({
                    scanId,
                    annotationId,
                    customerVisible: next,
                  })
                  await refreshAnnotations()
                  toast.success(
                    next
                      ? 'Pin ist jetzt für die Kundin sichtbar.'
                      : 'Pin ist jetzt privat.',
                  )
                } catch (err) {
                  toast.error(
                    'Sichtbarkeit ändern fehlgeschlagen: '
                      + (err instanceof Error ? err.message : 'unbekannter Fehler'),
                  )
                }
              }
            : undefined
        }
      />

      <SpatialMeasurementTable
        measurements={measurements}
        isHydrated={measurementsHydrated}
        editable={editableMeasurements}
        onEdit={props.onEditMeasurement}
      />

      <RescanCTA measurements={measurements} onStartScan={props.onStartScan} />

      <div className="flex flex-wrap items-center gap-3">
        <SpatialAssetDownloadButtons
          scanId={scan.id}
          assets={convertAssets.length > 0 ? convertAssets : assets}
          hasUsdz={hasUsdz}
          hasGltf={hasGltf}
          isHydrated={scanHydrated}
          onConvertEnqueued={refreshConvert}
          showConvert={!isCustomerScope}
        />
        <SpatialQuickLookButton usdzStoragePath={usdzAsset?.storagePath ?? null} />
      </div>

      <DownloadCenter scanId={scan.id} enabled={!isCustomerScope} />

      {sessionUserId && (props.role === 'craftsman' || props.role === 'operator') ? (
        <PinDetailSheet
          open={pinSheet.open}
          onClose={closePinSheet}
          annotation={pinSheet.annotation}
          placement={pinSheet.placement}
          userId={sessionUserId}
          scanId={scan.id}
          onChanged={refreshAnnotations}
        />
      ) : null}
    </section>
  )
}
