/**
 * Subscription domain public API — Block 6
 */
export type {
  SubscriptionBaseStatus,
  EffectiveSubscriptionStatus,
  SubscriptionRow,
  ProAction,
  EntitlementLevel,
  EntitlementResult,
  ActiveWorkContext,
  SubscriptionScope,
  TrialStartResult,
} from './types'

export { resolveEffectiveState } from './resolveEffectiveState'
export { resolveActionEntitlement, isMessageAllowedInThread, isFreeAction } from './entitlements'
export { resolveActiveWorkContextForJob, resolveAllActiveWorkContexts } from './activeWorkContext'
export { startTrial, ensureSubscriptionRow } from './trialService'
export {
  initializeRevenueCat,
  getProPackages,
  purchasePkg,
  restorePurchases,
  hasActiveProEntitlement,
  presentCustomerCenter,
  RC_PRODUCT_IDS,
  RC_ENTITLEMENT_ID,
} from './revenueCat'
export type { ProPackage, ProPackages, ProPackageId, PurchaseResult } from './revenueCat'
