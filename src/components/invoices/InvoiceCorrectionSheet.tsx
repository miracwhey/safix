import { useMemo, useState } from 'react'
import CorridorAction from '../system/CorridorAction'
import {
  formatInvoiceEuro,
  getCorrectionsForInvoice,
  getInvoices,
  type Invoice,
} from '../../lib/invoices'
import {
  createCancellationInvoiceWorkflow,
  createCreditNoteWorkflow,
} from '../../lib/workflow'
import { mapInvoiceWorkflowError } from './invoiceErrorMapper'

type Props = {
  invoice: Invoice
  onCorrectionIssued: (correction: Invoice) => void
  onClose: () => void
}

type Mode = 'cancellation' | 'credit_note'

function formatEuroFromCents(cents: number): string {
  return formatInvoiceEuro(cents / 100)
}

function parseEuroInputToCents(value: string): number | null {
  // Akzeptiert „123,45" / „123.45" / „1.234,56".
  const cleaned = value.replace(/\./g, '').replace(',', '.').trim()
  if (cleaned === '') return null
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.round(parsed * 100)
}

export default function InvoiceCorrectionSheet({
  invoice,
  onCorrectionIssued,
  onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>('cancellation')
  const [refundAmountInput, setRefundAmountInput] = useState('')
  const [reason, setReason] = useState('')
  const [refundEventId, setRefundEventId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const existingCorrections = useMemo(
    () => getCorrectionsForInvoice(getInvoices(), invoice.id),
    [invoice.id],
  )
  const existingCancellation = existingCorrections.find(
    (c) => c.kind === 'cancellation',
  )
  const totalCreditCents = existingCorrections
    .filter((c) => c.kind === 'credit_note')
    .reduce((sum, c) => sum + Math.abs(c.correctionAmountCents ?? 0), 0)
  const originalGrossCents = Math.round(invoice.amounts.grossAmount * 100)
  const remainingCents = Math.max(0, originalGrossCents - totalCreditCents)

  const refundCents = useMemo(
    () => (mode === 'credit_note' ? parseEuroInputToCents(refundAmountInput) : null),
    [mode, refundAmountInput],
  )

  const isMultiRate = (invoice.taxBreakdown ?? []).length > 1
  const isAlreadyCancelled = !!existingCancellation
  const reasonValid = reason.trim().length >= 3

  let confirmBlocker: string | null = null
  if (isAlreadyCancelled) {
    confirmBlocker = 'Originalrechnung wurde bereits storniert. Weitere Korrekturen sind nicht möglich.'
  } else if (!reasonValid) {
    confirmBlocker = 'Begründung mit mindestens 3 Zeichen ist Pflicht.'
  } else if (mode === 'credit_note') {
    if (isMultiRate) {
      confirmBlocker =
        'Originalrechnung enthält mehrere Steuersätze. Gutschrift in dieser Version nur für Einsatz mit einheitlichem Steuersatz unterstützt — bitte vollständig stornieren und neu ausstellen.'
    } else if (refundCents === null) {
      confirmBlocker = 'Refundbetrag eingeben (z. B. 119,00).'
    } else if (refundCents > remainingCents) {
      confirmBlocker = `Refundbetrag übersteigt den noch nicht gutgeschriebenen Restbetrag von ${formatEuroFromCents(remainingCents)}.`
    } else if (refundCents > 0 && totalCreditCents > 0 && refundCents === remainingCents) {
      // Hinweis aber nicht blockieren — voller Restbetrag via Gutschrift ist erlaubt.
      confirmBlocker = null
    }
  } else if (mode === 'cancellation' && totalCreditCents > 0) {
    confirmBlocker =
      'Originalrechnung trägt bereits Gutschriften. Vollständiger Storno ist nicht mehr möglich — weitere Gutschriften erstellen.'
  }

  async function handleConfirm() {
    if (confirmBlocker) {
      setError(confirmBlocker)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const refundEvent = refundEventId.trim() || undefined
      const trimmedReason = reason.trim()
      let result: Invoice
      if (mode === 'cancellation') {
        result = await createCancellationInvoiceWorkflow({
          originalInvoiceId: invoice.id,
          reason: trimmedReason,
          refundEventId: refundEvent,
        })
      } else {
        if (refundCents === null) throw new Error('refund amount missing')
        result = await createCreditNoteWorkflow({
          originalInvoiceId: invoice.id,
          refundAmountCents: refundCents,
          reason: trimmedReason,
          refundEventId: refundEvent,
        })
      }
      onCorrectionIssued(result)
    } catch (err) {
      setError(mapInvoiceWorkflowError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_24px_48px_-32px_rgba(2,6,23,0.4)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            §14 Abs. 6 UStG
          </div>
          <div className="mt-1 text-[18px] font-semibold text-slate-900">
            Korrekturbeleg ausstellen
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            Originalrechnung {invoice.invoiceNumber} ·{' '}
            {invoice.parties.customerName} ·{' '}
            {formatInvoiceEuro(invoice.amounts.grossAmount)}
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-xl bg-slate-50 px-3 py-1.5 text-[12px] font-semibold text-slate-600 ring-1 ring-slate-200"
        >
          Schließen
        </button>
      </div>

      {totalCreditCents > 0 && (
        <div className="mt-4 rounded-[14px] bg-amber-50 px-4 py-3 text-[13px] text-amber-800 ring-1 ring-amber-200">
          Bereits gutgeschrieben:{' '}
          <strong>{formatEuroFromCents(totalCreditCents)}</strong>. Verbleibende
          Forderung: <strong>{formatEuroFromCents(remainingCents)}</strong>.
        </div>
      )}

      {existingCancellation && (
        <div className="mt-4 rounded-[14px] bg-rose-50 px-4 py-3 text-[13px] text-rose-800 ring-1 ring-rose-200">
          Diese Rechnung wurde bereits durch{' '}
          <strong>{existingCancellation.invoiceNumber}</strong> storniert.
          Weitere Korrekturen sind nicht zulässig.
        </div>
      )}

      <fieldset className="mt-5 space-y-3">
        <legend className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
          Art der Korrektur
        </legend>
        <label className="flex items-start gap-3 rounded-[16px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
          <input
            type="radio"
            checked={mode === 'cancellation'}
            disabled={isAlreadyCancelled || busy}
            onChange={() => setMode('cancellation')}
            className="mt-1"
          />
          <span className="text-[14px] text-slate-800">
            <strong>Vollständige Stornierung</strong>
            <span className="block text-[12px] text-slate-500">
              Macht die Originalrechnung buchhalterisch nichtig
              (Stornorechnung über{' '}
              {formatInvoiceEuro(-invoice.amounts.grossAmount)}).
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-[16px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
          <input
            type="radio"
            checked={mode === 'credit_note'}
            disabled={isAlreadyCancelled || busy}
            onChange={() => setMode('credit_note')}
            className="mt-1"
          />
          <span className="text-[14px] text-slate-800">
            <strong>Teilbetrag-Gutschrift</strong>
            <span className="block text-[12px] text-slate-500">
              Mindert die Forderung um den refundierten Betrag. Originalrechnung
              bleibt buchhalterisch bestehen.
            </span>
          </span>
        </label>
      </fieldset>

      {mode === 'credit_note' && (
        <div className="mt-4 space-y-2">
          <label className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
            Refundbetrag (Brutto)
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={refundAmountInput}
            disabled={busy}
            placeholder="z. B. 119,00"
            onChange={(e) => setRefundAmountInput(e.target.value)}
            className="w-full rounded-[14px] bg-white px-4 py-2.5 text-[14px] ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
          {refundCents !== null && (
            <div className="text-[12px] text-slate-500">
              Wird als Δ <strong>{formatEuroFromCents(-refundCents)}</strong>{' '}
              gegen die Originalrechnung gebucht.
            </div>
          )}
        </div>
      )}

      <div className="mt-4 space-y-2">
        <label className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
          Begründung
        </label>
        <textarea
          rows={3}
          value={reason}
          disabled={busy}
          placeholder="z. B. Voller Refund nach Dispute-Resolution refund_full"
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-[14px] bg-white px-4 py-2.5 text-[14px] ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
        />
      </div>

      <div className="mt-4 space-y-2">
        <label className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
          Refund-/Dispute-Referenz (optional)
        </label>
        <input
          type="text"
          value={refundEventId}
          disabled={busy}
          placeholder="z. B. re_3PqXyZ… oder Dispute-ID"
          onChange={(e) => setRefundEventId(e.target.value)}
          className="w-full rounded-[14px] bg-white px-4 py-2.5 text-[14px] ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
        />
      </div>

      {confirmBlocker && (
        <div className="mt-4 rounded-[14px] bg-amber-50 px-4 py-3 text-[13px] text-amber-800 ring-1 ring-amber-200">
          {confirmBlocker}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-[14px] bg-rose-50 px-4 py-3 text-[13px] text-rose-800 ring-1 ring-rose-200">
          {error}
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-[14px] bg-slate-100 px-4 py-2.5 text-[13px] font-semibold text-slate-700 ring-1 ring-slate-200 disabled:opacity-60"
        >
          Abbrechen
        </button>
        <CorridorAction
          variant={mode === 'cancellation' ? 'destructive' : 'primary'}
          block={false}
          disabled={busy || !!confirmBlocker || isAlreadyCancelled}
          onClick={handleConfirm}
        >
          {busy
            ? 'Wird ausgestellt …'
            : mode === 'cancellation'
              ? 'Stornorechnung ausstellen'
              : 'Gutschrift ausstellen'}
        </CorridorAction>
      </div>
    </div>
  )
}
