/**
 * Block D Slice 2 M1 — ChatArtifactCardCompact wiring + render-contract
 *
 * Source-inspection tests per existing tests/finance/payoutFailureBanner.test.ts
 * convention (vitest env = 'node', no @testing-library/react available).
 *
 * Behavioral coverage of the routing map lives in chatArtifactRouting.test.ts;
 * tests here guard structural wiring so accidental removal of subscriptions,
 * skeleton fallback, the reconciliation banner, or the MessageThreadScreen
 * activation surfaces as a test failure rather than a runtime regression.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CARD = resolve(__dirname, '../../src/components/chat/ChatArtifactCardCompact.tsx')
const INDEX = resolve(__dirname, '../../src/components/chat/index.ts')
const THREAD_SCREEN = resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx')

describe('ChatArtifactCardCompact — wiring contract', () => {
  const src = readFileSync(CARD, 'utf-8')

  it('imports getArtifactRoute + isKnownArtifactType from the routing map', () => {
    expect(src).toMatch(/from\s+'\.\/chatArtifactRouting'/)
    expect(src).toContain('getArtifactRoute')
    expect(src).toContain('isKnownArtifactType')
  })

  it('subscribes reactively to all four canonical domains', () => {
    expect(src).toContain('subscribeProjects')
    expect(src).toContain('subscribeOffers')
    expect(src).toContain('subscribeChangeOrders')
    expect(src).toContain('subscribeFundingRequests')
  })

  it('looks up entity by artifactId per type (getById functions)', () => {
    expect(src).toContain('getProjectById')
    expect(src).toContain('getOfferById')
    expect(src).toContain('getChangeOrderById')
    expect(src).toContain('getFundingRequestById')
  })

  it('renders a stable skeleton placeholder while the entity is unhydrated', () => {
    expect(src).toMatch(/CompactSkeleton/)
    expect(src).toContain('data-testid="artifact-card-compact-skeleton"')
  })

  it('returns null for unknown artifactType (does not call domain selectors)', () => {
    expect(src).toMatch(/if\s*\(!isKnownArtifactType\(artifactType\)\s*\|\|\s*!artifactId\)\s*{\s*\n\s*return null/)
  })

  it('renders the reconciliation banner only above FundingStep cards when offerFundingSuperseded is true', () => {
    expect(src).toContain('data-testid="artifact-reconciliation-banner"')
    expect(src).toMatch(/showReconciliation\s*=\s*\n?\s*artifactType\s*===\s*'FundingStep'\s*&&\s*offerFundingSuperseded\s*===\s*true/)
  })

  it('navigates via the onNavigate prop — no direct router import', () => {
    expect(src).not.toMatch(/from\s+'react-router-dom'/)
    expect(src).toContain('onNavigate(targetPath)')
  })

  it('exposes per-type render testids for downstream screen audits', () => {
    // V5 (2026-06-23): renders through the shared ArtifactCardShell; the
    // per-type testid is passed via the shell's `testid` prop, the status pill
    // testid ("artifact-card-status") lives in the shell.
    expect(src).toContain('testid={`artifact-card-compact-${artifactType}`}')
    expect(src).toContain('ArtifactCardShell')
  })

  it('is keyboard-actionable (Enter / Space triggers navigation)', () => {
    expect(src).toMatch(/role="button"/)
    expect(src).toMatch(/tabIndex=\{0\}/)
    expect(src).toMatch(/e\.key === 'Enter'\s*\|\|\s*e\.key === ' '/)
  })

  it('uses German status labels for all four artifact families', () => {
    expect(src).toContain('PROJECT_STATUS_LABEL')
    expect(src).toContain('OFFER_DOCTYPE_LABEL')
    expect(src).toContain('CHANGE_ORDER_STATUS_LABEL')
    expect(src).toContain('FUNDING_STATUS_LABEL')
  })

  it('does NOT render inline workflow action buttons (canonical decision = detail screen)', () => {
    // Persistent ThreadArtifactOfferCard explicitly removed inline accept/decline;
    // the compact variant inherits the same rule — tap navigates, business
    // decisions remain in the detail surface.
    expect(src).not.toMatch(/onClick=\{[^}]*acceptOfferWorkflow/)
    expect(src).not.toMatch(/onClick=\{[^}]*declineOfferWorkflow/)
    expect(src).not.toMatch(/changeOrderWorkflow/)
  })
})

describe('components/chat/index — public exports', () => {
  const src = readFileSync(INDEX, 'utf-8')

  it('re-exports ChatArtifactCardCompact + its props type', () => {
    expect(src).toMatch(/ChatArtifactCardCompact/)
    expect(src).toMatch(/ChatArtifactCardCompactProps/)
  })

  it('re-exports the routing helpers and KNOWN_ARTIFACT_TYPES', () => {
    expect(src).toContain('getArtifactRoute')
    expect(src).toContain('isKnownArtifactType')
    expect(src).toContain('KNOWN_ARTIFACT_TYPES')
  })
})

describe('MessageThreadScreen — Slice 2 M1 activation', () => {
  const src = readFileSync(THREAD_SCREEN, 'utf-8')

  it('imports ChatArtifactCardCompact alongside ChatBubble + ChatComposer', () => {
    expect(src).toMatch(/import\s+\{\s*ChatArtifactCardCompact,\s*ChatBubble,\s*ChatComposer\s*\}\s+from\s+'\.\.\/components\/chat'/)
  })

  it('pushes a chat_artifact_card timeline entry for messageType === artifact_card', () => {
    expect(src).toContain("msg.messageType === 'artifact_card'")
    expect(src).toContain("kind: 'chat_artifact_card'")
    // and records the artifactType so the matching legacy event is suppressed per-type
    expect(src).toContain('chatArtifactCardTypes')
  })

  it('skips a failed (never-persisted) artifact_card so no ghost card renders', () => {
    expect(src).toMatch(/if\s*\(msg\.status === 'failed'\)\s+continue/)
  })

  it('skips compact-card pushes when artifactType or artifactId is missing', () => {
    expect(src).toMatch(/if\s*\(!msg\.artifactType\s*\|\|\s*!msg\.artifactId\)\s+continue/)
  })

  it('renders the compact card with role + onNavigate + offerFundingSuperseded', () => {
    expect(src).toContain('<ChatArtifactCardCompact')
    expect(src).toMatch(/role=\{role\}/)
    expect(src).toMatch(/onNavigate=\{\(path\) => navigate\(path\)\}/)
    expect(src).toMatch(/offerFundingSuperseded=\{artifacts\.offerFundingSuperseded\}/)
  })

  it('suppresses each legacy artifact event PER-TYPE (a Project card must not hide offer/funding cards)', () => {
    expect(src).toMatch(/if\s*\(!chatArtifactCardTypes\.has\('Project'\)\)/)
    expect(src).toMatch(/!chatArtifactCardTypes\.has\('OfferPayment'\)\s*&&\s*artifacts\.offerPaymentArtifact/)
    expect(src).toMatch(/!chatArtifactCardTypes\.has\('FundingStep'\)\s*&&\s*artifacts\.fundingStepArtifact/)
  })

  it('keeps the workflow tiebreaker rank for chat_artifact_card', () => {
    expect(src).toMatch(/chat_artifact_card:\s*2/)
  })
})
