import { useEffect, useMemo, useState } from 'react'
import AppShell from '../components/AppShell'
import CraftsmanSectionCard from '../components/CraftsmanSectionCard'
import ProActionGuard from '../components/subscription/ProActionGuard'
import InvoiceLinkSection from '../components/invoices/InvoiceLinkSection'
import InvoicesOverviewCard from '../components/invoices/InvoicesOverviewCard'
import OpenInvoicesSection from '../components/invoices/OpenInvoicesSection'
import PaidInvoicesSection from '../components/invoices/PaidInvoicesSection'
import { mapInvoiceWorkflowError } from '../components/invoices/invoiceErrorMapper'
import InvoiceCreationSheet from '../components/invoices/InvoiceCreationSheet'
import IssueInvoiceSheet from '../components/invoices/IssueInvoiceSheet'
import InvoiceCorrectionSheet from '../components/invoices/InvoiceCorrectionSheet'
import { useSubscription } from '../hooks/useSubscription'
import {
  ensureInvoiceForJobId,
  getInvoiceByJobId,
  getInvoices,
  getOpenInvoices,
  getPaidInvoices,
  getPrimaryInvoices,
  getCorrectionInvoices,
  subscribeInvoices,
  isJobWithoutInvoice,
  isInvoiceRepositoryHydrated,
  type Invoice,
} from '../lib/invoices'
import { getJobs, subscribeJobs, type Job } from '../lib/jobs'
import { getPaymentForJob, subscribePayments } from '../lib/payments'
import { markInvoiceSentWorkflow } from '../lib/workflow'
import { downloadInvoicePdf } from '../lib/invoices'
import { resolveCanonicalAmount } from '../lib/shared/canonicalAmountResolver'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import { ArrowLeft } from 'lucide-react'
import { useSmartBack } from '../hooks/useSmartBack'

// Initial number of open and paid invoices visible before "show more" appears.
const OPEN_INVOICES_INITIAL = 5
const PAID_INVOICES_INITIAL = 5

function isInvoiceRelevantJob(job: Job): boolean {
  // Use canonical payment state for the payment-dependent checks.
  const payment = getPaymentForJob(job.id)
  const paymentState = payment?.state ?? job.paymentState
  return (
    job.status === 'waiting_payment' ||
    job.status === 'completed' ||
    paymentState === 'release_pending' ||
    paymentState === 'released'
  )
}

function JobsWithoutInvoiceSection({ jobs, onCreated, subscription }: { jobs: Job[]; onCreated: () => void; subscription: ReturnType<typeof useSubscription> }) {
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)

  if (jobs.length === 0) return null

  return (
    <CraftsmanSectionCard
      eyebrow="Auswahl"
      title="Jobs ohne Rechnung"
      subtitle="Für diese Jobs kannst du manuell eine Rechnung erstellen."
    >
      <div className="space-y-2">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="flex items-center justify-between gap-3 rounded-[18px] bg-white p-3 ring-1 ring-slate-200/70"
          >
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold text-slate-900">
                {job.title}
              </div>
              <div className="text-[13px] text-slate-500">
                {job.customer} · {resolveCanonicalAmount(job.id).formatted || job.amount}
              </div>
            </div>
            <ProActionGuard
              action="open_invoice_creator"
              effectiveState={subscription.effectiveState}
              scope={subscription.scope}
              onAction={() => setSelectedJob(job)}
              onTrialStarted={subscription.refetch}
            >
              {(guardedOnClick) => (
                <button
                  disabled={selectedJob !== null}
                  onClick={guardedOnClick}
                  className="shrink-0 rounded-xl bg-emerald-50 px-3 py-2 text-[12px] font-semibold text-emerald-700 ring-1 ring-emerald-200 transition active:scale-[0.97] disabled:opacity-60"
                >
                  Rechnung erstellen
                </button>
              )}
            </ProActionGuard>
          </div>
        ))}
      </div>

      {selectedJob && (
        <div className="mt-3">
          <InvoiceCreationSheet
            job={selectedJob}
            onCreated={() => {
              setSelectedJob(null)
              onCreated()
            }}
            onClose={() => setSelectedJob(null)}
          />
        </div>
      )}
    </CraftsmanSectionCard>
  )
}

