import type {
  ConfirmDepositInput,
  CreateEscrowInput,
  DepositResult,
  EscrowResult,
  PaymentProviderName,
  RefundEscrowInput,
  ReleaseEscrowInput,
} from './PaymentProvider.js'
import { getPaymentProvider, getPaymentProviderName } from './registry.js'

export function getActivePaymentProviderName(): PaymentProviderName {
  return getPaymentProviderName()
}

export async function createEscrowWithProvider(
  input: CreateEscrowInput
): Promise<EscrowResult> {
  const provider = getPaymentProvider()
  return provider.createEscrow(input)
}

export async function confirmDepositWithProvider(
  input: ConfirmDepositInput
): Promise<DepositResult> {
  const provider = getPaymentProvider()
  return provider.confirmDeposit(input)
}

export async function releaseEscrowWithProvider(
  input: ReleaseEscrowInput
): Promise<void> {
  const provider = getPaymentProvider()
  await provider.releaseEscrow(input)
}

export async function refundEscrowWithProvider(
  input: RefundEscrowInput
): Promise<void> {
  const provider = getPaymentProvider()
  await provider.refundEscrow(input)
}
