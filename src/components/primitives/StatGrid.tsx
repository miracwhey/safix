type StatItem = {
  label: string
  value: string | number
  sub?: string
  accent?: 'brand' | 'neutral'
}

type StatGridProps = {
  items: StatItem[]
  className?: string
}

/**
 * KPI grid. Replaces CompactDashboardStats and CraftsmanDashboardStats.
 * 2-column layout. accent='brand' renders the stat with brand color background.
 */
export default function StatGrid({ items, className = '' }: StatGridProps) {
  return (
    <div className={`grid grid-cols-2 gap-3 ${className}`}>
      {items.map((item) => {
        const isBrand = item.accent === 'brand'
        return (
          <div
            key={item.label}
            className={`rounded-card p-4 ${
              isBrand
                ? 'bg-brand shadow-subtle'
                : 'bg-surface shadow-subtle ring-1 ring-edge'
            }`}
          >
            <p
              className={`text-[11px] font-medium uppercase tracking-widest ${
                isBrand ? 'text-white/70' : 'text-ink-muted'
              }`}
            >
              {item.label}
            </p>
            <p
              className={`mt-2 text-[24px] font-bold leading-none ${
                isBrand ? 'text-white' : 'text-ink'
              }`}
            >
              {item.value}
            </p>
            {item.sub && (
              <p
                className={`mt-1.5 text-[13px] font-medium ${
                  isBrand ? 'text-white/80' : 'text-ink-sub'
                }`}
              >
                {item.sub}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
