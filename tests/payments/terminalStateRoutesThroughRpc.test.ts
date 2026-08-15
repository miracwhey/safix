/**
 * P5b chokepoint pin — updatePaymentState must route the money-terminal writes
 * (released / refunded) through the atomic finalize RPC, NOT a raw payments
 * UPDATE.
 *
 * Behavioral coverage of the release path lives in
 * tests/workflow/customerReleaseAfterConfirm.test.ts (in-memory flow). This file
 * is the structural guard that the single-chokepoint routing is not silently
 * reverted: if someone re-points released/refunded at getPaymentRepository()
 * .update(), the P5b trigger (which blocks every authenticated direct terminal
 * write) would reject the live corridor release with an uncaught 42501.
 *
 * Source of truth:
 *   src/lib/payments/service.ts                  (updatePaymentState)
 *   supabase/migrations/20260621000000_p5b_payment_terminal_client_lockdown.sql
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const servicePath = path.resolve(__dirname, '../../src/lib/payments/service.ts')

/** Extract the updatePaymentState function body. */
function extractUpdatePaymentState(content: string): string {
  const startIdx = content.indexOf('export async function updatePaymentState(')
  expect(startIdx).toBeGreaterThan(-1)
  const endIdx = content.indexOf('\nexport async function createEscrowPayment(', startIdx)
  expect(endIdx).toBeGreaterThan(startIdx)
  return content.slice(startIdx, endIdx)
}

describe('P5b — updatePaymentState terminal-state chokepoint', () => {
  const fn = extractUpdatePaymentState(fs.readFileSync(servicePath, 'utf-8'))

  it('routes released/refunded through finalizeStateAtomic (the atomic RPC)', () => {
    expect(fn).toContain("if (state === 'released' || state === 'refunded')")
    expect(fn).toMatch(/getPaymentRepository\(\)\.finalizeStateAtomic\(\s*jobId,\s*state,/)
  })

  it('still uses the plain update() path for non-terminal transitions', () => {
    // The else branch (non-terminal) keeps the raw repo.update — the trigger
    // permits forward escrow steps + dispute-open for the participant.
    const elseIdx = fn.indexOf('} else {')
    expect(elseIdx).toBeGreaterThan(-1)
    const elseBranch = fn.slice(elseIdx)
    expect(elseBranch).toContain('getPaymentRepository().update(updated.id')
  })

  it('forwards disputeId + refundedAmount to the RPC (dispute-resolved finalize)', () => {
    const finalizeIdx = fn.indexOf('.finalizeStateAtomic(')
    const finalizeCall = fn.slice(finalizeIdx, fn.indexOf('})', finalizeIdx) + 2)
    expect(finalizeCall).toContain('disputeId: options?.disputeId')
    expect(finalizeCall).toContain('refundedAmount: options?.refundedAmount')
  })

  it('does NOT raw-update payments status for the terminal write', () => {
    // The terminal branch must not fall through to a second raw update on the
    // same call (that would hit the trigger as an authenticated direct write).
    const terminalIdx = fn.indexOf("if (state === 'released' || state === 'refunded')")
    const terminalBranch = fn.slice(
      terminalIdx,
      fn.indexOf('} else {', terminalIdx),
    )
    expect(terminalBranch).toContain('finalizeStateAtomic')
    expect(terminalBranch).not.toContain('getPaymentRepository().update(')
  })
})
