/**
 * Spatial · Verify · VerifyStepBar (Phase 3 · Block 3.1)
 *
 * The 5-segment progress indicator at the top of the VerifySheet (Mockup 15
 * `step-bar`). One `step-dot` per sub-stage: `done` (teal) for completed
 * stages, `active` (accent) for the current one, neutral for upcoming. A
 * `N/5 · {label}` text line follows the segments.
 *
 * Pure presentation — the active stage + label come from the workflow stage
 * model; this component never decides navigation.
 */

import type { ReactElement } from 'react'

import {
  VERIFY_STAGES,
  VERIFY_STAGE_COUNT,
  VERIFY_STAGE_LABEL,
  type VerifyStage,
} from '../../../lib/spatial/workflow/spatialVerifyWorkflow'

export interface VerifyStepBarProps {
  /** The current sub-stage. */
  stage: VerifyStage
}

export function VerifyStepBar({ stage }: VerifyStepBarProps): ReactElement {
  return (
    <div
      className="flex items-center gap-1.5 border-b border-slate-900/[0.06] px-5 pb-3.5 pt-2.5"
      data-testid="verify-step-bar"
    >
      {VERIFY_STAGES.map((s) => {
        const state = s < stage ? 'done' : s === stage ? 'active' : 'upcoming'
        return (
          <span
            key={s}
            data-testid={`verify-step-dot-${s}`}
            data-state={state}
            aria-hidden="true"
            className={[
              'h-1 flex-1 rounded-full transition-colors',
              state === 'done'
                ? 'bg-teal-700'
                : state === 'active'
                  ? 'bg-orange-500 shadow-[0_0_8px_rgba(217,119,87,0.4)]'
                  : 'bg-slate-900/10',
            ].join(' ')}
          />
        )
      })}
      <span className="ml-2 whitespace-nowrap text-[11px] font-semibold tracking-[0.5px] text-slate-500">
        <strong className="text-slate-900">{stage}</strong>
        {`/${VERIFY_STAGE_COUNT} · ${VERIFY_STAGE_LABEL[stage]}`}
      </span>
    </div>
  )
}
