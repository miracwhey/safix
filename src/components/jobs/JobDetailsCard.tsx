import CraftsmanSectionCard from '../CraftsmanSectionCard'
import CraftsmanInfoRow from '../CraftsmanInfoRow'
import type { Job } from '../../lib/jobs'
import { resolveCanonicalProjectFacts } from '../../lib/shared/canonicalProjectFacts'

type Props = {
  job: Job
}

export default function JobDetailsCard({ job }: Props) {
  const facts = resolveCanonicalProjectFacts(job.id)

  // Derive display values: canonical facts for accepted/booked jobs,
  // raw job fields otherwise.
  // Use nullish coalescing (??) not logical-or (||) to preserve ''
  // from canonical resolver when it intentionally resolves to empty.
  const title = facts?.title ?? job.title
  const customer = (facts?.customer ?? job.customer) || '–'
  const amount = facts?.canonicalAmount?.formatted || job.amount || '–'
  const location = facts?.location ?? job.location
  const dateLabel = facts?.dateLabel ?? job.dateLabel

  return (
    <CraftsmanSectionCard
      eyebrow="Auftragsdetails"
      title={title}
      subtitle="Zentrale Übersicht für Status, Kommunikation und nächste operative Schritte."
    >
      <div className="divide-y divide-slate-100">
        <CraftsmanInfoRow label="Kunde" value={customer} />
        <CraftsmanInfoRow label="Auftragswert" value={amount} />
        <CraftsmanInfoRow label="Ort" value={location} />
        <CraftsmanInfoRow label="Termin" value={dateLabel} />
      </div>
    </CraftsmanSectionCard>
  )
}