export default function CraftsmanInvoicesScreen() {
  const invoicesReady = isInvoiceRepositoryHydrated()
  const subscription = useSubscription()
  const goBack = useSmartBack('/craftsman/finance')
  const [jobs, setJobs] = useState<Job[]>(getJobs())
  const [invoices, setInvoices] = useState<Invoice[]>(getInvoices())
  const [showAllOpenInvoices, setShowAllOpenInvoices] = useState(false)
  const [showAllPaidInvoices, setShowAllPaidInvoices] = useState(false)
  const [invoiceError, setInvoiceError] = useState<string | null>(null)
  const [issueSheetInvoice, setIssueSheetInvoice] = useState<Invoice | null>(null)
  const [correctionSheetInvoice, setCorrectionSheetInvoice] =
    useState<Invoice | null>(null)

  useEffect(() => {
    const relevantJobs = getJobs().filter(isInvoiceRelevantJob)

    relevantJobs.forEach((job) => {
      ensureInvoiceForJobId(job.id)
    })

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInvoices(getInvoices())

    const unsubscribeJobs = subscribeJobs(() => {
      const nextJobs = getJobs()
      setJobs(nextJobs)

      nextJobs
        .filter(isInvoiceRelevantJob)
        .forEach((job) => ensureInvoiceForJobId(job.id))

      setInvoices(getInvoices())
    })

    const unsubscribeInvoices = subscribeInvoices(() => {
      setInvoices(getInvoices())
    })

    // Payment state changes can affect invoice relevance (canonical payment
    // may update before job mirror syncs). Re-evaluate when payments change.
    const unsubscribePayments = subscribePayments(() => {
      const nextJobs = getJobs()
      setJobs(nextJobs)

      nextJobs
        .filter(isInvoiceRelevantJob)
        .forEach((job) => ensureInvoiceForJobId(job.id))

      setInvoices(getInvoices())
    })

    return () => {
      unsubscribeJobs()
      unsubscribeInvoices()
      unsubscribePayments()
    }
  }, [])

  const openInvoices = useMemo(() => getOpenInvoices(invoices), [invoices])
  const paidInvoices = useMemo(() => getPaidInvoices(invoices), [invoices])
  const jobsWithoutInvoice = useMemo(() => jobs.filter((j) => isJobWithoutInvoice(j, getPaymentForJob(j.id), getInvoiceByJobId)), [jobs])

  const visibleOpenInvoices = showAllOpenInvoices
    ? openInvoices
    : openInvoices.slice(0, OPEN_INVOICES_INITIAL)
  const hiddenOpenCount = openInvoices.length - visibleOpenInvoices.length

  const visiblePaidInvoices = showAllPaidInvoices
    ? paidInvoices
    : paidInvoices.slice(0, PAID_INVOICES_INITIAL)
  const hiddenPaidCount = paidInvoices.length - visiblePaidInvoices.length

  const hasNoContent =
    openInvoices.length === 0 && paidInvoices.length === 0 && jobsWithoutInvoice.length === 0

  if (!invoicesReady) {
    return (
      <AppShell active="home">
        <ScreenSkeleton variant="list" />
      </AppShell>
    )
  }

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <button
            type="button"
            onClick={goBack}
            aria-label="Zurück"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
          >
            <ArrowLeft size={18} className="text-ink" aria-hidden />
          </button>
          <InvoicesOverviewCard
            totalInvoices={getPrimaryInvoices(invoices).length}
            openInvoices={openInvoices.length}
            correctionsCount={getCorrectionInvoices(invoices).length}
          />

          {hasNoContent ? (
            <div className="rounded-[20px] bg-white px-5 py-8 ring-1 ring-slate-200/70 text-center">
              <div className="text-[15px] font-semibold text-slate-700">Keine Rechnungen</div>
              <div className="mt-1.5 text-[13px] text-slate-400 leading-relaxed">
                Sobald ein Auftrag abgeschlossen ist, kannst du hier eine Rechnung erstellen.
              </div>
            </div>
          ) : (
            <JobsWithoutInvoiceSection
              jobs={jobsWithoutInvoice}
              onCreated={() => setInvoices(getInvoices())}
              subscription={subscription}
            />
          )}

          <OpenInvoicesSection
            invoices={visibleOpenInvoices}
            allInvoices={invoices}
            hiddenCount={hiddenOpenCount}
            errorMessage={invoiceError}
            effectiveState={subscription.effectiveState}
            scope={subscription.scope}
            onTrialStarted={subscription.refetch}
            onShowMore={() => setShowAllOpenInvoices(true)}
            onIssueInvoice={(invoice) => {
              setInvoiceError(null)
              setIssueSheetInvoice(invoice)
            }}
            onMarkSent={(invoice) => {
              setInvoiceError(null)
              markInvoiceSentWorkflow(invoice.jobId).catch((err: unknown) => {
                console.error('[CraftsmanInvoicesScreen] markInvoiceSentWorkflow failed', err)
                setInvoiceError(mapInvoiceWorkflowError(err))
              })
            }}
            onDownload={(invoice) => {
              setInvoiceError(null)
              downloadInvoicePdf(invoice).catch((err: unknown) => {
                console.error('[CraftsmanInvoicesScreen] downloadInvoicePdf failed', err)
                setInvoiceError(mapInvoiceWorkflowError(err))
              })
            }}
          />

          <PaidInvoicesSection
            invoices={visiblePaidInvoices}
            allInvoices={invoices}
            hiddenCount={hiddenPaidCount}
            onShowMore={() => setShowAllPaidInvoices(true)}
            onDownload={(invoice) => {
              setInvoiceError(null)
              downloadInvoicePdf(invoice).catch((err: unknown) => {
                console.error('[CraftsmanInvoicesScreen] downloadInvoicePdf failed', err)
                setInvoiceError(mapInvoiceWorkflowError(err))
              })
            }}
            onCreateCorrection={(invoice) => {
              setInvoiceError(null)
              setCorrectionSheetInvoice(invoice)
            }}
          />

          <InvoiceLinkSection
            jobsCount={jobs.length}
            openInvoicesCount={openInvoices.length}
          />

          {issueSheetInvoice && (
            <IssueInvoiceSheet
              invoice={issueSheetInvoice}
              onIssued={() => {
                setIssueSheetInvoice(null)
                setInvoices(getInvoices())
              }}
              onClose={() => setIssueSheetInvoice(null)}
            />
          )}

          {correctionSheetInvoice && (
            <InvoiceCorrectionSheet
              invoice={correctionSheetInvoice}
              onCorrectionIssued={() => {
                setCorrectionSheetInvoice(null)
                setInvoices(getInvoices())
              }}
              onClose={() => setCorrectionSheetInvoice(null)}
            />
          )}
        </div>
      </section>
    </AppShell>
  )
}
