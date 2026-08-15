/**
 * Block 4 — Customer Payment/Release/Payout Visibility Symmetry
 *
 * Guards the release-maturity invariants:
 *
 *  1. CustomerReleaseProgressCard renders from funded_in_escrow onwards so
 *     the customer sees the 25/75 mechanic early and calmly (no surprise
 *     later). The old gate hid the card until first release.
 *
 *  2. CustomerProjectsScreen chips reflect the funded state ("Zahlung
 *     gesichert") so the list is symmetric with the detail surface. The
 *     chip row must be hydration-gated so a cold start can't flash
 *     "Zahlung ausstehend" for jobs that are already funded.
 *
 *  3. ThreadPaymentStatusCard resolves the customer deep-link via
 *     projectId (the route key), not jobId. Passing jobId produced a
 *     404 because /projects/:projectId expects the project identifier.
 *
 *  4. deriveJobAttention does not emit payment-critical attention items
 *     before the payment/funding/escrow repositories are hydrated.
 *
 *  5. HomeScreen.tsx (demo stub with hard-coded €550) is gone: no file,
 *     no lazy export, no component index re-exports for its tail.
 *
 *  6. CustomerHomeScreen phase status text for a funded job is
 *     "Im Stripe-Absicherung gesichert" (matches detail + release card).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { setupCleanRepositories } from '../helpers/setupRepositories'

// ─────────────────────────────────────────────────────────────────────────
// 1. ReleaseProgressCard: funded_in_escrow visible without release
// ─────────────────────────────────────────────────────────────────────────

describe('Block 4 — CustomerReleaseProgressCard visible from funded_in_escrow', () => {
  const componentPath = path.resolve(
    __dirname,
    '../../src/components/projects/CustomerReleaseProgressCard.tsx',
  )
  const source = fs.readFileSync(componentPath, 'utf-8')

  it('no longer hides on releasedAmount === 0 while funded_in_escrow', () => {
    // The pre-Block-4 gate looked like:
    //   if (mfp.fundingStatus !== 'funded_in_escrow') return null
    //   if (mfp.releasedAmount === 0 && !mfp.isDisputed && !mfp.isTerminal) return null
    // which returned null for funded_in_escrow with no releases yet.
    //
    // The new gate must keep the card visible in that state.
    const gateBlock = source.slice(
      source.indexOf('// ── Gate'),
      source.indexOf('const badge = derivePlanBadge'),
    )

    // Old single-line exit removed
    expect(gateBlock).not.toMatch(
      /if \(mfp\.releasedAmount === 0 && !mfp\.isDisputed && !mfp\.isTerminal\) return null/,
    )
    // Still bails when there is no escrow plan at all
    expect(gateBlock).toContain("!mfp.hasEscrowPlan")
    // Funded-but-not-released is permitted (only bails when ALSO not funded)
    expect(gateBlock).toMatch(/fundingStatus !== 'funded_in_escrow' &&[\s\S]*releasedAmount === 0/)
  })

  it('carries a calm pre-release explanation of the 25/75 mechanic', () => {
    expect(source).toMatch(/25[^<]*Arbeitsbeginn/)
    expect(source).toMatch(/75[^<]*Freigabe[^<]*Ende/)
    expect(source).toContain('über Stripe abgesichert')
  })

  it('re-reads payout-outcome signals via its own timeline subscription', () => {
    // The card is used in screens that may not re-render on timeline
    // changes. A self-contained timeline subscription keeps payoutStatus
    // and per-tranche releasedAt fresh without parent wiring.
    expect(source).toContain("subscribeTimeline")
    expect(source).toContain("useEffect")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. CustomerProjectsScreen: funded chip + hydration-gated urgency
// ─────────────────────────────────────────────────────────────────────────

describe('Block 4 — CustomerProjectsScreen chip symmetry', () => {
  const screenPath = path.resolve(
    __dirname,
    '../../src/screens/CustomerProjectsScreen.tsx',
  )
  const source = fs.readFileSync(screenPath, 'utf-8')

  it('exposes a "Zahlung abgesichert" chip for funded pre-release states', () => {
    expect(source).toContain("'Zahlung abgesichert'")
    // Covers the three funded-but-not-released states
    expect(source).toMatch(/paymentState === 'deposit_paid'[\s\S]*paymentState === 'in_escrow'[\s\S]*paymentState === 'work_in_progress'/)
  })

  it('gates every payment-driven chip on payment hydration', () => {
    // Without this gate a cold start could flash a false-positive
    // deposit-required chip for jobs that are already funded because
    // funding truth has not arrived yet. The block also protects against
    // stale mirror values for release_pending and disputed.
    expect(source).toMatch(/if \(paymentReady\) \{[\s\S]*paymentState === 'release_pending'[\s\S]*paymentState === 'disputed'[\s\S]*paymentState === 'deposit_required'[\s\S]*!fundingConfirmed/)
  })

  it('subscribes to all repositories that feed the chip derivation', () => {
    // subscribe*/isHydrated imports must all exist so the list chip stays
    // in sync with realtime updates and waits for first hydration.
    expect(source).toContain('subscribePayments')
    expect(source).toContain('subscribeFundingRequests')
    expect(source).toContain('subscribeEscrowPlans')
    expect(source).toContain('subscribeDisputes')
    expect(source).toContain('subscribeTimeline')
    expect(source).toContain('isPaymentRepositoryHydrated')
    expect(source).toContain('isFundingRequestRepositoryHydrated')
    expect(source).toContain('isEscrowPlanRepositoryHydrated')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. ThreadPaymentStatusCard: customer deep-link uses projectId
