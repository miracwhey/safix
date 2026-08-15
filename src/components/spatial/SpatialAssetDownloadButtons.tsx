/**
 * Spatial Core · Block E3 · Asset Download + Convert Buttons
 *
 * Three CTAs for a captured scan:
 *
 *   1. USDZ Download — opens the signed URL in a new tab; iOS Safari
 *      auto-triggers AR Quick Look from a .usdz response.
 *   2. glTF Download — opens the signed glb (Block X output). Disabled
 *      until `convertStatus.hasGltf` is true, with a "Webansicht erzeugen"
 *      CTA next to it.
 *   3. Convert CTA — manual trigger for the `spatial-enqueue-convert`
 *      Edge Function. Default flow per user decision: autoConvert OFF,
 *      craftsman explicitly opts in to generate the web preview (~60 s).
 *
 * PDF + Floorplan-SVG are disabled stubs — Block I lights them up.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToast } from '../../hooks/useToast'
import { resolveScanAssetUrl } from '../../hooks/useScanAssetUrl'
import { enqueueConvertJob } from '../../lib/spatial/workflow/enqueueConvert'
import type { ScanAsset } from '../../lib/spatial/types'

const CONVERT_BUSY_TIMEOUT_MS = 90_000
const CONVERT_TICK_MS = 5_000

export interface SpatialAssetDownloadButtonsProps {
  scanId: string
  assets: ScanAsset[]
  hasUsdz: boolean
  hasGltf: boolean
  isHydrated: boolean
  /** Optional refresh hook from `useScanConvertStatus` so the buttons can
   *  re-hydrate immediately after the manual convert kicks off. */
  onConvertEnqueued?: () => void
  /** Hide the convert CTA for customer surfaces. */
  showConvert?: boolean
}

export function SpatialAssetDownloadButtons(props: SpatialAssetDownloadButtonsProps) {
  const toast = useToast()
  // convertEnqueuedAt is the only piece of state; convertBusy is derived
  // from it + `props.hasGltf` + a 5-second tick that keeps the safety-
  // timeout decision reactive even if no other prop changes. This is the
  // setState-free shape that satisfies the react-hooks lint rule.
  const [convertEnqueuedAt, setConvertEnqueuedAt] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const usdz = props.assets.find(a => a.kind === 'usdz') ?? null
  const gltf = props.assets.find(a => a.kind === 'gltf') ?? null
  const showConvert = props.showConvert ?? true

  useEffect(() => {
    if (convertEnqueuedAt == null) return
    const id = setInterval(() => setTick(t => t + 1), CONVERT_TICK_MS)
    return () => clearInterval(id)
  }, [convertEnqueuedAt])

  const convertBusy = useMemo(() => {
    if (convertEnqueuedAt == null) return false
    if (props.hasGltf) return false
    if (Date.now() - convertEnqueuedAt >= CONVERT_BUSY_TIMEOUT_MS) return false
    return true
    // `tick` participates in the dep array so the 90 s timeout flips the
    // button back without needing a manual setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convertEnqueuedAt, props.hasGltf, tick])

  const onDownloadUsdz = useCallback(async () => {
    if (!usdz) return
    try {
      const url = await resolveScanAssetUrl(usdz.storagePath)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast.error(`Download fehlgeschlagen: ${err instanceof Error ? err.message : 'unbekannt'}`)
    }
  }, [usdz, toast])

  const onDownloadGltf = useCallback(async () => {
    if (!gltf) return
    try {
      const url = await resolveScanAssetUrl(gltf.storagePath)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast.error(`Download fehlgeschlagen: ${err instanceof Error ? err.message : 'unbekannt'}`)
    }
  }, [gltf, toast])

  const onConvert = useCallback(async () => {
    if (!usdz || convertBusy) return
    setConvertEnqueuedAt(Date.now())
    try {
      await enqueueConvertJob({ scanId: props.scanId, usdzPath: usdz.storagePath })
      toast.info('Webansicht wird erzeugt – dauert ca. 60 Sekunden.')
      props.onConvertEnqueued?.()
    } catch (err) {
      setConvertEnqueuedAt(null)
      toast.error(
        `Konvertierung konnte nicht gestartet werden: ${
          err instanceof Error ? err.message : 'unbekannt'
        }`,
      )
    }
  }, [usdz, convertBusy, props, toast])

  if (!props.isHydrated) {
    return (
      <div
        className="h-12 animate-pulse rounded-lg bg-neutral-100"
        aria-busy="true"
      />
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <ActionButton
          disabled={!props.hasUsdz}
          onClick={onDownloadUsdz}
          variant="primary"
        >
          USDZ herunterladen
        </ActionButton>
        <ActionButton
          disabled={!props.hasGltf}
          onClick={onDownloadGltf}
          variant="secondary"
        >
          glTF herunterladen
        </ActionButton>
        {showConvert ? (
          <ActionButton
            disabled={!props.hasUsdz || props.hasGltf || convertBusy}
            onClick={onConvert}
            variant="ghost"
          >
            {convertBusy
              ? 'Konvertierung läuft…'
              : props.hasGltf
                ? 'Webansicht erzeugt'
                : 'Webansicht erzeugen'}
          </ActionButton>
        ) : null}
      </div>
      {/* Block I lights up the PDF + SVG + JSON via the dedicated
          <DownloadCenter> — see SpatialDetailSection. */}
    </div>
  )
}

interface ActionButtonProps {
  disabled: boolean
  onClick: () => void
  variant: 'primary' | 'secondary' | 'ghost'
  children: React.ReactNode
}

function ActionButton(props: ActionButtonProps) {
  const base =
    'rounded-md px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50'
  const variants: Record<ActionButtonProps['variant'], string> = {
    primary:
      'bg-emerald-600 text-white hover:bg-emerald-700 disabled:hover:bg-emerald-600',
    secondary:
      'border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50',
    ghost:
      'text-neutral-600 hover:text-neutral-900',
  }
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`${base} ${variants[props.variant]}`}
    >
      {props.children}
    </button>
  )
}
