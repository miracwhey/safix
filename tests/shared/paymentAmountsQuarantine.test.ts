/**
 * Block 5C — payment.amounts Quarantine Regression Guard
 *
 * Structural test that ensures no UI/component/selector files directly read
 * payment.amounts for display purposes. payment.amounts is engine-internal
 * only — all user-facing display must come from canonical resolvers:
 *
 *   - resolveCanonicalAmount()
 *   - resolveCommercialDisplayContext()
 *   - resolveCanonicalProviderDetail()
 *
 * ALLOWED payment.amounts reads:
 *   - src/lib/payments/service.ts        (engine/ledger — creates & transitions)
 *   - src/lib/payments/repository/       (persistence layer)
 *   - src/lib/payments/types.ts          (type definition)
 *   - src/lib/workflow/paymentWorkflow.ts (engine workflow)
 *   - src/lib/jobs/paymentPrepSelectors.ts (engine-internal validity check, documented)
 *   - tests/                             (test assertions on internal state)
 *
 * BANNED payment.amounts reads:
 *   - src/components/  (UI display)
 *   - src/screens/     (UI display)
 *   - src/lib/finance/ (display selectors)
 *   - src/lib/jobs/customerDepositSelectors.ts  (customer display)
 *   - src/lib/jobs/jobCompletionSelectors.ts    (provider display)
 *   - src/lib/shared/canonicalCommercialDisplay.ts (should compose, not read raw)
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')

/**
 * Files/directories that are ALLOWED to read payment.amounts directly.
 * These are engine-internal, persistence, or type-definition files.
 */
const ALLOWED_PATHS = [
  'src/lib/payments/service.ts',
  'src/lib/payments/types.ts',
  'src/lib/payments/repository/',
  'src/lib/workflow/paymentWorkflow.ts',
  // paymentPrepSelectors has ONE justified engine-internal validity check (documented)
  'src/lib/jobs/paymentPrepSelectors.ts',
]

/**
 * Directories that must NEVER read payment.amounts directly.
 * These are UI/display surfaces.
 */
const BANNED_DIRS = [
  'src/components/',
  'src/screens/',
  'src/lib/finance/',
  'src/lib/jobs/customerDepositSelectors.ts',
  'src/lib/jobs/jobCompletionSelectors.ts',
]

function isAllowed(filePath: string): boolean {
  return ALLOWED_PATHS.some((allowed) => filePath.startsWith(allowed))
}

function isBanned(filePath: string): boolean {
  return BANNED_DIRS.some((banned) => filePath.startsWith(banned))
}

