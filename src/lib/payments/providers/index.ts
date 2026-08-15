export type {
  ConfirmDepositInput,
  CreateEscrowInput,
  DepositResult,
  EscrowResult,
  PaymentProvider,
  PaymentProviderName,
  RefundEscrowInput,
  ReleaseEscrowInput,
} from './PaymentProvider.js'

export { MockProvider } from './MockProvider.js'
export { StripeProvider } from './StripeProvider.js'

export {
  getPaymentProvider,
  getPaymentProviderName,
  setPaymentProvider,
} from './registry.js'

export {
  confirmDepositWithProvider,
  createEscrowWithProvider,
  getActivePaymentProviderName,
  refundEscrowWithProvider,
  releaseEscrowWithProvider,
} from './adapter.js'
