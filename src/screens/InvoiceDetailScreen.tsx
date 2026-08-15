/**
 * InvoiceDetailScreen — Rechnung-Detailansicht
 *
 * Canonical read-only detail view for an Invoice (Rechnung).
 * Accessible by both craftsman and customer.
 *
 * Routes:
 *   /craftsman/rechnung/:invoiceId  (craftsman)
 *   /rechnung/:invoiceId             (customer)
 *
 * Role is determined from the URL path prefix.
 *
 * DOCUMENT surface: shows the invoice (number, amounts, line items, status,
 * dates) + PDF export. Never moves money — payment/release lives on the
 * dedicated payment surfaces.
 *
 * Freshness: the recipient (customer) has no invoices realtime channel, so the
 * invoice is force-refetched on every mount (ensureInvoiceLoaded refreshes the
 * cached row) — the status is current each time the screen is opened, not
 * pinned to the one-shot initial load. The lazy-fetch is bounded by an 8 s
 * ceiling so a stalled connection settles to "nicht gefunden" (with a back
 * affordance) instead of an endless skeleton.
 */

import { useEffect, useState } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { useSmartBack } from '../hooks/useSmartBack'
import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import ScreenNotFound from '../components/system/ScreenNotFound'
import InlineFeedback from '../components/system/InlineFeedback'
import {
  getInvoiceById,
  getInvoices,
  ensureInvoiceLoaded,
  subscribeInvoices,
  downloadInvoicePdf,
  formatInvoiceEuro,
  isInvoiceLogicallyCancelled,
  type Invoice,
} from '../lib/invoices'
import { getJobById, subscribeJobs } from '../lib/jobs'
import { normalizeErrorMessage } from '../lib/diagnostics'
import { useStoreSubscriptions } from '../lib/reactive'

const LAZY_LOAD_CEILING_MS = 8000

// ── Status display ──────────────────────────────────────────────────────────
// Labels mirror the chat artifact-card vocabulary (artifactCardVocab.ts) so the
// detail header matches the card the user tapped (Gestellt / Versendet / …).

const STATUS_BADGE: Record<Invoice['status'], { label: string; classes: string }> = {
  draft:     { label: 'Entwurf',   classes: 'bg-slate-100 text-slate-600' },
  issued:    { label: 'Gestellt',  classes: 'bg-amber-100 text-amber-800' },
  sent:      { label: 'Versendet', classes: 'bg-sky-100 text-sky-800' },
  paid:      { label: 'Bezahlt',   classes: 'bg-emerald-100 text-emerald-800' },
  cancelled: { label: 'Storniert', classes: 'bg-rose-100 text-rose-700' },
}

function StatusBadge({ status }: { status: Invoice['status'] }) {
  const { label, classes } = STATUS_BADGE[status] ?? { label: status, classes: 'bg-slate-100 text-slate-600' }
  return (
    <span className={['inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold', classes].join(' ')}>
      {label}
    </span>
  )
}

// Belegart-Eyebrow for correction documents (Stornorechnung / Gutschrift).
function kindLabel(kind: Invoice['kind']): string {
  if (kind === 'cancellation') return 'Stornorechnung'
  if (kind === 'credit_note') return 'Gutschrift'
  return 'Rechnung'
}

