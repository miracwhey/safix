import { describe, it, expect } from 'vitest'
import { submitWiderruf } from '../../src/lib/widerruf/widerrufService'
import { WITHDRAWAL_CONSENT_TEXT_VERSION } from '../../src/lib/subscription/withdrawalConsent'

describe('widerrufService — § 356a submit guards', () => {
  it('rejects an empty contact email without hitting the network', async () => {
    const result = await submitWiderruf('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/E-Mail/i)
    }
  })

  it('requires an authenticated session before submitting a real address', async () => {
    // No active Supabase session in the test environment → must fail closed
    // with the re-auth prompt rather than dispatching the request.
    const result = await submitWiderruf('kunde@beispiel.de')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/anmelden/i)
    }
  })
})

describe('withdrawalConsent — § 356 Abs. 4 audit version', () => {
  it('pins the consent text version so a copy change forces a bump', () => {
    expect(WITHDRAWAL_CONSENT_TEXT_VERSION).toBe('v1')
  })
})
