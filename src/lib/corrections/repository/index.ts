export type { CorrectionRepository } from './CorrectionRepository'
export { InMemoryCorrectionRepository } from './InMemoryCorrectionRepository'
export { SupabaseCorrectionRepository } from './SupabaseCorrectionRepository'
export {
  getCorrectionRepository,
  setCorrectionRepository,
  initializeCorrectionRepository,
} from './registry'
