import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useKeyboardInset } from '../../hooks/useKeyboardInset'

type Props = {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  /** Maximum width on desktop. Default 420px (mobile-first sheet width). */
  maxWidth?: number
  /** Hide the drag handle at the top. Default false. */
  hideHandle?: boolean
  /** Additional class names for the sheet container. */
  className?: string
  children: React.ReactNode
}

/**
 * BottomSheet — minimal slide-from-bottom sheet wrapper.
 *
 * Pattern follows existing SaFix sheets (UpgradeSheet, InvoiceCorrectionSheet):
 * fixed backdrop with blur, slide from bottom, safe-area-aware bottom padding,
 * drag handle, max-w-[420px]. Renders nothing when `open` is false.
 *
 * Use for confirm dialogs, picker sheets, and any inline-action follow-up
 * that should not pull the user out of the current screen context.
 *
 * Closes on:
 * - Backdrop click
 * - Escape key
 * - explicit `onClose` from children
 *
 * Form-state guards (discard-confirm) are caller responsibility — sheet does
 * not intercept close. This will be revisited when bestand-Sheets migrate
 * to this wrapper (separate block).
 */
export default function BottomSheet(props: Props) {
  // Early-return the whole component when closed so the open-only sheet body
  // (and its keyboard rig) mounts/unmounts with `open`. Keeping the keyboard
  // listeners off while closed matters because many screens render
  // `<BottomSheet open={false}>` permanently; an always-on hook would register
  // document listeners and hold the global keyboard rig for every one of them.
  if (!props.open) return null
  return <OpenBottomSheet {...props} />
}

function OpenBottomSheet({
  onClose,
  title,
  description,
  maxWidth = 420,
  hideHandle = false,
  className = '',
  children,
}: Props) {
  // Lift the sheet above the on-screen keyboard when any input inside it is
  // focused (shared chat keyboard rig). The `data-kb-pinned-composer` marker on
  // the sheet container flips the native resize mode to `none` while focused, so
  // the JS-driven `--keyboard-height` offset is the sole lift (no double
  // compensation with iOS body-resize). Mirrors ReportUserSheet / SaveToFolderSheet.
  useKeyboardInset()

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Portal to document.body so the fixed overlay escapes any scrolled/
  // transformed ancestor (AppShell's `100dvh` scroll container, immersive
  // feeds). Without this, iOS WKWebView traps `position:fixed` under the
  // transformed ancestor and the sheet renders clipped / mispositioned.
  // Mirrors ProjectPickerSheet / SaveToFolderSheet. This wrapper has 21
  // consumers, so the portal + dvh + keyboard fix lands across all of them at once.
  const sheet = (
    <div
      className="animate-sheet-backdrop-fade fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
      // Inset the whole `items-end` stack by the live keyboard height so the
      // sheet rides the top of the keyboard instead of hiding behind it.
      style={{ paddingBottom: 'var(--keyboard-height, 0px)' }}
    >
      <div
        // max-h-[85dvh] + overflow-y-auto: prevents the sheet from sliding
        // under the iOS keyboard when an input is focused. Long Pin-Editor
        // contents (Photo + Voice + Note + 4 buttons) on an iPhone SE were
        // previously unreachable below the keyboard. `dvh` (not `vh`) tracks
        // the iOS dynamic viewport so the cap never overestimates height.
        data-kb-pinned-composer
        className={`animate-sheet-slide-up flex w-full max-h-[85dvh] flex-col overflow-y-auto overscroll-contain rounded-t-[24px] bg-white px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-5 shadow-[0_-8px_30px_rgba(0,0,0,0.12)] ${className}`}
        style={{ maxWidth: `${maxWidth}px` }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'bottom-sheet-title' : undefined}
        aria-describedby={description ? 'bottom-sheet-description' : undefined}
      >
        {!hideHandle && (
          <div
            className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-200"
            aria-hidden="true"
          />
        )}

        {title !== undefined && (
          <h2
            id="bottom-sheet-title"
            className="text-[17px] font-semibold text-slate-900"
          >
            {title}
          </h2>
        )}

        {description !== undefined && (
          <p
            id="bottom-sheet-description"
            className="mt-1 text-[13px] text-slate-500"
          >
            {description}
          </p>
        )}

        {children}
      </div>
    </div>
  )
  // SSR / non-DOM render contexts (e.g. node-env unit tests via renderToString)
  // have no document — render inline there; portal only in a real DOM.
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body)
}
