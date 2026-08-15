/**
 * Provider domain public API.
 *
 * Re-exports the canonical ProviderProfile service plus readiness selectors
 * so that all provider-facing logic is discoverable from a single import path.
 */
export type {
  ProviderProfile,
  ProviderProfileForm,
  ProviderTaxProfile,
  ProviderTaxProfileForm,
  ProviderLegalForm,
} from './providerProfileService'
export {
  getMyProviderProfile,
  getProviderProfile,
  getProviderCompanyNameById,
  updateProviderProfile,
  updateProviderTaxProfile,
  PROVIDER_LEGAL_FORMS,
} from './providerProfileService'

export type {
  TaxProfileValidationResult,
  TaxProfileValidationIssue,
  AllowedDefaultVatRate,
} from './taxProfileSelectors'
export {
  ALLOWED_DEFAULT_VAT_RATES,
  isAllowedDefaultVatRate,
  isValidTaxNumberFormat,
  isValidVatIdFormat,
  isValidIbanFormat,
  isValidBicFormat,
  isValidLegalForm,
  validateTaxProfileForm,
  isTaxProfileComplete,
  hasBankingDetails,
} from './taxProfileSelectors'

/**
 * Re-export readiness selectors from the craftsman domain so that any code
 * working with the providers domain index has a single import point for both
 * profile data and derived readiness state.
 */
export type { ProviderReadiness, ProviderReadinessStatus } from '../craftsman/craftsmanReadinessSelectors'
export {
  deriveProviderReadiness,
  isProviderReady,
} from '../craftsman/craftsmanReadinessSelectors'
