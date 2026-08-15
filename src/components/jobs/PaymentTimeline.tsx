import type { PaymentState } from '../../lib/payments/types'

type StepStatus = 'completed' | 'current' | 'pending'

type Step = {
  id: PaymentState
  label: string
  isBranch?: boolean
}

const mainSteps: Step[] = [
  { id: 'deposit_required', label: 'Einzahlung angefordert' },
  { id: 'deposit_paid', label: 'Einzahlung bestätigt' },
  { id: 'in_escrow', label: 'Im Stripe-Absicherung gesichert' },
  { id: 'work_in_progress', label: 'Arbeit läuft' },
  { id: 'release_pending', label: 'Freigabe vorbereitet' },
  { id: 'released', label: 'An Auszahlungskonto übergeben' },
]

const branchSteps: Step[] = [
  { id: 'disputed', label: 'Konflikt eröffnet', isBranch: true },
  { id: 'refunded', label: 'Zahlung erstattet', isBranch: true },
]

function getMainStepIndex(state: PaymentState): number {
  return mainSteps.findIndex((s) => s.id === state)
}

function getStepStatus(stepIndex: number, currentIndex: number): StepStatus {
  if (stepIndex < currentIndex) return 'completed'
  if (stepIndex === currentIndex) return 'current'
  return 'pending'
}

function resolveStepStatus(
  index: number,
  currentMainIndex: number,
  isBranchState: boolean
): StepStatus {
  if (isBranchState && index === currentMainIndex) return 'completed'
  return getStepStatus(index, currentMainIndex)
}

type StepDotProps = {
  status: StepStatus
  isBranch?: boolean
}

function StepDot({ status, isBranch }: StepDotProps) {
  if (status === 'completed') {
    return (
      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-600">
        <svg
          className="h-3 w-3 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    )
  }

  if (status === 'current' && isBranch) {
    return (
      <div className="h-5 w-5 flex-shrink-0 rounded-full bg-amber-500 ring-2 ring-amber-200" />
    )
  }

  if (status === 'current') {
    return (
      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 ring-2 ring-blue-200">
        <div className="h-2 w-2 rounded-full bg-white" />
      </div>
    )
  }

  return <div className="h-5 w-5 flex-shrink-0 rounded-full bg-slate-200" />
}

type Props = {
  state: PaymentState
}

export default function PaymentTimeline({ state }: Props) {
  const isDisputed = state === 'disputed'
  const isRefunded = state === 'refunded'
  const isBranchState = isDisputed || isRefunded

  const currentMainIndex = isBranchState
    ? mainSteps.findIndex((s) => s.id === 'release_pending')
    : getMainStepIndex(state)

  const visibleMainSteps = isBranchState
    ? mainSteps.filter((_, i) => i <= currentMainIndex)
    : mainSteps

  const branchStep = isBranchState
    ? branchSteps.find((s) => s.id === state)
    : undefined

  return (
    <div className="space-y-2">
      {visibleMainSteps.map((step, index) => {
        const resolvedStatus = resolveStepStatus(index, currentMainIndex, isBranchState)

        return (
          <div key={step.id} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <StepDot status={resolvedStatus} />
              {(index < visibleMainSteps.length - 1 || branchStep) && (
                <div
                  className={[
                    'mt-1 h-3 w-px',
                    index < currentMainIndex || isBranchState
                      ? 'bg-blue-200'
                      : 'bg-slate-200',
                  ].join(' ')}
                />
              )}
            </div>
            <div
              className={[
                'pb-1 pt-0.5 text-[13px] leading-snug',
                resolvedStatus === 'pending'
                  ? 'text-slate-400'
                  : 'font-medium text-slate-800',
              ].join(' ')}
            >
              {step.label}
            </div>
          </div>
        )
      })}

      {branchStep && (
        <div className="flex items-start gap-3">
          <div className="flex flex-col items-center">
            <StepDot status="current" isBranch />
          </div>
          <div
            className={[
              'pb-1 pt-0.5 text-[13px] leading-snug font-medium',
              isDisputed ? 'text-amber-700' : 'text-rose-700',
            ].join(' ')}
          >
            {branchStep.label}
          </div>
        </div>
      )}
    </div>
  )
}
