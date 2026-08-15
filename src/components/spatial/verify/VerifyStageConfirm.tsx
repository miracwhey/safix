/**
 * Spatial · Verify · Stage 5 — Confirm + Senden (Phase 3 · Block 3.8)
 *
 * The Customer-Verify Stage-5 confirm + submit (Mockup 15 · Phone 5). Read-only
 * overview of EVERY change the customer made across Stages 2-4 (measurement
 * corrections, layout edits, wish-pins), then two terminal actions:
 *
 *   - "Provider anfragen"  → FSM-flip `base_ready → inquiry_ready` + start
 *     provider-discovery (the workflow-layer concern, wired in `VerifySheet`).
 *   - "Erstmal speichern"  → the scene stays `base_ready`; the verify is still
 *     marked `approved` (durchlaufen, aber nicht angefragt).
 *
 * Both land `customer_verify_state` on `approved` (Implementation-Spec §5.1).
 *
 * ── Confirm-mechanik (Implementation-Spec §2.1) ─────────────────────────────
 * "Provider anfragen" surfaces a short inline confirm — NO hard-press, NO
 * multi-step. The customer taps the accent CTA, an inline confirm panel
 * appears, and a second tap commits. "Erstmal speichern" commits directly
 * (a save is non-destructive — no confirm needed).
 *
 * ── Multi-click safety (binding · SaFix core-flow rule) ─────────────────────
 * A `busy` flag + the parent's idempotent submit handlers guarantee no double-
 * submit: the moment either action is tapped both CTAs disable until the async
 * submit settles. A double-tapped "Provider anfragen" cannot fire the FSM-flip
 * twice; a double-tapped "Erstmal speichern" cannot write `approved` twice.
 *
 * Pure presentation + local view-state (the confirm-panel toggle + the busy
 * flag). The change-summary is derived by the workflow layer
 * (`deriveVerifyChangeSummary`); submit is delegated to the `on*` callbacks.
 * This component constructs NO command and makes NO DB call directly.
 */

import { useCallback, useState, type ReactElement, type ReactNode } from 'react'

import type {
  VerifyChangeSummary,
} from '../../../lib/spatial/workflow/verifyChangeSummary'
import {
  measurementSummaryLine,
  layoutSummaryLine,
  pinSummaryLine,
} from '../../../lib/spatial/workflow/verifyChangeSummary'

/** Which Stage-5 action a submit handler is reporting on. */
export type VerifySubmitAction = 'inquiry' | 'save'

/** Outcome of a Stage-5 submit — surfaced for toast handling. */
export interface VerifySubmitOutcome {
  ok: boolean
  /** German line for the toast (success copy or failure hint). */
  message: string
}

export interface VerifyStageConfirmProps {
  /** The change overview from `deriveVerifyChangeSummary`. */
  summary: VerifyChangeSummary
  /** The 3D preview node — the canonical renderer hero (16/9 on Stage 5). */
  preview: ReactNode
  /**
   * "Provider anfragen" — flips the scene to `inquiry_ready`, starts provider-
   * discovery, marks the verify `approved`. Must be idempotent (multi-click).
   */
  onRequestProvider: () => Promise<VerifySubmitOutcome>
  /**
   * "Erstmal speichern" — keeps the scene `base_ready`, marks the verify
   * `approved`. Must be idempotent (multi-click).
   */
  onSaveOnly: () => Promise<VerifySubmitOutcome>
}

