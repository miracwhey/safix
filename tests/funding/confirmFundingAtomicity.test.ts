/**
 * Confirm-Funding Atomicity Tests
 *
 * Validates that the funding confirmation path uses atomic DB operations
 * (single RPC call) instead of sequential writes that can produce split state.
 *
 * Invariants verified:
 * 1. API endpoint uses confirm_funding_atomic RPC (not sequential writes)
 * 2. Webhook reconciliation uses the same RPC (not sequential writes)
 * 3. RPC is called with correct parameters (funding_request_id, escrow_plan_id, payment_intent_id)
 * 4. API handles RPC error → 500 (no partial state left behind)
 * 5. API handles 'not_found' outcome → 404
 * 6. API handles 'invalid_state' outcome → 409
 * 7. API handles 'already_funded' outcome → 200 (idempotent)
 * 8. API handles 'confirmed' outcome → 200
 * 9. No sequential funding_requests/escrow_payment_plans/escrow_tranches writes in confirm-funding
 * 10. No sequential writes in webhook reconcileFundingConfirmation
 * 11. Migration file creates confirm_funding_atomic function
 * 12. Migration grants service_role access
 * 13. RPC function uses FOR UPDATE locks (concurrency safety)
 * 14. RPC function handles all pre-funded status guards
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── File paths ────────────────────────────────────────────────────────────

const confirmFundingPath = path.resolve(__dirname, '../../api/confirm-funding.ts')
const webhookPath = path.resolve(__dirname, '../../api/stripe-webhook.ts')
const migrationPath = path.resolve(
  __dirname,
  '../../supabase/migrations/20260415000002_confirm_funding_atomic.sql',
)

// ── Helpers ───────────────────────────────────────────────────────────────

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf-8')
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Confirm-Funding Atomicity', () => {
  // ─── 1. API uses RPC ─────────────────────────────────────────────────
  describe('1. API endpoint uses confirm_funding_atomic RPC', () => {
    it('calls supabase.rpc with confirm_funding_atomic', () => {
      const content = readFile(confirmFundingPath)
      expect(content).toContain("supabase.rpc(\n      'confirm_funding_atomic'")
    })

    it('passes p_funding_request_id parameter', () => {
      const content = readFile(confirmFundingPath)
      expect(content).toContain('p_funding_request_id: resolvedFundingRequestId')
    })

    it('passes p_escrow_plan_id parameter', () => {
      const content = readFile(confirmFundingPath)
      expect(content).toContain('p_escrow_plan_id:')
    })

    it('passes p_payment_intent_id parameter', () => {
      const content = readFile(confirmFundingPath)
      expect(content).toContain('p_payment_intent_id:')
    })
  })

  // ─── 2. Webhook uses same RPC ───────────────────────────────────────
  describe('2. Webhook reconciliation uses confirm_funding_atomic RPC', () => {
    it('calls supabase.rpc with confirm_funding_atomic', () => {
      const content = readFile(webhookPath)
      expect(content).toContain("confirm_funding_atomic")
    })

    it('passes funding request ID to RPC', () => {
      const content = readFile(webhookPath)
      expect(content).toContain('p_funding_request_id: fundingRequestId')
    })
  })

  // ─── 3. API error handling ──────────────────────────────────────────
  describe('3-8. API handles all RPC outcomes correctly', () => {
    it('handles RPC error → returns 500', () => {
      const content = readFile(confirmFundingPath)
      expect(content).toContain('rpcError')
      expect(content).toContain("res.status(500).json({ error: `Funding confirmation failed:")
    })

    it('handles not_found outcome → returns 404', () => {
      const content = readFile(confirmFundingPath)
      expect(content).toContain("outcome === 'not_found'")
      expect(content).toContain('res.status(404)')
    })

    it('handles invalid_state outcome → returns 409', () => {
      const content = readFile(confirmFundingPath)
      expect(content).toContain("outcome === 'invalid_state'")
      expect(content).toContain('res.status(409)')
    })

    it('handles already_funded and confirmed as 200 success', () => {
      const content = readFile(confirmFundingPath)
      // Both outcomes fall through to the success path
      expect(content).toContain("res.status(200).json")
      expect(content).toContain("'confirmed' or 'already_funded'")
    })
  })

  // ─── 9. No sequential writes in confirm-funding ─────────────────────
  describe('9. No sequential writes in confirm-funding API', () => {
    it('does not directly update funding_requests table', () => {
      const content = readFile(confirmFundingPath)
      // The RPC call section should not contain direct table updates
      const rpcSection = content.slice(content.indexOf('confirm_funding_atomic'))
      expect(rpcSection).not.toContain(".from('funding_requests')\n      .update")
    })

    it('does not directly update escrow_payment_plans table', () => {
      const content = readFile(confirmFundingPath)
      expect(content).not.toContain(".from('escrow_payment_plans')\n        .update")
    })

    it('does not directly update escrow_tranches table', () => {
      const content = readFile(confirmFundingPath)
      expect(content).not.toContain(".from('escrow_tranches')\n        .update")
    })
  })

  // ─── 10. No sequential writes in webhook ────────────────────────────
  describe('10. No sequential writes in webhook reconcileFundingConfirmation', () => {
    it('webhook does not directly update funding_requests in reconcileFundingConfirmation', () => {
      const content = readFile(webhookPath)
      // Find the reconcileFundingConfirmation function boundaries
      const fnStart = content.indexOf('async function reconcileFundingConfirmation(')
      const fnEnd = content.indexOf('\n// -----', fnStart + 100)
      const fnBody = content.slice(fnStart, fnEnd)
      // Should not contain direct table updates for these tables
      expect(fnBody).not.toContain(".from('funding_requests')\n    .update")
      expect(fnBody).not.toContain(".from('escrow_payment_plans')\n      .update")
      expect(fnBody).not.toContain(".from('escrow_tranches')\n      .update")
    })
  })

  // ─── 11. Migration creates the function ─────────────────────────────
  describe('11. Migration creates confirm_funding_atomic function', () => {
    it('migration file exists', () => {
      expect(fs.existsSync(migrationPath)).toBe(true)
    })

    it('creates confirm_funding_atomic function', () => {
      const content = readFile(migrationPath)
      expect(content).toContain('CREATE OR REPLACE FUNCTION confirm_funding_atomic(')
    })

    it('function accepts p_funding_request_id UUID parameter', () => {
      const content = readFile(migrationPath)
      expect(content).toContain('p_funding_request_id UUID')
    })

    it('function accepts p_escrow_plan_id UUID parameter', () => {
      const content = readFile(migrationPath)
      expect(content).toContain('p_escrow_plan_id     UUID')
    })

    it('function accepts p_payment_intent_id TEXT parameter', () => {
      const content = readFile(migrationPath)
      expect(content).toContain('p_payment_intent_id  TEXT')
    })

    it('function returns JSONB', () => {
      const content = readFile(migrationPath)
      expect(content).toContain('RETURNS JSONB')
    })

    it('function is SECURITY DEFINER', () => {
      const content = readFile(migrationPath)
      expect(content).toContain('SECURITY DEFINER')
    })
  })

  // ─── 12. Migration grants access ───────────────────────────────────
  describe('12. Migration grants service_role access', () => {
    it('grants EXECUTE to service_role', () => {
      const content = readFile(migrationPath)
      expect(content).toContain('GRANT EXECUTE ON FUNCTION confirm_funding_atomic')
      expect(content).toContain('TO service_role')
    })
  })

  // ─── 13. Concurrency safety ─────────────────────────────────────────
  describe('13. RPC uses FOR UPDATE locks for concurrency safety', () => {
    it('locks funding_request row with FOR UPDATE', () => {
      const content = readFile(migrationPath)
      expect(content).toContain('FROM funding_requests')
      expect(content).toContain('FOR UPDATE')
    })

    it('locks escrow_payment_plans row with FOR UPDATE', () => {
      const content = readFile(migrationPath)
      const planSection = content.slice(content.indexOf('FROM escrow_payment_plans'))
      expect(planSection).toContain('FOR UPDATE')
    })
  })

  // ─── 14. Status guards ──────────────────────────────────────────────
  describe('14. RPC handles all pre-funded status guards', () => {
    it('guards funding_request with pre-funded status list', () => {
      const content = readFile(migrationPath)
      expect(content).toContain("'created', 'sent', 'funding_started', 'funding_initiated'")
    })

    it('guards escrow_payment_plans with pre-funded status list', () => {
      const content = readFile(migrationPath)
      expect(content).toContain("'awaiting_customer_funding', 'funding_initiated'")
    })

    it('guards escrow_tranches with pending_funding status', () => {
      const content = readFile(migrationPath)
      expect(content).toContain("AND status = 'pending_funding'")
    })

    it('returns already_funded for idempotent re-calls', () => {
      const content = readFile(migrationPath)
      expect(content).toContain("'outcome', 'already_funded'")
    })

    it('returns invalid_state for non-fundable states', () => {
      const content = readFile(migrationPath)
      expect(content).toContain("'outcome', 'invalid_state'")
    })
  })
})
