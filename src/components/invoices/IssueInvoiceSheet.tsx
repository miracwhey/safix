import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import CorridorAction from '../system/CorridorAction'
import {
  buildInvoiceSnapshot,
  type LineItemVatOverride,
} from '../../lib/invoices/invoiceSnapshotBuilder'
import {
  resolveDefaultServicePeriod,
  normalizeServicePeriod,
} from '../../lib/invoices/invoiceServicePeriodResolver'
import type {
  Invoice,
  InvoiceLineItem,
  InvoiceLineItemCategory,
  InvoiceServicePeriod,
} from '../../lib/invoices/types'
import { isAllowedVatRate } from '../../lib/invoices/invoiceTaxModel'
import { issueInvoiceWithSnapshotWorkflow } from '../../lib/workflow'
import { mapInvoiceWorkflowError } from './invoiceErrorMapper'
import { normalizeErrorMessage } from '../../lib/diagnostics'
import {
  getMyProviderProfile,
  type ProviderProfile,
} from '../../lib/providers/providerProfileService'
import { isTaxProfileComplete } from '../../lib/providers/taxProfileSelectors'
import { getCustomerBillingForInvoice } from '../../lib/customer/customerBillingProfileService'
import { getOfferById, getAcceptedOfferByJobId } from '../../lib/offers'
import { getChangeOrdersByJobId } from '../../lib/changeOrders'
import { getSupplementaryPaymentsByJobId } from '../../lib/payments/supplementary'
import { getJobs } from '../../lib/jobs'
import { getScheduleForJob } from '../../lib/operations'

type Props = {
  invoice: Invoice
  onIssued: () => void
  onClose: () => void
}

type CustomerBillingForInvoice = NonNullable<
  Awaited<ReturnType<typeof getCustomerBillingForInvoice>>
>

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | {
      phase: 'ready'
      provider: ProviderProfile
      customer: CustomerBillingForInvoice | null
      defaultPeriod: InvoiceServicePeriod | null
    }

const ALLOWED_RATES = [0, 7, 19] as const

function toDateInputValue(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function fromDateInputValue(value: string): number | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : null
}

function formatEuro(value: number): string {
  return value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
}

