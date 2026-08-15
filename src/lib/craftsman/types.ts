import type { ProviderTaxProfile } from '../providers/providerProfileService'

export type CraftsmanBusinessProfile = {
  userId: string
  /** providers.id (DB-generated UUID); present when profile originates from the providers table */
  providerId?: string
  businessName: string
  handle: string
  avatarUrl?: string
  bio?: string
  location: string
  /** Full business address for invoice issuance (e.g. "Hauptstraße 5, 10115 Berlin"). */
  businessAddress: string
  tradeCategories: string[]
  servicesOffered: string[]
  serviceRadiusKm: number
  yearsInBusiness?: number
  completedJobsCount?: number
  phone?: string
  website?: string
  onboardingCompleted: boolean
  /**
   * Public-discovery visibility (`providers.is_public`). When false the
   * craftsman's reels + profile are hidden from every other account; only the
   * owner still sees their own. Drives the "Dein Profil ist versteckt" banner
   * and the visibility toggle. Legacy-only profiles (no providers row) default
   * to `true` — they can't be feed-hidden since the feed reads `providers`.
   */
  isPublic: boolean
  /**
   * Steuer-/Bankprofil (Block 7.1B1). Read-only-Spiegel von
   * `providers.tax_*` / `providers.iban` / `providers.bic`. Nur bei
   * canonical-Read aus `providers` befüllt; wenn nur die Legacy-Tabelle
   * `craftsman_profiles` greift, bleibt das Feld `null` und Konsumenten
   * fallen auf Defaults zurück.
   *
   * Schreibpfad bleibt getrennt: nur `updateProviderTaxProfile` aus dem
   * Provider-Service schreibt diese Felder.
   */
  taxProfile: ProviderTaxProfile | null
  createdAt: number
  updatedAt: number
}

export type CraftsmanBusinessProfileInput = {
  businessName: string
  handle: string
  avatarUrl?: string
  bio?: string
  location: string
  /** Full business address for invoice issuance (e.g. "Hauptstraße 5, 10115 Berlin"). */
  businessAddress?: string
  tradeCategories: string[]
  servicesOffered: string[]
  serviceRadiusKm: number
  yearsInBusiness?: number
  phone?: string
  website?: string
}
