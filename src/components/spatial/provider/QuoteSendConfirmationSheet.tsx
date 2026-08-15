/**
 * QuoteSendConfirmationSheet — Angebot-Senden-Bestätigung (Mockup 27 · B-7 →
 * Phase C · C-10).
 *
 * Phase C (C-10): the send is a real, awaited operation with feedback.
 *   - A two-step flow: Bestätigen → Vorschau → Senden (no blind send).
 *   - `onSend` returns a Promise<QuoteSendResult>; on failure the sheet stays
 *     open with an inline error + retry; `isSending` always resets.
 *   - On success the sheet shows a persistent "gesendet" confirmation —
 *     re-sending the same quote is no longer possible (multi-send guard).
 *   - Three delivery channels (In-App / E-Mail / Push).
 *   - The MwSt label is driven by `vatRatePct`, not a hardcoded string; the
 *     job title comes from the real `job`, not a scene-metadata fallback.
 */

import { useState } from 'react'
import {
  Send,
  CheckCircle2,
  AlertTriangle,
  Smartphone,
  Mail,
  Bell,
  Eye,
  ChevronLeft,
} from 'lucide-react'
import BottomSheet from '../../ui/BottomSheet'
import type { SpatialScene } from '../../../lib/spatial/canonical/repository/SpatialSceneRepository'
import type { Job } from '../../../lib/jobs/types'
import { useHaptics } from '../../../hooks/useHaptics'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface QuoteTotals {
  netCents: number
  vatCents: number
  totalCents: number
  itemCount: number
  sceneItemCount: number
}

/** Delivery channels — C-10 adds `push`. */
export interface DeliveryChannels {
  inApp: boolean
  email: boolean
  push: boolean
}

/**
 * Commercial document type — Provider chooses per Quote (C-10 · C10.4).
 *
 * `binding_offer` (default) — Festpreis-Angebot. Customer-Accept = bindender
 *                             Vertrag, Escrow + Job entsteht, Pricing-Lock.
 * `cost_estimate`           — Kostenvoranschlag. Unverbindlich, kein Escrow,
 *                             nur Tracking-Job auf Accept.
 *
 * The DB CHECK constraint (`offers_document_type_check`) accepts both.
 */
export type QuoteDocumentType = 'binding_offer' | 'cost_estimate'

/** Result of an awaited quote send. */
export type QuoteSendResult = { ok: true } | { ok: false; error: string }

export interface QuoteSendConfirmationSheetProps {
  open: boolean
  onClose: () => void
  scene: SpatialScene
  /** The real job — title + customer come from here, not scene metadata. */
  job: Job
  totals: QuoteTotals
  recipientName: string
  /** VAT rate in percent — drives the MwSt label. */
  vatRatePct: number
  /** Unix-ms the quote was already sent, or null. Non-null → the sent view. */
  quoteSentAt: number | null
  /**
   * Awaited send. The caller persists the quote + returns ok / error.
   * `documentType` defaults to `binding_offer` for first-time-sent Quotes;
   * the Provider can change it via the Segment-Control before tapping Send.
   */
  onSend: (
    channels: DeliveryChannels,
    documentType: QuoteDocumentType,
  ) => Promise<QuoteSendResult>
}

type SendPhase = 'confirm' | 'preview' | 'sending' | 'sent'

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatEur(cents: number): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

