/**
 * Onboarding domain public API.
 *
 * Re-exports all onboarding selectors so consumers use a single import path.
 */
export type {
  OnboardingStageId,
  OnboardingStepStatus,
  OnboardingStep,
  OnboardingProgress,
} from './selectors'

export {
  deriveOnboardingProgress,
  getMissingOnboardingSteps,
  getNextOnboardingStep,
  isProviderReadyForDiscovery,
} from './selectors'
