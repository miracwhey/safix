import { MockProvider } from './MockProvider.js'
import { StripeProvider } from './StripeProvider.js'
import type {
  PaymentProvider,
  PaymentProviderName,
} from './PaymentProvider.js'

const providers: Record<PaymentProviderName, PaymentProvider> = {
  mock: new MockProvider(),
  stripe: new StripeProvider(),
}

let activeProviderName: PaymentProviderName = 'mock'

export function getPaymentProvider(): PaymentProvider {
  return providers[activeProviderName]
}

export function getPaymentProviderName(): PaymentProviderName {
  return activeProviderName
}

export function setPaymentProvider(name: PaymentProviderName): void {
  activeProviderName = name
}
