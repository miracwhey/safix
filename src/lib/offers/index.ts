export type {
  Offer,
  OfferStatus,
  OfferMode,
  OfferStaleReason,
  QuoteLineItem,
  SpatialOfferMetadata,
  SpatialOfferLineItemMeta,
} from './types'
export { isSpatialOffer } from './types'

export {
  getOffers,
  getOfferById,
  getOffersByConversationId,
  getActiveOfferForConversation,
  getAcceptedOfferByJobId,
  getFollowUpOfferForDiagnosis,
  subscribeOffers,
  isOfferRepositoryHydrated,
  addOffer,
  updateOffer,
  isOfferLocked,
  isOfferActionable,
  isOfferInactive,
} from './service'

export type { PaymentBasis, PaymentGatingReason } from './quotePaymentGating'
export {
  isQuotePaymentReady,
  getQuotePaymentGatingReason,
  deriveQuotePaymentBasis,
} from './quotePaymentGating'

export { resolveCanonicalQuoteId } from './resolveCanonicalQuoteId'

export type { OfferRepository } from './repository'
export {
  getOfferRepository,
  setOfferRepository,
  initializeOfferRepository,
  SupabaseOfferRepository,
} from './repository'
