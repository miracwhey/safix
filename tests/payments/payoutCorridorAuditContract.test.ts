/**
 * Block P · P3b — Cluster C+E source-contract tests.
 *
 * The destination-charge payout corridor (FUNDING_DESTINATION_CHARGE_ENABLED)
 * is unverifiable end-to-end before P7 (no live connect balance), so these are
 * pure SOURCE-CONTRACT assertions over the endpoint source — string/structure
 * checks mirroring tests/funding/initiateFundingContract.test.ts (sections
 * 13-16: fs.readFileSync + toContain / not.toContain / indexOf-ordering). No
 * Stripe execution.
 *
 * Covers:
 *  ITEM C — payout.failed audit: a compensating ledger entry + a payout_failed
 *           timeline signal are emitted alongside the existing
 *           release_pending → eligible_for_release revert, so every money
 *           state change is journaled (audit invariant).
 *  ITEM E — payout_completed email gate: deriveJobsFullyPaidOut counts a
 *           released tranche via EITHER external_release_ref (tr_*) OR
 *           external_payout_ref (po_*) proving ref.
 *
 * Flag-OFF byte-identity is enforced structurally: the audit lives strictly
 * inside the `failedCorridor.kind === 'resolved'` branch, and the proving-ref
 * fallback only changes a decision when external_release_ref is NULL.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── File paths ──────────────────────────────────────────────────────────────

const webhookPath = path.resolve(__dirname, '../../api/stripe-webhook.ts')
const emailGatePath = path.resolve(__dirname, '../../src/lib/payments/payoutEmailGate.ts')

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

// =========================================================================
// 16. ITEM C — payout.failed compensating audit helper
// =========================================================================

describe('16. Item C — payout.failed audit (recordPayoutFailureAudit)', () => {
  const content = readFile(webhookPath)

  it('defines the recordPayoutFailureAudit helper', () => {
    expect(content).toContain('async function recordPayoutFailureAudit(')
  })

  it('writes a compensating ledger entry with the established payout_adjustment type', () => {
    expect(content).toContain("entry_type: 'payout_adjustment'")
  })

  it('records a POSITIVE amount (payout.amount / 100) — direction via entry_type, never a negative sign', () => {
    expect(content).toContain('amount: payout.amount / 100')
    // No unary-minus feeding the failure-audit amount (CHECK amount >= 0).
    expect(content).not.toContain('amount: -payout.amount')
    expect(content).not.toContain('-(payout.amount / 100)')
  })

  it('keys the ledger movement_ref on payout.id (per-payout dedup, distinct from tranche-keyed rows)', () => {
    expect(content).toContain('movement_ref: payout.id')
  })

  it('dedups the ledger upsert on (payment_id,entry_type,movement_ref) with ignoreDuplicates', () => {
    expect(content).toContain("onConflict: 'payment_id,entry_type,movement_ref'")
    expect(content).toContain('ignoreDuplicates: true')
  })

  it('emits a payout_failed timeline signal keyed by payout.id', () => {
    expect(content).toContain('timeline_payout_failed__${payout.id}')
    expect(content).toContain("type: 'payout_failed'")
  })

  it('resolves payment_id via payments.eq(job_id) using maybeSingle (no .single() throw on a data gap)', () => {
    const helperIdx = content.indexOf('async function recordPayoutFailureAudit(')
    expect(helperIdx).toBeGreaterThan(0)
    const helperBody = content.slice(helperIdx, helperIdx + 4000)
    expect(helperBody).toContain(".from('payments')")
    expect(helperBody).toContain('.maybeSingle()')
    expect(helperBody).not.toContain('.single()')
  })
})

// =========================================================================
// 17. ITEM C — wiring into the payout.failed resolved-corridor branch
// =========================================================================

describe('17. Item C — payout.failed wiring + revert preserved', () => {
  const content = readFile(webhookPath)

  it('preserves the release_pending → eligible_for_release revert (status-guarded)', () => {
    // P3b A+B couples a payout_attempt_count bump into the same UPDATE payload,
    // so the revert is multi-line now — but the revert itself is intact: it
    // still flips to eligible_for_release, still stamps updated_at, and is still
    // guarded on the prior release_pending state.
    expect(content).toContain("status: 'eligible_for_release',")
    expect(content).toContain('updated_at: new Date().toISOString(),')
    expect(content).toContain(".eq('status', 'release_pending')")
  })

  it('scopes the revert to the specific failed payout (double-pay guard)', () => {
    // A stale, redelivered payout.failed(po_A) must not revert a tranche whose
    // live payout is now po_B — else the cron re-issues po_C and po_B+po_C can
    // both pay. The revert UPDATE is filtered on the failed payout id.
    expect(content).toContain(".eq('external_payout_ref', failedPayout.id)")
  })

  it('calls recordPayoutFailureAudit AFTER the revert and finalizes audit-retry on failure', () => {
    const revertIdx = content.indexOf(".eq('status', 'release_pending')")
    const auditCallIdx = content.indexOf('await recordPayoutFailureAudit(', revertIdx)
    expect(revertIdx).toBeGreaterThan(0)
    expect(auditCallIdx).toBeGreaterThan(revertIdx)
    expect(content).toContain("'payout_corridor_audit_retry'")
  })

  it('scopes the audit inside the resolved-corridor branch (flag-OFF auto-payouts never reach it)', () => {
    const resolvedIdx = content.indexOf("if (failedCorridor.kind === 'resolved') {")
    const auditCallIdx = content.indexOf('await recordPayoutFailureAudit(')
    const notCorridorEmitIdx = content.indexOf('const failedEmit = await emitPayoutOutcomeSignals(')
    expect(resolvedIdx).toBeGreaterThan(0)
    expect(auditCallIdx).toBeGreaterThan(resolvedIdx)
    // The audit call (resolved branch) precedes the not_corridor transfer-model
    // fan-out, proving it lives inside the corridor branch.
    expect(notCorridorEmitIdx).toBeGreaterThan(auditCallIdx)
  })

  it('removes the stale TODO(P3b) placeholder for the failed-payout audit', () => {
    expect(content).not.toContain('// TODO(P3b): the hourly payout-reconciliation cron re-issues')
  })
})

// =========================================================================
// 18. ITEM E — corridor-aware payout_completed email gate (webhook wrapper)
// =========================================================================

describe('18. Item E — email gate counts external_payout_ref (webhook)', () => {
  const content = readFile(webhookPath)

  it('extends the deriveJobsFullyPaidOut tranche SELECT with external_payout_ref', () => {
    expect(content).toContain("select('plan_id, external_release_ref, external_payout_ref, status')")
  })

  it('maps externalPayoutRef into the tranche shape passed to the pure gate', () => {
    expect(content).toContain('externalPayoutRef: (t.external_payout_ref as string | null) ?? null')
  })

  it('builds released proving refs from EITHER ref type', () => {
    expect(content).toContain('t.status === \'released\' && (t.externalReleaseRef || t.externalPayoutRef)')
    expect(content).toContain('(t.externalReleaseRef ?? t.externalPayoutRef) as string')
  })

  it('removes the stale comment claiming the gate is not corridor-adapted', () => {
    expect(content).not.toContain('skipped until the gate is corridor-adapted')
  })
})

// =========================================================================
// 19. ITEM E — proving-ref fallback in the pure gate
// =========================================================================

describe('19. Item E — payoutEmailGate proving ref (tr_* ?? po_*)', () => {
  const content = readFile(emailGatePath)

  it('adds the optional externalPayoutRef field to PayoutGateTranche', () => {
    expect(content).toContain('externalPayoutRef?: string | null')
  })

  it('selects the proving ref as externalReleaseRef ?? externalPayoutRef', () => {
    expect(content).toContain('const provingRef = t.externalReleaseRef ?? t.externalPayoutRef ?? null')
  })

  it('gates and adds via the proving ref (not the transfer ref directly)', () => {
    expect(content).toContain("if (t.status !== 'released' || !provingRef) continue")
    expect(content).toContain('set.add(provingRef)')
  })
})
