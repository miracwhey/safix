import type { ProviderPayoutAccount, PayoutReadinessStatus } from './types'

export function derivePayoutReadinessStatus(
  account: ProviderPayoutAccount | null
): PayoutReadinessStatus {
  if (!account || !account.stripeConnectAccountId) return 'no_account'
  if (account.payoutsEnabled && account.chargesEnabled) return 'payout_ready'
  if (account.onboardingStatus === 'payout_blocked') return 'payout_blocked'
  if (account.onboardingStatus === 'pending_verification') return 'pending_verification'
  if (account.onboardingStatus === 'onboarding_in_progress') return 'onboarding_in_progress'
  return 'onboarding_required'
}

export function isPayoutEligible(account: ProviderPayoutAccount | null): boolean {
  return derivePayoutReadinessStatus(account) === 'payout_ready'
}

export function getPayoutReadinessLabel(status: PayoutReadinessStatus): string {
  switch (status) {
    case 'no_account': return 'Kein Konto verknüpft'
    case 'onboarding_required': return 'Einrichtung erforderlich'
    case 'onboarding_in_progress': return 'Einrichtung läuft'
    case 'pending_verification': return 'Verifizierung läuft'
    case 'payout_ready': return 'Auszahlungen aktiv'
    case 'payout_blocked': return 'Auszahlungen gesperrt'
  }
}
