/**
 * Funding Request — Public API
 */
export type { FundingRequest, FundingRequestStatus, FundingRequestType } from './types'
export {
  ensureFundingRequest,
  getFundingRequestById,
  getFundingRequestByPlanId,
  getFundingRequestByJobId,
  getFundingRequestByOfferId,
  getAllFundingRequests,
  getFundingRequestStatusLabel,
  markFundingRequestSent,
  markFundingStarted,
  markFundingInitiated,
  markFundingCompleted,
  markFundingFailed,
  markFundingCancelled,
  isFundingRequestRepositoryHydrated,
  subscribeFundingRequests,
} from './fundingRequestService'
export { getFundingRequestRepository, setFundingRequestRepository, initializeFundingRequestRepository } from './fundingRequestRegistry'
export { SupabaseFundingRequestRepository } from './SupabaseFundingRequestRepository'
export { isFundingConfirmedForJob } from './fundingDominance'
export { isFundingRequestTerminalDead } from './fundingRequestStatus'
