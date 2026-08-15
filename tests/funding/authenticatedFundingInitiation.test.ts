/**
 * Authenticated Funding Initiation Tests
 *
 * Validates:
 * 1. initiateFundingApi module exists and is well-structured
 * 2. The module uses Supabase auth for Bearer token
 * 3. The module sends Authorization header
 * 4. The module calls /api/initiate-funding with POST
 * 5. The module sends canonical funding identifiers (fundingRequestId, escrowPlanId, jobId)
 * 6. The module handles missing session token
 * 7. The module handles HTTP errors
 * 8. The module handles missing clientSecret
 * 9. The barrel exports the new function and types
 * 10. CustomerEscrowFundingCard uses the authenticated helper
 * 11. The component no longer uses a bare fetch to /api/initiate-funding
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── File paths ────────────────────────────────────────────────────────────

const apiClientPath = path.resolve(__dirname, '../../src/lib/funding/initiateFundingApi.ts')
const barrelPath = path.resolve(__dirname, '../../src/lib/funding/index.ts')
const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Authenticated Funding Initiation', () => {

  // ─── 1. Module exists and is well-structured ──────────────────────────

  describe('1. initiateFundingApi module exists and is well-structured', () => {
    it('client API module exists', () => {
      expect(fs.existsSync(apiClientPath)).toBe(true)
    })

    it('exports initiateFundingPayment function', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export async function initiateFundingPayment')
    })

    it('exports InitiateFundingParams type', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export type InitiateFundingParams')
    })

    it('exports InitiateFundingResult type', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export type InitiateFundingResult')
    })

    it('exports InitiateFundingSuccess type', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export type InitiateFundingSuccess')
    })

    it('exports InitiateFundingError type', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('export type InitiateFundingError')
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

  // ─── 4. Calls /api/initiate-funding with POST ────────────────────────

  describe('4. Calls /api/initiate-funding with POST', () => {
    it('calls the correct endpoint', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain("'/api/initiate-funding'")
    })

    it('uses POST method', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain("method: 'POST'")
    })
  })

  // ─── 5. Sends canonical funding identifiers ──────────────────────────

  describe('5. Sends canonical funding identifiers', () => {
    it('InitiateFundingParams includes fundingRequestId', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      const paramsSection = content.slice(
        content.indexOf('export type InitiateFundingParams'),
        content.indexOf('}', content.indexOf('export type InitiateFundingParams')) + 1,
      )
      expect(paramsSection).toContain('fundingRequestId: string')
    })

    it('InitiateFundingParams includes escrowPlanId', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      const paramsSection = content.slice(
        content.indexOf('export type InitiateFundingParams'),
        content.indexOf('}', content.indexOf('export type InitiateFundingParams')) + 1,
      )
      expect(paramsSection).toContain('escrowPlanId: string')
    })

    it('InitiateFundingParams includes jobId', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      const paramsSection = content.slice(
        content.indexOf('export type InitiateFundingParams'),
        content.indexOf('}', content.indexOf('export type InitiateFundingParams')) + 1,
      )
      expect(paramsSection).toContain('jobId: string')
    })

    it('sends all three identifiers in the request body', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('JSON.stringify({ fundingRequestId, escrowPlanId, jobId })')
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
      expect(content).toContain('payment.initiate_funding_no_token')
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
      expect(content).toContain('data.error')
    })

    it('returns statusCode in error result', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('statusCode: response.status')
    })

    it('handles network errors in catch block', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('Netzwerkfehler bei der Zahlungsinitiierung')
    })
  })

  // ─── 8. Handles missing clientSecret ─────────────────────────────────

  describe('8. Handles missing clientSecret', () => {
    it('checks for null/undefined clientSecret in successful response', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('!clientSecret')
    })

    it('returns error when clientSecret is missing from payment-ready outcome', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('CONTRACT_VIOLATION_NO_CLIENT_SECRET')
    })

    it('logs missing clientSecret as contract violation', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('payment.initiate_funding_outcome_without_secret')
    })
  })

  // ─── 9. Barrel exports ───────────────────────────────────────────────

  describe('9. Barrel exports include initiateFundingPayment', () => {
    it('barrel exports initiateFundingPayment function', () => {
      const content = fs.readFileSync(barrelPath, 'utf-8')
      expect(content).toContain('initiateFundingPayment')
    })

    it('barrel exports InitiateFundingParams type', () => {
      const content = fs.readFileSync(barrelPath, 'utf-8')
      expect(content).toContain('InitiateFundingParams')
    })

    it('barrel exports InitiateFundingResult type', () => {
      const content = fs.readFileSync(barrelPath, 'utf-8')
      expect(content).toContain('InitiateFundingResult')
    })

    it('barrel exports from initiateFundingApi module', () => {
      const content = fs.readFileSync(barrelPath, 'utf-8')
      expect(content).toContain("from './initiateFundingApi'")
    })
  })

  // ─── 10. CustomerEscrowFundingCard uses the authenticated helper ─────

  describe('10. CustomerEscrowFundingCard uses authenticated helper', () => {
    it('imports initiateFundingPayment', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain("initiateFundingPayment")
      expect(content).toContain("from '../../lib/funding/initiateFundingApi'")
    })

    it('calls initiateFundingPayment in handleStartPayment', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      // Extract handleStartPayment function body
      const startIdx = content.indexOf('const handleStartPayment = useCallback')
      const endPatterns = ['const handleMockConfirm', 'const handleRetryPayment']
      let endIdx = content.length
      for (const pat of endPatterns) {
        const idx = content.indexOf(pat, startIdx + 100)
        if (idx > startIdx && idx < endIdx) endIdx = idx
      }
      const fnBody = content.slice(startIdx, endIdx)
      expect(fnBody).toContain('initiateFundingPayment')
    })

    it('passes fundingRequestId, escrowPlanId, and jobId to the helper', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('fundingRequestId: fr.id')
      expect(content).toContain('escrowPlanId: plan.id')
    })

    it('checks result.ok for success/failure', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('!result.ok')
    })
  })

  // ─── 11. No bare fetch to /api/initiate-funding in the component ─────

  describe('11. No bare fetch to /api/initiate-funding in the component', () => {
    it('component does not use fetch("/api/initiate-funding") directly', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      // The component should NOT have a raw fetch call to /api/initiate-funding
      expect(content).not.toContain("fetch('/api/initiate-funding'")
    })

    it('component does not manually set Content-Type for initiate-funding', () => {
      const content = fs.readFileSync(cardPath, 'utf-8')
      // The handleStartPayment should not manually build headers for /api/initiate-funding
      const startIdx = content.indexOf('const handleStartPayment = useCallback')
      const endPatterns = ['const handleMockConfirm', 'const handleRetryPayment']
      let endIdx = content.length
      for (const pat of endPatterns) {
        const idx = content.indexOf(pat, startIdx + 100)
        if (idx > startIdx && idx < endIdx) endIdx = idx
      }
      const fnBody = content.slice(startIdx, endIdx)
      // Should not contain manual Content-Type header for the API call
      expect(fnBody).not.toContain("'Content-Type': 'application/json'")
    })
  })
})
