import { Link } from 'react-router-dom'
import type { OperatorIssueGroup } from '../../lib/operators/operatorIssueGroups'

type Props = {
  groups: OperatorIssueGroup[]
}

/**
 * Compact operator issue summary bar.
 *
 * Shows issue categories as actionable cards. Each card shows the issue count
 * with severity indicators and links directly to the relevant action surface.
 *
 * Used at the top of the OperatorDashboardScreen to let operators immediately
 * see which category requires the most urgent attention.
 */
export default function OperatorIssueSummaryBar({ groups }: Props) {
  if (groups.length === 0) return null

  return (
    <div className="grid grid-cols-2 gap-2">
      {groups.map((group) => {
        const isUrgent = group.criticalCount > 0 || group.highCount > 0
        return (
          <Link
            key={group.categoryId}
            to={group.actionRoute}
            className={`relative overflow-hidden rounded-[20px] p-3.5 ring-1 shadow-[0_8px_20px_-16px_rgba(2,6,23,0.22)] transition active:scale-[0.97] ${
              group.criticalCount > 0
                ? 'bg-rose-50 ring-rose-200/80'
                : group.highCount > 0
                  ? 'bg-orange-50 ring-orange-200/70'
                  : 'bg-white ring-slate-200/70'
            }`}
          >
            {/* Accent bar */}
            <div
              className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[20px] ${
                group.criticalCount > 0
                  ? 'bg-gradient-to-b from-rose-500 via-rose-400 to-rose-300'
                  : group.highCount > 0
                    ? 'bg-gradient-to-b from-orange-500 via-orange-400 to-orange-300'
                    : 'bg-gradient-to-b from-slate-400 via-slate-300 to-slate-200'
              }`}
            />

            <div className="flex items-center gap-2">
              <span className="text-[18px] leading-none">{group.icon}</span>
              <span
                className={`text-[11px] font-semibold ${
                  group.criticalCount > 0
                    ? 'text-rose-700'
                    : group.highCount > 0
                      ? 'text-orange-700'
                      : 'text-slate-600'
                }`}
              >
                {group.label}
              </span>
            </div>

            <div className="mt-2 flex items-end justify-between">
              <span
                className={`text-[24px] font-extrabold leading-none ${
                  group.criticalCount > 0
                    ? 'text-rose-600'
                    : group.highCount > 0
                      ? 'text-orange-600'
                      : 'text-slate-700'
                }`}
              >
                {group.totalCount}
              </span>

              {isUrgent && (
                <span
                  className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-wider ring-1 ${
                    group.criticalCount > 0
                      ? 'bg-rose-100 text-rose-700 ring-rose-200'
                      : 'bg-orange-100 text-orange-700 ring-orange-200'
                  }`}
                >
                  {group.criticalCount > 0 ? `${group.criticalCount} KRITISCH` : `${group.highCount} HOCH`}
                </span>
              )}
            </div>

            <div
              className={`mt-1 text-[10px] font-medium ${
                group.criticalCount > 0
                  ? 'text-rose-500'
                  : group.highCount > 0
                    ? 'text-orange-500'
                    : 'text-slate-400'
              }`}
            >
              Öffnen →
            </div>
          </Link>
        )
      })}
    </div>
  )
}
