/**
 * Spatial · Verify · VerifyStagePlaceholder (Phase 3 · Block 3.1)
 *
 * A declared placeholder slot for a verify sub-stage not yet built. After
 * Block 3.1-3.7 the only remaining placeholdered stage is Confirm (5); the
 * slot also stands in for any stage when the scene has not loaded. It renders
 * the stage headline + a "kommt gleich" panel so the VerifySheet shell, the
 * 5-segment step-bar, and the next/prev navigation stay exercisable.
 *
 * Intentionally inert — no edit, no scene access, no DB. Replacing it is a
 * pure swap inside `VerifySheet` (the `stage === Confirm` branch · Block 3.8).
 */

import type { ReactElement } from 'react'

import {
  VERIFY_STAGE_LABEL,
  type VerifyStage,
} from '../../../lib/spatial/workflow/spatialVerifyWorkflow'

export interface VerifyStagePlaceholderProps {
  /** The sub-stage this slot stands in for. */
  stage: VerifyStage
  /** Optional extra note (e.g. a reason the stage cannot run yet). */
  note?: string
}

/** German one-liner describing each not-yet-built stage. */
const STAGE_BLURB: Partial<Record<VerifyStage, string>> = {
  3: 'Wände verschieben, hinzufügen oder löschen.',
  4: 'Markiere, was kaputt ist oder neu soll.',
  5: 'Übersicht aller Änderungen und absenden.',
}

export function VerifyStagePlaceholder({
  stage,
  note,
}: VerifyStagePlaceholderProps): ReactElement {
  return (
    <div
      data-testid="verify-stage-placeholder"
      data-stage={stage}
      className="flex flex-col items-center py-10 text-center"
    >
      <h2 className="text-[22px] font-extrabold tracking-[-0.01em] text-slate-900">
        {VERIFY_STAGE_LABEL[stage]}
      </h2>
      <p className="mt-1.5 max-w-[260px] text-[14px] leading-snug text-slate-500">
        {note ?? STAGE_BLURB[stage] ?? 'Dieser Schritt wird gerade gebaut.'}
      </p>
      <span className="mt-4 rounded-full bg-slate-900/[0.05] px-3 py-1 text-[11px] font-semibold uppercase tracking-[1px] text-slate-400">
        Kommt gleich
      </span>
    </div>
  )
}
