export type {
  MediaArtifact,
  MediaArtifactInput,
  MediaArtifactKind,
} from './types'

export type { MediaArtifactViewModel } from './mediaSelectors'

export {
  subscribeMedia,
  getArtifacts,
  getArtifactsByJobId,
  getArtifactById,
  getArtifactsByDisputeId,
  isMediaHydrated,
} from './mediaStore'

export { addArtifact } from './mediaService'

export { createArtifact } from './mediaEngine'

export {
  getArtifactKindLabel,
  mapArtifactToViewModel,
  getArtifactViewModels,
  getPhotoArtifacts,
  getDisputeEvidenceArtifacts,
  getDocumentArtifacts,
  formatPhotoCount,
} from './mediaSelectors'

export type { MediaRepository } from './repository'
export { getMediaRepository, setMediaRepository, initializeMediaRepository, SupabaseMediaRepository } from './repository'

export type {
  MediaEntityType,
  MediaUploadInput,
  PersistedMediaRecord,
  MediaValidationResult,
  MediaValidationError,
  MediaValidationSuccess,
} from './mediaUploadService'

export {
  validateMediaFile,
  resolveMediaType,
  mimeTypeToExtension,
  sanitizePathSegment,
  buildStoragePath,
  uploadMediaFile,
  fetchMediaForEntity,
  deleteMediaFile,
  MAX_FILE_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
  MEDIA_STORAGE_BUCKET,
  IMAGE_ACCEPT,
  IMAGE_VIDEO_ACCEPT,
  VIDEO_ACCEPT,
} from './mediaUploadService'
