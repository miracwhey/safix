export type CreateEscrowInput = {
  jobId: string
  customerId: string
  craftsmanUserId: string
  amount: number
  currency: 'EUR'
}

export type EscrowResult = {
  escrowId: string
  status: 'created'
  /**
   * PaymentIntent client_secret returned by the provider.
   * Required for the customer to authorise the payment client-side
   * (e.g. via Stripe.js / Payment Element).
   * Only present when the underlying provider supports client-side confirmation.
   */
  clientSecret?: string
}

export type ConfirmDepositInput = {
  escrowId: string
  jobId: string
  amount: number
}

export type DepositResult = {
  depositConfirmed: boolean
}

export type ReleaseEscrowInput = {
  escrowId: string
  disputeId?: string
}

export type RefundEscrowInput = {
  escrowId: string
  amount?: number
  disputeId?: string
}

export type PaymentProviderName = 'mock' | 'stripe'

export interface PaymentProvider {
  readonly name: PaymentProviderName

  createEscrow(input: CreateEscrowInput): Promise<EscrowResult>

  confirmDeposit(input: ConfirmDepositInput): Promise<DepositResult>

  releaseEscrow(input: ReleaseEscrowInput): Promise<void>

  refundEscrow(input: RefundEscrowInput): Promise<void>
}
