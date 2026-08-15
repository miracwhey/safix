/**
 * Block 7.2.8 — DisputeStatusCard (craftsman) owner-side evidence-upload wiring.
 *
 * Source-inspection contract: prior to 7.2.8 the craftsman DisputeStatusCard
 * forgot to forward `ownerUserId` to DisputeResolutionCard, which silently
 * suppressed the photo-/video-evidence upload for the only RLS-eligible
 * provider-side role (owner). The wire must:
 *
 *  1. Pass `ownerUserId` to DisputeResolutionCard
 *  2. Gate it on craftsmanRole === 'owner' so workers never get a button
 *     they cannot use (the disputes_update_own_side RLS does not include a
 *     team_members branch — see Memory N3a / project_friction_roadmap).
 *
 * Behavior is exercised through the existing DisputeEvidenceSection +
 * mediaUploadService suites; this test pins the wiring contract.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CARD = resolve(
  __dirname,
  '../../../src/components/jobs/DisputeStatusCard.tsx',
)

describe('DisputeStatusCard — owner-side evidence-upload wiring', () => {
  const src = readFileSync(CARD, 'utf-8')

  it('forwards ownerUserId to DisputeResolutionCard', () => {
    expect(src).toMatch(/ownerUserId=\{ownerUserId\}/)
  })

  it('gates ownerUserId on craftsmanRole === "owner"', () => {
    expect(src).toContain("session.craftsmanRole === 'owner'")
    expect(src).toMatch(
      /ownerUserId\s*=\s*[\s\S]*session\.craftsmanRole === 'owner'\s*\?\s*session\.user\?\.id\s*:\s*undefined/,
    )
  })

  it('does not hard-wire session.user?.id without role gate', () => {
    expect(src).not.toMatch(/ownerUserId=\{session\.user\?\.id\}/)
  })
})
