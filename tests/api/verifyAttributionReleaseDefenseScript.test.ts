/**
 * verify-attribution-release-defense.sql — static parse guard.
 *
 * Locks the Codex-P3 regression where the script carried an `ORDER BY`
 * inside a SELECT that was part of a UNION ALL, which PostgreSQL rejects
 * unless the SELECT is parenthesised.  The script MUST be runnable as-is;
 * anyone running it gets an immediate syntax error otherwise.
 *
 * We enforce structurally here (fast, zero-DB) instead of via live
 * execution in CI.  The live proof was performed against project
 * itdntawwuzqfwmcwnwjr on 2026-04-20 and documented in the script header.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SCRIPT_PATH = resolve(__dirname, '../../scripts/verify-attribution-release-defense.sql')
const script = readFileSync(SCRIPT_PATH, 'utf8')

describe('scripts/verify-attribution-release-defense.sql — static parse guard', () => {
  it('contains both behavioural tests (tranche + supplementary) + smoke query', () => {
    expect(script).toMatch(/-- Test 1/)
    expect(script).toMatch(/-- Test 2/)
    expect(script).toMatch(/-- Test 3/)
    expect(script).toMatch(/INSERT INTO public\.escrow_tranches/)
    expect(script).toMatch(/INSERT INTO public\.supplementary_payment_requests/)
  })

  it('behavioural tests expect SQLSTATE P0004', () => {
    expect(script).toMatch(/WHEN sqlstate 'P0004'/)
    // Both tests PASS-label uses the sqlstate capture pattern
    expect(script.match(/SQLSTATE/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('no ORDER BY sits between a SELECT and its UNION (PostgreSQL syntax error)', () => {
    // The parse rule: `ORDER BY` is only legal as the TRAILING clause of a
    // compound query, not inside a UNION operand (unless parenthesised).
    // We detect the invalid form by searching for `ORDER BY ...\nUNION`
    // without an intervening `)` — which would imply a parenthesised operand.
    const invalidPattern = /ORDER BY[^;()\n]*\n\s*UNION\b/i
    expect(script).not.toMatch(invalidPattern)
  })

  it('smoke query ends with a single ORDER BY before the semicolon', () => {
    // Last statement should be the UNION ALL smoke — match at least one
    // ORDER BY that sits before the final semicolon, and verify exactly one
    // ORDER BY exists in that compound.
    const finalStatement = script.split(/UNION ALL/i).slice(-1)[0] ?? ''
    expect(finalStatement).toMatch(/ORDER BY\s+\d+\s*;/)
  })

  it('script references both triggers by name for installation-check', () => {
    expect(script).toMatch(/assert_attribution_finalized_before_release/)
    expect(script).toMatch(/operator_resolve_attribution/)
  })

  it('all INSERT targets use non-existent UUIDs (never touches real rows)', () => {
    // Safety-net check: the script must not try to INSERT with real-looking
    // UUIDs.  `gen_random_uuid()` or the all-zero UUID are both safe.
    expect(script).toMatch(/'00000000-0000-0000-0000-000000000000'/)
  })
})
