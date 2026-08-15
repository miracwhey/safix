export type PayoutOnboardingStatus =
  | 'not_started'
  | 'onboarding_in_progress'
  | 'pending_verification'
  | 'onboarding_complete'
  | 'payout_blocked'

export type PayoutReadinessStatus =
  | 'no_account'
  | 'onboarding_required'
  | 'onboarding_in_progress'
  | 'pending_verification'
  | 'payout_ready'
  | 'payout_blocked'

export type ProviderPayoutAccount = {
  id: string
  providerUserId: string
  stripeConnectAccountId: string | null
  onboardingStatus: PayoutOnboardingStatus
  chargesEnabled: boolean
  payoutsEnabled: boolean
  onboardingCompletedAt: number | null
  requirementsDue: string | null
  createdAt: number
  updatedAt: number
}