describe('Block 5C — payment.amounts quarantine guard', () => {
  it('no UI/component/selector files read payment.amounts directly', () => {
    // Use grep to find all payment.amounts reads in src/ (excluding comments and type defs)
    let grepOutput: string
    try {
      grepOutput = execSync(
        'grep -rn "payment\\.amounts\\." src/ --include="*.ts" --include="*.tsx" || true',
        { encoding: 'utf-8', cwd: ROOT },
      )
    } catch {
      // grep returns exit code 1 when no matches — that's the ideal outcome
      grepOutput = ''
    }

    if (!grepOutput.trim()) {
      // No matches at all — perfect quarantine
      return
    }

    const lines = grepOutput.trim().split('\n').filter(Boolean)

    // Filter out comment lines (lines where the match is inside a comment)
    const codeLines = lines.filter((line) => {
      const content = line.split(':').slice(2).join(':').trim()
      return !content.startsWith('//') && !content.startsWith('*') && !content.startsWith('/*')
    })

    // Check each remaining line
    const violations: string[] = []

    for (const line of codeLines) {
      const filePath = line.split(':')[0]

      // Skip allowed engine-internal files
      if (isAllowed(filePath)) continue

      // Flag banned display files
      if (isBanned(filePath)) {
        violations.push(filePath + ': ' + line.split(':').slice(2).join(':').trim())
      }
    }

    if (violations.length > 0) {
      const message = [
        'payment.amounts reads found in banned UI/display files:',
        '',
        ...violations.map((v) => `  ❌ ${v}`),
        '',
        'These files must use canonical resolvers instead:',
        '  - resolveCanonicalAmount(jobId)',
        '  - resolveCommercialDisplayContext(jobId)',
        '  - resolveCanonicalProviderDetail(jobId)',
      ].join('\n')

      expect.fail(message)
    }
  })

  it('canonical commercial display module does not read payment.amounts', () => {
    let grepOutput: string
    try {
      grepOutput = execSync(
        'grep -n "payment\\.amounts" src/lib/shared/canonicalCommercialDisplay.ts || true',
        { encoding: 'utf-8', cwd: ROOT },
      )
    } catch {
      grepOutput = ''
    }

    // Filter out comments
    const codeLines = (grepOutput || '').trim().split('\n').filter((line) => {
      if (!line.trim()) return false
      const content = line.split(':').slice(1).join(':').trim()
      return !content.startsWith('//') && !content.startsWith('*') && !content.startsWith('/*')
    })

    expect(
      codeLines.length,
      'canonicalCommercialDisplay.ts must not read payment.amounts — it should compose from canonical resolvers only',
    ).toBe(0)
  })

  it('canonical amount resolver does not read payment.amounts', () => {
    let grepOutput: string
    try {
      grepOutput = execSync(
        'grep -n "payment\\.amounts" src/lib/shared/canonicalAmountResolver.ts || true',
        { encoding: 'utf-8', cwd: ROOT },
      )
    } catch {
      grepOutput = ''
    }

    const codeLines = (grepOutput || '').trim().split('\n').filter((l) => l.trim().length > 0)

    expect(
      codeLines.length,
      'canonicalAmountResolver.ts must not read payment.amounts — it resolves from escrow/offer/job only',
    ).toBe(0)
  })

  // ── Patch C: no client-side escrow split derivations ───────────────────────
  //
  // Ensures that deposit/final amounts are computed exclusively by
  // calculateTrancheAmounts (escrowService) and never re-derived from
  // hardcoded constants (0.25, * 25 / 100, DEPOSIT_PERCENT arithmetic) outside
  // that function and the escrowService module itself.

  it('no hardcoded 0.25 tranche multiplier outside escrowService', () => {
    let grepOutput: string
    try {
      grepOutput = execSync(
        // Match literal "* 0.25" or "* 0.75" (tranche multipliers) in source files.
        // Exclude: escrowService (canonical), test files, type definitions, comments.
        "grep -rn '\\* 0\\.25\\|\\* 0\\.75' src/ --include='*.ts' --include='*.tsx' || true",
        { encoding: 'utf-8', cwd: ROOT },
      )
    } catch {
      grepOutput = ''
    }

    const violations = (grepOutput || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const file = line.split(':')[0]
        const content = line.split(':').slice(2).join(':').trim()
        // Allowed: the canonical escrow formula and PDF layout (non-financial)
        if (file.includes('escrowService')) return false
        if (file.includes('artifactGenerator')) return false
        // Ignore pure comment lines
        if (content.startsWith('//') || content.startsWith('*') || content.startsWith('/*')) return false
        return true
      })

    expect(
      violations,
      'Hardcoded tranche multiplier (0.25 / 0.75) found outside escrowService. ' +
        'Use calculateTrancheAmounts() instead:\n' +
        violations.join('\n'),
    ).toHaveLength(0)
  })

  it('no duplicate DEPOSIT_PERCENT arithmetic outside escrowService', () => {
    let grepOutput: string
    try {
      grepOutput = execSync(
        // Match patterns like "* DEPOSIT_PERCENT) / 100" or "DEPOSIT_PERCENT / 100 *"
        "grep -rn 'DEPOSIT_PERCENT.*/ 100\\|/ 100.*DEPOSIT_PERCENT\\|totalAmount.*DEPOSIT_PERCENT\\|DEPOSIT_PERCENT.*totalAmount' src/ --include='*.ts' --include='*.tsx' || true",
        { encoding: 'utf-8', cwd: ROOT },
      )
    } catch {
      grepOutput = ''
    }

    const violations = (grepOutput || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const file = line.split(':')[0]
        const content = line.split(':').slice(2).join(':').trim()
        if (file.includes('escrowService')) return false
        if (content.startsWith('//') || content.startsWith('*') || content.startsWith('/*')) return false
        return true
      })

    expect(
      violations,
      'DEPOSIT_PERCENT arithmetic found outside escrowService. ' +
        'Use calculateTrancheAmounts() instead:\n' +
        violations.join('\n'),
    ).toHaveLength(0)
  })
})
