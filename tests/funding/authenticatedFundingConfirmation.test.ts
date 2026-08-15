/**
 * Authenticated Funding Confirmation Tests
 *
 * Validates:
 * 1. confirmFundingApi module exists and is well-structured
 * 2. The module uses Supabase auth for Bearer token
 * 3. The module sends Authorization header
 * 4. The module calls /api/confirm-funding with POST
 * 5. The module sends canonical funding + payment identifiers
 * 6. The module handles missing session token
 * 7. The module handles HTTP errors
 * 8. The barrel exports the new function and types
 * 9. CustomerEscrowFundingCard uses the authenticated helper
 * 10. The component no longer uses a bare fetch to /api/confirm-funding
 * 11. The API endpoint supports dual auth (server secret OR JWT)
 * 12. The API endpoint validates customer ownership for JWT auth
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── File paths ────────────────────────────────────────────────────────────

const apiClientPath = path.resolve(__dirname, '../../src/lib/funding/confirmFundingApi.ts')
const barrelPath = path.resolve(__dirname, '../../src/lib/funding/index.ts')
const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
const endpointPath = path.resolve(__dirname, '../../api/confirm-funding.ts')

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Authenticated Funding Confirmation', () => {

  // ─── 1. Module exists and is well-structured ──────────────────────────

  describe('1. confirmFundingApi module exists and is well-structured', () => {
    it('client API module exists', () => {
      expect(fs.existsSync(apiClientPath)).toBe(true)
    })

    it('exports confirmFundingPayment function', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export async function confirmFundingPayment')
    })

    it('exports ConfirmFundingParams type', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export type ConfirmFundingParams')
    })

    it('exports ConfirmFundingResult type', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export type ConfirmFundingResult')
    })

    it('exports ConfirmFundingSuccess type', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export type ConfirmFundingSuccess')
    })

    it('exports ConfirmFundingError type', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export type ConfirmFundingError')
    })
  })

  // ─── 2. Uses Supabase auth for Bearer token ──────────────────────────

  describe('2. Uses Supabase auth for Bearer token', () => {
    it('imports supabase client', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain("import { supabase } from '../supabase'")
    })

    it('calls supabase.auth.getSession to retrieve current session', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('supabase.auth.getSession()')
    })

    it('extracts access_token from session data', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('access_token')
    })
  })

  // ─── 3. Sends Authorization header ────────────────────────────────────

  describe('3. Sends Authorization: Bearer header', () => {
    it('builds Authorization header with Bearer scheme', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain("'Authorization': `Bearer ${token}`")
    })

    it('includes Content-Type: application/json', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain("'Content-Type': 'application/json'")
    })
  })

  // ─── 4. Calls /api/confirm-funding with POST ─────────────────────────

  describe('4. Calls /api/confirm-funding with POST', () => {
    it('calls the correct endpoint', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain("'/api/confirm-funding'")
    })

    it('uses POST method', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain("method: 'POST'")
    })
  })

  // ─── 5. Sends canonical funding + payment identifiers ────────────────

  describe('5. Sends canonical funding + payment identifiers', () => {
    it('ConfirmFundingParams includes paymentIntentId', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      const paramsSection = content.slice(
        content.indexOf('export type ConfirmFundingParams'),
        content.indexOf('}', content.indexOf('export type ConfirmFundingParams')) + 1,
      )
      expect(paramsSection).toContain('paymentIntentId: string')
    })

    it('ConfirmFundingParams includes fundingRequestId', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      const paramsSection = content.slice(
        content.indexOf('export type ConfirmFundingParams'),
        content.indexOf('}', content.indexOf('export type ConfirmFundingParams')) + 1,
      )
      expect(paramsSection).toContain('fundingRequestId: string')
    })

    it('ConfirmFundingParams includes escrowPlanId', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      const paramsSection = content.slice(
        content.indexOf('export type ConfirmFundingParams'),
        content.indexOf('}', content.indexOf('export type ConfirmFundingParams')) + 1,
      )
      expect(paramsSection).toContain('escrowPlanId: string')
    })

    it('ConfirmFundingParams includes jobId', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      const paramsSection = content.slice(
        content.indexOf('export type ConfirmFundingParams'),
        content.indexOf('}', content.indexOf('export type ConfirmFundingParams')) + 1,
      )
      expect(paramsSection).toContain('jobId: string')
    })

    it('sends all four identifiers in the request body', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('JSON.stringify({ paymentIntentId, fundingRequestId, escrowPlanId, jobId })')
    })
  })

  // ─── 6. Handles missing session token ────────────────────────────────

  describe('6. Handles missing session token', () => {
    it('checks for missing token before making the API call', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('!token')
    })

    it('returns an error result when no token is available', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('Keine aktive Sitzung gefunden')
    })

    it('logs a warning when no token is available', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('payment.confirm_funding_no_token')
    })
  })

  // ─── 7. Handles HTTP errors ──────────────────────────────────────────

  describe('7. Handles HTTP errors', () => {
    it('checks response.ok for HTTP failures', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('!response.ok')
    })

    it('extracts error message from response body', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('body.error')
    })

    it('returns statusCode in error result', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('statusCode: response.status')
    })

    it('handles network errors in catch block', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('Netzwerkfehler bei der Zahlungsbestätigung')
    })
  })

  // ─── 8. Barrel exports ───────────────────────────────────────────────

  describe('8. Barrel exports include confirmFundingPayment', () => {
    it('barrel exports confirmFundingPayment function', () => {
      const content = fs.readFileSync(barrelPath, 'utf-8')
      expect(content).toContain('confirmFundingPayment')
    })

    it('barrel exports ConfirmFundingParams type', () => {
      const content = fs.readFileSync(barrelPath, 'utf-8')
      expect(content).toContain('ConfirmFundingParams')
    })

    it('barrel exports ConfirmFundingResult type', () => {
      const content = fs.readFileSync(barrelPath, 'utf-8')
      expect(content).toContain('ConfirmFundingResult')
    })

    it('barrel exports from confirmFundingApi module', () => {
      const content = fs.readFileSync(barrelPath, 'utf-8')
      expect(content).toContain("from './confirmFundingApi'")
    })
  })

  // ─── 9. CustomerEscrowFundingCard uses the authenticated helper ──────

  describe('9. CustomerEscrowFundingCard uses authenticated confirm helper', () => {
    it('imports confirmFundingPayment', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain("import { confirmFundingPayment } from '../../lib/funding/confirmFundingApi'")
    })

    it('calls confirmFundingPayment in handleStripeConfirmed', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      const startIdx = content.indexOf('const handleStripeConfirmed = useCallback')
      const endPatterns = ['const handleStripeError', 'const handleRetryPayment']
      let endIdx = content.length
      for (const pat of endPatterns) {
        const idx = content.indexOf(pat, startIdx + 100)
        if (idx > startIdx && idx < endIdx) endIdx = idx
      }
      const fnBody = content.slice(startIdx, endIdx)
      expect(fnBody).toContain('confirmFundingPayment')
    })

    it('passes paymentIntentId, fundingRequestId, escrowPlanId, and jobId to the helper', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      const startIdx = content.indexOf('const handleStripeConfirmed = useCallback')
      const endPatterns = ['const handleStripeError', 'const handleRetryPayment']
      let endIdx = content.length
      for (const pat of endPatterns) {
        const idx = content.indexOf(pat, startIdx + 100)
        if (idx > startIdx && idx < endIdx) endIdx = idx
      }
      const fnBody = content.slice(startIdx, endIdx)
      expect(fnBody).toContain('paymentIntentId')
      expect(fnBody).toContain('fundingRequestId')
      expect(fnBody).toContain('escrowPlanId')
      expect(fnBody).toContain('jobId')
    })

    it('checks result.ok for success/failure', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      const startIdx = content.indexOf('const handleStripeConfirmed = useCallback')
      const endPatterns = ['const handleStripeError', 'const handleRetryPayment']
      let endIdx = content.length
      for (const pat of endPatterns) {
        const idx = content.indexOf(pat, startIdx + 100)
        if (idx > startIdx && idx < endIdx) endIdx = idx
      }
      const fnBody = content.slice(startIdx, endIdx)
      expect(fnBody).toContain('!result.ok')
    })
  })

  // ─── 10. No bare fetch to /api/confirm-funding in the component ──────

  describe('10. No bare fetch to /api/confirm-funding in the component', () => {
    it('component does not use fetch("/api/confirm-funding") directly', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).not.toContain("fetch('/api/confirm-funding'")
    })

    it('component does not manually set Content-Type for confirm-funding', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      const startIdx = content.indexOf('const handleStripeConfirmed = useCallback')
      const endPatterns = ['const handleStripeError', 'const handleRetryPayment']
      let endIdx = content.length
      for (const pat of endPatterns) {
        const idx = content.indexOf(pat, startIdx + 100)
        if (idx > startIdx && idx < endIdx) endIdx = idx
      }
      const fnBody = content.slice(startIdx, endIdx)
      expect(fnBody).not.toContain("'Content-Type': 'application/json'")
    })
  })

  // ─── 11. API endpoint supports dual auth ─────────────────────────────

  describe('11. API endpoint supports dual auth (server secret OR JWT)', () => {
    it('endpoint imports requireCustomer from _authRole', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain("import { requireCustomer } from './_authRole.js'")
    })

    it('endpoint checks for server secret via x-funding-confirm-secret header', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('x-funding-confirm-secret')
    })

    it('endpoint falls back to requireCustomer when no server secret', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('requireCustomer(req, res)')
    })

    it('endpoint uses dual auth pattern (hasServerSecret check)', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('hasServerSecret')
      expect(content).toContain('if (!hasServerSecret)')
    })
  })

  // ─── 12. API endpoint validates customer ownership for JWT auth ──────

  describe('12. API endpoint validates customer ownership for JWT auth', () => {
    it('endpoint checks customer_user_id for ownership', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('customer_user_id')
    })

    it('endpoint logs ownership denial', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('api.confirm_funding.ownership_denied')
    })

    it('endpoint returns 403 for non-customer callers', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('you are not the customer for this funding request')
    })

    it('endpoint only checks ownership when authenticatedUserId is present', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('if (authenticatedUserId)')
    })
  })
})
