/**
 * Spatial · Edit · MaterialUndoToast (Mockup 42 State C)
 *
 * Bottom-centered Liquid-Glass toast shown after a material is applied. Auto-
 * dismisses after 8 s; "Rückgängig" reverts the variant-write. Only one toast
 * is visible at a time — re-applying replaces it (the host remounts this with
 * a fresh `key`).
 *
 * The auto-dismiss timer is keyed only on `visible`/`materialName`; the
 * `onDismiss` callback is read through a ref so an unrelated parent re-render
 * cannot restart the 8 s countdown.
 */

import { useEffect, useRef } from 'react'

export interface MaterialUndoToastProps {
  visible: boolean
  /** Display name of the just-applied material. */
  materialName: string
  onUndo: () => void
  onDismiss: () => void
}

const AUTO_DISMISS_MS = 8000

export function MaterialUndoToast({ visible, materialName, onUndo, onDismiss }: MaterialUndoToastProps) {
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  })

  useEffect(() => {
    if (!visible) return
    const handle = setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(handle)
  }, [visible, materialName])

  if (!visible) return null

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[max(20px,env(safe-area-inset-bottom))] z-[60] flex justify-center px-4"
    >
      <div
        className="pointer-events-auto flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-white shadow-[0_8px_30px_rgba(0,0,0,0.32)]"
        style={{
          background: 'rgba(15,18,28,0.82)',
          backdropFilter: 'blur(28px) saturate(165%)',
          WebkitBackdropFilter: 'blur(28px) saturate(165%)',
        }}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500">
          <svg viewBox="0 0 20 20" className="size-3" fill="currentColor">
            <path d="M8.143 14.6 3.5 9.957l1.414-1.414 3.229 3.228 6.943-6.942 1.414 1.414z" />
          </svg>
        </span>
        <span className="text-[13px] font-medium">
          <span className="font-semibold">{materialName}</span> angewendet
        </span>
        <button
          type="button"
          onClick={onUndo}
          aria-label="Material-Änderung rückgängig machen"
          className="ml-1 shrink-0 rounded-lg px-2 py-1 text-[13px] font-semibold text-blue-300 active:scale-95 hover:text-blue-200"
        >
          Rückgängig
        </button>
      </div>
    </div>
  )
}
