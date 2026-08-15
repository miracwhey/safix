import {
  EXECUTION_STATUS_CONFIG,
  type ExecutionStatus,
} from '../../lib/jobs/executionSelectors'

type Props = {
  status: ExecutionStatus
  /** When true, renders as a compact dot + text inline (default: false → full pill) */
  compact?: boolean
}

export default function ExecutionStatusBadge({ status, compact }: Props) {
  const config = EXECUTION_STATUS_CONFIG[status]

  if (compact) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${config.dot}`}
        />
        <span className="text-[12px] font-semibold text-slate-600">
          {config.label}
        </span>
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${config.badge}`}
    >
      <span className="leading-none">{config.icon}</span>
      {config.label}
    </span>
  )
}
