export type { ProviderMediaKind, ProviderMediaItem, ProviderMediaRowV2, PortfolioItem, PortfolioAsset } from './providerMediaTypes'

export {
  fetchProviderMedia,
  fetchProviderAvatar,
  fetchProviderPortfolio,
  fetchProviderAvatarsBatch,
} from './providerMediaService'

export type { AvatarUploadInput, AvatarUploadResult } from './avatarUploadService'
export { uploadProviderAvatar } from './avatarUploadService'

export type { ShowcaseUploadInput, ShowcaseUploadResult } from './showcaseUploadService'
export { uploadShowcaseMedia, fetchProviderShowcase, deleteShowcaseMedia } from './showcaseUploadService'

// Block 2: Portfolio system (canonical source of truth for public portfolio)
export type {
  CreatePortfolioFromUploadInput,
  CreatePortfolioFromJobInput,
  UpdatePortfolioItemInput,
  JobPhotoSelection,
} from './portfolioItemService'
export {
  fetchPublicPortfolio,
  fetchOwnerPortfolio,
  createPortfolioItemFromUpload,
  createPortfolioItemFromJob,
  updatePortfolioItem,
  deletePortfolioItem,
} from './portfolioItemService'

// Block 2: Portfolio likes (provider_media_likes table)
export type { LikeStatus } from './portfolioLikeService'
export { fetchLikeStatus, toggleLike } from './portfolioLikeService'
