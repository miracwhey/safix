export type { PersistenceFailure, PersistenceFailureInput } from './persistenceErrorStore'
export {
  recordPersistenceFailure,
  getPersistenceFailures,
  hasPersistenceFailures,
  needsUserAttention,
  getEscalationTimeoutMs,
  clearPersistenceFailures,
  clearPersistenceFailureForEntity,
  hasPersistenceFailureForEntity,
  subscribeToPersistenceFailures,
} from './persistenceErrorStore'

export type { FailureKind, ClassifyContext } from './classifyFailure'
export { classifyFailure, isRetryableKind, isPermanentKind } from './classifyFailure'

export type { PendingMutation, PendingMutationSnapshot } from './pendingMutationStore'
export {
  enqueuePendingMutation,
  getPendingMutations,
  removePendingMutation,
  incrementRetryCount,
  hasPendingMutations,
  hasPendingMutationsForCurrentUser,
  hasPendingMutationForEntity,
  getPendingMutationOperation,
  clearPendingMutations,
  prunePendingMutations,
  getPendingMutationsSnapshot,
  migratePendingMutationsIfNeeded,
  setActiveMutationUser,
  MAX_PENDING_AGE_MS,
} from './pendingMutationStore'

export type { FlushResult } from './flushPendingMutations'
export { flushPendingMutations } from './flushPendingMutations'

export {
  markRecoveryStarted,
  isRecovering,
  getRecoveryStartedAt,
  clearRecoveryStatus,
  subscribeToRecoveryStatus,
} from './recoveryStatus'

export { isServerSideError, isDuplicateKeyError, describeError } from './serverErrors'
export type { ErrorShape } from './serverErrors'
