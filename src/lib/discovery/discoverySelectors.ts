import type { DiscoveryProvider } from './discoveryTypes'

/**
 * Structured readiness result for a DiscoveryProvider.
 * Mirrors the shape used by deriveProviderReadiness in the craftsman domain
 * so that both sides report consistent gaps to callers.
 */
export type DiscoveryProviderReadiness = {
  isReady: boolean
  missingFields: string[]
}

/**
 * Derives the readiness state of a DiscoveryProvider.
 *
 * A provider is considered ready when all of the following are true:
 *   - companyName is non-empty
 *   - city is non-empty
 *   - at least one trade category is present
 *   - providers.is_public = true  (provider opted in to public visibility)
 *   - profiles.onboarding_done = true  (account setup is complete)
 *
 * Returns { isReady, missingFields } so callers can surface specific gaps
 * without re-implementing the checks.
 */
export function deriveDiscoveryReadiness(
  provider: DiscoveryProvider
): DiscoveryProviderReadiness {
  const missingFields: string[] = []

  // Operator-Accounts sind valide Handwerker-Persona (Inhaber mit Mitarbeitenden) —
  // kein Sichtbarkeits-Block.
  if (!(provider.companyName ?? '').trim()) missingFields.push('Betriebsname fehlt')
  if (!(provider.city ?? '').trim()) missingFields.push('Standort fehlt')
  if (provider.tradeCategories.length === 0) missingFields.push('Gewerke fehlen')
  if (!provider.isPublic) missingFields.push('Profil nicht öffentlich')
  if (!provider.onboardingDone) missingFields.push('Onboarding nicht abgeschlossen')

  return { isReady: missingFields.length === 0, missingFields }
}

/**
 * Centralized Discovery Visibility Rule.
 *
 * Pass-Through: das harte Sichtbarkeits-Gate ist die SECURITY-DEFINER-View
 * `visible_discovery_providers` (is_public=true AND onboarding_done=true).
 * Alles, was diese View ausliefert, soll Customer-seitig sichtbar sein.
 *
 * Operator-Accounts und Provider mit unvollständigem Profil (kein city /
 * companyName / tradeCategories) werden NICHT mehr clientseitig versteckt —
 * stattdessen bekommt die UI ein „Profil unvollständig"-Badge über
 * `deriveDiscoveryReadiness(provider)` und der Ranking-Score deprioritisiert
 * sie via `profileReadinessSignal` in `src/lib/search/selectors.ts`.
 */
export function isDiscoveryVisible(_provider: DiscoveryProvider): boolean {
  return true
}
