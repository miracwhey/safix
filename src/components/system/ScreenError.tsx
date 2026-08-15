import { Link } from 'react-router-dom'
import CorridorAction from './CorridorAction'

type Props = {
  title?: string
  description?: string
  onRetry?: () => void
  onLogout?: () => void
  backTo?: string
  backLabel?: string
  retrying?: boolean
}

/**
 * Error-state display for corridor screens.
 *
 * Shows what went wrong and provides a recovery path (retry button and/or
 * back link). Never a dead end.
 *
 * Does NOT wrap in AppShell — the calling screen provides that.
 */
export default function ScreenError({
  title = 'Etwas ist schiefgelaufen',
  description,
  onRetry,
  onLogout,
  backTo,
  backLabel = '← Zurück',
  retrying = false,
}: Props) {
  return (
    <section className="px-4 pt-16 pb-8">
      <div className="mx-auto w-full max-w-[420px] text-center">
        <div className="flex justify-center">
          <svg className="h-10 w-10 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
        </div>
        <h2 className="mt-3 text-[18px] font-semibold text-slate-900">
          {title}
        </h2>
        {description && (
          <p className="mt-2 text-[14px] leading-relaxed text-slate-500">
            {description}
          </p>
        )}
        <div className="mt-5 flex flex-col items-center gap-3">
          {onRetry && (
            <CorridorAction variant="primary" block={false} onClick={onRetry} loading={retrying}>
              {retrying ? 'Wird geladen…' : 'Erneut versuchen'}
            </CorridorAction>
          )}
          {backTo && (
            <Link
              to={backTo}
              className="text-[13px] font-medium text-blue-600"
            >
              {backLabel}
            </Link>
          )}
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="mt-1 text-[13px] text-slate-400 hover:text-slate-600 transition"
            >
              Abmelden
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
