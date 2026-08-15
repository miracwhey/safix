import type { CraftsmanBusinessProfile } from './types'

export type ProviderReadinessStatus = 'ready' | 'incomplete' | 'not_started'

export type ProviderReadiness = {
  status: ProviderReadinessStatus
  isReady: boolean
  completionPercent: number
  gaps: string[]
}

/**
 * Derives a provider readiness state from a craftsman business profile.
 * A provider is considered 'ready' when all required fields are populated
 * and onboarding has been marked complete.
 *
 * Required: businessName, location, tradeCategories (≥1), onboardingCompleted
 */
export function deriveProviderReadiness(
  profile: CraftsmanBusinessProfile | null
): ProviderReadiness {
  if (!profile) {
    return { status: 'not_started', isReady: false, completionPercent: 0, gaps: [] }
  }

  const gaps: string[] = []

  if (!(profile.businessName ?? '').trim()) gaps.push('Betriebsname fehlt')
  if (!(profile.handle ?? '').trim()) gaps.push('Handle fehlt')
  if (!(profile.location ?? '').trim()) gaps.push('Standort fehlt')
  if (profile.tradeCategories.length === 0) gaps.push('Gewerke fehlen')
  if (!profile.onboardingCompleted) gaps.push('Onboarding nicht abgeschlossen')

  const total = 5
  const completionPercent = Math.round(((total - gaps.length) / total) * 100)
  const isReady = gaps.length === 0
  const status: ProviderReadinessStatus = isReady
    ? 'ready'
    : profile.onboardingCompleted
      ? 'incomplete'
      : 'not_started'

  return { status, isReady, completionPercent, gaps }
}

/**
 * Returns true when the profile satisfies all required fields for
 * provider discovery/search visibility.
 */
export function isProviderReady(profile: CraftsmanBusinessProfile | null): boolean {
  return deriveProviderReadiness(profile).isReady
}
