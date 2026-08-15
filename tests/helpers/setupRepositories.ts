/**
 * Test helper: wires up clean (empty) InMemory repositories for all
 * payment, ledger, dispute, job, timeline, invoice, message, project,
 * calendar, schedule, and audit domains.
 *
 * Call `setupCleanRepositories()` inside a `beforeEach` block so every
 * test starts with a blank slate, independent of production mock data.
 */

import { InMemoryPaymentRepository } from '../../src/lib/payments/repository/InMemoryPaymentRepository'
import { setPaymentRepository } from '../../src/lib/payments/repository/registry'

import { InMemoryLedgerRepository } from '../../src/lib/payments/ledger/repository/InMemoryLedgerRepository'
import { setLedgerRepository } from '../../src/lib/payments/ledger/repository/registry'

import { InMemoryDisputeRepository } from '../../src/lib/disputes/repository/InMemoryDisputeRepository'
import { setDisputeRepository } from '../../src/lib/disputes/repository/registry'

import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'

import { InMemoryTimelineRepository } from '../../src/lib/timeline/repository/InMemoryTimelineRepository'
import { setTimelineRepository } from '../../src/lib/timeline/repository/registry'

import { InMemoryInvoiceRepository } from '../../src/lib/invoices/repository/InMemoryInvoiceRepository'
import { setInvoiceRepository } from '../../src/lib/invoices/repository/registry'

import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'

import { InMemoryProjectRepository } from '../../src/lib/projects/repository/InMemoryProjectRepository'
import { setProjectRepository } from '../../src/lib/projects/repository/registry'

import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'

import { InMemoryScheduleRepository } from '../../src/lib/operations/repository/InMemoryScheduleRepository'
import { setScheduleRepository } from '../../src/lib/operations/repository/registry'

import { InMemoryAuditRepository } from '../../src/lib/audit/InMemoryAuditRepository'
import { setAuditRepository } from '../../src/lib/audit/registry'

import { InMemoryNotificationRepository } from '../../src/lib/notifications/repository/InMemoryNotificationRepository'
import { setNotificationRepository } from '../../src/lib/notifications/repository/registry'

import { InMemoryRatingRepository } from '../../src/lib/ratings/repository/InMemoryRatingRepository'
import { setRatingRepository } from '../../src/lib/ratings/repository/registry'

import { InMemoryAnalyticsRepository } from '../../src/lib/analytics/repository/InMemoryAnalyticsRepository'
import { setAnalyticsRepository } from '../../src/lib/analytics/repository/registry'

import { InMemoryMediaRepository } from '../../src/lib/media/repository/InMemoryMediaRepository'
import { setMediaRepository } from '../../src/lib/media/repository/registry'

import { InMemoryOfferRepository } from '../../src/lib/offers/repository/InMemoryOfferRepository'
import { setOfferRepository } from '../../src/lib/offers/repository/registry'

import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { setThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'

import { setPaymentProvider } from '../../src/lib/payments/providers/registry'

import { InMemoryEscrowPlanRepository } from '../../src/lib/payments/escrow/InMemoryEscrowPlanRepository'
import { setEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'

import { InMemoryFundingRequestRepository } from '../../src/lib/payments/fundingRequest/InMemoryFundingRequestRepository'
import { setFundingRequestRepository } from '../../src/lib/payments/fundingRequest/fundingRequestRegistry'

import { InMemoryAcceptanceRepository } from '../../src/lib/acceptance/repository/InMemoryAcceptanceRepository'
import { setAcceptanceRepository } from '../../src/lib/acceptance/repository/registry'

import { _resetInMemorySends } from '../../src/lib/customerEntry/requestLimitService'
import { clearCommercialAttributionCache } from '../../src/lib/commercialAttribution/commercialAttributionService'

export function setupCleanRepositories(): void {
  setPaymentRepository(new InMemoryPaymentRepository([]))
  setLedgerRepository(new InMemoryLedgerRepository([]))
  setDisputeRepository(new InMemoryDisputeRepository([]))
  setJobRepository(new InMemoryJobRepository([]))
  setTimelineRepository(new InMemoryTimelineRepository())
  setInvoiceRepository(new InMemoryInvoiceRepository([]))
  setMessageRepository(new InMemoryMessageRepository([], []))
  setProjectRepository(new InMemoryProjectRepository([]))
  setCalendarRepository(new InMemoryCalendarRepository([]))
  setScheduleRepository(new InMemoryScheduleRepository())
  setAuditRepository(new InMemoryAuditRepository())
  setNotificationRepository(new InMemoryNotificationRepository())
  setRatingRepository(new InMemoryRatingRepository())
  setAnalyticsRepository(new InMemoryAnalyticsRepository())
  setMediaRepository(new InMemoryMediaRepository())
  setOfferRepository(new InMemoryOfferRepository())
  setThreadArtifactRepository(new InMemoryThreadArtifactRepository())
  setEscrowPlanRepository(new InMemoryEscrowPlanRepository())
  setFundingRequestRepository(new InMemoryFundingRequestRepository())
  setAcceptanceRepository(new InMemoryAcceptanceRepository())
  // Always use the mock payment provider in tests (no Stripe calls)
  setPaymentProvider('mock')
  // Reset the request-limit in-memory sends so tests start with a clean slate
  _resetInMemorySends()
  // Clear the attribution session cache so commercial origin state does not
  // leak between tests when the same customerUserId:craftsmanUserId pair appears
  // in multiple test cases.
  clearCommercialAttributionCache()
  // Note: the workflow-layer RBAC guards in src/lib/auth/rbacGuards.ts read
  // their identity from src/lib/session. Tests that install a session via
  // tests/helpers/mockSession overwrite that store on every call, and tests
  // that vi.mock the session module entirely never read it — so a forced
  // reset is not needed here. Importing session into this helper would also
  // trigger its top-level supabase.auth.onAuthStateChange, which not all
  // tests mock; keeping setupRepositories session-free avoids that coupling.
}
