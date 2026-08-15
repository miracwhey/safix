import type {
  PaymentProvider,
  CreateEscrowInput,
  EscrowResult,
  ConfirmDepositInput,
  DepositResult,
  ReleaseEscrowInput,
  RefundEscrowInput,
} from './PaymentProvider.js'

export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const

  async createEscrow(input: CreateEscrowInput): Promise<EscrowResult> {
    return {
      escrowId: `mock_escrow_${input.jobId}_${Date.now()}`,
      status: 'created',
      clientSecret: `mock_client_secret_${input.jobId}`,
    }
  }

  async confirmDeposit(_input: ConfirmDepositInput): Promise<DepositResult> {
    return { depositConfirmed: true }
  }

  async releaseEscrow(_input: ReleaseEscrowInput): Promise<void> {
    return
  }

  async refundEscrow(_input: RefundEscrowInput): Promise<void> {
    return
  }
}
