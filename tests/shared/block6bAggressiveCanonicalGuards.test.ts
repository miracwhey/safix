/**
 * Block 6B — Aggressive Canonical Boundary Guards
 *
 * Extends Block 6 guards with harder structural enforcement:
 *
 * 1. Provider-facing display components showing job facts MUST use
 *    resolveCanonicalProjectFacts — no raw job.title/customer/location/amount.
 *
 * 2. CustomerProjectDetailScreen MUST use deriveCanonicalProjection (shared)
 *    not a local ad-hoc status derivation via deriveProjectStatusFromJob.
 *
 * 3. No duplicate parseEuroAmount helpers — canonical resolver is sole path.
 *
 * 4. Finance dashboard selectors must use canonical facts for job titles
 *    (not raw job?.title fallback).
 *
 * 5. No raw `project.status` reads in CustomerProjectDetailScreen display
 *    paths — all must go through canonicalStatus.
 *
 * 6. TeamLoadCard (CalendarEntry) is allowed to read .title directly because
 *    CalendarEntry is NOT a Job — it is a pre-projected display struct.
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8')
}

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
// Guard 1 — Provider display components use canonical facts
// ---------------------------------------------------------------------------

describe('Block 6B — provider display components use canonical facts', () => {
  const PROVIDER_DISPLAY_COMPONENTS = [
    'src/components/owner/TeamAssignmentOverview.tsx',
    'src/components/owner/TeamWorkloadCard.tsx',
  ]

  for (const componentPath of PROVIDER_DISPLAY_COMPONENTS) {
    it(`${componentPath} imports resolveCanonicalProjectFacts`, () => {
      const source = readFile(componentPath)
      expect(
        source.includes('resolveCanonicalProjectFacts'),
        `${componentPath} must use resolveCanonicalProjectFacts — raw job.title/customer/amount are weak sources`,
      ).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// Guard 2 — CustomerProjectDetailScreen uses shared canonical projection
// ---------------------------------------------------------------------------

describe('Block 6B — CustomerProjectDetailScreen uses shared canonical lifecycle', () => {
  it('imports deriveCanonicalProjection (not local ad-hoc derivation)', () => {
    const source = readFile('src/screens/CustomerProjectDetailScreen.tsx')
    expect(
      source.includes('deriveCanonicalProjection'),
      'CustomerProjectDetailScreen must import deriveCanonicalProjection — local deriveProjectStatusFromJob ad-hoc usage was a shadow path',
    ).toBe(true)
  })

  it('does not import deriveProjectStatusFromJob directly', () => {
    const source = readFile('src/screens/CustomerProjectDetailScreen.tsx')
    // The screen should use deriveCanonicalProjection which wraps deriveProjectStatusFromJob
    expect(
      source.includes('deriveProjectStatusFromJob'),
      'CustomerProjectDetailScreen must not import deriveProjectStatusFromJob directly — use deriveCanonicalProjection',
    ).toBe(false)
  })

  it('does not have raw project.status in display conditionals', () => {
    const source = readFile('src/screens/CustomerProjectDetailScreen.tsx')
    const code = codeLines(source)

    // project.status should not appear in display JSX conditionals
    // (allowed only inside non-display logic like isProjectOperational check)
    const displayStatusReads = code.filter((l) =>
      /project\.status\s*[!=]==/.test(l) ||
      /status=\{[^}]*project\.status/.test(l),
    )

    expect(
      displayStatusReads.length,
      'CustomerProjectDetailScreen must not use raw project.status in display paths — use canonicalStatus',
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Guard 3 — No duplicate parseEuroAmount in finance/selectors
// ---------------------------------------------------------------------------

describe('Block 6B — no duplicate parseEuroAmount in finance selectors', () => {
  it('finance/selectors.ts does not define parseEuroAmount', () => {
    const source = readFile('src/lib/finance/selectors.ts')
    expect(
      source.includes('function parseEuroAmount'),
      'finance/selectors.ts must not define parseEuroAmount — use resolveCanonicalAmount instead',
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Guard 4 — Finance selectors use canonical facts for job titles
// ---------------------------------------------------------------------------

describe('Block 6B — finance selectors use canonical facts', () => {
  it('finance/selectors.ts uses resolveCanonicalProjectFacts for job context', () => {
    const source = readFile('src/lib/finance/selectors.ts')
    expect(
      source.includes('resolveCanonicalProjectFacts'),
      'finance/selectors.ts must use resolveCanonicalProjectFacts — not raw job?.title',
    ).toBe(true)
  })

  it('finance/selectors.ts does not read raw job?.title for display', () => {
    const source = readFile('src/lib/finance/selectors.ts')
    const code = codeLines(source)

    const rawTitleReads = code.filter((l) => /job\??\.\s*title/.test(l))
    expect(
      rawTitleReads.length,
      'finance/selectors.ts must not use raw job?.title — use resolveCanonicalProjectFacts',
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Guard 5 — (Removed: DashboardJobRow was dead code from older Home iteration)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Guard 6 — Banned raw field display patterns in stabilized provider area
// ---------------------------------------------------------------------------

describe('Block 6B — no raw job field display in stabilized provider components', () => {
  it('no component in src/components/dashboard/ renders raw {job.title}', () => {
    let grepOutput: string
    try {
      grepOutput = execSync(
        'grep -rn "{job\\.title}" src/components/dashboard/ --include="*.tsx" || true',
        { encoding: 'utf-8', cwd: ROOT },
      )
    } catch {
      grepOutput = ''
    }

    const codeMatches = (grepOutput || '').trim().split('\n').filter((line) => {
      if (!line.trim()) return false
      const content = line.split(':').slice(2).join(':').trim()
      return !content.startsWith('//') && !content.startsWith('*')
    })

    expect(
      codeMatches.length,
      'Dashboard components must not render raw {job.title} — use canonical facts',
    ).toBe(0)
  })

  it('no component in src/components/owner/ renders raw {job.title}', () => {
    let grepOutput: string
    try {
      grepOutput = execSync(
        'grep -rn "{job\\.title}" src/components/owner/ --include="*.tsx" || true',
        { encoding: 'utf-8', cwd: ROOT },
      )
    } catch {
      grepOutput = ''
    }

    const codeMatches = (grepOutput || '').trim().split('\n').filter((line) => {
      if (!line.trim()) return false
      const content = line.split(':').slice(2).join(':').trim()
      return !content.startsWith('//') && !content.startsWith('*')
    })

    expect(
      codeMatches.length,
      'Owner components must not render raw {job.title} — use canonical facts',
    ).toBe(0)
  })
})
