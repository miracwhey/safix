import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispute, SplitProposal } from '../../lib/disputes/types'
import {
  getDisputeRepository,
  isDisputeRepositoryHydrated,
  ACTIVE_DISPUTE_STATUSES,
} from '../../lib/disputes'
import { resolveCanonicalAmount } from '../../lib/shared/canonicalAmountResolver'
import { resolveJobFeeRate } from '../../lib/shared/feeRate'
import { getEscrowPlanByJobId, getEscrowTranches } from '../../lib/payments'
import ConsensusSplitPanel from './ConsensusSplitPanel'

/**
 * Client feature flag for the consensus-split UI. Strict `=== 'true'`, default
 * OFF — mirrors the workflow-layer VITE_CONSENSUS_SPLIT_ENABLED gate. While OFF
 * this component renders nothing and runs no fetch, so the party surfaces are
 * byte-identical to today. Kept module-private so this file only exports the
 * component (fast-refresh contract).
 */
function isConsensusSplitUiEnabled(): boolean {
  return import.meta.env.VITE_CONSENSUS_SPLIT_ENABLED === 'true'
}

/**
 * Already-released craftsman share as a percent of the frozen total. Mirrors the
 * server held-predicate's complement at the tranche grain (a tranche counts as
 * 'with the craftsman' when status==='released' and not reversed — true for both
 * the transfer and the corridor payout release model). The consensus slider is
 * floored to this so a party can never propose below the already-paid-out share,
 * which would imply a clawback the corridor avoids. Module-private to preserve
 * the file's single-export fast-refresh contract.
 */
function deriveReleasedCraftsmanPercent(jobId: string, total: number): number {
  if (total <= 0) return 0
  const plan = getEscrowPlanByJobId(jobId)
  if (!plan) return 0
  const released = getEscrowTranches(plan.id)
    .filter((t) => t.status === 'released' && !t.transferReversalRef)
    .reduce((sum, t) => sum + t.amount, 0)
  return Math.floor((released / total) * 100)
}

type Props = {
  dispute: Dispute
  jobId: string
  /** Viewer's auth user id (from session). */
  currentUserId: string | undefined
  /**
   * True only when the viewer is a dispute PARTY (customer, or owner-craftsman)
   * — never the operator. The operator keeps the unilateral last-resort slider.
   */
  isParty: boolean
}

/**
 * Data wiring for the party-facing consensus-split flow. Mounted into
 * `DisputeResolutionCard`'s `consensusSlot` by the three party surfaces. Fetches
 * the dispute's currently-pending proposal and renders `ConsensusSplitPanel`.
 *
 * Realtime choice (v1): refetch-on-mount + refetch-after-action (onChanged) +
 * refetch-on-focus/visibility. The dispute itself already streams via the
 * dispute realtime channel, so the resolving confirm (which flips the dispute to
 * `resolved`) unmounts this slot through the `isActive` gate without a dedicated
 * proposals channel. A brand-new counter from the other party is picked up on
 * the next focus/refetch. No new Supabase channel is opened from the UI layer.
 */
export default function ConsensusSplitSlot({ dispute, jobId, currentUserId, isParty }: Props) {
  const disputeId = dispute.id
  const isActive = ACTIVE_DISPUTE_STATUSES.has(dispute.status)
  const enabled =
    isConsensusSplitUiEnabled() &&
    isParty &&
    !!currentUserId &&
    isActive &&
    isDisputeRepositoryHydrated()

  const [proposal, setProposal] = useState<SplitProposal | undefined>(undefined)
  // Which disputeId the current `proposal` snapshot belongs to. Gates render so
  // a stale proposal from a previous dispute id never flashes, and avoids any
  // synchronous setState inside the effect.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  // Generation guard — drops out-of-order / post-unmount fetch results.
  const genRef = useRef(0)

  const refetch = useCallback(() => {
    if (!enabled) return
    const gen = ++genRef.current
    void getDisputeRepository()
      .getActiveProposal(disputeId)
      .then((p) => {
        if (gen !== genRef.current) return
        setProposal(p)
        setLoadedFor(disputeId)
      })
      .catch(() => {
        if (gen !== genRef.current) return
        // Surface no active proposal on a read failure; the panel falls back to
        // its propose state and the action workflows still enforce the truth.
        setProposal(undefined)
        setLoadedFor(disputeId)
      })
  }, [enabled, disputeId])

  useEffect(() => {
    if (!enabled) return

    refetch()

    const onFocus = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') refetch()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onFocus)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus)
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onFocus)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus)
      }
    }
  }, [enabled, disputeId, refetch])

  // Render only once a fetch for THIS dispute has settled — never a stale
  // snapshot, never before flag/party/active gating passes. The `currentUserId`
  // check also narrows it to `string` for the panel prop.
  if (!enabled || !currentUserId || loadedFor !== disputeId) return null

  const total = resolveCanonicalAmount(jobId).amount ?? 0

  return (
    <ConsensusSplitPanel
      disputeId={disputeId}
      jobId={jobId}
      totalAmount={total}
      feeRate={resolveJobFeeRate(jobId)}
      currentUserId={currentUserId}
      activeProposal={proposal}
      minCraftsmanPercent={deriveReleasedCraftsmanPercent(jobId, total)}
      onChanged={refetch}
    />
  )
}
