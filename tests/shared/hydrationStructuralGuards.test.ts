/**
 * Block 1 — Hydration Gates: Structural Guards
 *
 * These tests guard against reintroducing timeout-based, collection-size-based,
 * or timing-luck-based fake readiness decisions in the critical repositories.
 *
 * They also ensure that screens with user-visible decisions import the
 * hydration check functions they need.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC_ROOT = path.resolve(__dirname, '../../src')

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf-8')
}

describe('Block 1 — Hydration Structural Guards', () => {

  // ── Guard 1: Critical repositories expose isHydrated in interface ─────

  describe('Repository interfaces include isHydrated()', () => {
    const interfaceFiles = [
      'lib/payments/repository/PaymentRepository.ts',
      'lib/jobs/repository/JobRepository.ts',
      'lib/messages/repository/MessageRepository.ts',
      'lib/payments/escrow/escrowRepository.ts',
      'lib/payments/fundingRequest/fundingRequestRepository.ts',
      'lib/offers/repository/OfferRepository.ts',
      'lib/projects/repository/ProjectRepository.ts',
      'lib/disputes/repository/DisputeRepository.ts',
      'lib/invoices/repository/InvoiceRepository.ts',
      'lib/payments/ledger/repository/LedgerRepository.ts',
      'lib/payments/supplementary/SupplementaryPaymentRepository.ts',
      'lib/timeline/repository/TimelineRepository.ts',
      'lib/notifications/repository/NotificationRepository.ts',
    ]

    for (const file of interfaceFiles) {
      it(`${file} declares isHydrated(): boolean`, () => {
        const content = readFile(file)
        expect(content).toContain('isHydrated()')
      })
    }
  })

  // ── Guard 2: InMemory implementations return true for isHydrated ──────

  describe('InMemory implementations return true for isHydrated', () => {
    const inMemoryFiles = [
      'lib/payments/repository/InMemoryPaymentRepository.ts',
      'lib/jobs/repository/InMemoryJobRepository.ts',
      'lib/messages/repository/InMemoryMessageRepository.ts',
      'lib/payments/escrow/InMemoryEscrowPlanRepository.ts',
      'lib/payments/fundingRequest/InMemoryFundingRequestRepository.ts',
      'lib/offers/repository/InMemoryOfferRepository.ts',
      'lib/projects/repository/InMemoryProjectRepository.ts',
    ]

    for (const file of inMemoryFiles) {
      it(`${file} implements isHydrated() returning true`, () => {
        const content = readFile(file)
        expect(content).toContain('isHydrated()')
        expect(content).toContain('return true')
      })
    }
  })

  // ── Guard 3: Supabase implementations set _hydrated flag ──────────────

  describe('Supabase implementations use _hydrated flag', () => {
    const supabaseFiles = [
      'lib/payments/repository/SupabasePaymentRepository.ts',
      'lib/jobs/repository/SupabaseJobRepository.ts',
      'lib/messages/repository/SupabaseMessageRepository.ts',
      'lib/offers/repository/SupabaseOfferRepository.ts',
      'lib/projects/repository/SupabaseProjectRepository.ts',
    ]

    for (const file of supabaseFiles) {
      it(`${file} tracks _hydrated flag`, () => {
        const content = readFile(file)
        expect(content).toContain('_hydrated')
        expect(content).toContain('isHydrated()')
      })

      it(`${file} sets _hydrated = true after initialize`, () => {
        const content = readFile(file)
        expect(content).toContain('this._hydrated = true')
      })
    }
  })

  // ── Guard 4: No setTimeout-based readiness decisions ──────────────────

  describe('No timeout-based readiness decisions in repositories', () => {
    const repoFiles = [
      'lib/payments/repository/PaymentRepository.ts',
      'lib/payments/repository/InMemoryPaymentRepository.ts',
      'lib/payments/repository/SupabasePaymentRepository.ts',
      'lib/jobs/repository/JobRepository.ts',
      'lib/jobs/repository/InMemoryJobRepository.ts',
      'lib/jobs/repository/SupabaseJobRepository.ts',
      'lib/messages/repository/MessageRepository.ts',
      'lib/messages/repository/InMemoryMessageRepository.ts',
      'lib/messages/repository/SupabaseMessageRepository.ts',
      'lib/payments/escrow/escrowRepository.ts',
      'lib/payments/escrow/InMemoryEscrowPlanRepository.ts',
      'lib/payments/fundingRequest/fundingRequestRepository.ts',
      'lib/payments/fundingRequest/InMemoryFundingRequestRepository.ts',
      'lib/projects/repository/ProjectRepository.ts',
      'lib/projects/repository/InMemoryProjectRepository.ts',
      'lib/projects/repository/SupabaseProjectRepository.ts',
    ]

    for (const file of repoFiles) {
      it(`${file} does not use setTimeout for readiness`, () => {
        const content = readFile(file)
        // No setTimeout used for readiness decisions
        expect(content).not.toMatch(/setTimeout.*hydrat/i)
        expect(content).not.toMatch(/setTimeout.*ready/i)
        expect(content).not.toMatch(/setTimeout.*loaded/i)
      })
    }
  })

  // ── Guard 5: Critical screens import hydration checks ─────────────────

  describe('Critical screens use hydration gates', () => {
    it('CustomerProjectDetailScreen imports isProjectRepositoryHydrated', () => {
      const content = readFile('screens/CustomerProjectDetailScreen.tsx')
      expect(content).toContain('isProjectRepositoryHydrated')
    })

    it('CustomerProjectDetailScreen imports isJobRepositoryHydrated', () => {
      const content = readFile('screens/CustomerProjectDetailScreen.tsx')
      expect(content).toContain('isJobRepositoryHydrated')
    })

    it('CustomerProjectDetailScreen has loading state before not-found', () => {
      const content = readFile('screens/CustomerProjectDetailScreen.tsx')
      expect(content).toContain('ScreenSkeleton')
    })

    it('CraftsmanJobDetailScreen imports isJobRepositoryHydrated', () => {
      const content = readFile('screens/CraftsmanJobDetailScreen.tsx')
      expect(content).toContain('isJobRepositoryHydrated')
    })

    it('CraftsmanJobDetailScreen has loading state before not-found', () => {
      const content = readFile('screens/CraftsmanJobDetailScreen.tsx')
      expect(content).toContain('ScreenSkeleton')
    })

    it('CraftsmanRequestDetailScreen imports isProjectRepositoryHydrated', () => {
      const content = readFile('screens/CraftsmanRequestDetailScreen.tsx')
      expect(content).toContain('isProjectRepositoryHydrated')
    })

    it('CraftsmanRequestDetailScreen imports isMessageRepositoryHydrated', () => {
      const content = readFile('screens/CraftsmanRequestDetailScreen.tsx')
      expect(content).toContain('isMessageRepositoryHydrated')
    })

    it('CraftsmanRequestDetailScreen has loading state before not-found', () => {
      const content = readFile('screens/CraftsmanRequestDetailScreen.tsx')
      expect(content).toContain('ScreenSkeleton')
    })

    it('QuoteDetailScreen still uses isOfferRepositoryHydrated (no regression)', () => {
      const content = readFile('screens/QuoteDetailScreen.tsx')
      expect(content).toContain('isOfferRepositoryHydrated')
    })
  })

  // ── Guard 5b: List screens gate on deferred repo hydration ────────────

  describe('List/overview screens gate on deferred repo hydration', () => {
    it('DisputeCenterScreen gates on isDisputeRepositoryHydrated', () => {
      const content = readFile('screens/DisputeCenterScreen.tsx')
      expect(content).toContain('isDisputeRepositoryHydrated')
      expect(content).toContain('ScreenSkeleton')
    })

    it('CraftsmanFinanceScreen gates on areRepositoriesHydrated', () => {
      const content = readFile('screens/CraftsmanFinanceScreen.tsx')
      expect(content).toContain('areRepositoriesHydrated')
      expect(content).toContain('isInvoiceRepositoryHydrated')
      expect(content).toContain('isDisputeRepositoryHydrated')
      expect(content).toContain('isLedgerRepositoryHydrated')
      expect(content).toContain('ScreenSkeleton')
    })

    it('CraftsmanInvoicesScreen gates on isInvoiceRepositoryHydrated', () => {
      const content = readFile('screens/CraftsmanInvoicesScreen.tsx')
      expect(content).toContain('isInvoiceRepositoryHydrated')
      expect(content).toContain('ScreenSkeleton')
    })

    it('OperatorDashboardScreen gates on isDisputeRepositoryHydrated', () => {
      const content = readFile('screens/OperatorDashboardScreen.tsx')
      expect(content).toContain('isDisputeRepositoryHydrated')
      expect(content).toContain('ScreenSkeleton')
    })

    it('OperatorDashboardScreen gates on isTimelineRepositoryHydrated — no false All-Clear during cold-load', () => {
      // payout_error cases are derived from timeline signals; the gate must block
      // rendering until timeline is hydrated, otherwise an empty signal list is
      // incorrectly treated as "no errors".
      const content = readFile('screens/OperatorDashboardScreen.tsx')
      expect(content).toContain('isTimelineRepositoryHydrated')
    })

    it('OperatorDashboardScreen includes subscribeTimeline in useStoreSync — late hydration re-render', () => {
      // When timeline repo finishes loading after initial render, subscribeTimeline
      // must trigger a re-render so payout_error cases are derived from real signals.
      const content = readFile('screens/OperatorDashboardScreen.tsx')
      expect(content).toContain('subscribeTimeline')
    })
  })

  // ── Guard 5c: Scheduling repos have isHydrated() ─────────────────────

  describe('Scheduling repository interfaces include isHydrated()', () => {
    it('CalendarRepository declares isHydrated(): boolean', () => {
      const content = readFile('lib/calendar/repository/CalendarRepository.ts')
      expect(content).toContain('isHydrated()')
    })

    it('ScheduleRepository declares isHydrated(): boolean', () => {
      const content = readFile('lib/operations/repository/ScheduleRepository.ts')
      expect(content).toContain('isHydrated()')
    })

    it('InMemoryCalendarRepository implements isHydrated() returning true', () => {
      const content = readFile('lib/calendar/repository/InMemoryCalendarRepository.ts')
      expect(content).toContain('isHydrated()')
      expect(content).toContain('return true')
    })

    it('InMemoryScheduleRepository implements isHydrated() returning true', () => {
      const content = readFile('lib/operations/repository/InMemoryScheduleRepository.ts')
      expect(content).toContain('isHydrated()')
      expect(content).toContain('return true')
    })

    it('SupabaseCalendarRepository tracks _hydrated flag', () => {
      const content = readFile('lib/calendar/repository/SupabaseCalendarRepository.ts')
      expect(content).toContain('_hydrated')
      expect(content).toContain('isHydrated()')
      expect(content).toContain('this._hydrated = true')
    })

    it('SupabaseScheduleRepository tracks _hydrated flag', () => {
      const content = readFile('lib/operations/repository/SupabaseScheduleRepository.ts')
      expect(content).toContain('_hydrated')
      expect(content).toContain('isHydrated()')
      expect(content).toContain('this._hydrated = true')
    })
  })

  // ── Guard 5d: CraftsmanOperationsScreen gates on schedule hydration ───

  describe('CraftsmanOperationsScreen gates on schedule repository hydration', () => {
    it('imports isScheduleRepositoryHydrated', () => {
      const content = readFile('screens/CraftsmanOperationsScreen.tsx')
      expect(content).toContain('isScheduleRepositoryHydrated')
    })

    it('tracks schedulesHydrated state', () => {
      const content = readFile('screens/CraftsmanOperationsScreen.tsx')
      expect(content).toContain('schedulesHydrated')
    })

    it('passes schedulesHydrated to PlanungTab', () => {
      const content = readFile('screens/CraftsmanOperationsScreen.tsx')
      expect(content).toContain('schedulesHydrated={schedulesHydrated}')
    })
  })

  // ── Guard 5e: Scheduling repos have Realtime subscription ───────────────

  describe('Scheduling repositories have Realtime subscription', () => {
    it('SupabaseCalendarRepository tracks realtimeChannel', () => {
      const content = readFile('lib/calendar/repository/SupabaseCalendarRepository.ts')
      expect(content).toContain('realtimeChannel')
      expect(content).toContain('startRealtimeSubscription')
      expect(content).toContain('fixup-calendar-')
    })

    it('SupabaseScheduleRepository tracks realtimeChannel', () => {
      const content = readFile('lib/operations/repository/SupabaseScheduleRepository.ts')
      expect(content).toContain('realtimeChannel')
      expect(content).toContain('startRealtimeSubscription')
      expect(content).toContain('fixup-schedules-')
    })

    it('SupabaseCalendarRepository has auth lifecycle (ensureAuthListener)', () => {
      const content = readFile('lib/calendar/repository/SupabaseCalendarRepository.ts')
      expect(content).toContain('ensureAuthListener')
      expect(content).toContain('SIGNED_OUT')
    })

    it('SupabaseScheduleRepository has auth lifecycle (ensureAuthListener)', () => {
      const content = readFile('lib/operations/repository/SupabaseScheduleRepository.ts')
      expect(content).toContain('ensureAuthListener')
      expect(content).toContain('SIGNED_OUT')
    })
  })

  // ── Guard 5f: CalendarEntry DB write payload excludes non-existent columns ──

  describe('CalendarEntry DB write payload does not include schema-absent columns', () => {
    it('entryToRow does not write kind — column does not exist in calendar_entries table', () => {
      const content = readFile('lib/calendar/repository/SupabaseCalendarRepository.ts')
      // kind column does not exist in the DB; sending it causes PGRST204 and silent write failure
      expect(content).not.toMatch(/kind:\s*entry\.kind/)
    })
  })

  // ── Guard 6: No collection-size-based fake readiness ──────────────────

  describe('No collection-size-based fake readiness in screens', () => {
    const screenFiles = [
      'screens/CustomerProjectDetailScreen.tsx',
      'screens/CraftsmanJobDetailScreen.tsx',
      'screens/CraftsmanRequestDetailScreen.tsx',
      'screens/QuoteDetailScreen.tsx',
    ]

    for (const file of screenFiles) {
      it(`${file} does not decide readiness from .length`, () => {
        const content = readFile(file)
        // Should not use getAll().length > 0 as a readiness check
        expect(content).not.toMatch(/\.length\s*[><=]+\s*0.*loaded/i)
      })
    }
  })

  // ── Guard 7: Cancel/Close screens subscribe to canonical funding stores ─

  describe('Cancel/Close screens subscribe to canonical funding confirmation stores', () => {
    it('CustomerProjectDetailScreen subscribes to subscribeFundingRequests', () => {
      const content = readFile('screens/CustomerProjectDetailScreen.tsx')
      expect(content).toContain('subscribeFundingRequests')
    })

    it('CustomerProjectDetailScreen subscribes to subscribeEscrowPlans', () => {
      const content = readFile('screens/CustomerProjectDetailScreen.tsx')
      expect(content).toContain('subscribeEscrowPlans')
    })

    it('CraftsmanJobDetailScreen subscribes to subscribeFundingRequests', () => {
      const content = readFile('screens/CraftsmanJobDetailScreen.tsx')
      expect(content).toContain('subscribeFundingRequests')
    })

    it('CraftsmanJobDetailScreen subscribes to subscribeEscrowPlans', () => {
      const content = readFile('screens/CraftsmanJobDetailScreen.tsx')
      expect(content).toContain('subscribeEscrowPlans')
    })

    it('CraftsmanJobDetailScreen subscribes to subscribePayments for canClose reactivity', () => {
      const content = readFile('screens/CraftsmanJobDetailScreen.tsx')
      expect(content).toContain('subscribePayments')
    })

    it('CustomerProjectDetailScreen fundingConfirmed is reactive state, not inline computed', () => {
      const content = readFile('screens/CustomerProjectDetailScreen.tsx')
      // fundingConfirmed must be a useState, not a raw inline call to isFundingConfirmedForJob
      expect(content).toContain('setFundingConfirmed')
      expect(content).not.toMatch(/const fundingConfirmedForCancel\s*=/)
    })
  })
})
