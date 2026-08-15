/**
 * Payment-Prozess · Variante A — Phasen-Stepper (Loading-Patterns handoff).
 *
 * The trust-defining money loader: escrow funding runs 5–15 s and the user
 * must not navigate away. Calm and legible, NEVER springy — a completed phase
 * gets a check that fades in without overshoot (no bounce on money).
 *
 * Purely presentational. The caller maps its own payment state machine onto
 * `phase`; this component owns no business logic.
 *
 *   phase 0  nothing started (all idle)
 *   phase 1  preparing payment data   (step 1 active)
 *   phase 2  processing payment        (step 1 done, step 2 active)
 *   phase 3  confirmation pending      (steps 1–2 done, step 3 active)
 *   phase 4  secured                   (all done)
 *
 * Motion is transform/opacity only; the active-node arc uses the shared
 * `.fx-spin`, the check uses `.animate-fx-check-pop` (calm). reduced-motion
 * is handled globally in index.css.
 */

type Props = {
  phase: 0 | 1 | 2 | 3 | 4
  /** Override the three step labels if the surface needs different wording. */
  steps?: [string, string, string]
  className?: string
}

const DEFAULT_STEPS: [string, string, string] = [
  'Zahlungsdaten vorbereiten',
  'Zahlung verarbeiten',
  'Bestätigung ausstehend',
]

type NodeState = 'idle' | 'active' | 'done'

function nodeState(phase: number, index1: number): NodeState {
  if (phase > index1) return 'done'
  if (phase === index1) return 'active'
  return 'idle'
}

function CheckNode() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-600">
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fff"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-fx-check-pop"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}

function ActiveNode() {
  return (
    <span className="inline-flex text-brand" aria-label="läuft">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="block">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2.8} opacity={0.2} />
        <path
          d="M12 3a9 9 0 0 1 9 9"
          stroke="currentColor"
          strokeWidth={2.8}
          strokeLinecap="round"
          className="fx-spin"
          style={{ ['--spin-dur' as string]: '0.9s' }}
        />
      </svg>
    </span>
  )
}

function IdleNode() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 ring-1 ring-slate-200">
      <span className="h-[7px] w-[7px] rounded-full bg-slate-300" />
    </span>
  )
}

function StepNode({ state }: { state: NodeState }) {
  if (state === 'done') return <CheckNode />
  if (state === 'active') return <ActiveNode />
  return <IdleNode />
}

export default function PaymentProcessStepper({ phase, steps = DEFAULT_STEPS, className }: Props) {
  return (
    <div
      className={`rounded-[22px] bg-white p-6 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ${className ?? ''}`}
      role="status"
      aria-label="Zahlung wird verarbeitet"
    >
      {steps.map((label, i) => {
        const index1 = i + 1
        const state = nodeState(phase, index1)
        const isLast = i === steps.length - 1
        const connectorDone = phase > index1
        return (
          <div key={label} className="flex gap-3.5">
            <div className="flex flex-col items-center justify-center">
              <StepNode state={state} />
              {!isLast && (
                <span
                  className={`my-1 w-0.5 flex-1 ${connectorDone ? 'bg-green-600' : 'bg-slate-200'}`}
                  style={{ minHeight: 26 }}
                />
              )}
            </div>
            <div className={isLast ? 'pt-1' : 'pt-1 pb-5'}>
              <div
                className={`text-[14.5px] font-semibold tracking-[-0.01em] ${
                  state === 'idle' ? 'text-slate-400' : 'text-ink'
                }`}
              >
                {label}
              </div>
            </div>
          </div>
        )
      })}

      <div className="mt-4 flex items-center gap-2 border-t border-slate-200/70 pt-4">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        <span className="text-[12px] font-semibold text-green-600">über Stripe abgesichert</span>
      </div>
    </div>
  )
}