export function VerifyStageConfirm({
  summary,
  preview,
  onRequestProvider,
  onSaveOnly,
}: VerifyStageConfirmProps): ReactElement {
  // The short inline confirm for "Provider anfragen" (Implementation-Spec §2.1
  // — kein Hard-Press, kein Multi-Step). `false` = primary CTA shown.
  const [confirmingInquiry, setConfirmingInquiry] = useState(false)
  // Disables BOTH CTAs the moment either submit starts — the multi-click guard.
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  const measurementLine = measurementSummaryLine(summary)
  const layoutLine = layoutSummaryLine(summary)
  const pinLine = pinSummaryLine(summary)

  const handleSubmit = useCallback(
    async (run: () => Promise<VerifySubmitOutcome>) => {
      if (busy) return
      setBusy(true)
      setFeedback(null)
      try {
        const outcome = await run()
        setFeedback({ ok: outcome.ok, text: outcome.message })
        // A failed submit re-enables the CTAs so the customer can retry; a
        // successful one leaves them disabled — the verify is done.
        if (!outcome.ok) setBusy(false)
      } catch {
        setFeedback({ ok: false, text: 'Senden nicht möglich — bitte erneut versuchen.' })
        setBusy(false)
      }
    },
    [busy],
  )

  const handleRequestProvider = useCallback(() => {
    void handleSubmit(onRequestProvider)
  }, [handleSubmit, onRequestProvider])

  const handleSaveOnly = useCallback(() => {
    void handleSubmit(onSaveOnly)
  }, [handleSubmit, onSaveOnly])

  return (
    <div data-testid="verify-stage-confirm">
      <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em] text-slate-900">
        Fertig! Schick es ab.
      </h2>
      <p className="mb-4 mt-1.5 text-[14px] leading-snug text-slate-500">
        Provider sehen alles und machen passende Angebote.
      </p>

      <div className="mb-3.5 overflow-hidden rounded-[18px] bg-slate-900 shadow-[0_8px_24px_rgba(10,15,28,0.15)]">
        {preview}
      </div>

      {/* Change overview — the three buckets (Mockup 15 · Phone 5). */}
      <div
        className="mb-3 rounded-[14px] bg-slate-900/[0.04] p-3.5"
        data-testid="verify-confirm-summary"
      >
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[1px] text-slate-400">
          {summary.isEmpty ? 'Dein Scan' : 'Du hast hinzugefügt'}
        </p>

        {summary.isEmpty ? (
          <p
            className="py-1 text-[13px] leading-snug text-slate-600"
            data-testid="verify-confirm-empty"
          >
            Du hast nichts geändert — der Scan sieht für dich gut aus. Du kannst
            ihn so an Provider schicken.
          </p>
        ) : (
          <ul className="space-y-0.5" data-testid="verify-confirm-changes">
            {measurementLine && (
              <ChangeRow testId="verify-confirm-measurements" text={measurementLine} />
            )}
            {layoutLine && (
              <ChangeRow testId="verify-confirm-layout" text={layoutLine} />
            )}
            {pinLine && <ChangeRow testId="verify-confirm-pins" text={pinLine} />}
          </ul>
        )}
      </div>

      {/* Why-card — the conversion nudge (Mockup 15). */}
      <div className="mb-3 rounded-[14px] border border-teal-700/20 bg-teal-700/[0.07] p-3.5">
        <p className="mb-1 text-[10px] font-bold uppercase tracking-[1px] text-teal-800">
          Warum das?
        </p>
        <p className="text-[12px] leading-snug text-slate-700">
          Provider sehen deinen korrigierten Scan und deine Wünsche, bevor sie
          ein Angebot machen. Du bekommst genauere Angebote und weniger
          Rückfragen.
        </p>
      </div>

      {/* Inline confirm for "Provider anfragen" — kein Hard-Press (§2.1). */}
      {confirmingInquiry ? (
        <div
          className="rounded-[14px] border border-orange-400/40 bg-orange-500/[0.08] p-3.5"
          data-testid="verify-confirm-inquiry-panel"
        >
          <p className="mb-2.5 text-[13px] font-semibold leading-snug text-slate-900">
            Scan an Provider schicken? Du kannst danach nichts mehr ändern, bis
            ein Angebot da ist.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmingInquiry(false)}
              disabled={busy}
              data-testid="verify-confirm-inquiry-cancel"
              className="flex-1 rounded-[12px] bg-slate-900/[0.06] px-3 py-3 text-[13px] font-bold text-slate-600 transition active:scale-[0.98] disabled:opacity-40"
            >
              Zurück
            </button>
            <button
              type="button"
              onClick={handleRequestProvider}
              disabled={busy}
              data-testid="verify-confirm-inquiry-commit"
              className="flex-[2] rounded-[12px] bg-orange-500 px-3 py-3 text-[13px] font-bold text-white shadow-[0_6px_18px_rgba(217,119,87,0.35)] transition active:scale-[0.98] disabled:opacity-40"
            >
              {busy ? 'Wird gesendet …' : 'Ja, Provider anfragen'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setConfirmingInquiry(true)}
            disabled={busy}
            data-testid="verify-confirm-request-provider"
            className="w-full rounded-2xl bg-orange-500 px-4 py-3.5 text-[15px] font-bold text-white shadow-[0_6px_18px_rgba(217,119,87,0.35)] transition active:scale-[0.99] disabled:opacity-40"
          >
            Provider anfragen →
          </button>
          <button
            type="button"
            onClick={handleSaveOnly}
            disabled={busy}
            data-testid="verify-confirm-save-only"
            className="w-full px-2 py-2 text-[13px] font-semibold text-slate-500 transition disabled:opacity-40"
          >
            {busy ? 'Wird gespeichert …' : 'Erstmal nur speichern'}
          </button>
        </div>
      )}

      {feedback && (
        <p
          role="status"
          data-testid="verify-confirm-feedback"
          className={[
            'mt-3 rounded-lg px-3 py-2 text-center text-[12px] font-medium',
            feedback.ok
              ? 'bg-teal-700/10 text-teal-800'
              : 'bg-rose-500/10 text-rose-800',
          ].join(' ')}
        >
          {feedback.text}
        </p>
      )}
    </div>
  )
}

/** One change-bucket row in the Stage-5 summary card. */
function ChangeRow({ testId, text }: { testId: string; text: string }): ReactElement {
  return (
    <li
      className="flex items-center gap-2.5 py-1.5 text-[13px] text-slate-900"
      data-testid={testId}
    >
      <span
        aria-hidden="true"
        className="grid size-[18px] shrink-0 place-items-center rounded-full bg-green-600 text-[11px] font-extrabold text-white"
      >
        ✓
      </span>
      <span>{text}</span>
    </li>
  )
}
