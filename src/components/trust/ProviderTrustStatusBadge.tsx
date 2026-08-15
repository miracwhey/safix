import type { ProviderTrustStatus, ProviderTrustFlag } from '../../lib/trust/trustTypes'

type Props = {
  status: ProviderTrustStatus
  flags?: ProviderTrustFlag[]
  compact?: boolean
}

type StatusStyle = {
  container: string
  icon: string
  label: string
}

function getStatusStyle(status: ProviderTrustStatus): StatusStyle {
  switch (status) {
    case 'trusted':
      return {
        container: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
        icon: '✅',
        label: 'Vertrauenswürdig',
      }
    case 'watch':
      return {
        container: 'bg-amber-50 text-amber-700 ring-amber-200',
        icon: '⚠️',
        label: 'Beobachten',
      }
    case 'restricted':
      return {
        container: 'bg-rose-50 text-rose-700 ring-rose-200',
        icon: '🚫',
        label: 'Eingeschränkt',
      }
  }
}

/**
 * Compact trust status badge for use in provider cards and lists.
 * When `flags` are provided and compact is false, shows a detailed flag list.
 */
export default function ProviderTrustStatusBadge({ status, flags, compact = true }: Props) {
  const style = getStatusStyle(status)

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${style.container}`}
      >
        <span>{style.icon}</span>
        <span>{style.label}</span>
      </span>
    )
  }

  return (
    <div className="space-y-2">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${style.container}`}
      >
        <span>{style.icon}</span>
        <span>{style.label}</span>
      </span>

      {flags && flags.length > 0 && (
        <ul className="space-y-1">
          {flags.map((flag) => (
            <li
              key={flag.kind}
              className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200"
            >
              <span className="mt-0.5 text-[13px]">
                {flag.severity === 'high' ? '🔴' : flag.severity === 'medium' ? '🟡' : '⚪'}
              </span>
              <span className="text-[12px] leading-snug text-slate-700">{flag.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
