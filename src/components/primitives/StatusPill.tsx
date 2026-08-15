type StatusVariant = 'brand' | 'warn' | 'ok' | 'danger' | 'neutral'

type StatusPillProps = {
  status: StatusVariant
  label: string
  className?: string
}

const variantClasses: Record<StatusVariant, string> = {
  brand:   'bg-blue-50  text-blue-700  border-blue-200',
  warn:    'bg-amber-50 text-amber-700 border-amber-200',
  ok:      'bg-green-50 text-green-700 border-green-200',
  danger:  'bg-red-50   text-red-700   border-red-200',
  neutral: 'bg-slate-100 text-slate-600 border-slate-200',
}

/**
 * Unified status badge. One schema across the entire app.
 * No custom per-status styling outside this component.
 */
export default function StatusPill({ status, label, className = '' }: StatusPillProps) {
  return (
    <span
      className={`
        inline-flex items-center rounded-chip border px-2.5 py-0.5
        text-[12px] font-medium leading-none
        ${variantClasses[status]} ${className}
      `}
    >
      {label}
    </span>
  )
}
