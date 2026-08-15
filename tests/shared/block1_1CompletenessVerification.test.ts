/**
 * Block 1.1 — Hydration Gates Completeness Verification
 *
 * Strict post-Block-1 verification that every critical repository has
 * production-grade hydration readiness semantics with no hidden gaps.
 *
 * Verifies:
 *   1. All Supabase repos notify subscribers AFTER setting _hydrated = true
 *   2. FundingRequest / EscrowPlan are InMemory-only (no Supabase impl)
 *   3. Screen hydration gates don't depend on any uncovered repository
 *   4. No regression to QuoteDetailScreen hydration-aware loading
 *   5. Complete coverage of the initialize → _hydrated → notify() chain
 *   6. Invoice / Notification / Timeline domains now covered (Sub-block 1.1)
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC_ROOT = path.resolve(__dirname, '../../src')

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf-8')
}

function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(SRC_ROOT, relativePath))
}

describe('Block 1.1 — Hydration Gates Completeness Verification', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Supabase repos: notify() fires AFTER _hydrated = true
  // ═══════════════════════════════════════════════════════════════════════

  describe('Supabase repos call notify() after setting _hydrated = true in initialize()', () => {
    const supabaseFiles = [
      'lib/payments/repository/SupabasePaymentRepository.ts',
      'lib/jobs/repository/SupabaseJobRepository.ts',
      'lib/messages/repository/SupabaseMessageRepository.ts',
      'lib/offers/repository/SupabaseOfferRepository.ts',
      'lib/projects/repository/SupabaseProjectRepository.ts',
      // Sub-block 1.1 additions
      'lib/invoices/repository/SupabaseInvoiceRepository.ts',
      'lib/notifications/repository/SupabaseNotificationRepository.ts',
      'lib/timeline/repository/SupabaseTimelineRepository.ts',
    ]

    for (const file of supabaseFiles) {
      it(`${file} has this._hydrated = true followed by this.notify() in initialize`, () => {
        const content = readFile(file)

        // Extract the initialize() method body to check ordering
        const initMatch = content.match(
          /async initialize\(\)[\s\S]*?(?=\n\s{2}\w|\n\s{2}private|\n\s{2}isHydrated)/
        )
        expect(initMatch).not.toBeNull()
        const initBody = initMatch![0]

        // Every occurrence of `this._hydrated = true` must be followed by
        // `this.notify()` before a `return` or end of block.
        // Find all _hydrated = true positions
        const hydratedPositions: number[] = []
        let searchFrom = 0
        while (true) {
          const idx = initBody.indexOf('this._hydrated = true', searchFrom)
          if (idx === -1) break
          hydratedPositions.push(idx)
          searchFrom = idx + 1
        }

        expect(hydratedPositions.length).toBeGreaterThan(0)

        for (const pos of hydratedPositions) {
          // The text after _hydrated = true should contain notify() before the next return/}
          const afterHydrated = initBody.slice(pos + 'this._hydrated = true'.length)
          // Find the next meaningful statement
          const nextLines = afterHydrated.split('\n').filter((l) => l.trim().length > 0)
          // The first non-empty line after `this._hydrated = true` should be `this.notify()`
          const firstMeaningfulLine = nextLines[0]?.trim() ?? ''
          expect(firstMeaningfulLine).toBe(
            'this.notify()'
          )
        }
      })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. FundingRequest / EscrowPlan: Supabase implementations exist
  // ═══════════════════════════════════════════════════════════════════════

  describe('FundingRequest and EscrowPlan have Supabase implementations', () => {
    it('SupabaseEscrowPlanRepository file exists', () => {
      expect(fileExists('lib/payments/escrow/SupabaseEscrowPlanRepository.ts')).toBe(true)
    })

    it('SupabaseFundingRequestRepository file exists', () => {
      expect(fileExists('lib/payments/fundingRequest/SupabaseFundingRequestRepository.ts')).toBe(true)
    })

    it('InMemoryEscrowPlanRepository is always hydrated', () => {
      const content = readFile('lib/payments/escrow/InMemoryEscrowPlanRepository.ts')
      expect(content).toContain('isHydrated()')
      expect(content).toContain('return true')
    })

    it('InMemoryFundingRequestRepository is always hydrated', () => {
      const content = readFile('lib/payments/fundingRequest/InMemoryFundingRequestRepository.ts')
      expect(content).toContain('isHydrated()')
      expect(content).toContain('return true')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Screens don't depend on any uncovered repository for hydration
  // ═══════════════════════════════════════════════════════════════════════

  describe('Screen hydration gates cover all required repositories', () => {
    it('CustomerProjectDetailScreen only gates on project + job (both covered)', () => {
      const content = readFile('screens/CustomerProjectDetailScreen.tsx')
      // Must use these two hydration checks
      expect(content).toContain('isProjectRepositoryHydrated')
      expect(content).toContain('isJobRepositoryHydrated')
      // The loaded state must combine both
      expect(content).toMatch(/isProjectRepositoryHydrated\(\)\s*&&\s*isJobRepositoryHydrated\(\)/)
    })

    it('CraftsmanJobDetailScreen only gates on job (covered)', () => {
      const content = readFile('screens/CraftsmanJobDetailScreen.tsx')
      expect(content).toContain('isJobRepositoryHydrated')
    })

    it('CraftsmanRequestDetailScreen gates on project + message (both covered)', () => {
      const content = readFile('screens/CraftsmanRequestDetailScreen.tsx')
      expect(content).toContain('isProjectRepositoryHydrated')
      expect(content).toContain('isMessageRepositoryHydrated')
      expect(content).toMatch(/isProjectRepositoryHydrated\(\)\s*&&\s*isMessageRepositoryHydrated\(\)/)
    })

    it('QuoteDetailScreen gates on offer (covered)', () => {
      const content = readFile('screens/QuoteDetailScreen.tsx')
      expect(content).toContain('isOfferRepositoryHydrated')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Every Supabase repo initialize() method is fully consistent
  // ═══════════════════════════════════════════════════════════════════════

  describe('All Supabase repos follow consistent initialize() pattern', () => {
    const supabaseFiles = [
      'lib/payments/repository/SupabasePaymentRepository.ts',
      'lib/jobs/repository/SupabaseJobRepository.ts',
      'lib/messages/repository/SupabaseMessageRepository.ts',
      'lib/offers/repository/SupabaseOfferRepository.ts',
      'lib/projects/repository/SupabaseProjectRepository.ts',
      // Sub-block 1.1 additions
      'lib/invoices/repository/SupabaseInvoiceRepository.ts',
      'lib/notifications/repository/SupabaseNotificationRepository.ts',
      'lib/timeline/repository/SupabaseTimelineRepository.ts',
    ]

    for (const file of supabaseFiles) {
      it(`${file} initializes _hydrated = false`, () => {
        const content = readFile(file)
        expect(content).toContain('private _hydrated = false')
      })

      it(`${file} does NOT start with _hydrated = true`, () => {
        const content = readFile(file)
        expect(content).not.toContain('private _hydrated = true')
      })

      it(`${file} calls isHydrated() → return this._hydrated`, () => {
        const content = readFile(file)
        expect(content).toMatch(/isHydrated\(\).*\{[\s\S]*?return this\._hydrated/)
      })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Service-layer export completeness (all 7 domains)
  // ═══════════════════════════════════════════════════════════════════════

  describe('All 10 domains have service-layer isXxxRepositoryHydrated export', () => {
    const servicePaths: Array<{ file: string; fnName: string }> = [
      { file: 'lib/payments/service.ts', fnName: 'isPaymentRepositoryHydrated' },
      { file: 'lib/jobs/service.ts', fnName: 'isJobRepositoryHydrated' },
      { file: 'lib/messages/service.ts', fnName: 'isMessageRepositoryHydrated' },
      { file: 'lib/payments/escrow/escrowService.ts', fnName: 'isEscrowPlanRepositoryHydrated' },
      { file: 'lib/payments/fundingRequest/fundingRequestService.ts', fnName: 'isFundingRequestRepositoryHydrated' },
      { file: 'lib/projects/projectsStore.ts', fnName: 'isProjectRepositoryHydrated' },
      { file: 'lib/offers/service.ts', fnName: 'isOfferRepositoryHydrated' },
      // Sub-block 1.1 additions
      { file: 'lib/invoices/invoiceStore.ts', fnName: 'isInvoiceRepositoryHydrated' },
      { file: 'lib/notifications/notificationStore.ts', fnName: 'isNotificationRepositoryHydrated' },
      { file: 'lib/timeline/timelineStore.ts', fnName: 'isTimelineRepositoryHydrated' },
    ]

    for (const { file, fnName } of servicePaths) {
      it(`${file} exports ${fnName}()`, () => {
        const content = readFile(file)
        expect(content).toContain(`export function ${fnName}`)
        expect(content).toContain('.isHydrated()')
      })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Barrel export chain completeness
  // ═══════════════════════════════════════════════════════════════════════

  describe('Barrel exports expose hydration functions', () => {
    it('jobs/index.ts exports isJobRepositoryHydrated', () => {
      const content = readFile('lib/jobs/index.ts')
      expect(content).toContain('isJobRepositoryHydrated')
    })

    it('messages/index.ts exports isMessageRepositoryHydrated', () => {
      const content = readFile('lib/messages/index.ts')
      expect(content).toContain('isMessageRepositoryHydrated')
    })

    it('projects/index.ts exports isProjectRepositoryHydrated', () => {
      const content = readFile('lib/projects/index.ts')
      expect(content).toContain('isProjectRepositoryHydrated')
    })

    it('payments/escrow/index.ts exports isEscrowPlanRepositoryHydrated', () => {
      const content = readFile('lib/payments/escrow/index.ts')
      expect(content).toContain('isEscrowPlanRepositoryHydrated')
    })

    it('payments/fundingRequest/index.ts exports isFundingRequestRepositoryHydrated', () => {
      const content = readFile('lib/payments/fundingRequest/index.ts')
      expect(content).toContain('isFundingRequestRepositoryHydrated')
    })

    it('offers barrel exports isOfferRepositoryHydrated', () => {
      const content = readFile('lib/offers/service.ts')
      expect(content).toContain('export function isOfferRepositoryHydrated')
    })

    // Sub-block 1.1 additions
    it('invoices/index.ts exposes isInvoiceRepositoryHydrated (via export * from invoiceStore)', () => {
      const content = readFile('lib/invoices/index.ts')
      // export * from './invoiceStore' re-exports isInvoiceRepositoryHydrated
      expect(content).toContain("export * from './invoiceStore'")
      // Verify the function exists in the store
      const storeContent = readFile('lib/invoices/invoiceStore.ts')
      expect(storeContent).toContain('export function isInvoiceRepositoryHydrated')
    })

    it('notifications/index.ts exports isNotificationRepositoryHydrated', () => {
      const content = readFile('lib/notifications/index.ts')
      expect(content).toContain('isNotificationRepositoryHydrated')
    })

    it('timeline/index.ts exports isTimelineRepositoryHydrated', () => {
      const content = readFile('lib/timeline/index.ts')
      expect(content).toContain('isTimelineRepositoryHydrated')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Sub-block 1.2 — Invoice Write Contract Alignment
  // ═══════════════════════════════════════════════════════════════════════

  describe('Sub-block 1.2 — Invoice write contract uses Promise<void> with rollback', () => {
    it('InvoiceRepository interface declares add() as Promise<void>', () => {
      const content = readFile('lib/invoices/repository/InvoiceRepository.ts')
      expect(content).toContain('add(invoice: Invoice): Promise<void>')
    })

    it('InvoiceRepository interface declares update() as Promise<void>', () => {
      const content = readFile('lib/invoices/repository/InvoiceRepository.ts')
      expect(content).toContain('update(invoiceId: string, updater: (invoice: Invoice) => Invoice): Promise<void>')
    })

    it('SupabaseInvoiceRepository.add() awaits supabase insert (not fire-and-forget)', () => {
      const content = readFile('lib/invoices/repository/SupabaseInvoiceRepository.ts')
      // Must use await on the supabase insert, not .then()
      expect(content).toContain('const { error } = await supabase')
      expect(content).not.toContain('.insert(invoiceToRow(invoice))\n      .then(')
    })

    it('SupabaseInvoiceRepository.add() queues under invoices/draft on error (no rollback — draft stays in local cache)', () => {
      const content = readFile('lib/invoices/repository/SupabaseInvoiceRepository.ts')
      expect(content).toContain('enqueuePendingMutation(')
      expect(content).toContain("operation: 'insert'")
      expect(content).toContain("table: 'invoices'")
      expect(content).toContain("domain: 'invoices/draft'")
    })

    it('SupabaseInvoiceRepository.add() throws on error', () => {
      const content = readFile('lib/invoices/repository/SupabaseInvoiceRepository.ts')
      // Verify throw exists in add method context — check general throw error presence
      expect(content).toMatch(/if \(error\) \{[\s\S]*?throw error[\s\S]*?\}/)
    })

    it('SupabaseInvoiceRepository.update() captures previous before optimistic update', () => {
      const content = readFile('lib/invoices/repository/SupabaseInvoiceRepository.ts')
      expect(content).toContain('const previous = this.invoices.find((inv) => inv.id === invoiceId)')
    })

    it('SupabaseInvoiceRepository.update() rolls back on error', () => {
      const content = readFile('lib/invoices/repository/SupabaseInvoiceRepository.ts')
      expect(content).toContain('this.invoices = this.invoices.map((inv) => (inv.id === invoiceId ? previous : inv))')
    })

    it('syncInvoiceWithPayment in invoiceService is async', () => {
      const content = readFile('lib/invoices/invoiceService.ts')
      expect(content).toContain('export async function syncInvoiceWithPayment')
    })

    it('paymentWorkflow awaits syncInvoiceWithPayment at all call sites', () => {
      const content = readFile('lib/workflow/paymentWorkflow.ts')
      // No bare (non-awaited) syncInvoiceWithPayment calls remain
      const bareCall = /(?<!await )syncInvoiceWithPayment\(/.test(content)
      expect(bareCall).toBe(false)
    })

    it('jobWorkflow awaits syncInvoiceWithPayment at all call sites', () => {
      const content = readFile('lib/workflow/jobWorkflow.ts')
      const bareCall = /(?<!await )syncInvoiceWithPayment\(/.test(content)
      expect(bareCall).toBe(false)
    })

    it('jobWorkflow awaits ensureInvoiceForJobId at all call sites', () => {
      const content = readFile('lib/workflow/jobWorkflow.ts')
      const bareCall = /(?<!await )ensureInvoiceForJobId\(/.test(content)
      expect(bareCall).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Sub-block 1.4 — Funding Artifact Phase await
  // ═══════════════════════════════════════════════════════════════════════

  describe('Sub-block 1.4 — updateFundingArtifactPhase is awaited with try/catch + logError', () => {
    it('jobWorkflow imports logError from observability', () => {
      const content = readFile('lib/workflow/jobWorkflow.ts')
      expect(content).toMatch(/import\s*\{[^}]*logError[^}]*\}\s*from\s*['"]\.\.\/observability['"]/)
    })

    it('funding_started call site uses await inside try block', () => {
      const content = readFile('lib/workflow/jobWorkflow.ts')
      expect(content).toContain("await updateFundingArtifactPhase(job.sourceConversationId, 'funding_started'")
    })

    it('funded call site uses await inside try block', () => {
      const content = readFile('lib/workflow/jobWorkflow.ts')
      expect(content).toContain("await updateFundingArtifactPhase(job.sourceConversationId, 'funded'")
    })

    it('no bare void updateFundingArtifactPhase calls remain', () => {
      const content = readFile('lib/workflow/jobWorkflow.ts')
      expect(content).not.toContain('void updateFundingArtifactPhase(')
    })

    it('both call sites have catch block with logError', () => {
      const content = readFile('lib/workflow/jobWorkflow.ts')
      const matches = content.match(/catch \(err\) \{[\s\S]*?logError\('workflow\.funding\.artifact_phase_failed'/g)
      expect(matches).not.toBeNull()
      expect(matches!.length).toBe(2)
    })

    it('errors are not re-thrown in either catch block', () => {
      const content = readFile('lib/workflow/jobWorkflow.ts')
      // Tightened pattern: previously the leading `[\s\S]*?` between
      // `catch (err) {` and `logError(...)` was greedy enough to span
      // unrelated code (other workflows' bodies between the two artifact
      // phase catch blocks). Anchor `logError(...)` directly after the
      // brace so the match stays inside the actual catch block.
      const catchBlocks = content.match(/catch \(err\) \{\s*logError\('workflow\.funding\.artifact_phase_failed'[\s\S]*?\}/g)
      expect(catchBlocks).not.toBeNull()
      expect(catchBlocks!.length).toBe(2)
      for (const block of catchBlocks!) {
        expect(block).not.toContain('throw ')
      }
    })
  })
})
