import { useEffect, useState } from 'react'
import { createInvoiceFromJob } from '../../lib/invoices/invoiceEngine'
import { getOfferById, getAcceptedOfferByJobId } from '../../lib/offers'
import { resolveIssuerData } from '../../lib/workflow/issuerDataHelper'
import { createInvoiceWorkflow } from '../../lib/workflow'
import { normalizeErrorMessage } from '../../lib/diagnostics'
import { mapInvoiceWorkflowError } from './invoiceErrorMapper'
import type { Job } from '../../lib/jobs'
import type { Invoice } from '../../lib/invoices'
import CorridorAction from '../system/CorridorAction'

type Props = {
  job: Job
  onCreated: () => void
  onClose: () => void
}

/**
 * Confirmation sheet for invoice creation.
 *
 * Pre-fills a read-only summary from job + offer data using the same
 * engine (createInvoiceFromJob) the workflow uses. The craftsman reviews
 * the preview and confirms or cancels.
 */
export default function InvoiceCreationSheet({ job, onCreated, onClose }: Props) {
  const [preview, setPreview] = useState<Invoice | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadPreview() {
      try {
        // Mirror ensureInvoiceForJob: sourceOfferId → getOfferById, else reverse-lookup
        const offer = job.sourceOfferId
          ? getOfferById(job.sourceOfferId)
          : getAcceptedOfferByJobId(job.id)
        const issuerData = await resolveIssuerData(job.craftsmanUserId)
        const inv = createInvoiceFromJob(job, offer ?? undefined, issuerData ?? undefined)
        if (!cancelled) setPreview(inv)
      } catch (err) {
        if (!cancelled) setPreviewError(normalizeErrorMessage(err))
      }
    }

    loadPreview()
    return () => { cancelled = true }
  }, [job])

  const handleConfirm = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await createInvoiceWorkflow(job.id)
      onCreated()
    } catch (err) {
      setError(mapInvoiceWorkflowError(err))
    } finally {
      setBusy(false)
    }
  }

  const fmt = (n: number) =>
    n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' \u20AC'

  return (
    <div
      className="rounded-[16px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_34px_-26px_rgba(2,6,23,0.16)]"
      data-testid="invoice-creation-sheet"
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[16px]">🧾</span>
          <span className="text-[14px] font-semibold text-slate-800">
            Rechnung erstellen
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[14px] text-slate-400 transition hover:bg-slate-100 disabled:opacity-50"
          aria-label="Schließen"
        >
          ✕
        </button>
      </div>

      {/* Preview loading / error */}
      {!preview && !previewError && (
        <p className="py-4 text-center text-[13px] text-slate-400">Vorschau wird geladen…</p>
      )}

      {previewError && (
        <p className="py-4 text-center text-[13px] text-red-500">{previewError}</p>
      )}

      {/* Invoice preview */}
      {preview && (
        <div className="space-y-3">
          {/* Parties */}
          <div className="space-y-1">
            <Row label="Kunde" value={preview.parties.customerName} />
            <Row label="Aussteller" value={preview.parties.issuerName} />
          </div>

          {/* Line items */}
          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Positionen
            </p>
            {preview.lineItems.map((li) => (
              <div key={li.id} className="flex items-start justify-between gap-2 py-1">
                <span className="text-[13px] text-slate-700">
                  {li.quantity > 1 ? `${li.quantity}× ` : ''}
                  {li.label}
                </span>
                <span className="shrink-0 text-[13px] font-medium text-slate-900">
                  {fmt(li.total)}
                </span>
              </div>
            ))}
          </div>

          {/* Amounts */}
          <div className="space-y-1 border-t border-slate-100 pt-2">
            <Row label="Netto" value={fmt(preview.amounts.netAmount)} subtle />
            <Row label="MwSt." value={fmt(preview.amounts.taxAmount)} subtle />
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-slate-800">Gesamt</span>
              <span className="text-[14px] font-bold text-slate-900">
                {fmt(preview.amounts.grossAmount)}
              </span>
            </div>
          </div>

          {/* Location */}
          {job.location && (
            <Row label="Ort" value={job.location} subtle />
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <CorridorAction
              variant="primary"
              size="sm"
              loading={busy}
              onClick={handleConfirm}
              data-testid="invoice-confirm-button"
            >
              {busy ? '…' : 'Rechnung erstellen'}
            </CorridorAction>
            <CorridorAction
              variant="ghost"
              size="sm"
              block={false}
              disabled={busy}
              onClick={onClose}
            >
              Abbrechen
            </CorridorAction>
          </div>

          {error && (
            <p className="text-[12px] text-red-500" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, subtle }: { label: string; value: string; subtle?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={`text-[13px] ${subtle ? 'text-slate-400' : 'text-slate-500'}`}>
        {label}
      </span>
      <span className={`text-right text-[13px] ${subtle ? 'text-slate-600' : 'font-medium text-slate-800'}`}>
        {value}
      </span>
    </div>
  )
}