export default function IssueInvoiceSheet({ invoice, onIssued, onClose }: Props) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [periodFromInput, setPeriodFromInput] = useState('')
  const [periodToInput, setPeriodToInput] = useState('')
  const [overrides, setOverrides] = useState<
    Record<string, { vatRate?: number; category?: InvoiceLineItemCategory }>
  >({})
  const [previewLines, setPreviewLines] = useState<InvoiceLineItem[]>([])
  const [previewTotals, setPreviewTotals] = useState<{
    netAmount: number
    taxAmount: number
    grossAmount: number
  } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Load Provider/Customer/Schedule once when sheet mounts ───────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [provider, customer] = await Promise.all([
          getMyProviderProfile(),
          getCustomerBillingForInvoice(invoice.jobId),
        ])
        if (cancelled) return
        if (!provider) {
          setState({
            phase: 'error',
            message:
              'Betriebsprofil noch nicht angelegt. Bitte zuerst dein Profil speichern.',
          })
          return
        }
        const job = getJobs().find((j) => j.id === invoice.jobId)
        const schedule = job ? getScheduleForJob(job.id) ?? null : null
        const defaultPeriod = job
          ? resolveDefaultServicePeriod({ job, schedule })
          : null
        if (defaultPeriod) {
          setPeriodFromInput(toDateInputValue(defaultPeriod.from))
          setPeriodToInput(toDateInputValue(defaultPeriod.to))
        }
        setState({ phase: 'ready', provider, customer, defaultPeriod })
      } catch (err) {
        if (cancelled) return
        setState({ phase: 'error', message: normalizeErrorMessage(err) })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [invoice.jobId])

  // ── Re-compute Snapshot-Preview whenever inputs change ───────────────────
  const lineItemOverrides = useMemo<LineItemVatOverride[]>(() => {
    return Object.entries(overrides)
      .filter(([, v]) => v.vatRate !== undefined || v.category !== undefined)
      .map(([id, v]) => ({
        lineItemId: id,
        vatRate: v.vatRate,
        category: v.category,
      }))
  }, [overrides])

  useEffect(() => {
    if (state.phase !== 'ready') {
      setPreviewLines([])
      setPreviewTotals(null)
      setPreviewError(null)
      return
    }
    const job = getJobs().find((j) => j.id === invoice.jobId)
    if (!job) {
      setPreviewError('Job nicht gefunden.')
      return
    }
    const offer = job.sourceOfferId
      ? getOfferById(job.sourceOfferId) ?? null
      : getAcceptedOfferByJobId(job.id) ?? null
    const acceptedChangeOrders = getChangeOrdersByJobId(job.id).filter(
      (co) => co.status === 'accepted',
    )
    const supplementaryPayments = getSupplementaryPaymentsByJobId(job.id)

    const fromTs = fromDateInputValue(periodFromInput)
    const toTs = fromDateInputValue(periodToInput)
    const period: InvoiceServicePeriod | null =
      fromTs || toTs
        ? normalizeServicePeriod({
            from: fromTs,
            to: toTs ?? fromTs,
            label: '',
          })
        : state.defaultPeriod

    try {
      const snap = buildInvoiceSnapshot({
        job,
        offer,
        acceptedChangeOrders,
        supplementaryPayments,
        provider: {
          providerId: state.provider.id,
          companyName: state.provider.companyName,
          businessAddress: state.provider.businessAddress,
          taxNumber: state.provider.taxProfile.taxNumber,
          vatId: state.provider.taxProfile.vatId,
          legalForm: state.provider.taxProfile.legalForm,
          isKleinunternehmer: state.provider.taxProfile.isKleinunternehmer,
          defaultVatRate: state.provider.taxProfile.defaultVatRate,
          iban: state.provider.taxProfile.iban,
          bic: state.provider.taxProfile.bic,
        },
        customer: state.customer
          ? {
              userId: state.customer.userId,
              billingName: state.customer.billingName,
              billingAddressLine1: state.customer.billingAddressLine1,
              billingAddressLine2: state.customer.billingAddressLine2,
              billingPostalCode: state.customer.billingPostalCode,
              billingCity: state.customer.billingCity,
              billingCountry: state.customer.billingCountry,
              billingEmail: state.customer.billingEmail,
              billingPhone: state.customer.billingPhone,
              isBusiness: state.customer.isBusiness,
              businessName: state.customer.businessName,
              vatId: state.customer.vatId,
            }
          : null,
        servicePeriod: period,
        lineItemOverrides,
      })
      setPreviewLines(snap.lineItems)
      setPreviewTotals(snap.amounts)
      setPreviewError(null)
    } catch (err) {
      setPreviewLines([])
      setPreviewTotals(null)
      setPreviewError(normalizeErrorMessage(err))
    }
  }, [
    state,
    invoice.jobId,
    periodFromInput,
    periodToInput,
    lineItemOverrides,
  ])

  const handleConfirm = async () => {
    if (busy || state.phase !== 'ready') return
    const fromTs = fromDateInputValue(periodFromInput)
    const toTs = fromDateInputValue(periodToInput)
    const servicePeriod: InvoiceServicePeriod | undefined =
      fromTs || toTs
        ? normalizeServicePeriod({
            from: fromTs,
            to: toTs ?? fromTs,
            label: '',
          }) ?? undefined
        : undefined
    setBusy(true)
    setError(null)
    try {
      await issueInvoiceWithSnapshotWorkflow(invoice.jobId, {
        servicePeriod,
        lineItemOverrides,
      })
      onIssued()
    } catch (err) {
      setError(mapInvoiceWorkflowError(err))
    } finally {
      setBusy(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (state.phase === 'loading') {
    return (
      <div
        className="rounded-[16px] bg-white p-4 ring-1 ring-slate-200/70"
        data-testid="issue-invoice-sheet"
      >
        <p className="py-4 text-center text-[13px] text-slate-400">
          Daten werden geladen…
        </p>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div
        className="rounded-[16px] bg-white p-4 ring-1 ring-slate-200/70"
        data-testid="issue-invoice-sheet"
      >
        <p className="py-4 text-center text-[13px] text-red-500">
          {state.message}
        </p>
        <CorridorAction variant="ghost" size="sm" onClick={onClose}>
          Schließen
        </CorridorAction>
      </div>
    )
  }

  const providerComplete = isTaxProfileComplete(state.provider.taxProfile)
  // Inline-Check der Customer-Pflichtfelder. Wir verwenden den
  // `customer_billing_profiles`-Selector hier bewusst nicht, weil der
  // RPC-Reader nur das Subset der Felder zurückgibt und kein
  // CustomerBillingProfile mit id/createdAt liefert.
  const customerComplete = (() => {
    const c = state.customer
    if (!c) return false
    const name = (c.billingName ?? '').trim()
    const line1 = (c.billingAddressLine1 ?? '').trim()
    const postal = (c.billingPostalCode ?? '').trim()
    const city = (c.billingCity ?? '').trim()
    const country = (c.billingCountry ?? '').trim()
    if (!name || !line1 || !postal || !city || country.length !== 2) return false
    if (c.isBusiness && !(c.businessName ?? '').trim()) return false
    return true
  })()
  const blockingMissing = !providerComplete || !customerComplete

  return (
    <div
      className="rounded-[16px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_34px_-26px_rgba(2,6,23,0.16)] space-y-4"
      data-testid="issue-invoice-sheet"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[16px]">📄</span>
          <span className="text-[14px] font-semibold text-slate-800">
            Rechnung ausstellen
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

      {/* Provider status */}
      <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Aussteller
        </p>
        <div className="text-[13px] font-semibold text-slate-800">
          {state.provider.companyName || '—'}
        </div>
        <div className="text-[12px] text-slate-500">
          {state.provider.businessAddress || 'Geschäftsanschrift fehlt'}
        </div>
        <div className="mt-1 text-[12px] text-slate-500">
          {state.provider.taxProfile.taxNumber
            ? `Steuernummer: ${state.provider.taxProfile.taxNumber}`
            : state.provider.taxProfile.vatId
              ? `USt-IdNr.: ${state.provider.taxProfile.vatId}`
              : 'Keine Steuernummer / USt-IdNr. hinterlegt'}
        </div>
        {!providerComplete && (
          <Link
            to="/craftsman/profile/tax-bank"
            className="mt-2 inline-flex items-center text-[12px] font-semibold text-emerald-700 underline"
          >
            Steuerdaten ergänzen →
          </Link>
        )}
      </div>

      {/* Customer status */}
      <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Empfänger
        </p>
        {state.customer ? (
          <>
            <div className="text-[13px] font-semibold text-slate-800">
              {state.customer.billingName || invoice.parties.customerName || '—'}
            </div>
            <div className="text-[12px] text-slate-500">
              {state.customer.billingAddressLine1 || '—'}
              {state.customer.billingAddressLine2
                ? `, ${state.customer.billingAddressLine2}`
                : ''}
            </div>
            <div className="text-[12px] text-slate-500">
              {[state.customer.billingPostalCode, state.customer.billingCity]
                .filter(Boolean)
                .join(' ') || '—'}{' '}
              · {state.customer.billingCountry}
            </div>
            {state.customer.isBusiness && state.customer.businessName && (
              <div className="text-[12px] text-slate-500">
                {state.customer.businessName}
                {state.customer.vatId ? ` · ${state.customer.vatId}` : ''}
              </div>
            )}
          </>
        ) : (
          <div className="text-[13px] text-slate-700">
            Der Kunde hat noch keine Rechnungsdaten hinterlegt.
          </div>
        )}
        {!customerComplete && (
          <p className="mt-2 text-[12px] text-amber-700">
            Der Kunde muss seine Rechnungsdaten unter „Konto → Rechnungsdaten"
            ergänzen, bevor du eine §14-konforme Rechnung ausstellen kannst.
          </p>
        )}
      </div>

      {/* Service period */}
      <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Leistungszeitraum (§14 UStG)
        </p>
        <div className="flex items-center gap-2">
          <label className="flex flex-col gap-0.5 text-[12px] text-slate-500">
            Von
            <input
              type="date"
              value={periodFromInput}
              onChange={(e) => setPeriodFromInput(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[13px] text-slate-800"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[12px] text-slate-500">
            Bis
            <input
              type="date"
              value={periodToInput}
              onChange={(e) => setPeriodToInput(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[13px] text-slate-800"
            />
          </label>
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Wenn nur ein Datum bekannt ist, reicht das „Bis"-Feld als Leistungsdatum.
        </p>
      </div>

      {/* Line items */}
      <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Positionen & Steuersätze
        </p>
        {previewLines.length === 0 ? (
          <p className="text-[12px] text-slate-500">
            Keine Positionen aus Offer + Nachträgen verfügbar.
          </p>
        ) : (
          <div className="space-y-2">
            {previewLines.map((li) => (
              <div
                key={li.id}
                className="rounded-lg bg-white p-2 ring-1 ring-slate-100"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[13px] text-slate-700">
                    {li.quantity > 1 ? `${li.quantity}× ` : ''}
                    {li.label}
                  </span>
                  <span className="shrink-0 text-[13px] font-medium text-slate-900">
                    {formatEuro(li.gross ?? li.total)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                  <label className="flex items-center gap-1">
                    Kategorie
                    <select
                      value={li.category ?? 'labor'}
                      onChange={(e) =>
                        setOverrides((prev) => ({
                          ...prev,
                          [li.id]: {
                            ...prev[li.id],
                            category: e.target
                              .value as InvoiceLineItemCategory,
                          },
                        }))
                      }
                      className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px]"
                    >
                      <option value="labor">Lohn</option>
                      <option value="material">Material</option>
                      <option value="travel">Anfahrt</option>
                      <option value="other">Sonstiges</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    USt
                    <select
                      value={li.vatRate ?? 19}
                      onChange={(e) => {
                        const next = Number(e.target.value)
                        if (!isAllowedVatRate(next)) return
                        setOverrides((prev) => ({
                          ...prev,
                          [li.id]: { ...prev[li.id], vatRate: next },
                        }))
                      }}
                      className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px]"
                    >
                      {ALLOWED_RATES.map((rate) => (
                        <option key={rate} value={rate}>
                          {rate} %
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
        {previewTotals && (
          <div className="mt-2 space-y-0.5 border-t border-slate-200 pt-2 text-[12px] text-slate-600">
            <div className="flex justify-between">
              <span>Netto</span>
              <span>{formatEuro(previewTotals.netAmount)}</span>
            </div>
            <div className="flex justify-between">
              <span>USt</span>
              <span>{formatEuro(previewTotals.taxAmount)}</span>
            </div>
            <div className="flex justify-between text-[13px] font-semibold text-slate-900">
              <span>Brutto</span>
              <span>{formatEuro(previewTotals.grossAmount)}</span>
            </div>
          </div>
        )}
        {previewError && (
          <p className="mt-2 text-[12px] text-red-500" role="alert">
            {previewError}
          </p>
        )}
      </div>

      {/* Action */}
      <div className="flex gap-2">
        <CorridorAction
          variant="primary"
          size="sm"
          loading={busy}
          disabled={blockingMissing || !!previewError || !previewTotals}
          onClick={handleConfirm}
          data-testid="issue-invoice-confirm"
        >
          {busy ? '…' : 'Rechnung ausstellen'}
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
  )
}
