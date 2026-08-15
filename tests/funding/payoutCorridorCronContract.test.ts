/**
 * Payout-Corridor Reconciliation Cron — Source-Contract Tests (Block P · P3b A+B)
 *
 * Pure source-contract assertions (fs.readFileSync + substring / index-ordering),
 * mirroring tests/funding/initiateFundingContract.test.ts sections 13–16. The
 * flag-ON corridor path is unverifiable end-to-end until P7 (no live connect
 * balance), so correctness of the money/FSM wiring is pinned here on the
 * endpoint SOURCE rather than by executing Stripe.
 *
 * Items covered:
 *   A. Hourly reconcile-payout-corridor cron + re-attempt + 24h aging alert.
 *   B. DE 90-day manual-payout deadline guard (T+60 warn / T+75 operator-force).
 *   + the varying-idempotency-key retry-enabler in release-tranche.ts and the
 *     payout.failed counter-bump coupling in stripe-webhook.ts.
 *   + flag-OFF byte-identity guards (transfer key + fee math untouched).
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── File paths ──────────────────────────────────────────────────────────────

const cronPath = path.resolve(__dirname, '../../api/cron/reconcile-payout-corridor.ts')
const helperPath = path.resolve(__dirname, '../../api/_payoutCorridorReconciliation.ts')
const releaseTranchePath = path.resolve(__dirname, '../../api/release-tranche.ts')
const webhookPath = path.resolve(__dirname, '../../api/stripe-webhook.ts')
const vercelJsonPath = path.resolve(__dirname, '../../vercel.json')
const migrationPath = path.resolve(
  __dirname,
  '../../supabase/migrations/20260613030000_p3b_payout_attempt_count.sql',
)

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

// =========================================================================
// 16. Cron flag-OFF no-op (primary flag-OFF safety)
// =========================================================================

describe('16. reconcile-payout-corridor cron is a flag-OFF no-op before any query', () => {
  const content = readFile(cronPath)

  it('reads the corridor flag with the canonical === \'true\' test', () => {
    expect(content).toContain("FUNDING_DESTINATION_CHARGE_ENABLED === 'true'")
  })

  it('returns a corridor_disabled no-op (200) when the flag is off', () => {
    expect(content).toContain('corridor_disabled')
    expect(content).toContain('skipped: true')
    expect(content).toContain('res.status(200)')
  })

  it('corridor_disabled gate precedes the Supabase client + helper call', () => {
    const disabledIdx = content.indexOf('corridor_disabled')
    const adminCallIdx = content.indexOf('getSupabaseAdmin()')
    const helperCallIdx = content.indexOf('reconcilePayoutCorridor(')
    expect(disabledIdx).toBeGreaterThan(0)
    expect(adminCallIdx).toBeGreaterThan(0)
    expect(helperCallIdx).toBeGreaterThan(0)
    // No-op must fire BEFORE the admin client is resolved and before any query.
    expect(disabledIdx).toBeLessThan(adminCallIdx)
    expect(disabledIdx).toBeLessThan(helperCallIdx)
  })
})

// =========================================================================
// 17. Cron auth + infra
// =========================================================================

describe('17. cron uses cron auth, release secret, and Sentry flush', () => {
  const content = readFile(cronPath)

  it('authenticates via requireCronAuth', () => {
    expect(content).toContain('requireCronAuth')
  })

  it('requires RELEASE_CONFIRM_SECRET', () => {
    expect(content).toContain('RELEASE_CONFIRM_SECRET')
  })

  it('wraps the handler in withSentryFlush', () => {
    expect(content).toContain('withSentryFlush')
    expect(content).toContain('export default withSentryFlush(handler)')
  })

  it('escalates to Sentry when failed / aging / deadlineForced', () => {
    expect(content).toContain('cron.payout_corridor.attention_required')
    expect(content).toContain('summary.failed > 0')
    expect(content).toContain('summary.agingAlerts > 0')
    expect(content).toContain('summary.deadlineForced > 0')
  })
})

// =========================================================================
// 18. Corridor-aware query
// =========================================================================

describe('18. helper query is corridor-aware', () => {
  const content = readFile(helperPath)

  it('selects only eligible_for_release + release_pending tranches', () => {
    expect(content).toContain("'eligible_for_release', 'release_pending'")
    expect(content).toContain("from('escrow_tranches')")
  })

  it('skips transfer-corridor rows (non-null external_release_ref)', () => {
    expect(content).toContain('external_release_ref')
    expect(content).toContain('if (tranche.external_release_ref) continue')
  })
})

// =========================================================================
// 19. Re-attempt is restricted to eligible_for_release
// =========================================================================

describe('19. re-attempt only fires for eligible_for_release', () => {
  const content = readFile(helperPath)

  it('POSTs to /api/release-tranche with actor: system + the release secret', () => {
    expect(content).toContain('/api/release-tranche')
    expect(content).toContain("actor: 'system'")
    expect(content).toContain("'x-release-confirm-secret': releaseConfirmSecret")
  })

  it('an eligible_for_release guard precedes the re-attempt fetch (release_pending never re-issued)', () => {
    const guardIdx = content.indexOf("status === 'eligible_for_release'")
    const fetchIdx = content.indexOf('fetch(')
    expect(guardIdx).toBeGreaterThan(0)
    expect(fetchIdx).toBeGreaterThan(0)
    expect(guardIdx).toBeLessThan(fetchIdx)
  })

  it('documents that release_pending is NOT re-issued (double-pay / P5)', () => {
    expect(content).toContain('release_pending is NOT re-issued')
  })
})

// =========================================================================
// 20. Thresholds — 1h re-attempt, 10d aging (past settlement), 60/75-day deadline on funded_at
// =========================================================================

describe('20. cron thresholds', () => {
  const content = readFile(helperPath)

  it('re-attempts tranches older than 1h', () => {
    expect(content).toContain('REATTEMPT_AFTER_MS = 60 * 60 * 1000')
  })

  it('raises a Sentry aging alert for tranches stuck past settlement (10d, not 24h)', () => {
    // Threshold is settlement window + buffer: a tranche correctly stays
    // eligible_for_release for ~7d while destination-charge funds settle, so a
    // 24h alert would false-fire hourly during normal settlement.
    expect(content).toContain('AGING_ALERT_AFTER_MS = 10 * 24 * 60 * 60 * 1000')
    expect(content).toContain("logError('payout_corridor.tranche_aging'")
    expect(content).toContain("severity: 'payout_stuck_past_settlement'")
  })

  it('warns at T+60 days and operator-forces at T+75 days, anchored on funded_at', () => {
    expect(content).toContain('DEADLINE_WARN_DAYS = 60')
    expect(content).toContain('DEADLINE_FORCE_DAYS = 75')
    expect(content).toContain('funded_at')
    expect(content).toContain('manual_payout_deadline_warn')
    expect(content).toContain('manual_payout_deadline_force')
  })

  it('deadline force is an alert only (no auto money movement in P3b)', () => {
    expect(content).toContain("severity: 'operator_action_required_before_90d_auto_return'")
    // The reconciliation helper issues NO Stripe call directly — it re-pokes
    // release-tranche over HTTP, which owns the payout. No SDK import / create.
    expect(content).not.toContain('payouts.create')
    expect(content).not.toContain('transfers.create')
    expect(content).not.toContain("from 'stripe'")
  })
})

// =========================================================================
// 21. release-tranche varying idempotency key (retry-enabler)
// =========================================================================

describe('21. release-tranche payout key varies by payout_attempt_count', () => {
  const content = readFile(releaseTranchePath)

  it('builds the payout idempotency key from payout_attempt_count', () => {
    expect(content).toContain(
      'idempotencyKey: `tranche_payout_${trancheId.trim()}_${Number(tranche.payout_attempt_count ?? 0)}`',
    )
  })

  it('selects payout_attempt_count on the tranche row', () => {
    expect(content).toContain(', payout_attempt_count')
  })

  it('leaves the transfer idempotency key UNCHANGED (flag-OFF byte-identical)', () => {
    expect(content).toContain('const transferIdempotencyKey = `tranche_release_${trancheId.trim()}`')
  })

  it('increments payout_attempt_count on balance_insufficient, status-guarded', () => {
    // The only new write on the soft-fail branch — bump precedes the 202.
    const balanceIdx = content.indexOf("?.code === 'balance_insufficient'")
    const incrementIdx = content.indexOf(
      'payout_attempt_count: Number(tranche.payout_attempt_count ?? 0) + 1',
    )
    const deferredIdx = content.indexOf("status: 'release_deferred'")
    expect(balanceIdx).toBeGreaterThan(0)
    expect(incrementIdx).toBeGreaterThan(balanceIdx)
    expect(incrementIdx).toBeLessThan(deferredIdx)
    // Status guard: only a still-eligible tranche is bumped.
    const guardIdx = content.indexOf("eq('status', 'eligible_for_release')", incrementIdx)
    expect(guardIdx).toBeGreaterThan(incrementIdx)
  })
})

// =========================================================================
// 22. webhook payout.failed couples the revert to a counter bump
// =========================================================================

describe('22. stripe-webhook payout.failed bumps payout_attempt_count on revert', () => {
  const content = readFile(webhookPath)

  it('the corridor tranche resolver selects payout_attempt_count', () => {
    expect(content).toContain("select('id, status, plan_id, payout_attempt_count')")
    expect(content).toContain('payoutAttemptCount: Number(data.payout_attempt_count ?? 0)')
  })

  it('the resolved-corridor revert sets eligible_for_release AND bumps the counter', () => {
    const revertStatusIdx = content.indexOf("status: 'eligible_for_release'")
    const bumpIdx = content.indexOf(
      'payout_attempt_count: failedCorridor.tranche.payoutAttemptCount + 1',
    )
    expect(revertStatusIdx).toBeGreaterThan(0)
    expect(bumpIdx).toBeGreaterThan(0)
    // Both fields live in the same UPDATE payload (separated only by the
    // retry-enabler explanatory comment).
    expect(bumpIdx - revertStatusIdx).toBeLessThan(900)
  })
})

// =========================================================================
// 23. Cron registration in vercel.json
// =========================================================================

describe('23. vercel.json registers the hourly cron without disturbing siblings', () => {
  const content = readFile(vercelJsonPath)
  const parsed = JSON.parse(content) as { crons: Array<{ path: string; schedule: string }> }

  it('registers /api/cron/reconcile-payout-corridor at 0 * * * *', () => {
    const entry = parsed.crons.find((c) => c.path === '/api/cron/reconcile-payout-corridor')
    expect(entry).toBeDefined()
    expect(entry!.schedule).toBe('0 * * * *')
  })

  it('keeps the pre-existing transfer-corridor crons registered (not repurposed)', () => {
    const paths = parsed.crons.map((c) => c.path)
    expect(paths).toContain('/api/cron/reconcile-escrow-tranches')
    expect(paths).toContain('/api/cron/reconcile-payments')
  })
})

// =========================================================================
// 24. Migration — unapplied, additive, idempotent
// =========================================================================

describe('24. payout_attempt_count migration', () => {
  it('file exists with a timestamp strictly after 20260613020000', () => {
    expect(fs.existsSync(migrationPath)).toBe(true)
    const ts = Number(path.basename(migrationPath).slice(0, 14))
    expect(ts).toBeGreaterThan(20260613020000)
  })

  it('adds payout_attempt_count idempotently with DEFAULT 0', () => {
    const content = readFile(migrationPath)
    expect(content).toContain('payout_attempt_count')
    expect(content).toContain('ADD COLUMN IF NOT EXISTS')
    expect(content).toContain('DEFAULT 0')
    expect(content).toContain("NOTIFY pgrst, 'reload schema'")
  })
})

// =========================================================================
// 25. Flag-OFF byte-identity guards (no item-D collision)
// =========================================================================

describe('25. flag-OFF byte-identity — transfer key + fee math untouched', () => {
  const content = readFile(releaseTranchePath)

  it('preserves the gross × (1 − fee) net math in release-tranche', () => {
    expect(content).toContain('(1 - platformFeeRate)')
    // Guard against an accidental double fee / hard-coded 12 %.
    expect(content).not.toContain('(1 - platformFeeRate) * (1 - platformFeeRate)')
    expect(content).not.toContain('0.12')
  })

  it('does not touch the transfer-corridor key or branch from this cluster', () => {
    // tranche_release_ key stays; payouts.create stays inside PAYOUT_MODE.
    expect(content).toContain('tranche_release_${trancheId.trim()}')
    expect(content).toContain('if (PAYOUT_MODE)')
  })
})
