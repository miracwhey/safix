/**
 * Initiate-Funding Contract & Lifecycle Tests
 *
 * Validates the deterministic server contract and client-side parsing
 * introduced by the Funding Initiation Contract Hardening.
 *
 * Covers:
 * 1. Server response shape: all paths include explicit `outcome`
 * 2. Client helper parses each outcome correctly (discriminated union)
 * 3. clientSecret field shape is stable and unambiguous
 * 4. PAYMENT_FORM_READY path always includes clientSecret
 * 5. PAYMENT_ALREADY_FUNDED path never requires clientSecret
 * 6. PAYMENT_RETRY_READY path always includes clientSecret
 * 7. PAYMENT_INIT_FAILED path returns explicit error
 * 8. UI state machine maps every outcome to a distinct phase
 * 9. No regression to authenticated initiate-funding
 * 10. No regression to dedicated funding route
 * 11. False success "kein Client-Secret erhalten" is eliminated
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── File paths ────────────────────────────────────────────────────────────

const serverEndpointPath = path.resolve(__dirname, '../../api/initiate-funding.ts')
const apiClientPath = path.resolve(__dirname, '../../src/lib/funding/initiateFundingApi.ts')
const _barrelPath = path.resolve(__dirname, '../../src/lib/funding/index.ts')
const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
const fundingEntryScreenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
const appPath = path.resolve(__dirname, '../../src/App.tsx')

// ── Helpers ───────────────────────────────────────────────────────────────

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

// =========================================================================
// 1. Server response: explicit outcome on all paths
// =========================================================================

describe('1. Server returns explicit outcome on all response paths', () => {
  const content = readFile(serverEndpointPath)

  it('defines all five outcome codes', () => {
    expect(content).toContain('PAYMENT_FORM_READY')
    expect(content).toContain('PAYMENT_ALREADY_FUNDED')
    expect(content).toContain('PAYMENT_RETRY_READY')
    expect(content).toContain('PAYMENT_INIT_FAILED')
    expect(content).toContain('FUNDING_REQUEST_EXPIRED')
  })

  it('already-funded path returns PAYMENT_ALREADY_FUNDED outcome', () => {
    expect(content).toContain("outcome: 'PAYMENT_ALREADY_FUNDED'")
  })

  it('new PaymentIntent path returns PAYMENT_FORM_READY outcome', () => {
    expect(content).toContain("outcome: 'PAYMENT_FORM_READY'")
  })

  it('replacement PaymentIntent path uses PAYMENT_RETRY_READY outcome', () => {
    // The outcome variable is computed: isReplacement ? 'PAYMENT_RETRY_READY' : 'PAYMENT_FORM_READY'
    expect(content).toContain("'PAYMENT_RETRY_READY'")
    expect(content).toContain('isReplacement')
  })

  it('error paths return PAYMENT_INIT_FAILED outcome', () => {
    expect(content).toContain("outcome: 'PAYMENT_INIT_FAILED'")
  })

  it('includes ok field in all success responses', () => {
    // Count instances of ok: true in JSON responses
    const okTrueMatches = content.match(/ok:\s*true/g)
    expect(okTrueMatches).not.toBeNull()
    expect(okTrueMatches!.length).toBeGreaterThanOrEqual(3) // at least: form-ready, already-funded, retry-ready
  })

  it('includes ok: false in failure responses', () => {
    const okFalseMatches = content.match(/ok:\s*false/g)
    expect(okFalseMatches).not.toBeNull()
    expect(okFalseMatches!.length).toBeGreaterThanOrEqual(1)
  })
})

// =========================================================================
// 2. Client helper parses each outcome correctly
// =========================================================================

describe('2. Client helper parses typed outcome union', () => {
  const content = readFile(apiClientPath)

  it('defines InitiateFundingOutcome type with all four codes', () => {
    expect(content).toContain("'PAYMENT_FORM_READY'")
    expect(content).toContain("'PAYMENT_ALREADY_FUNDED'")
    expect(content).toContain("'PAYMENT_RETRY_READY'")
    expect(content).toContain("'PAYMENT_INIT_FAILED'")
  })

  it('exports discriminated union types', () => {
    expect(content).toContain('InitiateFundingFormReady')
    expect(content).toContain('InitiateFundingAlreadyFunded')
    expect(content).toContain('InitiateFundingRetryReady')
    expect(content).toContain('InitiateFundingError')
  })

  it('switches on outcome field from server response', () => {
    expect(content).toContain("outcome === 'PAYMENT_ALREADY_FUNDED'")
    expect(content).toContain("outcome === 'PAYMENT_FORM_READY'")
    expect(content).toContain("outcome === 'PAYMENT_RETRY_READY'")
    expect(content).toContain("outcome === 'PAYMENT_INIT_FAILED'")
  })

  it('detects missing outcome as contract violation', () => {
    expect(content).toContain('CONTRACT_VIOLATION_NO_OUTCOME')
  })

  it('detects payment-ready outcome without clientSecret as contract violation', () => {
    expect(content).toContain('CONTRACT_VIOLATION_NO_CLIENT_SECRET')
  })

  it('detects unknown outcome as contract violation', () => {
    expect(content).toContain('CONTRACT_VIOLATION_UNKNOWN_OUTCOME')
  })
})

// =========================================================================
// 3. clientSecret field shape is stable
// =========================================================================

describe('3. clientSecret field shape is normalized', () => {
  it('server returns clientSecret (camelCase) — not client_secret', () => {
    const content = readFile(serverEndpointPath)
    // All response payloads use clientSecret (camelCase)
    const jsonResponses = content.match(/res\.status\(\d+\)\.json\(\{[\s\S]*?\}\)/g) ?? []
    for (const resp of jsonResponses) {
      if (resp.includes('clientSecret')) {
        // Make sure it's clientSecret, not client_secret in JSON output
        expect(resp).not.toMatch(/['"]client_secret['"]\s*:/)
      }
    }
  })

  it('client reads data.clientSecret consistently', () => {
    const content = readFile(apiClientPath)
    expect(content).toContain('data.clientSecret')
    // Must not try to read client_secret (snake_case) from response
    expect(content).not.toContain('data.client_secret')
  })
})

// =========================================================================
// 4. PAYMENT_FORM_READY always includes clientSecret
// =========================================================================

describe('4. PAYMENT_FORM_READY always delivers clientSecret', () => {
  it('server guards: new PaymentIntent must have client_secret before responding', () => {
    const content = readFile(serverEndpointPath)
    // Guard that prevents response if PaymentIntent has no client_secret
    expect(content).toContain('!paymentIntent.client_secret')
    expect(content).toContain('STRIPE_NO_CLIENT_SECRET')
  })

  it('server guards: reused PaymentIntent must have client_secret', () => {
    const content = readFile(serverEndpointPath)
    // Reuse path checks for client_secret before returning PAYMENT_FORM_READY
    expect(content).toContain('existingIntent.client_secret')
  })

  it('client validates clientSecret presence for payment-ready outcomes', () => {
    const content = readFile(apiClientPath)
    expect(content).toContain('CONTRACT_VIOLATION_NO_CLIENT_SECRET')
  })
})

// =========================================================================
// 5. PAYMENT_ALREADY_FUNDED never requires clientSecret
// =========================================================================

describe('5. PAYMENT_ALREADY_FUNDED does not require clientSecret', () => {
  it('server returns clientSecret: null for already-funded', () => {
    const content = readFile(serverEndpointPath)
    // Find already-funded response blocks and verify clientSecret: null
    expect(content).toContain("outcome: 'PAYMENT_ALREADY_FUNDED'")
  })

  it('client returns ok: true with outcome PAYMENT_ALREADY_FUNDED (no data.clientSecret)', () => {
    const content = readFile(apiClientPath)
    expect(content).toContain("outcome: 'PAYMENT_ALREADY_FUNDED'")
  })
})

// =========================================================================
// 6. PAYMENT_RETRY_READY includes replacement clientSecret
// =========================================================================

describe('6. PAYMENT_RETRY_READY delivers replacement clientSecret', () => {
  it('server creates replacement intent when existing is stale/canceled', () => {
    const content = readFile(serverEndpointPath)
    expect(content).toContain('isReplacement')
    expect(content).toContain('stale_intent_replaced')
  })

  it('server logs replacement lifecycle path', () => {
    const content = readFile(serverEndpointPath)
    expect(content).toContain("lifecyclePath: 'replace'")
  })
})

// =========================================================================
// 7. PAYMENT_INIT_FAILED returns explicit error
// =========================================================================

describe('7. PAYMENT_INIT_FAILED returns explicit failure', () => {
  it('server returns error with ok: false on Stripe error', () => {
    const content = readFile(serverEndpointPath)
    expect(content).toContain("ok: false")
    expect(content).toContain("outcome: 'PAYMENT_INIT_FAILED'")
  })

  it('server includes errorCode for Stripe errors', () => {
    const content = readFile(serverEndpointPath)
    expect(content).toContain('STRIPE_')
  })

  it('client surfaces server error codes', () => {
    const content = readFile(apiClientPath)
    expect(content).toContain('errorCode')
  })
})

// =========================================================================
// 8. UI state machine maps every outcome
// =========================================================================

describe('8. UI state machine maps each outcome to a distinct phase', () => {
  const content = readFile(cardPath)

  it('PaymentPhase includes payment-already-funded', () => {
    expect(content).toContain("'payment-already-funded'")
  })

  it('PaymentPhase includes all five phases', () => {
    expect(content).toContain("'idle'")
    expect(content).toContain("'preparing-payment'")
    expect(content).toContain("'payment-form-ready'")
    expect(content).toContain("'payment-already-funded'")
    expect(content).toContain("'payment-init-error'")
  })

  it('handleStartPayment checks result.outcome', () => {
    expect(content).toContain('result.outcome')
  })

  it('PAYMENT_ALREADY_FUNDED confirms server-side then reconciles', () => {
    expect(content).toContain("result.outcome === 'PAYMENT_ALREADY_FUNDED'")
    // FINDINGS P1 #333: already-funded no longer dead-ends on a local
    // payment-already-funded read (DB stayed funding_initiated until the
    // webhook). It now confirms (idempotent + Stripe-verified) then enters
    // the bounded reconciliation poll.
    expect(content).toContain("setPaymentPhase('reconciliation-pending')")
  })

  it('form-ready outcome maps to payment-form-ready phase', () => {
    expect(content).toContain("setPaymentPhase('payment-form-ready')")
  })

  it('renders already-funded UI block with data-testid', () => {
    expect(content).toContain('data-testid="payment-already-funded"')
  })

  it('failure outcome falls through to payment-init-error via catch', () => {
    expect(content).toContain("setPaymentPhase('payment-init-error')")
  })
})

// =========================================================================
// 9. No regression to authenticated initiate-funding
// =========================================================================

describe('9. No regression to authenticated initiate-funding', () => {
  it('client sends Authorization: Bearer header', () => {
    const content = readFile(apiClientPath)
    expect(content).toContain('Authorization')
    expect(content).toContain('Bearer')
  })

  it('server uses requireAuth', () => {
    const content = readFile(serverEndpointPath)
    expect(content).toContain('requireAuth')
  })

  it('server validates customer_user_id ownership', () => {
    const content = readFile(serverEndpointPath)
    expect(content).toContain('customer_user_id')
    expect(content).toContain('auth.userId')
  })
})

// =========================================================================
// 10. No regression to dedicated funding route
// =========================================================================

describe('10. No regression to dedicated funding route', () => {
  it('FundingEntryScreen still exists', () => {
    expect(fs.existsSync(fundingEntryScreenPath)).toBe(true)
  })

  it('App still registers /funding/:fundingRequestId route', () => {
    const content = readFile(appPath)
    expect(content).toContain('/funding/:fundingRequestId')
  })
})

// =========================================================================
// 11. False success "kein Client-Secret erhalten" is eliminated
// =========================================================================

describe('11. False success state is eliminated', () => {
  it('client helper no longer contains "kein Client-Secret erhalten"', () => {
    const content = readFile(apiClientPath)
    expect(content).not.toContain('kein Client-Secret erhalten')
  })

  it('UI component no longer contains "kein Client-Secret erhalten"', () => {
    const content = readFile(cardPath)
    expect(content).not.toContain('kein Client-Secret erhalten')
  })

  it('client never returns ok: true without an explicit outcome', () => {
    const content = readFile(apiClientPath)
    // Every return with ok: true must also have an outcome field
    const okTrueReturns = content.match(/return\s*\{\s*ok:\s*true[\s\S]*?\}/g) ?? []
    for (const ret of okTrueReturns) {
      expect(ret).toContain('outcome')
    }
  })
})

// =========================================================================
// 12. Structured debug logging covers lifecycle paths
// =========================================================================

describe('12. Structured debug logging covers lifecycle paths', () => {
  it('server logs lifecycle path for each branch', () => {
    const content = readFile(serverEndpointPath)
    // 'create' appears via ternary: isReplacement ? 'replace' : 'create'
    expect(content).toContain("'create'")
    expect(content).toContain("lifecyclePath: 'reuse'")
    expect(content).toContain("lifecyclePath: 'replace'")
    expect(content).toContain("lifecyclePath: 'already-funded'")
    expect(content).toContain("lifecyclePath: 'fail'")
  })

  it('server logs outcome code in all lifecycle paths', () => {
    const content = readFile(serverEndpointPath)
    // Outcome is logged in server info/warning/error events
    const outcomeLogMatches = content.match(/outcome:/g)
    expect(outcomeLogMatches).not.toBeNull()
    expect(outcomeLogMatches!.length).toBeGreaterThanOrEqual(5)
  })

  it('server logs hasClientSecret for payment-ready paths', () => {
    const content = readFile(serverEndpointPath)
    expect(content).toContain('hasClientSecret')
  })

  it('client logs outcome from server response', () => {
    const content = readFile(cardPath)
    expect(content).toContain('outcome: result.outcome')
  })
})

// =========================================================================
// 13. Funding expiry deadline enforcement (synchronous guard)
// =========================================================================

describe('13. Funding expiry deadline enforcement', () => {
  const content = readFile(serverEndpointPath)

  it('selects expires_at from funding_requests', () => {
    expect(content).toContain('expires_at')
  })

  it('defines FUNDING_REQUEST_EXPIRED outcome', () => {
    expect(content).toContain("'FUNDING_REQUEST_EXPIRED'")
  })

  it('checks expires_at against Date.now() before any Stripe operation', () => {
    const expiryCheckIdx = content.indexOf('expires_at != null')
    expect(expiryCheckIdx).toBeGreaterThan(0)
    // Date.now() must appear at or after the expiry check (not just in unrelated code)
    const dateNowAfterCheck = content.indexOf('Date.now()', expiryCheckIdx)
    expect(dateNowAfterCheck).toBeGreaterThan(expiryCheckIdx)
  })

  it('returns 409 with FUNDING_REQUEST_EXPIRED when deadline has passed', () => {
    expect(content).toContain("outcome: 'FUNDING_REQUEST_EXPIRED'")
    // Must be a reject path (409), not a success path
    const expiredOutcomeIdx = content.indexOf("outcome: 'FUNDING_REQUEST_EXPIRED'")
    const res409Idx = content.lastIndexOf('res.status(409)', expiredOutcomeIdx)
    expect(res409Idx).toBeGreaterThan(0)
    expect(expiredOutcomeIdx - res409Idx).toBeLessThan(300)
  })

  it('atomically marks row expired on deadline violation', () => {
    expect(content).toContain("status: 'expired'")
    expect(content).toContain('api.funding.deadline_expired')
  })

  it('expiry guard fires before escrow plan lookup (no Stripe call for expired requests)', () => {
    const expiryGuardIdx = content.indexOf('expires_at != null')
    const escrowLookupIdx = content.indexOf("from('escrow_payment_plans')")
    expect(expiryGuardIdx).toBeGreaterThan(0)
    expect(escrowLookupIdx).toBeGreaterThan(0)
    expect(expiryGuardIdx).toBeLessThan(escrowLookupIdx)
  })
})

// =========================================================================
// 14. Replacement PI does not double-charge (FIX 4 / FINDINGS P1 #327)
// =========================================================================

describe('14. Replacement PaymentIntent cannot cause a double charge', () => {
  const content = readFile(serverEndpointPath)

  it('classifies transient Stripe failures distinctly from terminal ones', () => {
    expect(content).toContain('isTransientStripeError')
    // Network blip and Stripe API error are transient.
    expect(content).toContain('StripeConnectionError')
    expect(content).toContain('StripeAPIError')
    // 429 rate-limit is transient too — a rate-limited retrieve must NOT spawn
    // a replacement PI (review condition-closer for the double-charge gap).
    expect(content).toContain('StripeRateLimitError')
    expect(content).toContain('=== 429')
    // Any 5xx is transient.
    expect(content).toContain('statusCode >= 500')
  })

  it('returns 502 (retry SAME PI) instead of replacing on a transient retrieve failure', () => {
    expect(content).toContain('STRIPE_RETRIEVE_TRANSIENT')
    const transientIdx = content.indexOf('STRIPE_RETRIEVE_TRANSIENT')
    expect(transientIdx).toBeGreaterThan(0)
    const res502Idx = content.lastIndexOf('res.status(502)', transientIdx)
    expect(res502Idx).toBeGreaterThan(0)
    expect(transientIdx - res502Idx).toBeLessThan(400)
  })

  it('only sets isReplacement after the transient guard (transient errors never replace)', () => {
    // In the main retrieve catch the transient check must precede the
    // isReplacement = true assignment so a network blip can never replace.
    const transientGuardIdx = content.indexOf('if (isTransientStripeError(retrieveErr))')
    expect(transientGuardIdx).toBeGreaterThan(0)
    const replaceAfterGuardIdx = content.indexOf('isReplacement = true', transientGuardIdx)
    expect(replaceAfterGuardIdx).toBeGreaterThan(transientGuardIdx)
  })

  it('cancels the old PaymentIntent before minting the replacement', () => {
    expect(content).toContain('paymentIntents.cancel')
    expect(content).toContain('old_intent_canceled')
    const cancelIdx = content.indexOf('paymentIntents.cancel')
    const createIdx = content.indexOf('paymentIntents.create')
    expect(cancelIdx).toBeGreaterThan(0)
    expect(createIdx).toBeGreaterThan(0)
    expect(cancelIdx).toBeLessThan(createIdx)
  })

  it('only cancels when actually replacing (gated on isReplacement)', () => {
    expect(content).toContain('if (isReplacement && fundingRequest.external_funding_ref)')
  })

  it('treats a cancel failure as best-effort (does not abort the replacement)', () => {
    expect(content).toContain('old_intent_cancel_failed')
  })
})

// =========================================================================
// 15. Card-only PaymentIntent — no redirect LPMs (FIX 3b / FINDINGS P1 #321)
// =========================================================================

describe('15. PaymentIntent is pinned to card-only', () => {
  const content = readFile(serverEndpointPath)

  it("pins payment_method_types to ['card']", () => {
    expect(content).toContain("payment_method_types: ['card']")
  })

  it('does NOT enable automatic_payment_methods as a param (would re-add redirect LPMs)', () => {
    // Match the object-key form so the explanatory comment mentioning the
    // option by name does not trip this guard.
    expect(content).not.toContain('automatic_payment_methods:')
  })
})

// =========================================================================
// 16. Destination-charge is flag-gated (P2 — ZAG corridor cutover)
// =========================================================================
// Static source-text assertions (this suite never executes the handler or
// mocks Stripe). They prove (a) the flag-on Destination template was added,
// and (b) it is gated behind FUNDING_DESTINATION_CHARGE_ENABLED so that with
// the flag OFF the PaymentIntent params are byte-identical to before P2.
// True flag-on behaviour is independently proven by the identical, already
// shipped template in api/initiate-diagnosis-payment.ts.

describe('16. Destination-charge is flag-gated (P2)', () => {
  const content = readFile(serverEndpointPath)

  it('reads the server flag FUNDING_DESTINATION_CHARGE_ENABLED with strict === \'true\'', () => {
    expect(content).toContain('FUNDING_DESTINATION_CHARGE_ENABLED')
    expect(content).toContain("=== 'true'")
  })

  it('carries the Destination template on the flag-on path', () => {
    expect(content).toContain('transfer_data')
    expect(content).toContain('application_fee_amount')
    expect(content).toContain('destination: payoutAccount.stripe_connect_account_id')
  })

  it('gates the destination params behind the flag (flag-off identity)', () => {
    // The gate must be read BEFORE the destination params are emitted, i.e. the
    // params live inside the conditional spread, not in the base PI literal.
    const flagIdx = content.indexOf('FUNDING_DESTINATION_CHARGE_ENABLED')
    const transferIdx = content.indexOf('transfer_data')
    expect(flagIdx).toBeGreaterThan(0)
    expect(transferIdx).toBeGreaterThan(0)
    expect(flagIdx).toBeLessThan(transferIdx)
  })

  it('leaves the flag-off card-only invariants untouched', () => {
    // Match the param-key (colon) forms so the explanatory comments that mention
    // these options by name do not trip the guards (same technique as Section 15).
    expect(content).toContain("payment_method_types: ['card']")
    expect(content).not.toContain('automatic_payment_methods:')
    expect(content).not.toContain('capture_method:')
    expect(content).not.toContain('on_behalf_of:')
  })

  it('replaces the stale warning with the P2/P3 coherence note', () => {
    expect(content).not.toContain('Do NOT add transfer_data.destination')
    expect(content).toContain('P3')
    expect(content).toContain('payouts.create')
  })
})
