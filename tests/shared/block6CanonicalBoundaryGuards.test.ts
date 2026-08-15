/**
 * Block 6 — Canonical Boundary Hardening Guards
 *
 * Structural tests that prevent regression of shadow truth paths
 * in the stabilized quote/job/payment/funding/thread area.
 *
 * These guards enforce that customer-facing and provider-facing
 * display surfaces route through canonical resolvers instead of
 * reading stale project/job fields directly.
 *
 * GUARDED BOUNDARIES:
 *
 * 1. Customer-facing screens must use deriveCanonicalProjection()
 *    for project status — never raw project.status for display.
 *
 * 2. Customer-facing screens must use resolveCanonicalProjectFacts()
 *    for project price/amount — never raw project.price for display.
 *
 * 3. Display components showing job fields (title/customer/location)
 *    must use resolveCanonicalProjectFacts() — never raw job.* alone.
 *
 * 4. ThreadProjectContextBar must use canonical lifecycle projection
 *    so stale project.status never overrides downstream job truth.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8')
}

/**
 * Strip comment lines (// and block-comment continuations) from source.
 * Returns only code lines for pattern matching.
 */
function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim()
    return (
      trimmed.length > 0 &&
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('*') &&
      !trimmed.startsWith('/*')
    )
  })
}

// ---------------------------------------------------------------------------
// Guard 1 — Customer-facing screens use canonical lifecycle projection
// ---------------------------------------------------------------------------

describe('Block 6 — canonical lifecycle boundary', () => {
  const CUSTOMER_SCREENS = [
    'src/screens/CustomerProjectsScreen.tsx',
    'src/screens/CustomerProjectDetailScreen.tsx',
  ]

  for (const screenPath of CUSTOMER_SCREENS) {
    it(`${screenPath} has canonical lifecycle projection (not raw project.status)`, () => {
      const source = readFile(screenPath)
      // Accept either the shared deriveCanonicalProjection import or
      // a local canonical status derivation (deriveProjectStatusFromJob / canonicalStatus).
      const hasCanonicalProjection =
        source.includes('deriveCanonicalProjection') ||
        source.includes('deriveProjectStatusFromJob')
      expect(
        hasCanonicalProjection,
        `${screenPath} must use deriveCanonicalProjection or deriveProjectStatusFromJob — raw project.status can show stale truth`,
      ).toBe(true)
    })
  }

  // CustomerHomeScreen (Block-1 JTBD redesign) delegates lifecycle truth to the
  // useCustomerAnswerCard data layer — the canonical projection now lives in the
  // hook, not the screen. The guard tracks it there AND asserts the screen reads
  // no raw project.status (strictly stronger than the old literal-import check).
  it('customer home answer-card layer derives via canonical projection', () => {
    const hook = readFile('src/hooks/useHomeState.ts')
    expect(
      hook.includes('deriveCanonicalProjection'),
      'useHomeState (useCustomerAnswerCard) must derive lifecycle via deriveCanonicalProjection — the home renders its answer card from this',
    ).toBe(true)
  })

  it('CustomerHomeScreen reads no raw project.status (canonical only)', () => {
    const code = codeLines(readFile('src/screens/CustomerHomeScreen.tsx'))
    const rawStatus = code.filter((l) => /\.status\b/.test(l))
    expect(
      rawStatus.length,
      'CustomerHomeScreen must not read raw *.status — lifecycle truth is canonical, owned by the hook',
    ).toBe(0)
  })

  // ThreadProjectContextBar was removed as orphaned dead code (screen truth cleanup).
  // The canonical lifecycle guard for thread context now lives in ThreadArtifactProjectCard
  // which uses snapshot-hardened rendering from persisted artifacts.
})

// ---------------------------------------------------------------------------
// Guard 2 — Customer-facing project price goes through canonical amount
// ---------------------------------------------------------------------------

describe('Block 6 — canonical amount boundary for project price', () => {
  it('CustomerProjectsScreen does not render raw project.price without canonical resolution', () => {
    const source = readFile('src/screens/CustomerProjectsScreen.tsx')
    const code = codeLines(source)

    // Ensure the file imports canonical facts for amount resolution
    expect(
      source.includes('resolveCanonicalProjectFacts'),
      'CustomerProjectsScreen must import resolveCanonicalProjectFacts for price display',
    ).toBe(true)

    // Ensure no raw {project.price} in JSX (the pattern that was the shadow path)
    // Check for direct project.price rendering without canonical resolution context
    const rawPriceJsx = code.filter((l) =>
      /\{\s*project\.price\s*\}/.test(l),
    )
    expect(
      rawPriceJsx.length,
      'CustomerProjectsScreen must not render raw {project.price} — use canonical amount with project.price as fallback only',
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Guard 3 — Display components use canonical facts for job fields
// ---------------------------------------------------------------------------

describe('Block 6 — canonical facts boundary for display components', () => {
  const CANONICALIZED_COMPONENTS = [
    'src/components/CraftsmanJobListItem.tsx',
    'src/components/jobs/JobDetailsCard.tsx',
    'src/components/calendar/SchedulingLifecycleSection.tsx',
    'src/components/worker/WorkerAssignedJobsSection.tsx',
  ]

  for (const componentPath of CANONICALIZED_COMPONENTS) {
    it(`${componentPath} imports resolveCanonicalProjectFacts`, () => {
      const source = readFile(componentPath)
      expect(
        source.includes('resolveCanonicalProjectFacts'),
        `${componentPath} must use resolveCanonicalProjectFacts for display — raw job.title/customer/location are weak sources`,
      ).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// Guard 4 — No local money formatters in display area
// ---------------------------------------------------------------------------

describe('Block 6 — no local money formatters in display area', () => {
  it('no display components define local formatCurrency/formatMoney/formatAmount helpers', () => {
    const dirs = ['src/components/', 'src/screens/']
    const forbidden = ['function formatCurrency', 'function formatMoney', 'function formatAmount']

    const violations: string[] = []

    for (const dir of dirs) {
      const fullDir = path.join(ROOT, dir)
      if (!fs.existsSync(fullDir)) continue

      const walk = (dirPath: string): string[] => {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        const files: string[] = []
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name)
          if (entry.isDirectory()) {
            files.push(...walk(fullPath))
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            files.push(fullPath)
          }
        }
        return files
      }

      for (const file of walk(fullDir)) {
        const content = fs.readFileSync(file, 'utf-8')
        for (const pattern of forbidden) {
          if (content.includes(pattern)) {
            const relPath = path.relative(ROOT, file)
            violations.push(`${relPath} defines ${pattern}`)
          }
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        [
          'Local money formatter definitions found in display area:',
          '',
          ...violations.map((v) => `  ❌ ${v}`),
          '',
          'Use canonical formatters from src/lib/shared/formatters.ts instead:',
          '  - formatEuro(amount)',
          '  - formatCents(cents)',
          '  - formatOfferPrice(rawPrice)',
        ].join('\n'),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Guard 5 — Quote detail loading uses resolveCanonicalQuoteId
// ---------------------------------------------------------------------------

describe('Block 6 — canonical quote ID resolution', () => {
  it('QuoteDetailScreen uses resolveCanonicalQuoteId (not bare getOfferById)', () => {
    const source = readFile('src/screens/QuoteDetailScreen.tsx')
    expect(
      source.includes('resolveCanonicalQuoteId'),
      'QuoteDetailScreen must use resolveCanonicalQuoteId — bare getOfferById bypasses jobId fallback',
    ).toBe(true)
  })
})
