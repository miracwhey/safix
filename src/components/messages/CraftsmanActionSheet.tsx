
import ProActionGuard from '../subscription/ProActionGuard'
import type { EffectiveSubscriptionStatus, SubscriptionScope } from '../../lib/subscription'

type Props = {
  /** Opens the estimate composer (Schätzung). */
  onCreateEstimate: () => void
  /** Opens the cost_estimate composer (Kostenvoranschlag). */
  onCreateCostEstimate: () => void
  /**
   * Opens the binding_offer composer (Verbindliches Angebot).
   * This is the ONLY path that starts the standard escrow/project corridor.
   */
  onSendQuote: () => void
  /** Opens the diagnosis composer (Diagnose-Einsatz). */
  onCreateDiagnosis: () => void
  onClose: () => void
  effectiveState: EffectiveSubscriptionStatus | null
  scope: SubscriptionScope
  onTrialStarted?: () => void
}

/**
 * Craftsman-side action sheet in the thread composer.
 *
 * Entry point for all commercial document creation from a conversation thread.
 * Presents four typed document choices:
 *   - Schätzung (estimate) — unverbindlich, no payment
 *   - Kostenvoranschlag (cost_estimate) — konkret, kein Escrow
 *   - Verbindliches Angebot (binding_offer) — echte Auftragsgrundlage mit Escrow
 *   - Diagnose-Einsatz (diagnosis) — eigener Sofortzahlungspfad, 5 % Fee
 *
 * Each entry is individually gated via ProActionGuard (open_quote_composer).
 */
export default function CraftsmanActionSheet({
  onCreateEstimate,
  onCreateCostEstimate,
  onSendQuote,
  onCreateDiagnosis,
  onClose,
  effectiveState,
  scope,
  onTrialStarted,
}: Props) {
  return (
    <div
      className="rounded-[16px] bg-white p-3 ring-1 ring-slate-200/70 shadow-[0_16px_34px_-26px_rgba(2,6,23,0.16)]"
      data-testid="craftsman-action-sheet"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-700">
          Dokument erstellen
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[14px] text-slate-400 transition hover:bg-slate-100"
          aria-label="Schließen"
        >
          ✕
        </button>
      </div>

      {/* Schätzung */}
      <ProActionGuard
        action="open_quote_composer"
        effectiveState={effectiveState}
        scope={scope}
        onAction={onCreateEstimate}
        onTrialStarted={onTrialStarted}
      >
        {(guardedOnClick) => (
          <button
            type="button"
            onClick={guardedOnClick}
            data-testid="craftsman-action-create-estimate"
            className="flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left transition hover:bg-slate-50 active:bg-slate-100"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-[16px]">
              📊
            </span>
            <div>
              <div className="text-[13px] font-semibold text-slate-800">
                Schätzung erstellen
              </div>
              <div className="text-[11px] text-slate-500">
                Unverbindliche Richtpreisangabe — keine Zahlungspflicht
              </div>
            </div>
          </button>
        )}
      </ProActionGuard>

      {/* Kostenvoranschlag */}
      <ProActionGuard
        action="open_quote_composer"
        effectiveState={effectiveState}
        scope={scope}
        onAction={onCreateCostEstimate}
        onTrialStarted={onTrialStarted}
      >
        {(guardedOnClick) => (
          <button
            type="button"
            onClick={guardedOnClick}
            data-testid="craftsman-action-create-cost-estimate"
            className="flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left transition hover:bg-slate-50 active:bg-slate-100"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-50 text-[16px]">
              📄
            </span>
            <div>
              <div className="text-[13px] font-semibold text-slate-800">
                Kostenvoranschlag senden
              </div>
              <div className="text-[11px] text-slate-500">
                Konkreter Preis & Leistungsumfang — kein Auftragsabschluss
              </div>
            </div>
          </button>
        )}
      </ProActionGuard>

      {/* Verbindliches Angebot */}
      <ProActionGuard
        action="open_quote_composer"
        effectiveState={effectiveState}
        scope={scope}
        onAction={onSendQuote}
        onTrialStarted={onTrialStarted}
      >
        {(guardedOnClick) => (
          <button
            type="button"
            onClick={guardedOnClick}
            data-testid="craftsman-action-send-quote"
            className="flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left transition hover:bg-slate-50 active:bg-slate-100"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[16px]">
              📋
            </span>
            <div>
              <div className="text-[13px] font-semibold text-slate-800">
                Verbindliches Angebot senden
              </div>
              <div className="text-[11px] text-slate-500">
                Annahmefähige Auftragsgrundlage mit Zahlung & Zahlungskorridor
              </div>
            </div>
          </button>
        )}
      </ProActionGuard>

      {/* Diagnose-Einsatz */}
      <ProActionGuard
        action="open_quote_composer"
        effectiveState={effectiveState}
        scope={scope}
        onAction={onCreateDiagnosis}
        onTrialStarted={onTrialStarted}
      >
        {(guardedOnClick) => (
          <button
            type="button"
            onClick={guardedOnClick}
            data-testid="craftsman-action-create-diagnosis"
            className="flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left transition hover:bg-slate-50 active:bg-slate-100"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-50 text-[16px]">
              🔍
            </span>
            <div>
              <div className="text-[13px] font-semibold text-slate-800">
                Diagnose-Einsatz
              </div>
              <div className="text-[11px] text-slate-500">
                Bezahlter Prüfeinsatz — eigener Sofortzahlungspfad, 5 % Plattformgebühr
              </div>
            </div>
          </button>
        )}
      </ProActionGuard>
    </div>
  )
}
