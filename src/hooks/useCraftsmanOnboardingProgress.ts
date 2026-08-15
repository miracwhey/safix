import { useEffect, useState } from 'react'
import { getMyCraftsmanBusinessProfile } from '../lib/craftsman/craftsmanProfileService'
import {
  deriveOnboardingProgress,
  type OnboardingProgress,
} from '../lib/onboarding'
import type { ProviderPayoutAccount } from '../lib/payout/types'
import { fetchPayoutAccountForOnboarding } from '../lib/payout/client'
import { logError, logInfo } from '../lib/observability'

export type UseCraftsmanOnboardingProgressResult = {
  progress: OnboardingProgress | null
  isLoaded: boolean
  /** First word of business name, used as a greeting fallback. */
  displayName: string | null
}

/**
 * Loads the current craftsman's onboarding progress and the connected payout
 * account state, then derives a single `OnboardingProgress` model via the
 * canonical `deriveOnboardingProgress` selector.
 *
 * Shared between Dashboard and Backoffice-Hub so both surfaces stay in sync
 * with one hydration path. The selector remains the single source of truth.
 */
export function useCraftsmanOnboardingProgress(): UseCraftsmanOnboardingProgressResult {
  const [progress, setProgress] = useState<OnboardingProgress | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [displayName, setDisplayName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const profile = await getMyCraftsmanBusinessProfile()

        let payoutAccount: ProviderPayoutAccount | null = null
        try {
          payoutAccount = await fetchPayoutAccountForOnboarding()
        } catch {
          // Payout status unavailable — onboarding will show payout_setup as incomplete
        }

        if (cancelled) return

        const next = deriveOnboardingProgress(profile, payoutAccount)
        setProgress(next)
        setIsLoaded(true)
        if (profile?.businessName) {
          setDisplayName(profile.businessName.split(' ')[0].trim())
        }
        if (next.isComplete) {
          logInfo('onboarding.ready_for_activation', {
            completionPercent: next.completionPercent,
          })
        }
      } catch (err) {
        if (cancelled) return
        setProgress(null)
        setIsLoaded(true)
        logError('onboarding.load_failed', err)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return { progress, isLoaded, displayName }
}
