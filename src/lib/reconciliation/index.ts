/**
 * Reconciliation module — user-facing read-model and helpers (N13.1).
 *
 * Surfaces:
 *   - `/profile/disputes` (list + detail)
 *   - `/jobs/:jobId?focus=dispute` (embedded job tab)
 *
 * Operator-side (`/operator/reconciliation`) is delivered by N13.OPS and
 * does not consume this module.
 */

export {
  formatAktenzeichen,
  parseAktenzeichen,
  findDisputeByAktenzeichen,
  aktenzeichenToUrlSlug,
  aktenzeichenFromUrlSlug,
} from './aktenzeichen'

export { redactPII, redactPIIList } from './piiRedaction'
export type { RedactionContext } from './piiRedaction'

export {
  selectReconciliationView,
  selectReconciliationList,
} from './reconciliationSelectors'
export type { ReconciliationListSelectorInput } from './reconciliationSelectors'

export { useReconciliationView } from './useReconciliationView'
export type {
  ReconciliationViewState,
  ReconciliationViewStatus,
  UseReconciliationViewParams,
} from './useReconciliationView'

export { useReconciliationListBuckets } from './useReconciliationListBuckets'

export { loadDisputeHistory, loadStripeEventsForJob } from './loaders'

export {
  mapMediaArtifactToReconciliationRow,
  mapMediaArtifactsToReconciliationRows,
} from './mediaArtifactMapping'

export type {
  ReconciliationActionId,
  ReconciliationDeadline,
  ReconciliationDecision,
  ReconciliationEvidenceItem,
  ReconciliationEvidenceKind,
  ReconciliationHistoryRow,
  ReconciliationListBuckets,
  ReconciliationListItem,
  ReconciliationMediaRow,
  ReconciliationRole,
  ReconciliationSelectorInput,
  ReconciliationStripeEvent,
  ReconciliationStripeRow,
  ReconciliationTimelineItem,
  ReconciliationTimelineSource,
  ReconciliationView,
} from './types'
