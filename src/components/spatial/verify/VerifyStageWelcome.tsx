/**
 * Spatial · Verify · Stage 1 — Welcome (Phase 3 · Block 3.2)
 *
 * The Customer-Verify Stage-1 sanity check (Mockup 15 · Phone 1). Read-only:
 * the customer reviews the scan overview + quality score and decides "Weiter"
 * or "Skip". No EditOperation, no mutation (Implementation-Spec §Stage-1).
 *
 * Three render branches driven by the {@link VerifySceneSummary.path}:
 *   - `ok`            : green Quality-Card + element list + 3D preview.
 *   - `warnings`      : yellow warning banner + hint list, then the overview.
 *   - `unrenderable`  : red block, hint list, NO 3D preview, NO forward path.
 *
 * Pure presentation — the summary is derived by the workflow layer
 * (`deriveVerifySceneSummary`); the footer CTAs are owned by the VerifySheet
 * container. This component renders the scrollable content only.
 */

import type { ReactElement, ReactNode } from 'react'

import { QualityScoreBadge } from './QualityScoreBadge'
import type { VerifySceneSummary } from '../../../lib/spatial/workflow/verifySceneSummary'

export interface VerifyStageWelcomeProps {
  /** Stage-1 sanity-check summary from `deriveVerifySceneSummary`. */
  summary: VerifySceneSummary
  /** The 3D preview node — the canonical renderer hero. */
  preview: ReactNode
  /** Open the Quality-Detail sheet (Mockup 14) — tap-through from the badge. */
  onOpenQualityDetail?: () => void
}

export function VerifyStageWelcome({
  summary,
  preview,
  onOpenQualityDetail,
}: VerifyStageWelcomeProps): ReactElement {
  const { counts, quality, qualityLabel, path, hints } = summary

  if (path === 'unrenderable') {
    return (
      <div data-testid="verify-stage-welcome" data-path="unrenderable">
        <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em] text-slate-900">
          Der Scan ist unvollständig.
        </h2>
        <p className="mb-4 mt-1.5 text-[14px] leading-snug text-slate-500">
          Wir konnten den Raum nicht darstellen. Bitte scanne ihn noch einmal.
        </p>

        <div
          role="alert"
          className="mb-3 flex gap-2.5 rounded-xl border border-rose-600/25 bg-rose-500/10 p-3.5 text-[12px] leading-snug text-rose-900"
        >
          <span
            aria-hidden="true"
            className="grid size-[18px] shrink-0 place-items-center rounded-full bg-rose-600 text-[11px] font-extrabold text-white"
          >
            !
          </span>
          <ul className="space-y-1">
            {hints.map((h) => (
              <li key={h.code}>{h.message}</li>
            ))}
          </ul>
        </div>

        <p className="text-[12px] leading-snug text-slate-500">
          Tipp: Geht der Scan wiederholt nicht, kannst du den Raum stattdessen
          per Foto erfassen.
        </p>
      </div>
    )
  }

  return (
    <div data-testid="verify-stage-welcome" data-path={path}>
      <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em] text-slate-900">
        Wir haben deinen Raum gescannt.
      </h2>
      <p className="mb-4 mt-1.5 text-[14px] leading-snug text-slate-500">
        Schau kurz drüber. Du kannst alles ändern.
      </p>

      {path === 'warnings' && hints.length > 0 && (
        <div
          role="alert"
          data-testid="verify-warning-banner"
          className="mb-3 flex gap-2.5 rounded-xl border border-amber-600/25 bg-amber-500/10 p-3.5 text-[12px] leading-snug text-slate-700"
        >
          <span
            aria-hidden="true"
            className="grid size-[18px] shrink-0 place-items-center rounded-full bg-amber-600 text-[11px] font-extrabold text-white"
          >
            !
          </span>
          <div>
            <p className="mb-1 font-semibold text-slate-900">
              {hints.length === 1 ? '1 Hinweis' : `${hints.length} Hinweise`}
            </p>
            <ul className="space-y-1">
              {hints.map((h) => (
                <li key={h.code}>{h.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="mb-3.5 overflow-hidden rounded-[18px] bg-slate-900 shadow-[0_8px_24px_rgba(10,15,28,0.15)]">
        {preview}
      </div>

      <QualityScoreBadge
        quality={quality}
        label={qualityLabel}
        onOpenDetail={onOpenQualityDetail}
      />

      <ul className="mt-3 space-y-1.5" data-testid="verify-scene-counts">
        <CountRow label="Wände" value={counts.walls} />
        <CountRow label="Türen" value={counts.doors} />
        <CountRow label="Fenster" value={counts.windows} />
        <CountRow label="Objekte" value={counts.objects} />
      </ul>
    </div>
  )
}

function CountRow({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <li className="flex items-center justify-between rounded-[10px] bg-slate-900/[0.03] px-3 py-2.5 text-[13px]">
      <span className="font-medium text-slate-500">{label}</span>
      <span className="font-bold text-slate-900" data-testid={`count-${label}`}>
        {value}
      </span>
    </li>
  )
}
