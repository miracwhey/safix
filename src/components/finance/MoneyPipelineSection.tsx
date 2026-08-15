import type { CraftsmanPayoutSummary } from '../../lib/payout'
import { formatEuro } from '../../lib/shared/formatters'
import ContentSection from '../primitives/ContentSection'

type PipelineStageProps = {
  label: string
  subtitle: string
  amount: number
  tag: string
  colorClasses: string // e.g. "bg-blue-50 text-blue-700"
  tagClasses: string   // e.g. "bg-blue-100 text-blue-600"
  isLast: boolean
}

function PipelineStage({
  label,
  subtitle,
  amount,
  tag,
  colorClasses,
  tagClasses,
  isLast,
}: PipelineStageProps) {
  return (
    <>
      <div className={`rounded-card p-3.5 ${colorClasses}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold leading-snug">{label}</p>
            <p className="mt-0.5 text-[12px] opacity-70">{subtitle}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-[16px] font-bold">{formatEuro(amount)}</span>
            <span
              className={`rounded-chip px-1.5 py-0.5 text-[10px] font-semibold ${tagClasses}`}
            >
              {tag}
            </span>
          </div>
        </div>
      </div>
      {!isLast && (
        <div className="flex justify-center py-1">
          <div className="h-4 w-0.5 bg-slate-200" />
        </div>
      )}
    </>
  )
}

type MoneyPipelineSectionProps = {
  summary: CraftsmanPayoutSummary
}

type StageConfig = {
  key: string
  label: string
  subtitle: string
  amount: number
  tag: string
  colorClasses: string
  tagClasses: string
}

export default function MoneyPipelineSection({ summary }: MoneyPipelineSectionProps) {
  const stages: StageConfig[] = []

  if (summary.inEscrowNetEstimated > 0) {
    stages.push({
      key: 'escrow',
      label: 'In Zahlung',
      subtitle: 'Kunde hat bezahlt, Arbeit läuft',
      amount: summary.inEscrowNetEstimated,
      tag: 'ca.',
      colorClasses: 'bg-blue-50 text-blue-700',
      tagClasses: 'bg-blue-100 text-blue-600',
    })
  }

  if (summary.releasePendingNetEstimated > 0) {
    stages.push({
      key: 'pending',
      label: 'Freigabe ausstehend',
      subtitle: 'Arbeit abgeschlossen, Kunde prüft',
      amount: summary.releasePendingNetEstimated,
      tag: 'ca.',
      colorClasses: 'bg-amber-50 text-amber-700',
      tagClasses: 'bg-amber-100 text-amber-600',
    })
  }

  if (summary.supplementaryAwaitingRelease > 0) {
    stages.push({
      key: 'supp-awaiting',
      label: 'Nachtrag bezahlt',
      subtitle: 'Auszahlung wird vorbereitet',
      amount: summary.supplementaryAwaitingRelease,
      tag: 'ca.',
      colorClasses: 'bg-teal-50 text-teal-700',
      tagClasses: 'bg-teal-100 text-teal-600',
    })
  }

  const totalEligible = summary.releasedPayoutEligible + summary.supplementaryReleased
  if (totalEligible > 0) {
    stages.push({
      key: 'eligible',
      label: 'Auszahlbar',
      subtitle: 'Bereit für dein Konto',
      amount: totalEligible,
      tag: 'Bestätigt',
      colorClasses: 'bg-emerald-50 text-emerald-700',
      tagClasses: 'bg-emerald-100 text-emerald-600',
    })
  }

  if (summary.releasedPayoutBlocked > 0) {
    stages.push({
      key: 'blocked',
      label: 'Blockiert',
      subtitle: 'Konto-Einrichtung nötig',
      amount: summary.releasedPayoutBlocked,
      tag: 'Gesperrt',
      colorClasses: 'bg-rose-50 text-rose-700',
      tagClasses: 'bg-rose-100 text-rose-600',
    })
  }

  // Payout failed / transfer reversed (MoneyFlowProjection outcome truth) —
  // kept separate from "Auszahlbar" so it is never shown as on its way.
  if (summary.releasedPayoutReversedFailed > 0) {
    stages.push({
      key: 'reversed',
      label: 'In Klärung',
      subtitle: 'Auszahlung wird geprüft',
      amount: summary.releasedPayoutReversedFailed,
      tag: 'Klärung',
      colorClasses: 'bg-amber-50 text-amber-700',
      tagClasses: 'bg-amber-100 text-amber-600',
    })
  }

  if (summary.disputedGross > 0) {
    stages.push({
      key: 'disputed',
      label: 'Einbehalten',
      subtitle: 'Konflikt in Bearbeitung',
      amount: summary.disputedGross,
      tag: 'Gehalten',
      colorClasses: 'bg-orange-50 text-orange-700',
      tagClasses: 'bg-orange-100 text-orange-600',
    })
  }

  if (stages.length === 0) return null

  return (
    <ContentSection eyebrow="Pipeline" title="Geldfluss">
      <div>
        {stages.map((stage, i) => (
          <PipelineStage
            key={stage.key}
            label={stage.label}
            subtitle={stage.subtitle}
            amount={stage.amount}
            tag={stage.tag}
            colorClasses={stage.colorClasses}
            tagClasses={stage.tagClasses}
            isLast={i === stages.length - 1}
          />
        ))}
      </div>
    </ContentSection>
  )
}
