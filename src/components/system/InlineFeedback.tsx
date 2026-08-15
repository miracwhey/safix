import { useEffect } from 'react'

type InlineFeedbackProps = {
  error?: string | null
  success?: string | null
  onDismiss?: () => void
  className?: string
  /** When set on a success message, auto-dismiss after this many ms. */
  autoHideDuration?: number
}

/**
 * Tiny reusable component for inline feedback messages.
 * Shows red/rose error messages or green/emerald success messages.
 */
export default function InlineFeedback({
  error,
  success,
  onDismiss,
  className,
  autoHideDuration,
}: InlineFeedbackProps) {
  useEffect(() => {
    if (success && autoHideDuration && onDismiss) {
      const t = setTimeout(onDismiss, autoHideDuration)
      return () => clearTimeout(t)
    }
  }, [success, autoHideDuration, onDismiss])
  if (error) {
    return (
      <div
        className={[
          'flex items-center justify-between gap-2 rounded-xl bg-rose-50 px-3 py-2 ring-1 ring-rose-200',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="alert"
      >
        <span className="text-[12px] text-rose-700">{error}</span>
        {onDismiss && (
          <button
            type="button"
            aria-label="Schließen"
            onClick={onDismiss}
            className="shrink-0 text-[14px] leading-none text-rose-400 hover:text-rose-600 transition-colors"
          >
            ×
          </button>
        )}
      </div>
    )
  }

  if (success) {
    return (
      <div
        className={[
          'flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 ring-1 ring-emerald-200',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="status"
      >
        <span className="text-[12px] text-emerald-700">{success}</span>
      </div>
    )
  }

  return null
}
