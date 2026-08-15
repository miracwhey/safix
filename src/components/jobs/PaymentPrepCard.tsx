import { useState } from 'react'
import { getJobById, subscribeJobs, derivePaymentPrepReadiness } from '../../lib/jobs'
import type { PaymentPrepViewModel } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments } from '../../lib/payments'
import { prepareDepositCardWorkflow, markDepositPaidForJobWorkflow } from '../../lib/workflow'
import CorridorAction from '../system/CorridorAction'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  jobId: string
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

const PHASE_STYLES = {
  missing_amount: {
    badge: 'bg-rose-50 text-rose-700 ring-rose-100',
    dot: 'bg-rose-500',
    icon: '⚠',
    border: 'ring-slate-200/70',
  },
  ready_to_confirm: {
    badge: 'bg-amber-50 text-amber-700 ring-amber-100',
    dot: 'bg-amber-400',
    icon: '💳',
    border: 'ring-slate-200/70',
  },
  deposit_initialized: {
    badge: 'bg-blue-50 text-blue-700 ring-blue-100',
    dot: 'bg-blue-400',
    icon: '💳',
    border: 'ring-blue-100',
  },
  deposit_confirmed: {
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    dot: 'bg-emerald-400',
    icon: '✅',
    border: 'ring-emerald-100',
  },
} as const

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function AmountRow({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-[13px] text-slate-500">{label}</span>
      <span
        className={[
          'text-[14px] font-semibold tabular-nums',
          highlight ? 'text-slate-900' : 'text-slate-700',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}

function PaymentPrepCardView({
  vm,
  onConfirmSetup,
  onMarkDepositReceived,
}: {
  vm: PaymentPrepViewModel
  onConfirmSetup: () => void
  onMarkDepositReceived: () => void
}) {
  const style = PHASE_STYLES[vm.phase]

  return (
    <section
      className={[
        'rounded-[28px] bg-white p-5 ring-1 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]',
        style.border,
      ].join(' ')}
    >
      {/* Header */}
      <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Zahlungsvorbereitung
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <h2 className="text-[22px] font-semibold text-slate-900">
          Zahlung einrichten
        </h2>
        <span
          className={[
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1',
            style.badge,
          ].join(' ')}
        >
          <span className={['h-1.5 w-1.5 rounded-full', style.dot].join(' ')} />
          {vm.phaseLabel}
        </span>
      </div>

      <p className="mt-2 text-[14px] text-slate-500">{vm.phaseDescription}</p>

      {/* Acceptance timestamp */}
      <div className="mt-3 rounded-[12px] bg-emerald-50 px-3 py-2.5 ring-1 ring-emerald-100">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600 mb-0.5">
          Angebot angenommen
        </div>
        <div className="text-[13px] text-slate-600">{vm.acceptedLabel}</div>
      </div>

      {/* Amount breakdown — shown when amount is known */}
      {vm.agreedAmount !== null && (
        <div className="mt-4 divide-y divide-slate-100">
          <AmountRow
            label={`Gesamtbetrag (vereinbart)`}
            value={vm.agreedAmountFormatted ?? '—'}
            highlight
          />
          <AmountRow
            label={`Freigabe bei Arbeitsbeginn (${vm.depositPercent} %)`}
            value={vm.depositAmountFormatted ?? '—'}
          />
          <AmountRow
            label="Freigabe bei Fertigstellung"
            value={vm.finalAmountFormatted ?? '—'}
          />
        </div>
      )}

      {/* Missing amount callout */}
      {vm.phase === 'missing_amount' && (
        <div className="mt-4 rounded-[14px] bg-rose-50 px-3.5 py-3 ring-1 ring-rose-100">
          <div className="text-[12px] font-semibold text-rose-700 mb-1">
            {style.icon} Kein Betrag hinterlegt
          </div>
          <div className="text-[13px] text-slate-500">
            Im Angebotsentwurf weiter oben einen Betrag eintragen, um die
            Zahlungskarte vorzubereiten.
          </div>
        </div>
      )}

      {/* Confirm setup CTA */}
      {vm.canConfirmSetup && (
        <button
          type="button"
          onClick={onConfirmSetup}
          className="mt-4 w-full rounded-2xl bg-blue-600 px-4 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-blue-700 active:bg-blue-800"
        >
          💳 Zahlungskarte initialisieren
        </button>
      )}

      {/* Deposit initialized state */}
      {vm.phase === 'deposit_initialized' && (
        <div className="mt-4 rounded-[14px] bg-blue-50 px-3.5 py-3 ring-1 ring-blue-100">
          <div className="text-[12px] font-semibold text-blue-700 mb-1">
            💳 Zahlungskarte bereit
          </div>
          <div className="text-[13px] text-slate-500">
            Die Zahlungskarte ist mit dem vereinbarten Betrag eingerichtet.
            Zahlung durch den Kunden steht noch aus.
          </div>
        </div>
      )}

      {/* Mark deposit received CTA */}
      {vm.canMarkDepositReceived && (
        <CorridorAction
          variant="primary"
          onClick={onMarkDepositReceived}
          className="mt-3"
        >
          ✓ Einzahlung als bestätigt markieren
        </CorridorAction>
      )}

      {/* Deposit confirmed state */}
      {vm.phase === 'deposit_confirmed' && (
        <div className="mt-4 rounded-[14px] bg-emerald-50 px-3.5 py-3 ring-1 ring-emerald-100">
          <div className="text-[12px] font-semibold text-emerald-700 mb-1">
            ✅ Zahlung bestätigt
          </div>
          <div className="text-[13px] text-slate-500">
            Die Einzahlung ist bestätigt. Der Betrag ist über Stripe abgesichert.
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/**
 * Craftsman-facing deposit/payment preparation card shown after proposal
 * acceptance.
 *
 * Derives a `PaymentPrepViewModel` from the job and its associated payment,
 * then renders:
 * - The agreed amount and deposit breakdown (25 % / 75 %)
 * - A "Zahlungskarte initialisieren" CTA when the payment needs to be confirmed
 *   with the agreed amount (`prepareDepositCardWorkflow`)
 * - A "Anzahlung als eingegangen markieren" CTA once the card is initialized
 *   (`markDepositPaidForJobWorkflow`)
 *
 * Returns null when the job has no accepted proposal.
 */
export default function PaymentPrepCard({ jobId }: Props) {
  function buildVm(): PaymentPrepViewModel | null {
    const job = getJobById(jobId)
    if (!job) return null
    const payment = getPaymentForJob(jobId)
    return derivePaymentPrepReadiness(job, payment)
  }

  const [vm, setVm] = useState<PaymentPrepViewModel | null>(buildVm)

  useStoreSync([subscribeJobs, subscribePayments], () => {
    setVm(buildVm())
  })

  const handleConfirmSetup = () => {
    void prepareDepositCardWorkflow(jobId).then(() => setVm(buildVm()))
  }

  const handleMarkDepositReceived = () => {
    void markDepositPaidForJobWorkflow(jobId).then(() => setVm(buildVm()))
  }

  if (!vm) return null

  return (
    <PaymentPrepCardView
      vm={vm}
      onConfirmSetup={handleConfirmSetup}
      onMarkDepositReceived={handleMarkDepositReceived}
    />
  )
}
