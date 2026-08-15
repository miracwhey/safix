/**
 * Spatial Core · Block G.4 · iOS AR Quick Look CTA
 *
 * One-tap "Im Raum zeigen" button that hands the USDZ off to iOS AR
 * Quick Look via Capacitor's Browser plugin. The web-origin caveat from
 * the chat-attachment-share helper applies here too: the URL we open
 * must be a real https:// origin so iOS AR Quick Look accepts the .usdz
 * MIME and switches into AR mode (capacitor:// crashes the system AR
 * viewer silently).
 *
 * Web + Android: button is rendered but disabled with an explanatory
 * tooltip — those platforms get the glTF download from
 * SpatialAssetDownloadButtons instead.
 */

import { useCallback, useState } from 'react'
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import { Scan } from 'lucide-react'
import { useToast } from '../../hooks/useToast'
import { resolveScanAssetUrl } from '../../hooks/useScanAssetUrl'

export interface SpatialQuickLookButtonProps {
  /** Storage path of the scan's USDZ asset. */
  usdzStoragePath: string | null
  className?: string
  /**
   * Compact icon-only variant for tight surfaces like the Provider-3D-Tab
   * bottom toolbar (V-13). Default `false` keeps the original text+emoji
   * button used by the Customer Spatial Detail surface.
   */
  iconOnly?: boolean
}

export function SpatialQuickLookButton(props: SpatialQuickLookButtonProps) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const platform = Capacitor.getPlatform()
  const supported = platform === 'ios'

  const onOpen = useCallback(async () => {
    if (!props.usdzStoragePath || !supported || busy) return
    setBusy(true)
    try {
      const url = await resolveScanAssetUrl(props.usdzStoragePath)
      // Browser.open uses SFSafariViewController on iOS which automatically
      // hands .usdz responses to the system AR Quick Look viewer.
      await Browser.open({ url })
    } catch (err) {
      toast.error(`AR-Vorschau fehlgeschlagen: ${err instanceof Error ? err.message : 'unbekannt'}`)
    } finally {
      setBusy(false)
    }
  }, [props.usdzStoragePath, supported, busy, toast])

  const disabled = !supported || !props.usdzStoragePath || busy
  const title = supported ? 'In AR ansehen' : 'Nur auf iPhone / iPad verfügbar'

  if (props.iconOnly) {
    return (
      <button
        type="button"
        onClick={() => void onOpen()}
        disabled={disabled}
        title={title}
        aria-label={busy ? 'AR wird geöffnet' : 'In AR ansehen'}
        className={
          'inline-flex h-9 w-9 items-center justify-center rounded-[11px] border border-edge bg-surface text-ink-sub shadow-subtle transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ' +
          (props.className ?? '')
        }
      >
        <Scan size={16} aria-hidden="true" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => void onOpen()}
      disabled={disabled}
      title={title}
      className={
        'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ' +
        (supported
          ? 'bg-neutral-900 text-white hover:bg-neutral-700'
          : 'bg-neutral-200 text-neutral-500') +
        ' ' +
        (props.className ?? '')
      }
    >
      <span aria-hidden="true">📐</span>
      {busy ? 'Wird geöffnet…' : 'In AR ansehen'}
    </button>
  )
}