export default function InvoiceDetailScreen() {
  const { invoiceId } = useParams<{ invoiceId: string }>()
  const location = useLocation()

  const isCraftsman = location.pathname.startsWith('/craftsman/')
  const goBack = useSmartBack(isCraftsman ? '/craftsman/invoices' : '/')

  const [invoice, setInvoice] = useState<Invoice | undefined>(
    invoiceId ? getInvoiceById(invoiceId) : undefined
  )
  const [loaded, setLoaded] = useState(() =>
    Boolean(invoiceId && getInvoiceById(invoiceId))
  )
  const [exportingPdf, setExportingPdf] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useStoreSubscriptions([
    {
      subscribe: subscribeInvoices,
      onChange: () => {
        if (!invoiceId) return
        const found = getInvoiceById(invoiceId)
        if (found) {
          setInvoice(found)
          setLoaded(true)
        }
      },
    },
    {
      subscribe: subscribeJobs,
      onChange: () => {
        if (!invoiceId) return
        const found = getInvoiceById(invoiceId)
        if (found) setInvoice(found)
      },
    },
  ])

  useEffect(() => {
    if (!invoiceId) {
      setInvoice(undefined)
      setLoaded(true)
      return
    }
    // Reset on id change so a direct invoice→invoice navigation shows a skeleton
    // for the new id, not the previous invoice's content.
    const found = getInvoiceById(invoiceId)
    setInvoice(found)
    setLoaded(Boolean(found))
    // ALWAYS refresh on mount (status freshness), even when cached. Bound by an
    // 8 s ceiling so a stalled fetch settles to not-found instead of an endless
    // skeleton; whichever of {fetch resolves, ceiling} fires first settles.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = () => {
      if (cancelled) return
      if (timer) clearTimeout(timer)
      setInvoice(getInvoiceById(invoiceId))
      setLoaded(true)
    }
    const ceiling = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LAZY_LOAD_CEILING_MS)
    })
    void Promise.race([ensureInvoiceLoaded(invoiceId), ceiling]).finally(settle)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [invoiceId])

  if (!invoiceId || (!invoice && loaded)) {
    return (
      <AppShell>
        <ScreenNotFound
          entity="Rechnung"
          backTo={isCraftsman ? '/craftsman/invoices' : '/'}
          backLabel={isCraftsman ? '← Rechnungen' : '← Zurück'}
        />
      </AppShell>
    )
  }

  if (!invoice) {
    return (
      <AppShell>
        <ScreenSkeleton eyebrow="Rechnung" lines={5} />
      </AppShell>
    )
  }

  const job = getJobById(invoice.jobId)

  // Defensive: `amounts` is a required type, but a malformed DB row could omit it.
  const grossAmount = invoice.amounts?.grossAmount ?? 0
  const netAmount = invoice.amounts?.netAmount ?? 0
  const taxAmount = invoice.amounts?.taxAmount ?? 0

  // A paid/sent original whose Storno-Beleg exists is logically cancelled — the
  // DB status stays put (audit-trail), but the customer must see "Storniert".
  const logicallyCancelled =
    invoice.kind === 'invoice' && isInvoiceLogicallyCancelled(invoice, getInvoices())
  const effectiveStatus: Invoice['status'] = logicallyCancelled ? 'cancelled' : invoice.status

  const issuedLabel = invoice.issuedAtLabel?.trim()
    || (invoice.issuedAt ? new Date(invoice.issuedAt).toLocaleDateString('de-DE') : null)

  const handleExportPdf = async () => {
    if (exportingPdf) return
    setExportingPdf(true)
    setActionError(null)
    try {
      await downloadInvoicePdf(invoice)
    } catch (err) {
      setActionError(`PDF konnte nicht erstellt werden: ${normalizeErrorMessage(err)}`)
    } finally {
      setExportingPdf(false)
    }
  }

  return (
    <AppShell>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">

          {/* Back navigation — returns to wherever the user came from (the chat
              thread for a tapped card), not a fixed home route. */}
          <button
            type="button"
            onClick={goBack}
            className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
          >
            ← Zurück
          </button>

          {/* Title + status */}
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {kindLabel(invoice.kind)}
              </p>
              <h1 className="mt-0.5 text-[20px] font-bold text-slate-900">
                {invoice.invoiceNumber ? `Nr. ${invoice.invoiceNumber}` : kindLabel(invoice.kind)}
              </h1>
            </div>
            <StatusBadge status={effectiveStatus} />
          </div>

          {/* Logical-cancellation note */}
          {logicallyCancelled && (
            <div className="rounded-card bg-rose-50 px-3 py-2 ring-1 ring-rose-200/60">
              <p className="text-[12px] text-rose-700">
                Diese Rechnung wurde durch eine Stornorechnung aufgehoben.
              </p>
            </div>
          )}

          {/* PDF export — both roles (the engine blocks draft / placeholder data) */}
          {invoice.status !== 'draft' && (
            <button
              type="button"
              onClick={() => void handleExportPdf()}
              disabled={exportingPdf}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-card px-3 py-2 text-[13px] font-semibold text-blue-600 ring-1 ring-blue-200 transition active:scale-[0.98] disabled:opacity-50"
            >
              {exportingPdf ? 'PDF wird erstellt…' : 'Als PDF speichern'}
            </button>
          )}

          <InlineFeedback error={actionError} onDismiss={() => setActionError(null)} />

          {/* Job context */}
          {job && (
            <div className="rounded-card bg-slate-50 px-3 py-2 ring-1 ring-edge">
              <p className="text-[11px] text-slate-400">Bezugsauftrag</p>
              <p className="text-[13px] font-semibold text-slate-800">
                {job.title ?? job.description ?? invoice.jobId}
              </p>
            </div>
          )}

          {/* Amount + breakdown (gross is shown once, prominently; the breakdown
              shows only the derivation Net + MwSt). */}
          <div className="rounded-container bg-surface p-4 ring-1 ring-edge shadow-subtle space-y-3">
            <div>
              <p className="text-[11px] font-semibold text-slate-400">Rechnungsbetrag</p>
              <p className={[
                'mt-1 text-[20px] font-bold',
                grossAmount < 0 ? 'text-rose-700' : 'text-slate-900',
              ].join(' ')}>
                {formatInvoiceEuro(grossAmount)}
              </p>
            </div>
            <div className="border-t border-slate-100 pt-3 space-y-1">
              <div className="flex justify-between text-[12px] text-slate-600">
                <span>Nettobetrag</span>
                <span>{formatInvoiceEuro(netAmount)}</span>
              </div>
              <div className="flex justify-between text-[12px] text-slate-600">
                <span>MwSt.</span>
                <span>{formatInvoiceEuro(taxAmount)}</span>
              </div>
            </div>
            {invoice.taxNote ? (
              <p className="border-t border-slate-100 pt-3 text-[11px] text-slate-500">{invoice.taxNote}</p>
            ) : null}
          </div>

          {/* Line items */}
          {invoice.lineItems.length > 0 && (
            <div className="rounded-container bg-surface p-4 ring-1 ring-edge shadow-subtle space-y-2">
              <p className="text-[11px] font-semibold text-slate-400">Positionen</p>
              {invoice.lineItems.map((li) => (
                <div key={li.id} className="flex justify-between gap-3 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {li.quantity > 1 ? `${li.quantity}× ` : ''}{li.label}
                  </span>
                  <span className="shrink-0 font-medium text-slate-800">
                    {formatInvoiceEuro(li.gross ?? li.total)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Timestamps. NO "Fällig:" line — dueAtLabel is a legacy non-escrow
              carry-over with no payment-deadline meaning in FixUp (escrow funded
              up-front; the invoice is never an outstanding claim). See
              03 Domains/Invoices.md + Block 7.1A Wording-Truth-Pass. */}
          <div className="space-y-1 text-[11px] text-slate-400">
            {issuedLabel && <p>Gestellt: {issuedLabel}</p>}
            {invoice.sentAt ? (
              <p>Versendet: {new Date(invoice.sentAt).toLocaleDateString('de-DE')}</p>
            ) : null}
          </div>

        </div>
      </section>
    </AppShell>
  )
}
