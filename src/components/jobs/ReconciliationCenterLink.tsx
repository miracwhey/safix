/**
 * `ReconciliationCenterLink` — small banner that surfaces the public
 * Aktenzeichen for a job's dispute and (for craftsman owners) links to the
 * full reconciliation center entry. Customers stay on the project page; their
 * dispute view remains embedded.
 *
 * Mounts inside the existing dispute section on the job/project detail
 * screens — additive and non-invasive.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, ScaleIcon } from 'lucide-react'
import { getDisputeByJobId, subscribeDisputes } from '../../lib/disputes/disputeStore'
import {
  aktenzeichenToUrlSlug,
  formatAktenzeichen,
} from '../../lib/reconciliation/aktenzeichen'

type Props = {
  jobId: string
  /** Whether to render the link to the profile-side reconciliation center. */
  variant: 'owner' | 'customer'
}

export default function ReconciliationCenterLink({ jobId, variant }: Props) {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const unsub = subscribeDisputes(() => setVersion((v) => v + 1))
    return unsub
  }, [])

  const dispute = getDisputeByJobId(jobId)
  if (!dispute) return null
  const akz = formatAktenzeichen(dispute.id, dispute.createdAt)
  if (!akz) return null

  // version is consumed via getDisputeByJobId above (re-runs on bump).
  void version

  return (
    <div className="rounded-card border border-edge bg-surface p-3 shadow-subtle flex items-center gap-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-card bg-brand/10 text-brand flex-shrink-0">
        <ScaleIcon className="h-4 w-4" strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold tracking-[.06em] uppercase text-ink-muted tabular-nums">
          {akz}
        </p>
        <p className="text-[13px] font-medium text-ink leading-snug">
          Streitfall · Aufbewahrung 10 Jahre
        </p>
      </div>
      {variant === 'owner' ? (
        <Link
          to={`/craftsman/profile/disputes/${aktenzeichenToUrlSlug(akz)}`}
          className="inline-flex items-center gap-1 rounded-chip border border-brand/30 bg-brand/5 px-3 py-1 text-[12px] font-semibold text-brand whitespace-nowrap"
        >
          Im Center öffnen
          <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.2} />
        </Link>
      ) : null}
    </div>
  )
}