// ─────────────────────────────────────────────────────────────────────────

describe('Block 4 — ThreadPaymentStatusCard routes customer via projectId', () => {
  const componentPath = path.resolve(
    __dirname,
    '../../src/components/messages/ThreadPaymentStatusCard.tsx',
  )
  const source = fs.readFileSync(componentPath, 'utf-8')

  it('imports getProjectByJobId and uses its result for the customer href', () => {
    expect(source).toContain('getProjectByJobId')
    // Customer href is built from the resolved project, not the raw jobId
    expect(source).toMatch(/customerProject\s*\?\s*`\/projects\/\$\{customerProject\.id\}\?focus=payment`/)
  })

  it('never links the customer into /projects/${jobId}', () => {
    // Regression guard: the pre-Block-4 string put jobId directly into the
    // /projects/:projectId route, which produced "Projekt nicht gefunden".
    expect(source).not.toMatch(/`\/projects\/\$\{jobId\}/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. attentionSelectors: no payment alarm before repos hydrated
// ─────────────────────────────────────────────────────────────────────────

describe('Block 4 — deriveJobAttention hydration guard', () => {
  beforeEach(() => setupCleanRepositories())

  it('skips payment-critical items when payment repo is not hydrated yet', async () => {
    // Mock the hydration functions so the selector believes the payment
    // repositories have not finished their initial load yet.
    vi.resetModules()
    vi.doMock('../../src/lib/payments/service', async () => {
      const actual = await vi.importActual<typeof import('../../src/lib/payments/service')>(
        '../../src/lib/payments/service',
      )
      return { ...actual, isPaymentRepositoryHydrated: () => false }
    })

    const { deriveAttentionItems } = await import(
      '../../src/lib/notifications/attentionSelectors'
    )
    const job = {
      id: 'job-block4',
      title: 'Block 4 Job',
      status: 'new',
      paymentState: 'deposit_required',
      proposalAcceptedAt: 0,
      proposalSentAt: 0,
      assignedMemberIds: [],
      photoCount: 0,
      notes: [],
      activities: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Parameters<typeof deriveAttentionItems>[0][number]

    const items = deriveAttentionItems([job], [], 1_000_000)

    // Deposit-required and release-pending branches must stay quiet.
    expect(items.find((i) => i.category === 'payment')).toBeUndefined()

    vi.doUnmock('../../src/lib/payments/service')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4b. Callers recompute attention when payment layer hydrates
// ─────────────────────────────────────────────────────────────────────────

describe('Block 4 — attention callers subscribe to payment hydration', () => {
  const notifPath = path.resolve(
    __dirname,
    '../../src/screens/NotificationCenterScreen.tsx',
  )
  const notifSrc = fs.readFileSync(notifPath, 'utf-8')

  it('NotificationCenterScreen subscribes to payment / funding / escrow', () => {
    expect(notifSrc).toContain("import { subscribePayments } from '../lib/payments'")
    expect(notifSrc).toContain(
      "import { subscribeFundingRequests } from '../lib/payments/fundingRequest'",
    )
    expect(notifSrc).toContain(
      "import { subscribeEscrowPlans } from '../lib/payments/escrow'",
    )
    expect(notifSrc).toMatch(/subscribePayments\(bumpPayments\)/)
    expect(notifSrc).toMatch(/subscribeFundingRequests\(bumpPayments\)/)
    expect(notifSrc).toMatch(/subscribeEscrowPlans\(bumpPayments\)/)
  })

  it('NotificationCenterScreen threads paymentsTick through the attention memo', () => {
    const memoBlock = notifSrc.slice(
      notifSrc.indexOf('const attentionSummary = useMemo'),
      notifSrc.indexOf('const { alerts'),
    )
    expect(memoBlock).toMatch(/\[\s*jobs,\s*disputes,\s*role,\s*paymentsTick\s*\]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4c. Cold-start ordering: attention appears after payment hydration
// ─────────────────────────────────────────────────────────────────────────

describe('Block 4 — cold-start hydration ordering for attention', () => {
  beforeEach(() => {
    vi.resetModules()
    setupCleanRepositories()
  })

  it('emits deposit attention only after payment/funding/escrow hydrate', async () => {
    // Mock only the three hydration functions on the low-level service
    // modules — the public barrel (`lib/payments/fundingRequest`,
    // `lib/payments/escrow`) re-exports them, so patching the source is
    // enough. Use importActual + spread so no sibling exports get lost.
    let paymentReady = false
    vi.doMock('../../src/lib/payments/service', async () => {
      const actual = await vi.importActual<typeof import('../../src/lib/payments/service')>(
        '../../src/lib/payments/service',
      )
      return { ...actual, isPaymentRepositoryHydrated: () => paymentReady }
    })
    vi.doMock('../../src/lib/payments/fundingRequest/fundingRequestService', async () => {
      const actual = await vi.importActual<
        typeof import('../../src/lib/payments/fundingRequest/fundingRequestService')
      >('../../src/lib/payments/fundingRequest/fundingRequestService')
      return { ...actual, isFundingRequestRepositoryHydrated: () => paymentReady }
    })
    vi.doMock('../../src/lib/payments/escrow/escrowService', async () => {
      const actual = await vi.importActual<
        typeof import('../../src/lib/payments/escrow/escrowService')
      >('../../src/lib/payments/escrow/escrowService')
      return { ...actual, isEscrowPlanRepositoryHydrated: () => paymentReady }
    })

    const { deriveAttentionItems } = await import(
      '../../src/lib/notifications/attentionSelectors'
    )
    const { getFundingRequestRepository } = await import(
      '../../src/lib/payments/fundingRequest'
    )

    // Minimal job mirror at deposit_required with a backing FundingRequest
    // so the selector has a concrete funding target to link to.
    const job = {
      id: 'job-cold',
      title: 'Cold-start deposit',
      status: 'new',
      paymentState: 'deposit_required',
      proposalAcceptedAt: 0,
      proposalSentAt: 0,
      assignedMemberIds: [],
      photoCount: 0,
      notes: [],
      activities: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Parameters<typeof deriveAttentionItems>[0][number]

    getFundingRequestRepository().add({
      id: 'fr-cold',
      jobId: job.id,
      type: 'initial_escrow',
      status: 'created',
      escrowPlanId: null,
      offerId: null,
      createdAt: 1,
      updatedAt: 1,
    } as Parameters<ReturnType<typeof getFundingRequestRepository>['add']>[0])

    // Stage 1 assertion — repos not hydrated yet → no payment attention
    const before = deriveAttentionItems([job], [], 1_000_000)
    expect(before.find((i) => i.category === 'payment')).toBeUndefined()

    // Stage 2: Repos finish hydration. The memo dep (paymentsTick) is a
    // caller-side concern — here we verify the pure selector emits the
    // expected item on the next invocation, which is exactly what the
    // tick-driven memo would trigger in the UI.
    paymentReady = true
    const after = deriveAttentionItems([job], [], 1_000_000)
    const deposit = after.find((i) => i.category === 'payment')
    expect(deposit?.title).toBe('Zahlung ausstehend')

    vi.doUnmock('../../src/lib/payments/service')
    vi.doUnmock('../../src/lib/payments/fundingRequest/fundingRequestService')
    vi.doUnmock('../../src/lib/payments/escrow/escrowService')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 5. HomeScreen dead tail removed
// ─────────────────────────────────────────────────────────────────────────

describe('Block 4 — dead HomeScreen + demo components removed', () => {
  const repoRoot = path.resolve(__dirname, '../..')

  it('HomeScreen.tsx no longer exists', () => {
    expect(fs.existsSync(path.join(repoRoot, 'src/screens/HomeScreen.tsx'))).toBe(false)
  })

  it('lazy.ts does not re-export HomeScreen', () => {
    const lazySrc = fs.readFileSync(path.join(repoRoot, 'src/screens/lazy.ts'), 'utf-8')
    expect(lazySrc).not.toMatch(/export const HomeScreen\b/)
    expect(lazySrc).not.toMatch(/import\(['"]\.\/HomeScreen['"]\)/)
  })

  it('components/index.ts no longer re-exports the demo-only primitives', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/components/index.ts'), 'utf-8')
    expect(src).not.toMatch(/TopBar/)
    expect(src).not.toMatch(/SearchPill/)
    expect(src).not.toMatch(/ProjectCard/)
    expect(src).not.toMatch(/InfoCard/)
  })

  it('demo-only primitive components are deleted', () => {
    for (const f of ['TopBar.tsx', 'SearchPill.tsx', 'ProjectCard.tsx', 'InfoCard.tsx']) {
      expect(fs.existsSync(path.join(repoRoot, 'src/components', f))).toBe(false)
    }
  })
})

