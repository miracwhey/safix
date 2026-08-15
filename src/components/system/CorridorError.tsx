/**
 * CorridorError — reusable error state with recovery for corridor screens.
 *
 * Shows a calm error explanation with an optional retry button and/or
 * back-navigation escape.  Replaces ad-hoc error UIs across corridor screens
 * with a consistent pattern.
 */
import { Link } from 'react-router-dom'

type Props = {
  message?: string
  onRetry?: () => void
  retryLabel?: string
  backTo?: string
  backLabel?: string
}

export default function CorridorError({
  message = 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
  onRetry,
  retryLabel = 'Erneut versuchen',
  backTo,
  backLabel = 'Zurück',
}: Props) {
  return (
    <section className="px-4 py-6">
      <div className="mx-auto w-full max-w-[420px]">
        <div className="rounded-[28px] bg-white p-6 text-center ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
          <div className="text-[32px] leading-none">⚠️</div>

          <h2 className="mt-3 text-[18px] font-semibold text-slate-900">
            Fehler aufgetreten
          </h2>

          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">
            {message}
          </p>

          <div className="mt-5 flex items-center justify-center gap-3">
            {backTo && (
              <Link
                to={backTo}
                className="inline-flex items-center rounded-full bg-slate-100 px-4 py-2.5 text-[13px] font-semibold text-slate-700 ring-1 ring-slate-200/70 transition active:scale-[0.98]"
              >
                ← {backLabel}
              </Link>
            )}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center rounded-full bg-[#2563EB] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(37,99,235,0.55)] transition active:scale-[0.98]"
              >
                {retryLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
