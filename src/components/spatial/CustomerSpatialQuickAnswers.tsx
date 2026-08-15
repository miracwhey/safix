/**
 * Spatial Lane 3 V1.6 Block 3 · CustomerSpatialQuickAnswers
 *
 * Three answer-cards above the 3D viewer on the customer detail screen.
 *
 *   1. Termin       — job.scheduledFor or "Noch nicht terminiert"
 *   2. Preis        — accepted offer amount or pending-offer hint
 *   3. Was wird gemacht — offer.line_items count + first item / job description
 *
 * Data sources are all existing SaFix domain stores. The component is
 * read-only and fails open — if any source is missing the card renders an
 * informational placeholder rather than throwing.
 */

import { useEffect, useState } from 'react'
import { Calendar, Coins, Hammer } from 'lucide-react'

import { subscribeJobs, getJobById } from '../../lib/jobs/service'
import { getAcceptedOfferByJobId } from '../../lib/offers/service'
import { subscribeOffers, isOfferRepositoryHydrated } from '../../lib/offers/service'
import { formatCents } from '../../lib/shared/formatters'
import type { Offer } from '../../lib/offers/types'
import type { Job } from '../../lib/jobs/types'

export interface CustomerSpatialQuickAnswersProps {
  jobId: string | null
}

interface AnswerCardProps {
  icon: React.ReactNode
  label: string
  value: string
  helper?: string
}

function AnswerCard({ icon, label, value, helper }: AnswerCardProps) {
  return (
    <div className="flex-1 rounded-container bg-surface px-4 py-3 ring-1 ring-edge shadow-sm">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand/10 text-brand">
          {icon}
        </span>
        <span>{label}</span>
      </div>
      <div className="mt-1 text-[14px] font-semibold text-ink">{value}</div>
      {helper ? <div className="mt-0.5 text-[11px] text-ink-muted">{helper}</div> : null}
    </div>
  )
}

function formatDate(ts: number | string | null | undefined): string {
  if (!ts) return '—'
  const date = typeof ts === 'number' ? new Date(ts) : new Date(ts)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
  } catch {
    return '—'
  }
}

function deriveTermin(job: Job | undefined): { value: string; helper?: string } {
  if (!job) return { value: '—' }
  // jobs/types: scheduledFor (ISO) or scheduledStart, fallback to acceptedAt
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = job as any
  const scheduled = j.scheduledFor ?? j.scheduledStart ?? j.scheduled_at
  if (scheduled) return { value: formatDate(scheduled), helper: 'Geplanter Termin' }
  return { value: 'Noch offen', helper: 'Wird vom Handwerker abgestimmt' }
}

function derivePreis(offer: Offer | undefined): { value: string; helper?: string } {
  if (!offer) return { value: 'Noch kein Angebot', helper: 'Sobald der Handwerker ein Angebot stellt, siehst du den Preis hier.' }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = offer as any
  const cents = o.totalCents ?? o.amountCents ?? o.priceCents ?? null
  if (cents == null || !Number.isFinite(cents)) {
    return { value: 'Im Angebot enthalten', helper: 'Details siehe Auftrag' }
  }
  return { value: formatCents(cents), helper: 'Aus dem angenommenen Angebot' }
}

function deriveScope(offer: Offer | undefined, job: Job | undefined): { value: string; helper?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = (offer as any) ?? null
  const items: Array<{ label?: string; title?: string }> = o?.lineItems ?? o?.line_items ?? []
  if (items.length > 0) {
    const first = items[0]?.label ?? items[0]?.title ?? 'Position'
    return {
      value: `${items.length} ${items.length === 1 ? 'Position' : 'Positionen'}`,
      helper: items.length === 1 ? first : `u. a. ${first}`,
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desc = (job as any)?.description ?? (job as any)?.title
  if (typeof desc === 'string' && desc.trim().length > 0) {
    const line = desc.split('\n')[0].slice(0, 60)
    return { value: line, helper: 'aus deinem Auftrag' }
  }
  return { value: '—', helper: 'Noch keine Details hinterlegt' }
}

export function CustomerSpatialQuickAnswers({ jobId }: CustomerSpatialQuickAnswersProps) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const unsub1 = subscribeJobs(() => setTick(t => t + 1))
    const unsub2 = subscribeOffers(() => setTick(t => t + 1))
    return () => {
      unsub1()
      unsub2()
    }
  }, [])

  if (!jobId) {
    return (
      <div className="rounded-container border border-dashed border-edge bg-slate-50 p-4 text-[12px] text-ink-muted">
        Dieses Aufmaß ist noch keinem Auftrag zugeordnet. Sobald du es einem Auftrag anhängst, erscheinen hier Termin, Preis und Scope.
      </div>
    )
  }

  const offerHydrated = isOfferRepositoryHydrated()
  const job = getJobById(jobId)
  const offer = offerHydrated ? getAcceptedOfferByJobId(jobId) : undefined

  const termin = deriveTermin(job)
  const preis = derivePreis(offer)
  const scope = deriveScope(offer, job)

  // tick is read to force re-render on store updates
  void tick

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <AnswerCard
        icon={<Calendar size={14} />}
        label="Termin"
        value={termin.value}
        helper={termin.helper}
      />
      <AnswerCard
        icon={<Coins size={14} />}
        label="Preis"
        value={preis.value}
        helper={preis.helper}
      />
      <AnswerCard
        icon={<Hammer size={14} />}
        label="Was wird gemacht"
        value={scope.value}
        helper={scope.helper}
      />
    </div>
  )
}