function channelSummary(c: DeliveryChannels): string {
  const parts: string[] = []
  if (c.inApp) parts.push('In-App')
  if (c.email) parts.push('E-Mail')
  if (c.push) parts.push('Push')
  return parts.join(' · ') || '—'
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SceneThumbnail() {
  return (
    <div
      className="h-[60px] w-[60px] flex-shrink-0 overflow-hidden rounded-[11px] border border-edge"
      style={{ background: 'linear-gradient(165deg,#EEF1F6,#DDE3EE)' }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 60 60" className="h-full w-full" aria-label="Szenen-Vorschau">
        <g transform="translate(13 14)">
          <path
            d="M0 0 H34 V19 H21 V32 H0 Z"
            fill="#FBFCFE"
            stroke="#3C4658"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <rect x="5" y="4" width="13" height="7" rx="2" fill="#fff" stroke="#9AA7BC" strokeWidth="1.2" />
          <ellipse cx="27" cy="8" rx="4" ry="5" fill="#fff" stroke="#9AA7BC" strokeWidth="1.2" />
        </g>
      </svg>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 mt-[18px] px-0.5 text-[11px] font-bold uppercase tracking-[0.6px] text-ink-muted">
      {children}
    </p>
  )
}

function BomRow({
  label,
  value,
  isTotal = false,
}: {
  label: string
  value: string
  isTotal?: boolean
}) {
  return (
    <div
      className={['flex justify-between px-[13px] py-[9px] text-[12.5px]', isTotal ? 'bg-canvas' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <span className={isTotal ? 'text-[13.5px] font-[750] text-ink' : 'text-ink-sub'}>
        {label}
      </span>
      <span className={isTotal ? 'text-[15px] font-[800] text-ink' : 'font-semibold text-ink'}>
        {value}
      </span>
    </div>
  )
}

function ChannelRow({
  icon,
  label,
  sub,
  enabled,
  onToggle,
}: {
  icon: React.ReactNode
  label: string
  sub: string
  enabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-[9px] rounded-[10px] border border-[#ECEFF4] bg-canvas px-[11px] py-[9px] text-left"
      aria-pressed={enabled}
    >
      <span className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[8px] border border-edge bg-white text-ink-sub">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold text-ink">{label}</span>
        <span className="block text-[10.5px] text-ink-muted">{sub}</span>
      </span>
      <span
        className={[
          'h-[20px] w-[36px] flex-shrink-0 rounded-full transition-colors duration-200',
          enabled ? 'bg-brand' : 'bg-slate-200',
        ].join(' ')}
        aria-hidden="true"
      >
        <span
          className={[
            'block h-[16px] w-[16px] translate-y-[2px] rounded-full bg-white shadow transition-transform duration-200',
            enabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
          ].join(' ')}
        />
      </span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function QuoteSendConfirmationSheet({
  open,
  onClose,
  scene,
  job,
  totals,
  recipientName,
  vatRatePct,
  quoteSentAt,
  onSend,
}: QuoteSendConfirmationSheetProps) {
  const haptics = useHaptics()

  const [channels, setChannels] = useState<DeliveryChannels>({
    inApp: true,
    email: true,
    push: true,
  })
  // C-10 · C10.4: Provider chooses commercial document type per Quote.
  // Defaults to binding_offer — Spatial-Scan is precise so the typical
  // Spatial-Quote IS a binding offer. cost_estimate is a deliberate
  // downgrade for sight-only / preliminary measurements.
  const [documentType, setDocumentType] = useState<QuoteDocumentType>('binding_offer')
  const [phase, setPhase] = useState<SendPhase>(quoteSentAt !== null ? 'sent' : 'confirm')
  const [sendError, setSendError] = useState<string | null>(null)

  // Sync the phase when the sheet (re-)opens — a quote already sent opens
  // directly in the confirmation view.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setPhase(quoteSentAt !== null ? 'sent' : 'confirm')
      setSendError(null)
    }
  }

  const validatorOk =
    scene.validationState === 'passed' || scene.validationState === 'passed_with_warnings'
  const canSend = channels.inApp || channels.email || channels.push

  function toggleChannel(channel: keyof DeliveryChannels) {
    haptics.light()
    setChannels((prev) => ({ ...prev, [channel]: !prev[channel] }))
  }

  async function doSend() {
    if (!canSend || phase === 'sending') return
    setPhase('sending')
    setSendError(null)
    haptics.heavy()
    const result = await onSend(channels, documentType)
    if (result.ok) {
      haptics.success()
      setPhase('sent')
    } else {
      setSendError(result.error)
      // Back to the confirm view so the user can retry — isSending is cleared.
      setPhase('confirm')
    }
  }

  const recipientInitials = recipientName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  // ── Sent view ──────────────────────────────────────────────────────────────
  if (phase === 'sent') {
    return (
      <BottomSheet open={open} onClose={onClose} maxWidth={480}>
        <div className="flex flex-col items-center px-4 py-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-[#D1FAE5] text-ok">
            <CheckCircle2 size={34} />
          </span>
          <h2 className="mt-3 text-[19px] font-[750] text-ink">Angebot gesendet</h2>
          <p className="mt-1 text-[13px] text-ink-sub">
            An <b className="font-bold text-ink">{recipientName}</b> · {job.title}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Kanäle: {channelSummary(channels)}
          </p>
          <div className="mt-4 w-full rounded-[12px] bg-canvas px-3 py-2.5 text-left">
            <BomRow label="Angebotssumme" value={formatEur(totals.totalCents)} isTotal />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full rounded-[13px] bg-brand py-3.5 text-[14px] font-bold text-white"
          >
            Fertig
          </button>
        </div>
      </BottomSheet>
    )
  }

  // ── Preview view ───────────────────────────────────────────────────────────
  if (phase === 'preview') {
    return (
      <BottomSheet open={open} onClose={onClose} maxWidth={480}>
        <div className="mb-1 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPhase('confirm')}
            aria-label="Zurück"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-ink-sub"
          >
            <ChevronLeft size={17} />
          </button>
          <div>
            <h2 className="text-[19px] font-[750] tracking-[-0.4px] text-ink">Vorschau</h2>
            <p className="text-[12px] text-ink-muted">So erhält {recipientName} das Angebot</p>
          </div>
        </div>

        <div className="mt-3 rounded-[14px] border border-edge bg-white p-4 shadow-subtle">
          <p className="text-[11px] font-bold uppercase tracking-[0.5px] text-ink-muted">
            Angebot
          </p>
          <p className="mt-0.5 text-[15px] font-bold text-ink">{job.title}</p>
          <p className="mt-0.5 text-[12px] text-ink-sub">
            Auf Basis des 3D-Aufmaßes · {totals.itemCount} Positionen
          </p>
          <div className="mt-3 overflow-hidden rounded-[10px] border border-edge">
            <BomRow label="Summe Netto" value={formatEur(totals.netCents)} />
            <div className="border-t border-[#ECEFF4]">
              <BomRow label={`MwSt ${vatRatePct} %`} value={formatEur(totals.vatCents)} />
            </div>
            <div className="border-t border-edge">
              <BomRow label="Gesamtbetrag" value={formatEur(totals.totalCents)} isTotal />
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-snug text-ink-muted">
            Die Kundin sieht das Angebot inkl. Link zur 3D-Szene und kann es
            annehmen oder Rückfragen stellen.
          </p>
        </div>

        <div className="mt-4 flex gap-[9px]">
          <button
            type="button"
            onClick={() => setPhase('confirm')}
            className="flex-1 rounded-[12px] border border-edge bg-surface py-[14px] text-[14px] font-bold text-ink-sub"
          >
            Zurück
          </button>
          <button
            type="button"
            onClick={() => void doSend()}
            className="flex flex-[1.5] items-center justify-center gap-[7px] rounded-[12px] bg-brand py-[14px] text-[14px] font-bold text-white shadow-[0_8px_20px_-8px_rgba(37,99,235,0.55)]"
          >
            <Send size={16} />
            Angebot jetzt senden
          </button>
        </div>
      </BottomSheet>
    )
  }

  // ── Confirm view (also covers 'sending') ───────────────────────────────────
  const sending = phase === 'sending'
  return (
    <BottomSheet open={open} onClose={onClose} maxWidth={480} hideHandle={false}>
      <div className="mb-1 flex items-start justify-between">
        <div>
          <h2 className="text-[21px] font-[750] leading-tight tracking-[-0.4px] text-ink">
            Angebot senden
          </h2>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">Prüfen und bestätigen</p>
        </div>
      </div>

      <div className="overflow-y-auto overscroll-contain" style={{ maxHeight: '52vh' }}>
        {/* Job + scene thumb */}
        <div className="flex items-center gap-[12px] rounded-[12px] border border-edge bg-canvas p-[11px]">
          <SceneThumbnail />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-bold text-ink">{job.title}</p>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">{job.customer}</p>
            <span className="mt-[5px] inline-flex items-center gap-1 rounded-full bg-[#EEF2FB] px-[7px] py-[2px] text-[9.5px] font-bold text-brand">
              Basis auf Aufmaß v{scene.schemaVersion ?? '1'}
            </span>
          </div>
        </div>

        {/* BoM summary */}
        <SectionLabel>Stückliste</SectionLabel>
        <div className="overflow-hidden rounded-[12px] border border-edge shadow-subtle">
          <BomRow
            label={`${totals.itemCount} Positionen · ${totals.sceneItemCount} aus Szene berechnet`}
            value=""
          />
          <div className="border-t border-[#ECEFF4]">
            <BomRow label="Summe Netto" value={formatEur(totals.netCents)} />
          </div>
          <div className="border-t border-[#ECEFF4]">
            <BomRow label={`MwSt ${vatRatePct} %`} value={formatEur(totals.vatCents)} />
          </div>
          <div className="border-t border-edge">
            <BomRow label="Gesamt" value={formatEur(totals.totalCents)} isTotal />
          </div>
        </div>

        {/* Recipient */}
        <SectionLabel>Empfänger</SectionLabel>
        <div className="flex items-center gap-[10px] rounded-[12px] border border-edge bg-canvas p-[11px] shadow-subtle">
          <div
            className="flex h-[36px] w-[36px] flex-shrink-0 items-center justify-center rounded-full bg-[#E5EDFB] text-[14px] font-bold text-brand"
            aria-hidden="true"
          >
            {recipientInitials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-[650] text-ink">{recipientName}</p>
            <p className="text-[11px] text-ink-muted">{job.title}</p>
          </div>
        </div>

        {/* Document type — Provider chooses commercial binding level (C-10 · C10.4) */}
        <SectionLabel>Angebotsart</SectionLabel>
        <div
          className="overflow-hidden rounded-[12px] border border-edge bg-canvas"
          role="group"
          aria-label="Angebotsart wählen"
        >
          <div className="flex">
            <button
              type="button"
              onClick={() => {
                haptics.selection()
                setDocumentType('binding_offer')
              }}
              aria-pressed={documentType === 'binding_offer'}
              aria-label="Festpreis-Angebot wählen — Annahme erstellt Auftrag mit Zahlung"
              disabled={quoteSentAt !== null}
              className={[
                'flex-1 px-[11px] py-[10px] text-[12px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                documentType === 'binding_offer'
                  ? 'bg-brand text-white shadow-[inset_0_-2px_0_0_rgba(0,0,0,0.1)]'
                  : 'bg-canvas text-ink-sub hover:text-ink',
              ].join(' ')}
            >
              Festpreis-Angebot
            </button>
            <button
              type="button"
              onClick={() => {
                haptics.selection()
                setDocumentType('cost_estimate')
              }}
              aria-pressed={documentType === 'cost_estimate'}
              aria-label="Kostenvoranschlag wählen — unverbindlich, kein Zahlung"
              disabled={quoteSentAt !== null}
              className={[
                'flex-1 px-[11px] py-[10px] text-[12px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                documentType === 'cost_estimate'
                  ? 'bg-brand text-white shadow-[inset_0_-2px_0_0_rgba(0,0,0,0.1)]'
                  : 'bg-canvas text-ink-sub hover:text-ink',
              ].join(' ')}
            >
              Kostenvoranschlag
            </button>
          </div>
          <p className="border-t border-[#ECEFF4] px-[11px] py-[9px] text-[11px] leading-snug text-ink-muted">
            {documentType === 'binding_offer'
              ? 'Verbindlich · Annahme erstellt Auftrag + Zahlungs-Zahlung. Festpreis ist nach Annahme gelockt.'
              : 'Unverbindlich · Annahme bestätigt nur den Voranschlag. Kein Zahlung, Endpreis kann abweichen.'}
          </p>
        </div>

        {/* Delivery channels */}
        <SectionLabel>Zustellkanäle</SectionLabel>
        <div className="flex flex-col gap-[7px]">
          <ChannelRow
            icon={<Smartphone size={14} />}
            label="In-App-Angebot"
            sub="Kundin sieht Angebot + 3D-Szene-Link"
            enabled={channels.inApp}
            onToggle={() => toggleChannel('inApp')}
          />
          <ChannelRow
            icon={<Mail size={14} />}
            label="E-Mail"
            sub="PDF-Anhang + Angebot als Dokument"
            enabled={channels.email}
            onToggle={() => toggleChannel('email')}
          />
          <ChannelRow
            icon={<Bell size={14} />}
            label="Push-Benachrichtigung"
            sub="Sofort-Hinweis auf dem Sperrbildschirm"
            enabled={channels.push}
            onToggle={() => toggleChannel('push')}
          />
        </div>

        {/* Validator check */}
        {validatorOk ? (
          <div className="mt-[12px] flex items-center gap-[9px] rounded-[12px] bg-[#D1FAE5] p-[10px]">
            <CheckCircle2 size={20} className="flex-shrink-0 text-ok" />
            <p className="text-[11.5px] font-[650] leading-snug text-ok">
              Szene geprüft — keine Validator-Warnungen.
            </p>
          </div>
        ) : (
          <div className="mt-[12px] flex items-start gap-[9px] rounded-[12px] bg-[#FEF3C7] p-[10px]">
            <AlertTriangle size={20} className="flex-shrink-0 text-warn" />
            <div>
              <p className="text-[11.5px] font-[750] text-warn">Szene hat Validator-Warnungen</p>
              <p className="mt-0.5 text-[11px] leading-snug text-[#92400E]">
                Das Angebot kann trotzdem gesendet werden — Warnungen werden als
                Hinweis vermerkt.
              </p>
            </div>
          </div>
        )}

        <div className="h-2" />
      </div>

      {/* Footer */}
      <div className="mt-3 border-t border-edge pt-3">
        {!canSend && (
          <p className="mb-2 text-center text-[11.5px] text-danger">
            Mindestens einen Zustellkanal aktivieren.
          </p>
        )}
        {sendError && (
          <p className="mb-2 text-center text-[11.5px] font-[600] text-danger">
            {sendError} — bitte erneut versuchen.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            if (!canSend || sending) return
            haptics.selection()
            setPhase('preview')
          }}
          disabled={!canSend || sending}
          className={[
            'flex w-full items-center justify-center gap-[7px] rounded-[12px] py-[14px] text-[14px] font-bold text-white transition-opacity',
            canSend && !sending
              ? 'bg-brand shadow-[0_8px_20px_-8px_rgba(37,99,235,0.55)]'
              : 'cursor-not-allowed bg-brand opacity-40',
          ].join(' ')}
        >
          <Eye size={16} />
          {sending ? 'Wird gesendet …' : 'Weiter zur Vorschau'}
        </button>
      </div>
    </BottomSheet>
  )
}
