import type { MarketplaceMetrics } from '../../lib/analytics'

type MetricItem = {
  label: string
  value: string
  icon: string
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`
}

function formatRating(rating: number): string {
  if (rating === 0) return '–'
  return rating.toFixed(1)
}

function buildMetricItems(metrics: MarketplaceMetrics): MetricItem[] {
  return [
    { label: 'Aufträge erstellt', value: String(metrics.jobsCreated), icon: '📋' },
    { label: 'Aufträge abgeschlossen', value: String(metrics.jobsCompleted), icon: '✅' },
    { label: 'Abschlussrate', value: formatRate(metrics.completionRate), icon: '📊' },
    { label: 'Angebote gesendet', value: String(metrics.proposalsSent), icon: '📨' },
    { label: 'Angebote angenommen', value: String(metrics.proposalsAccepted), icon: '🤝' },
    { label: 'Bewertungen', value: String(metrics.ratingsSubmitted), icon: '⭐' },
    { label: 'Ø Bewertung', value: formatRating(metrics.averageRating), icon: '🏆' },
    { label: 'Zahlungen erstellt', value: String(metrics.paymentsCreated), icon: '💳' },
    { label: 'Zahlungen freigegeben', value: String(metrics.paymentsReleased), icon: '💰' },
    { label: 'Erstattungen', value: String(metrics.paymentsRefunded), icon: '↩️' },
  ]
}

function buildSupplyMetricItems(metrics: MarketplaceMetrics): MetricItem[] {
  return [
    { label: 'Onboarding abgeschlossen', value: String(metrics.onboardingCompleted), icon: '🎓' },
    { label: 'Discovery-bereit', value: String(metrics.providersDiscoveryReady), icon: '🔍' },
    { label: 'Auszahlung bereit', value: String(metrics.payoutReady), icon: '🏦' },
  ]
}

export default function MarketplaceMetricsPanel({
  metrics,
  periodLabel,
}: {
  metrics: MarketplaceMetrics
  periodLabel: string
}) {
  const items = buildMetricItems(metrics)
  const supplyItems = buildSupplyMetricItems(metrics)

  return (
    <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_12px_28px_-20px_rgba(2,6,23,0.15)]">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-slate-900">
          📈 Marktplatz-Metriken
        </h3>
        <span className="text-[11px] font-medium text-slate-400">
          {periodLabel}
        </span>
      </div>

      {/* Demand-side metrics */}
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
        Nachfrage
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex flex-col items-center rounded-[16px] bg-slate-50 px-3 py-3 ring-1 ring-slate-100"
          >
            <span className="text-[16px] leading-none">{item.icon}</span>
            <span className="mt-1.5 text-[18px] font-bold text-slate-900">
              {item.value}
            </span>
            <span className="mt-0.5 text-center text-[10px] font-medium leading-tight text-slate-500">
              {item.label}
            </span>
          </div>
        ))}
      </div>

      {/* Supply-side metrics */}
      <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
        Angebot
      </div>
      <div className="grid grid-cols-3 gap-3">
        {supplyItems.map((item) => (
          <div
            key={item.label}
            className="flex flex-col items-center rounded-[16px] bg-emerald-50 px-3 py-3 ring-1 ring-emerald-100"
          >
            <span className="text-[16px] leading-none">{item.icon}</span>
            <span className="mt-1.5 text-[18px] font-bold text-emerald-900">
              {item.value}
            </span>
            <span className="mt-0.5 text-center text-[10px] font-medium leading-tight text-emerald-600">
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
