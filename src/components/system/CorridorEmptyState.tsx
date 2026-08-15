/**
 * CorridorEmptyState — intentional empty-state card for corridor screens.
 *
 * Renders a calm, purposeful explanation of why a list or section is empty.
 * Optionally provides a primary CTA so the user can resolve the empty state.
 *
 * Matches the CraftsmanSectionCard design vocabulary: rounded-[28px],
 * standard ring/shadow, centered layout.
 */
import { Link } from 'react-router-dom'

type Props = {
  icon: string
  title: string
  subtitle?: string
  action?: {
    label: string
    to?: string
    onClick?: () => void
  }
}

export default function CorridorEmptyState({
  icon,
  title,
  subtitle,
  action,
}: Props) {
  return (
    <div className="rounded-[28px] bg-white p-6 text-center ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="text-[32px] leading-none">{icon}</div>

      <h3 className="mt-3 text-[16px] font-semibold text-slate-900">
        {title}
      </h3>

      {subtitle && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">
          {subtitle}
        </p>
      )}

      {action && (
        <div className="mt-4">
          {action.to ? (
            <Link
              to={action.to}
              className="inline-flex items-center rounded-full bg-[#2563EB] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(37,99,235,0.55)] transition active:scale-[0.98]"
            >
              {action.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={action.onClick}
              className="inline-flex items-center rounded-full bg-[#2563EB] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(37,99,235,0.55)] transition active:scale-[0.98]"
            >
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
