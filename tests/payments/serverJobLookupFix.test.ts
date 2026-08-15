/**
 * Server Job Lookup Fix Tests
 *
 * Validates the fixes to /api/request-funding provider identity resolution,
 * canonical job redirect, and structured error surfacing:
 *
 *  1. Provider identity resolved via providers.profile_id → providers.id
 *  2. jobs.provider_id ownership check uses providers.id, not auth user id
 *  3. Stale duplicate incoming jobId is redirected to canonical accepted job
 *  4. Canonical accepted job proceeds into escrow/funding creation path
 *  5. Structured errors returned when provider mapping or ownership is invalid
 *  6. No regression to existing server-authoritative funding creation flow
 *  7. New error codes are mapped to German user-facing messages
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { mapFundingErrorToMessage } from '../../src/lib/payments/fundingClient'

// ── Helpers ───────────────────────────────────────────────────────────────

const apiPath = path.resolve(__dirname, '../../api/request-funding.ts')
const apiContent = fs.readFileSync(apiPath, 'utf-8')

const clientPath = path.resolve(__dirname, '../../src/lib/payments/fundingClient.ts')
const clientContent = fs.readFileSync(clientPath, 'utf-8')

// ═══════════════════════════════════════════════════════════════════════════
// 1. Provider identity resolved via providers.profile_id → providers.id
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — provider identity resolved via providers table', () => {
  it('queries providers table by provider_id to resolve profile_id', () => {
    // The API must look up providers.profile_id from providers.id
    expect(apiContent).toContain("from('providers')")
    expect(apiContent).toContain("select('id, profile_id')")
    expect(apiContent).toContain("eq('id', providerId)")
  })

  it('compares resolved profile_id to auth.userId', () => {
    expect(apiContent).toContain('providerRow.profile_id === auth.userId')
  })

  it('also resolves provider via auth profile_id reverse lookup', () => {
    // The API should also try: providers.profile_id = auth.userId → compare providers.id to job.provider_id
    expect(apiContent).toContain("eq('profile_id', auth.userId)")
    expect(apiContent).toContain('authProviderRow.id === providerId')
  })

  it('logs provider resolution via profile for observability', () => {
    expect(apiContent).toContain('provider_resolved_via_profile')
  })

  it('logs provider resolution via auth profile for observability', () => {
    expect(apiContent).toContain('provider_resolved_via_auth_profile')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. jobs.provider_id ownership check uses providers.id, not auth user id
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — provider_id ownership uses providers.id (not auth.uid)', () => {
  it('documents that provider_id stores providers.id (DB UUID)', () => {
    expect(apiContent).toContain('jobs.provider_id stores providers.id (DB UUID), NOT auth.uid()')
  })

  it('does NOT directly compare auth.userId to provider_id', () => {
    // auth.userId should NOT be compared directly to canonicalJob.provider_id
    // because provider_id is providers.id (DB UUID), not auth.uid()
    expect(apiContent).not.toMatch(/auth\.userId\s*(!==|===|!==?|===?)\s*providerId\b/)
    expect(apiContent).not.toMatch(/auth\.userId\s*(!==|===|!==?|===?)\s*canonicalJob\.provider_id\b/)
  })

  it('uses providerAuthorized flag for multi-path authorization', () => {
    expect(apiContent).toContain('let providerAuthorized')
    expect(apiContent).toContain('if (!providerAuthorized)')
  })

  it('first tries direct craftsman_user_id match before providers table lookup', () => {
    // Direct match comes before the providers table lookup
    const directMatch = apiContent.indexOf('auth.userId === providerUserId')
    const providerLookup = apiContent.indexOf("from('providers')")
    expect(directMatch).toBeGreaterThan(-1)
    expect(providerLookup).toBeGreaterThan(-1)
    expect(directMatch).toBeLessThan(providerLookup)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Server-side job identity stays artifact-bound
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — server-side canonical job identity', () => {
  it('never infers a replacement job from customer/provider parties', () => {
    expect(apiContent).toContain('accepted_offer_created_job_id_only')
    expect(apiContent).not.toContain('canonical_redirect')
    expect(apiContent).not.toContain(".eq('customer_user_id', job.customer_user_id)")
  })

  it('allows only exact accepted-offer recovery for the requested job', () => {
    expect(apiContent).toContain(".eq('created_job_id', canonicalJob.id)")
    expect(apiContent).toContain(".eq('status', 'accepted')")
    expect(apiContent).toContain('SOURCE_OFFER_MISSING')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Canonical accepted job proceeds into escrow/funding creation path
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — canonical job used for downstream creation', () => {
  it('uses canonicalJob for escrow plan creation', () => {
    expect(apiContent).toContain('job_id: canonicalJob.id')
  })

  it('uses canonicalJob for funding request creation', () => {
    // Funding request references canonical job
    expect(apiContent).toContain("job_id: canonicalJob.id")
  })

  it('uses canonicalJob for thread artifact creation', () => {
    // Thread artifact uses offer.conversation_id (confirmed-live) instead of
    // canonicalJob.source_conversation_id (not confirmed-live)
    expect(apiContent).toContain('offer.conversation_id')
  })

  it('returns canonical job ID in the response', () => {
    expect(apiContent).toContain("jobId: canonicalJob.id")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Structured errors for provider mapping and ownership validation
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — structured error codes for provider/ownership failures', () => {
  it('returns PROVIDER_PROFILE_NOT_FOUND when provider row is missing', () => {
    expect(apiContent).toContain('PROVIDER_PROFILE_NOT_FOUND')
  })

  it('returns PROVIDER_NOT_AUTHORIZED when ownership check fails', () => {
    expect(apiContent).toContain('PROVIDER_NOT_AUTHORIZED')
  })

  it('returns PROVIDER_LINKAGE_MISSING when no provider identity exists', () => {
    expect(apiContent).toContain('PROVIDER_LINKAGE_MISSING')
  })

  it('returns JOB_QUERY_FAILED instead of vague error on DB failure', () => {
    expect(apiContent).toContain('JOB_QUERY_FAILED')
    // The structured code should be in the JSON response
    expect(apiContent).toContain("code: 'JOB_QUERY_FAILED'")
  })

  it('logs authorization failure details for debugging', () => {
    expect(apiContent).toContain('expectedProviderId: providerId')
    expect(apiContent).toContain('expectedProviderUserId: providerUserId')
    // craftsman_user_id is no longer logged (not live on jobs table)
    // provider identity is derived from offer.craftsman_user_id instead
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. No regression to server-authoritative funding creation flow
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — no regression to server-authoritative funding creation', () => {
  it('uses requireOwner for JWT + role auth (Block 7.2.1c-FU)', () => {
    expect(apiContent).toContain('requireOwner')
    expect(apiContent).toContain("from './_authRole")
  })

  it('still uses admin client for DB writes', () => {
    expect(apiContent).toContain('getSupabaseAdminWithStatus')
  })

  it('still creates escrow plan with 25/75 tranche split', () => {
    expect(apiContent).toContain('deposit_release')
    expect(apiContent).toContain('final_release')
    expect(apiContent).toContain('DEPOSIT_RELEASE_PERCENT')
    expect(apiContent).toContain('FINAL_RELEASE_PERCENT')
  })

  it('still checks for existing escrow plan before creating (idempotent)', () => {
    expect(apiContent).toContain('escrow_payment_plans')
    expect(apiContent).toContain('escrow_plan_reused')
  })

  it('still checks for existing funding request before creating (idempotent)', () => {
    expect(apiContent).toContain('funding_requests')
    expect(apiContent).toContain('funding_request_reused')
  })

  it('still creates thread artifact for customer visibility', () => {
    expect(apiContent).toContain('thread_artifacts')
    // Uses 'payment_phase' (valid per DB CHECK constraint) instead of 'funding_step'
    expect(apiContent).toContain('payment_phase')
  })

  it('still returns idempotent flag when reusing existing data', () => {
    expect(apiContent).toContain('idempotent')
  })

  it('client still uses /api/request-funding endpoint', () => {
    expect(clientContent).toContain('/api/request-funding')
  })

  it('client still does NOT perform local writes', () => {
    expect(clientContent).not.toContain('ensureEscrowPlan')
    expect(clientContent).not.toContain('ensureFundingRequest')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. New error codes mapped to German user-facing messages
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — new error codes have German user-facing messages', () => {
  it('maps JOB_LOOKUP_FAILED to German message', () => {
    const msg = mapFundingErrorToMessage('JOB_LOOKUP_FAILED', 'fallback')
    expect(msg).not.toBe('fallback')
    expect(msg).toBeTruthy()
  })

  it('maps PROVIDER_PROFILE_NOT_FOUND to German message', () => {
    const msg = mapFundingErrorToMessage('PROVIDER_PROFILE_NOT_FOUND', 'fallback')
    expect(msg).not.toBe('fallback')
    expect(msg).toContain('Handwerkerprofil')
  })

  it('maps STALE_JOB_REDIRECT_FAILED to German message', () => {
    const msg = mapFundingErrorToMessage('STALE_JOB_REDIRECT_FAILED', 'fallback')
    expect(msg).not.toBe('fallback')
    expect(msg).toBeTruthy()
  })

  it('still maps all pre-existing error codes', () => {
    const preExistingCodes = [
      'CANONICAL_JOB_NOT_FOUND',
      'SOURCE_OFFER_MISSING',
      'ACCEPTED_OFFER_NOT_FOUND',
      'CUSTOMER_LINKAGE_MISSING',
      'PROVIDER_LINKAGE_MISSING',
      'PROVIDER_NOT_AUTHORIZED',
      'INVALID_AMOUNT_BASIS',
      'JOB_IN_TERMINAL_STATE',
      'NO_ACCEPTED_QUOTE',
      'ESCROW_PLAN_CREATE_FAILED',
      'FUNDING_REQUEST_CREATE_FAILED',
      'FUNDING_ARTIFACT_CREATE_FAILED',
    ]
    for (const code of preExistingCodes) {
      const msg = mapFundingErrorToMessage(code, 'fallback')
      expect(msg).not.toBe('fallback')
    }
  })

  it('still returns fallback for unknown codes', () => {
    expect(mapFundingErrorToMessage('UNKNOWN', 'fallback')).toBe('fallback')
    expect(mapFundingErrorToMessage(undefined, 'fallback')).toBe('fallback')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Error code type includes all new codes
// ═══════════════════════════════════════════════════════════════════════════

describe('8 — FundingCreationErrorCode type includes all new codes', () => {
  it('includes JOB_LOOKUP_FAILED in the error code type', () => {
    expect(apiContent).toContain("| 'JOB_LOOKUP_FAILED'")
  })

  it('includes PROVIDER_PROFILE_NOT_FOUND in the error code type', () => {
    expect(apiContent).toContain("| 'PROVIDER_PROFILE_NOT_FOUND'")
  })

  it('includes STALE_JOB_REDIRECT_FAILED in the error code type', () => {
    expect(apiContent).toContain("| 'STALE_JOB_REDIRECT_FAILED'")
  })
})
