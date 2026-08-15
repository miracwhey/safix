/**
 * Fee Rate Drift Guard
 *
 * Client (src/lib/shared/feeRate.ts) and server (api/_feeRate.ts) each define
 * their own FEE_RATES object because src/ cannot import from api/ at runtime.
 * This test imports both and asserts the rate values are identical — if someone
 * updates one file without the other, this test will fail.
 */

import { describe, it, expect } from 'vitest'
import { FEE_RATES as CLIENT_FEE_RATES, resolveFeeRateFromOrigin } from '../../src/lib/shared/feeRate'
import { FEE_RATES as SERVER_FEE_RATES, resolveCommercialFeeRate } from '../../api/_feeRate'

describe('Fee rate drift guard — client and server rates must match', () => {
  it('merchant_brought rate is identical', () => {
    expect(CLIENT_FEE_RATES.merchant_brought).toBe(SERVER_FEE_RATES.merchant_brought)
  })

  it('platform_acquired rate is identical', () => {
    expect(CLIENT_FEE_RATES.platform_acquired).toBe(SERVER_FEE_RATES.platform_acquired)
  })

  it('unknown (safe default) rate is identical', () => {
    expect(CLIENT_FEE_RATES.unknown).toBe(SERVER_FEE_RATES.unknown)
  })

  it('client resolveFeeRateFromOrigin agrees with server resolveCommercialFeeRate for merchant_brought', () => {
    const client = resolveFeeRateFromOrigin('merchant_brought')
    const server = resolveCommercialFeeRate('merchant_brought')
    expect(client).toBe(server.rate)
  })

  it('client resolveFeeRateFromOrigin agrees with server resolveCommercialFeeRate for platform_acquired', () => {
    const client = resolveFeeRateFromOrigin('platform_acquired')
    const server = resolveCommercialFeeRate('platform_acquired')
    expect(client).toBe(server.rate)
  })

  it('client resolveFeeRateFromOrigin agrees with server resolveCommercialFeeRate for null (safe default)', () => {
    const client = resolveFeeRateFromOrigin(null)
    const server = resolveCommercialFeeRate(null)
    expect(client).toBe(server.rate)
  })

  it('client resolveFeeRateFromOrigin agrees with server resolveCommercialFeeRate for undefined', () => {
    const client = resolveFeeRateFromOrigin(undefined)
    const server = resolveCommercialFeeRate(undefined)
    expect(client).toBe(server.rate)
  })

  it('server resolveCommercialFeeRate throws on unknown_pending_resolution (client returns safe default)', () => {
    expect(() => resolveCommercialFeeRate('unknown_pending_resolution')).toThrow(
      'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED'
    )
    // Client does not throw — returns safe default. This is intentional:
    // the client displays estimated amounts, so a safe default is acceptable.
    // The server blocks payment execution, where the hard invariant matters.
    expect(resolveFeeRateFromOrigin('unknown_pending_resolution')).toBe(CLIENT_FEE_RATES.unknown)
  })
})
