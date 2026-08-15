import { Link } from 'react-router-dom'
import { type LucideIcon } from 'lucide-react'
import Icon from './Icon'

type NavigationCardProps = {
  to: string
  icon: LucideIcon
  title: string
  subtitle?: string
  badge?: string | number
}

/**
 * Tappable navigation tile. Replaces CraftsmanModuleCard and BackofficeEntryCard.
 * Use for: quick-access grids, backoffice module lists.
 */
export default function NavigationCard({ to, icon, title, subtitle, badge }: NavigationCardProps) {
  return (
    <Link
      to={to}
      className="
        flex items-center gap-3 rounded-card bg-surface p-3.5 shadow-subtle
        ring-1 ring-edge
        transition-transform duration-150 active:scale-[0.97]
      "
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-slate-100 text-ink-sub">
        <Icon icon={icon} size="md" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold text-ink">{title}</p>
        {subtitle && (
          <p className="mt-0.5 text-[12px] font-medium text-ink-muted">{subtitle}</p>
        )}
      </div>
      {badge !== undefined && (
        <span className="shrink-0 rounded-chip bg-brand px-2 py-0.5 text-[11px] font-semibold text-white">
          {badge}
        </span>
      )}
    </Link>
  )
}
