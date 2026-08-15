/**
 * `useReconciliationListBuckets` — reactive read-model for the user's list
 * of dispute cases. Powers the profile reconciliation center.
 *
 * Composes existing reactive stores (disputes, jobs, payments) with the pure
 * `selectReconciliationList` selector. The hook returns empty buckets when
 * no viewer user is attached so callers can render a clean UI rather than
 * branching on auth state themselves.
 */

import { useMemo, useState } from 'react'
import { getDisputes, subscribeDisputes } from '../disputes/disputeStore'
import { getJobById, subscribeJobs } from '../jobs/jobsStore'
import { getPaymentForJob, subscribePayments } from '../payments/paymentsStore'
import { useStoreSubscriptions } from '../reactive/useStoreSubscriptions'
import { useSession } from '../../hooks/useSession'
import { deriveDisputeResponseDeadline } from '../disputes/disputeResponseSelectors'
import { selectReconciliationList } from './reconciliationSelectors'
import type {
  ReconciliationListBuckets,
  ReconciliationRole,
} from './types'

const EMPTY_BUCKETS: ReconciliationListBuckets = {
  active: [],
  resolved: [],
  counts: { active: 0, awaitingViewer: 0, resolved: 0 },
}

export function useReconciliationListBuckets(
  role: ReconciliationRole,
): ReconciliationListBuckets {
  const session = useSession()
  const viewerUserId = session.user?.id ?? ''

  const [version, setVersion] = useState(0)
  useStoreSubscriptions([
    { subscribe: subscribeDisputes, onChange: () => setVersion((v) => v + 1) },
    { subscribe: subscribeJobs, onChange: () => setVersion((v) => v + 1) },
    { subscribe: subscribePayments, onChange: () => setVersion((v) => v + 1) },
  ])

  return useMemo<ReconciliationListBuckets>(() => {
    if (!viewerUserId) return EMPTY_BUCKETS
    const disputes = getDisputes()
    return selectReconciliationList({
      role,
      viewerUserId,
      disputes,
      resolveContext: (dispute) => {
        const job = getJobById(dispute.jobId)
        const payment = getPaymentForJob(dispute.jobId)
        const deadlineDate = deriveDisputeResponseDeadline(dispute)
        return {
          jobTitle: job?.title,
          amountEur: payment?.amounts.totalAmount ?? null,
          statementDeadlineAt: deadlineDate ? deadlineDate.toISOString() : null,
          refundedAmountEur: payment?.refundedAmount ?? null,
        }
      },
    })
    // version triggers re-evaluation when the underlying stores change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, viewerUserId, version])
}
