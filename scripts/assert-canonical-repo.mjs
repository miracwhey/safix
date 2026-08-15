#!/usr/bin/env node
/**
 * Asserts this repo is being run from the canonical local clone.
 *
 * Problem: Two local FixUp clones exist on Leon's Mac:
 *   ~/FixUp                          ← canonical, Xcode-safe (no TCC restriction)
 *   ~/Documents/GitHub/FixUp         ← problematic for Xcode (macOS TCC blocks SPM)
 *
 * Running `npm run dev` or `npm run build` from the Documents clone causes:
 *   - Xcode SPM manifest-worker subprocess blocked by macOS TCC
 *   - "Missing package product" for all 8 Capacitor plugins
 *   - Dev server and Xcode building from diverged state
 *
 * This guard is SKIPPED in all CI/cloud/remote environments (Vercel, Xcode Cloud,
 * GitHub Actions, any process where CI=1/true or specific CI env vars are set).
 * It only activates locally on Leon's Mac.
 */

import { execSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const CANONICAL_REPO = '/Users/leonvalentin/FixUp'
const FORBIDDEN_REPO = '/Users/leonvalentin/Documents/GitHub/FixUp'
const CANONICAL_XCODE = `${CANONICAL_REPO}/ios/App/App.xcodeproj`
const OWNER_HOME = '/Users/leonvalentin'

// ── CI / cloud skip ────────────────────────────────────────────────────────
const CI_FLAGS = [
  'CI',
  'VERCEL',
  'CI_PRIMARY_REPOSITORY_PATH',
  'CI_XCODEBUILD_ACTION',
  'GITHUB_ACTIONS',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'DRONE',
]

function isCI() {
  for (const flag of CI_FLAGS) {
    const val = process.env[flag]
    if (val && val !== '0' && val !== 'false') return true
  }
  // Xcode Cloud runs under /Volumes/workspace/
  const cwd = process.cwd()
  if (cwd.startsWith('/Volumes/workspace/')) return true
  return false
}

if (isCI()) process.exit(0)

// ── Only run on Leon's Mac ─────────────────────────────────────────────────
if (os.homedir() !== OWNER_HOME) process.exit(0)

// ── Resolve actual repo root ───────────────────────────────────────────────
let repoRoot
try {
  repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
} catch {
  // Not in a git repo — skip
  process.exit(0)
}

const normalised = path.resolve(repoRoot)

if (normalised === path.resolve(FORBIDDEN_REPO)) {
  console.error('')
  console.error('╔═══════════════════════════════════════════════════════════════╗')
  console.error('║  WRONG CLONE — STOP                                           ║')
  console.error('╠═══════════════════════════════════════════════════════════════╣')
  console.error('║                                                               ║')
  console.error(`║  You are running from:                                        ║`)
  console.error(`║    ${normalised.padEnd(60)}║`)
  console.error('║                                                               ║')
  console.error(`║  This clone causes macOS TCC / Xcode SPM errors.             ║`)
  console.error(`║  Xcode cannot resolve Capacitor plugin packages here.        ║`)
  console.error('║                                                               ║')
  console.error('║  Use the canonical clone instead:                             ║')
  console.error(`║    cd ${CANONICAL_REPO.padEnd(53)}║`)
  console.error('║                                                               ║')
  console.error('║  Open Xcode from the canonical clone:                         ║')
  console.error(`║    open ${CANONICAL_XCODE.padEnd(51)}║`)
  console.error('║                                                               ║')
  console.error('╚═══════════════════════════════════════════════════════════════╝')
  console.error('')
  process.exit(1)
}

if (normalised !== path.resolve(CANONICAL_REPO)) {
  // Unknown non-canonical clone on Leon's machine — warn but don't block
  console.warn(`[assert-canonical-repo] WARN: repo root is ${normalised}`)
  console.warn(`[assert-canonical-repo] Expected: ${CANONICAL_REPO}`)
  console.warn('[assert-canonical-repo] Continuing — not the known forbidden clone.')
}
