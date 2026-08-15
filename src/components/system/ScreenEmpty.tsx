import { MessageSquare } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'

type Props = {
  /** Icon displayed above the title. Pass a Lucide component or any ReactNode. */
  icon?: ReactNode
  title: string
  description?: string
  /** Optional CTA — provide `to` for a Link or `onClick` for a button. */
  action?: { label: string; to?: string; onClick?: () => void }
}

/**
 * Empty-state display for corridor screens when a list or entity set is empty.
 *
 * Visually distinct from loading skeletons: shows a clear icon, title, and
 * optional guidance + CTA so users know the screen is not broken.
 *
 * Does NOT wrap in AppShell — the calling screen provides that.
 */
export default function ScreenEmpty({
  icon = <MessageSquare size={32} className="text-ink-muted" aria-hidden />,
  title,
  description,
  action,
}: Props) {
  return (
    <section className="px-4 pt-16 pb-8">
      <div className="mx-auto w-full max-w-[420px] text-center">
        <div className="flex justify-center">{icon}</div>
        <h2 className="mt-3 text-[18px] font-semibold text-slate-900">
          {title}
        </h2>
        {description && (
          <p className="mt-2 text-[14px] leading-relaxed text-slate-500">
            {description}
          </p>
        )}
        {action && (
          <div className="mt-5">
            {action.to ? (
              <Link
                to={action.to}
                className="text-[13px] font-medium text-blue-600"
              >
                {action.label}
              </Link>
            ) : action.onClick ? (
              <button
                type="button"
                onClick={action.onClick}
                className="text-[13px] font-medium text-blue-600"
              >
                {action.label}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}
