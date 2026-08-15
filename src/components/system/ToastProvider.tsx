/**
 * ToastProvider — lightweight transient feedback layer for corridor actions.
 *
 * Provides a global toast queue that corridor screens use to confirm
 * action outcomes.  Toasts auto-dismiss and stack calmly at the bottom
 * of the viewport above the bottom navigation.
 *
 * Usage:
 *   // In App.tsx or root layout:
 *   <ToastProvider>
 *     <App />
 *   </ToastProvider>
 *
 *   // In any component:
 *   import { useToast } from '../../hooks/useToast'
 *   const toast = useToast()
 *   toast.success('Nachricht gesendet')
 *   toast.error('Aktion fehlgeschlagen')
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ToastContext } from './toastContext'
import type { ToastAPI, ToastItem, ToastTone } from './toastTypes'

// ── Tone styles ──────────────────────────────────────────────────────────────

const TONE_STYLES: Record<ToastTone, string> = {
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-200/70',
  error: 'bg-rose-50 text-rose-800 ring-rose-200/70',
  info: 'bg-slate-50 text-slate-700 ring-slate-200/70',
}

const TONE_ICONS: Record<ToastTone, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
}

// ── Provider ─────────────────────────────────────────────────────────────────

let nextId = 0

const DEFAULT_DURATION_SUCCESS = 2500
const DEFAULT_DURATION_ERROR = 4000
const DEFAULT_DURATION_INFO = 3000
const EXIT_ANIMATION_MS = 200
const MAX_VISIBLE = 3

export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Schedule auto-dismiss for a toast
  const scheduleAutoDismiss = useCallback((id: string, duration: number) => {
    if (duration <= 0) return
    const timer = setTimeout(() => {
      // Start exit animation
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
      )
      // Remove after animation
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
        timersRef.current.delete(id)
      }, EXIT_ANIMATION_MS)
    }, duration)
    timersRef.current.set(id, timer)
  }, [])

  const push = useCallback(
    (message: string, tone: ToastTone, duration?: number) => {
      const id = `toast-${++nextId}`
      const dur =
        duration ??
        (tone === 'success'
          ? DEFAULT_DURATION_SUCCESS
          : tone === 'error'
            ? DEFAULT_DURATION_ERROR
            : DEFAULT_DURATION_INFO)

      setToasts((prev) => {
        // Cap visible toasts — remove oldest if at limit
        const next = [...prev, { id, message, tone, duration: dur, exiting: false }]
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next
      })

      scheduleAutoDismiss(id, dur)
    },
    [scheduleAutoDismiss]
  )

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    )
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, EXIT_ANIMATION_MS)
  }, [])

  const api: ToastAPI = useMemo(() => ({
    success: (msg, dur) => push(msg, 'success', dur),
    error: (msg, dur) => push(msg, 'error', dur),
    info: (msg, dur) => push(msg, 'info', dur),
    dismiss,
  }), [push, dismiss])

  // Clean up timers on unmount
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach((timer) => clearTimeout(timer))
    }
  }, [])

  return (
    <ToastContext.Provider value={api}>
      {children}

      {/* ── Toast overlay ── */}
      {toasts.length > 0 && (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-[calc(80px+env(safe-area-inset-bottom))]"
          aria-live="polite"
          aria-relevant="additions"
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={[
                'pointer-events-auto flex w-full max-w-[400px] items-center gap-2.5 rounded-[18px] px-4 py-3 ring-1 shadow-[0_12px_28px_-18px_rgba(2,6,23,0.22)] transition-all duration-200',
                TONE_STYLES[toast.tone],
                toast.exiting
                  ? 'translate-y-2 opacity-0'
                  : 'translate-y-0 opacity-100',
              ].join(' ')}
              role={toast.tone === 'error' ? 'alert' : 'status'}
            >
              <span className="shrink-0 text-[14px] font-bold leading-none">
                {TONE_ICONS[toast.tone]}
              </span>
              <span className="flex-1 text-[13px] font-medium leading-snug">
                {toast.message}
              </span>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="shrink-0 text-[14px] leading-none opacity-50 transition hover:opacity-100"
                aria-label="Schließen"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}
