/**
 * `useReconciliationView` — composes the reactive parts of the SaFix store
 * with the one-shot loaders for `dispute_status_history` and
 * `stripe_webhook_events`, runs `selectReconciliationView`, and returns a
 * stable view object for components.
 *
 * BOUNDARIES
 * ----------
 * - The hook is read-only. Mutations (statement submit, evidence upload) are
 *   driven by the existing dispute/media services. Callers invoke `refetch`
 *   after a mutation to pull a fresh history snapshot.
 * - The hook does not enforce role gates beyond surfacing role-aware data.
 *   Workflow-layer RBAC remains the authoritative gate (e.g.
 *   `canSubmitDisputeResponse`).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { getDisputeById, subscribeDisputes } from '../disputes/disputeStore'
import { getJobById, subscribeJobs } from '../jobs/jobsStore'
import { subscribePayments } from '../payments/paymentsStore'
import { getArtifactsByDisputeId, subscribeMedia } from '../media'
import { useStoreSubscriptions } from '../reactive/useStoreSubscriptions'
import { useSession } from '../../hooks/useSession'
import { deriveDisputeResponseDeadline } from '../disputes/disputeResponseSelectors'
import { mapMediaArtifactsToReconciliationRows } from './mediaArtifactMapping'
import { loadDisputeHistory } from './loaders/historyLoader'
import { loadStripeEventsForJob } from './loaders/stripeEventsLoader'
import { selectReconciliationView } from './reconciliationSelectors'
import type {
  ReconciliationHistoryRow,
  ReconciliationRole,
  ReconciliationStripeRow,
  ReconciliationView,
} from './types'

export type ReconciliationViewStatus =
  | 'loading'
  | 'ready'
  | 'not-found'
  | 'access-denied'

export type ReconciliationViewState = {
  status: ReconciliationViewStatus
  view: ReconciliationView | null
  /** Re-runs the one-shot loaders. Components call this after a write. */
  refetch: () => void
}

export type UseReconciliationViewParams = {
  disputeId: string
  role: ReconciliationRole
  /** Override the session-derived viewer id. Used in embed/admin contexts. */
  viewerUserId?: string
}

export function useReconciliationView(
  params: UseReconciliationViewParams,
): ReconciliationViewState {
  const session = useSession()
  const sessionUserId = session.user?.id ?? undefined
  const viewerUserId = params.viewerUserId ?? sessionUserId

  // Bump on store changes so derived data recomputes.
  const [version, setVersion] = useState(0)
  useStoreSubscriptions([
    { subscribe: subscribeDisputes, onChange: () => setVersion((v) => v + 1) },
    { subscribe: subscribeJobs, onChange: () => setVersion((v) => v + 1) },
    { subscribe: subscribePayments, onChange: () => setVersion((v) => v + 1) },
    { subscribe: subscribeMedia, onChange: () => setVersion((v) => v + 1) },
  ])

  const dispute = getDisputeById(params.disputeId)

  const [history, setHistory] = useState<ReconciliationHistoryRow[]>([])
  const [stripeEvents, setStripeEvents] = useState<ReconciliationStripeRow[]>([])
  const [loaderState, setLoaderState] = useState<'idle' | 'loading' | 'done' | 'error'>(
    'idle',
  )
  // Bump to force a refetch after a mutation.
  const [refetchKey, setRefetchKey] = useState(0)
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false })

  const disputeId = dispute?.id
  const disputeUpdatedAt = dispute?.updatedAt
  const jobId = dispute?.jobId

  useEffect(() => {
    if (!disputeId || !jobId) {
      setHistory([])
      setStripeEvents([])
      setLoaderState('idle')
      return
    }
    const token = { cancelled: false }
    cancelRef.current = token
    setLoaderState('loading')
    Promise.all([
      loadDisputeHistory(disputeId),
      loadStripeEventsForJob(jobId),
    ])
      .then(([historyRows, stripeRows]) => {
        if (token.cancelled) return
        setHistory(historyRows)
        setStripeEvents(stripeRows)
        setLoaderState('done')
      })
      .catch(() => {
        if (token.cancelled) return
        setLoaderState('error')
      })
    return () => {
      token.cancelled = true
    }
    // disputeUpdatedAt triggers a refetch when the dispute changes server-side.
  }, [disputeId, jobId, disputeUpdatedAt, refetchKey])

  const view = useMemo<ReconciliationView | null>(() => {
    if (!dispute) return null
    const job = getJobById(dispute.jobId)
    // payment is read at the component level for amount display; the
    // selector itself does not need it because it derives amounts from the
    // dispute snapshot. Intentionally not passed in here.
    const media = getArtifactsByDisputeId(dispute.id)
    const deadlineDate = deriveDisputeResponseDeadline(dispute)
    return selectReconciliationView({
      dispute,
      role: params.role,
      history,
      media: mapMediaArtifactsToReconciliationRows(media),
      stripeEvents,
      viewer: viewerUserId ? { userId: viewerUserId } : undefined,
      counterparty: deriveCounterparty(job, params.role),
      statementDeadlineAt: deadlineDate ? deadlineDate.toISOString() : null,
      // payment.amounts.totalAmount is in EUR (cents are not used in this
      // codebase — confirmed by Payment / PaymentAmounts contract).
      // selectReconciliationView reads amount via resolveContext on the list
      // selector; the detail selector exposes it through the underlying
      // dispute/snapshot, so no additional plumbing is needed here.
    })
    // The list selector consumes payment amount via resolveContext; the
    // detail selector exposes the snapshot directly. See
    // ReconciliationDetail's amount card for live payment.totalAmount usage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispute, params.role, history, stripeEvents, viewerUserId, version])

  const status: ReconciliationViewStatus = !disputeId
    ? 'not-found'
    : !view
      ? loaderState === 'idle' || loaderState === 'loading'
        ? 'loading'
        : 'not-found'
      : 'ready'

  return {
    status,
    view,
    refetch: () => setRefetchKey((k) => k + 1),
  }
}

function deriveCounterparty(
  job: ReturnType<typeof getJobById>,
  role: ReconciliationRole,
):
  | { displayName?: string; emails?: ReadonlyArray<string> }
  | undefined {
  if (!job) return undefined
  if (role === 'customer') {
    // The customer's counterparty is the provider. Job carries provider
    // reference but no display-name field at this layer; the redaction
    // pattern set still scrubs structured PII without it.
    return undefined
  }
  // craftsman role → counterparty is the customer
  return job.customer ? { displayName: job.customer } : undefined
}
