import { useState } from 'react'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments, isPaymentRepositoryHydrated } from '../../lib/payments'
import {
  getInvoiceByJobId,
  subscribeInvoices,
  deriveCustomerInvoiceView,
  formatInvoiceEuro,
  downloadInvoicePdf,
  isInvoiceRepositoryHydrated,
} from '../../lib/invoices'
import type { CustomerInvoiceViewModel, CustomerInvoicePaymentStatus } from '../../lib/invoices'
import { customerReleasePaymentWorkflow } from '../../lib/workflow'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  jobId: string | undefined
}

// ── Colour tokens per payment status ──────────────────────────────────────────

type ColourSet = {
  ring: string
  accentBar: string
  badgeBg: string
  iconBg: string
  iconShadow: string
  bannerBg: string
  bannerText: string
  icon: string
}

function getColours(status: CustomerInvoicePaymentStatus): ColourSet {
  switch (status) {
    case 'released':
      return {
        ring: 'ring-emerald-200/80',
        accentBar: 'bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300',
        badgeBg: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
        iconBg: 'bg-emerald-500',
        iconShadow: '0 8px 20px -12px rgba(16,185,129,0.5)',
        bannerBg: 'bg-emerald-50',
        bannerText: 'text-emerald-800',
        icon: '✅',
      }
    case 'disputed':
      return {
        ring: 'ring-red-200/80',
        accentBar: 'bg-gradient-to-b from-red-500 via-red-400 to-red-300',
        badgeBg: 'bg-red-50 text-red-700 ring-red-100',
        iconBg: 'bg-red-500',
        iconShadow: '0 8px 20px -12px rgba(239,68,68,0.5)',
        bannerBg: 'bg-red-50',
        bannerText: 'text-red-800',
        icon: '⚠️',
      }
    case 'refunded':
      return {
        ring: 'ring-amber-200/80',
        accentBar: 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300',
        badgeBg: 'bg-amber-50 text-amber-700 ring-amber-100',
        iconBg: 'bg-amber-500',
        iconShadow: '0 8px 20px -12px rgba(245,158,11,0.5)',
        bannerBg: 'bg-amber-50',
        bannerText: 'text-amber-800',
        icon: '↩',
      }
    case 'awaiting_release':
      return {
        ring: 'ring-violet-200/80',
        accentBar: 'bg-gradient-to-b from-violet-500 via-violet-400 to-blue-400',
        badgeBg: 'bg-violet-50 text-violet-700 ring-violet-100',
        iconBg: 'bg-violet-500',
        iconShadow: '0 8px 20px -12px rgba(139,92,246,0.5)',
        bannerBg: 'bg-violet-50',
        bannerText: 'text-violet-800',
        icon: '💳',
      }
    default: // 'pending'
      return {
        ring: 'ring-slate-200/80',
        accentBar: 'bg-gradient-to-b from-slate-400 via-slate-300 to-slate-200',
        badgeBg: 'bg-slate-50 text-slate-600 ring-slate-200',
        iconBg: 'bg-slate-400',
        iconShadow: '0 8px 20px -12px rgba(100,116,139,0.4)',
        bannerBg: 'bg-slate-50',
        bannerText: 'text-slate-700',
        icon: '🧾',
      }
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AmountRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={`text-[13px] ${bold ? 'font-semibold text-slate-800' : 'text-slate-400'}`}>
        {label}
      </span>
      <span className={`text-right text-[13px] ${bold ? 'font-bold text-slate-900' : 'font-semibold text-slate-700'}`}>
        {value}
      </span>
    </div>
  )
}

// ── Card view ──────────────────────────────────────────────────────────────────

