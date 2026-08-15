import { useEffect, useState } from 'react'
import {
  getCustomerContext,
  subscribeCustomerContext,
  type CustomerContext,
} from '../lib/customer/customerContextStore'

/**
 * React hook for the customer context projection (display name, city, avatar).
 *
 * The store is a projection of the canonical personal-data record
 * (`customer_billing_profiles`): it is hydrated from there on session load and
 * write-through updated on save. UI reads identity through this single path.
 */
export function useCustomerContext(): CustomerContext {
  const [ctx, setCtx] = useState<CustomerContext>(getCustomerContext)
  useEffect(() => subscribeCustomerContext(() => setCtx(getCustomerContext())), [])
  return ctx
}