function CustomerInvoiceCardView({
  vm,
  jobId,
}: {
  vm: CustomerInvoiceViewModel
  jobId: string
}) {
  const [releasing, setReleasing] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)

  const colours = getColours(vm.paymentStatus)

  async function handleRelease() {
    if (releasing) return
    setReleasing(true)
    setReleaseError(null)
    try {
      await customerReleasePaymentWorkflow(jobId)
    } catch (e) {
      console.error(e)
      setReleaseError('Freigabe fehlgeschlagen. Bitte versuche es erneut.')
    } finally {
      setReleasing(false)
    }
  }

  return (
    <section
      className={`relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ${colours.ring} shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]`}
    >
      {/* Left accent bar */}
      <div
        className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] ${colours.accentBar}`}
      />

      {/* Eyebrow + badge */}
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Rechnung
        </span>
        {vm.invoiceNumber && (
          <span className="text-[12px] text-slate-400">· {vm.invoiceNumber}</span>
        )}
        <span
          className={`ml-auto inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] ring-1 ${colours.badgeBg}`}
        >
          {vm.paymentStatusLabel}
        </span>
      </div>

      {/* Icon + headline */}
      <div className="mt-3 flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${colours.iconBg}`}
          style={{ boxShadow: colours.iconShadow }}
        >
          <span className="text-[18px] leading-none">{colours.icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-snug text-slate-900">
            {vm.jobTitle}
          </h2>
          {vm.craftsmanName && (
            <p className="mt-0.5 text-[13px] text-slate-500">{vm.craftsmanName}</p>
          )}
        </div>
      </div>

      {/* Line items table */}
      {vm.lineItems.length > 0 && (
        <>
          <div className="my-4 h-px bg-slate-100" />
          <div className="space-y-1.5">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 pb-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Pos.
              </span>
              <span className="text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Menge
              </span>
              <span className="text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                EP
              </span>
              <span className="text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Gesamt
              </span>
            </div>
            {vm.lineItems.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 rounded-xl bg-slate-50 px-2 py-2"
              >
                <span className="text-[13px] leading-snug text-slate-700">{item.label}</span>
                <span className="text-right text-[13px] text-slate-500">{item.quantity}</span>
                <span className="text-right text-[13px] text-slate-500">
                  {formatInvoiceEuro(item.unitPrice)}
                </span>
                <span className="text-right text-[13px] font-semibold text-slate-700">
                  {formatInvoiceEuro(item.total)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Amount summary */}
      <div className="my-4 h-px bg-slate-100" />
      <div className="space-y-2">
        <AmountRow label="Nettobetrag" value={vm.formattedNet} />
        <AmountRow label="MwSt." value={vm.formattedTax} />
        <div className="h-px bg-slate-100" />
        <AmountRow label="Gesamtbetrag" value={vm.formattedTotal} bold />
      </div>

      {/* Status banner */}
      <div
        className={`mt-4 flex items-center gap-2 rounded-2xl px-4 py-3 ${colours.bannerBg}`}
      >
        <span className="text-[16px]">{colours.icon}</span>
        <span className={`text-[13px] font-semibold ${colours.bannerText}`}>
          {vm.paymentStatusLabel}
        </span>
      </div>

      {/* PDF download button */}
      {(() => {
        const invoice = getInvoiceByJobId(jobId)
        if (!invoice || invoice.status === 'draft') return null
        return (
          <>
            <button
              onClick={() => {
                setPdfError(null)
                void downloadInvoicePdf(invoice).catch(() =>
                  setPdfError('Rechnung konnte nicht erstellt werden. Bitte später erneut versuchen.'),
                )
              }}
              className="mt-3 w-full rounded-2xl bg-slate-50 px-4 py-3 text-[13px] font-semibold text-slate-700 ring-1 ring-slate-200/70 transition active:scale-[0.98]"
            >
              Rechnung als PDF herunterladen
            </button>
            {pdfError ? <p className="mt-1.5 text-[12px] text-rose-600">{pdfError}</p> : null}
          </>
        )
      })()}

      {/* Release payment button */}
      {vm.canReleasePayment && (
        <>
          <p className="mt-4 text-[12px] leading-relaxed text-slate-500">
            Der Betrag ist bereits über Stripe abgesichert. Mit der
            Bestätigung gibst du ihn an den Handwerker frei.
          </p>
          <button
            onClick={handleRelease}
            disabled={releasing}
            className="mt-2 w-full rounded-2xl bg-violet-600 px-5 py-3.5 text-[15px] font-semibold text-white shadow-[0_6px_18px_-8px_rgba(139,92,246,0.6)] transition-opacity disabled:opacity-60 active:opacity-80"
          >
            {releasing ? 'Wird verarbeitet…' : 'Bestätigen & freigeben'}
          </button>
          {releaseError && (
            <p className="mt-2 text-[12px] leading-relaxed text-red-500">{releaseError}</p>
          )}
        </>
      )}
    </section>
  )
}

// ── Public export ──────────────────────────────────────────────────────────────

export default function CustomerInvoiceCard({ jobId }: Props) {
  function buildVm(): { vm: CustomerInvoiceViewModel; jobId: string } | null {
    if (!jobId) return null
    // Hydration gate (Z.125): the invoice view derives from both the invoice and
    // the payment repo. Until both have finished their initial load, render
    // nothing rather than a stale "pending" / "no invoice" state.
    if (!isInvoiceRepositoryHydrated() || !isPaymentRepositoryHydrated()) return null
    const job = getJobById(jobId)
    if (!job) return null
    const payment = getPaymentForJob(jobId)
    const invoice = getInvoiceByJobId(jobId)
    const vm = deriveCustomerInvoiceView(job, payment ?? undefined, invoice)
    if (!vm) return null
    // Terminal states are covered by CustomerJobCompletionCard — suppress the
    // invoice card to avoid repeating "Zahlung freigegeben / Betrag erstattet".
    if (vm.paymentStatus === 'released' || vm.paymentStatus === 'refunded') return null
    return { vm, jobId }
  }

  const [result, setResult] = useState<{ vm: CustomerInvoiceViewModel; jobId: string } | null>(
    buildVm
  )

  useStoreSync([subscribeJobs, subscribePayments, subscribeInvoices], () => {
    setResult(buildVm())
  })

  if (!result) return null

  return <CustomerInvoiceCardView vm={result.vm} jobId={result.jobId} />
}
