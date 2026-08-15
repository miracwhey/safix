/**
 * SupabaseThreadArtifactRepository Tests
 *
 * Validates the canonical Supabase read/write path for thread_artifacts (RUN 2).
 *
 * Coverage:
 *   A. Hydration on reload
 *      1. Loads project artifact rows from Supabase on initialize()
 *      2. Loads offer artifact rows from Supabase on initialize()
 *      3. Loads payment_phase artifact rows from Supabase on initialize()
 *      4. Empty store on no session
 *      5. Empty store on Supabase error (resilient, not throwing)
 *
 *   B. Upsert (write path)
 *      6. Optimistic cache update happens synchronously
 *      7. Supabase upsert is fired (background)
 *      8. Supabase failure records persistence error + keeps cache updated
 *
 *   C. Auth lifecycle
 *      9. SIGNED_IN event triggers reload for new user
 *     10. SIGNED_OUT event clears the cache
 *     11. TOKEN_REFRESHED event triggers reload
 *
 *   D. Participant scoping
 *     12. Only loads artifacts for conversations where user is participant
 *     13. After SIGNED_OUT, no artifacts are visible
 *
 *   E. Reload survival scenarios
 *     14. Project artifact survives reload (both participants)
 *     15. Offer artifact survives reload (both participants)
 *     16. Declined offer artifact survives reload
 *     17. Accepted/payment_due artifact survives reload
 *     18. Both project + offer artifacts coexist after reload
 *
 *   F. Regression
 *     19. No regression to auth/bootstrap foundation
 *     20. Repository interface satisfied (all methods return correct types)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SupabaseThreadArtifactRepository } from '../../src/lib/messages/repository/SupabaseThreadArtifactRepository'
import { supabase } from '../../src/lib/supabase'
import { recordPersistenceFailure } from '../../src/lib/persistence'

// ── Mocks ────────────────────────────────────────────────────────────────

interface MockSession {
  user: { id: string }
}

interface MockUpsertBuilder {
  upsert?: ReturnType<typeof vi.fn>
  insert?: ReturnType<typeof vi.fn>
  update?: ReturnType<typeof vi.fn>
  select?: ReturnType<typeof vi.fn>
  or?: ReturnType<typeof vi.fn>
  order?: ReturnType<typeof vi.fn>
  limit?: ReturnType<typeof vi.fn>
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
    },
    from: vi.fn(),
  },
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
}))

// ── Helpers ──────────────────────────────────────────────────────────────

const CUSTOMER_UID = 'customer-supabase-001'
const CRAFTSMAN_UID = 'craftsman-supabase-001'
const PROJECT_UUID_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const OFFER_ID_A = 'offer-supabase-001'
const FUNDING_REQUEST_ID_A = 'fr-supabase-001'
const ESCROW_PLAN_ID_A = 'ep-supabase-001'
const JOB_ID_A = 'job-supabase-001'
const CONV_ID_A = 'conv-supabase-001'
const CONV_ID_B = 'conv-supabase-002'

function makeArtifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `ta_project_${CONV_ID_A}`,
    conversation_id: CONV_ID_A,
    artifact_type: 'project',
    project_id: PROJECT_UUID_A,
    offer_id: null,
    job_id: null,
    phase: null,
    customer_user_id: CUSTOMER_UID,
    craftsman_user_id: CRAFTSMAN_UID,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  }
}

function makeOfferArtifactRow(overrides: Record<string, unknown> = {}) {
  return makeArtifactRow({
    id: `ta_offer_${CONV_ID_A}`,
    artifact_type: 'offer',
    project_id: null,
    offer_id: OFFER_ID_A,
    phase: 'sent',
    ...overrides,
  })
}

function makeFundingStepArtifactRow(overrides: Record<string, unknown> = {}) {
  return makeArtifactRow({
    id: `ta_funding_${CONV_ID_A}`,
    artifact_type: 'funding_step',
    project_id: null,
    offer_id: null,
    job_id: JOB_ID_A,
    funding_request_id: FUNDING_REQUEST_ID_A,
    escrow_plan_id: ESCROW_PLAN_ID_A,
    phase: 'sent',
    snapshot_price: '5.000,00 €',
    snapshot_phase_label: 'Zahlung angefordert',
    ...overrides,
  })
}

function mockSession(uid: string): void {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: { user: { id: uid } } as MockSession },
    error: null,
  } as never)
}

function mockNoSession(): void {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: null },
    error: null,
  } as never)
}

function mockAuthListener(): void {
  vi.mocked(supabase.auth.onAuthStateChange).mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  } as never)
}

function mockFromLoad(rows: Record<string, unknown>[]): void {
  vi.mocked(supabase.from).mockReturnValue({
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
  } as MockUpsertBuilder as never)
}

function mockFromError(): void {
  vi.mocked(supabase.from).mockReturnValue({
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
  } as MockUpsertBuilder as never)
}

function _mockFromWithUpsert(
  loadRows: Record<string, unknown>[],
  upsertResult: { error: null | { message: string } } = { error: null }
): MockUpsertBuilder {
  const upsertFn = vi.fn().mockResolvedValue(upsertResult)
  vi.mocked(supabase.from).mockReturnValue({
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: loadRows, error: null }),
    upsert: upsertFn,
  } as MockUpsertBuilder as never)
  return { upsert: upsertFn }
}

/** Mock for the new CAS write path: INSERT for new records, UPDATE+CAS for existing. */
function mockFromWithInsert(
  loadRows: Record<string, unknown>[],
  insertResult: { error: null | { message: string } } = { error: null }
): { insert: ReturnType<typeof vi.fn> } {
  const insertFn = vi.fn().mockResolvedValue(insertResult)
  vi.mocked(supabase.from).mockReturnValue({
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: loadRows, error: null }),
    insert: insertFn,
  } as MockUpsertBuilder as never)
  return { insert: insertFn }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('SupabaseThreadArtifactRepository', () => {
  let repo: SupabaseThreadArtifactRepository

  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthListener()
    repo = new SupabaseThreadArtifactRepository()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // A. HYDRATION ON RELOAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('A. Hydration on reload', () => {
    it('1. loads project artifact rows from Supabase on initialize()', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([makeArtifactRow()])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'project')
      expect(record).toBeDefined()
      expect(record!.projectId).toBe(PROJECT_UUID_A)
      expect(record!.conversationId).toBe(CONV_ID_A)
      expect(record!.artifactType).toBe('project')
    })

    it('2. loads offer artifact rows from Supabase on initialize()', async () => {
      mockSession(CRAFTSMAN_UID)
      mockFromLoad([makeOfferArtifactRow()])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'offer')
      expect(record).toBeDefined()
      expect(record!.offerId).toBe(OFFER_ID_A)
      expect(record!.phase).toBe('sent')
    })

    it('3. loads payment_phase artifact rows from Supabase on initialize()', async () => {
      mockSession(CUSTOMER_UID)
      const paymentRow = makeArtifactRow({
        id: `ta_payment_${CONV_ID_A}`,
        artifact_type: 'payment_phase',
        project_id: null,
        job_id: 'job-pay-001',
        phase: 'payment_due',
      })
      mockFromLoad([paymentRow])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'payment_phase')
      expect(record).toBeDefined()
      expect(record!.artifactType).toBe('payment_phase')
      expect(record!.jobId).toBe('job-pay-001')
      expect(record!.phase).toBe('payment_due')
    })

    it('4. returns empty store when no session', async () => {
      mockNoSession()
      mockAuthListener()

      await repo.initialize()

      expect(repo.getAll()).toHaveLength(0)
    })

    it('5. returns empty store on Supabase error (resilient, does not throw)', async () => {
      mockSession(CUSTOMER_UID)
      mockFromError()

      await expect(repo.initialize()).resolves.not.toThrow()
      expect(repo.getAll()).toHaveLength(0)
    })

    it('loads multiple artifacts for the same conversation', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([makeArtifactRow(), makeOfferArtifactRow()])

      await repo.initialize()

      expect(repo.getByConversationId(CONV_ID_A)).toHaveLength(2)
      expect(repo.getByConversationAndType(CONV_ID_A, 'project')).toBeDefined()
      expect(repo.getByConversationAndType(CONV_ID_A, 'offer')).toBeDefined()
    })

    it('loads artifacts for multiple conversations', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([
        makeArtifactRow({ conversation_id: CONV_ID_A }),
        makeArtifactRow({ id: `ta_project_${CONV_ID_B}`, conversation_id: CONV_ID_B }),
      ])

      await repo.initialize()

      expect(repo.getByConversationId(CONV_ID_A)).toHaveLength(1)
      expect(repo.getByConversationId(CONV_ID_B)).toHaveLength(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // B. UPSERT (WRITE PATH)
  // ═══════════════════════════════════════════════════════════════════════

  describe('B. Upsert (write path)', () => {
    it('6. upsert optimistically updates cache and awaits confirmed Supabase persistence', async () => {
      vi.mocked(supabase.from).mockReturnValue({
        insert: vi.fn().mockResolvedValue({ error: null }),
      } as MockUpsertBuilder as never)

      const record = {
        id: 'ta_project_test-001',
        conversationId: 'test-001',
        artifactType: 'project' as const,
        projectId: PROJECT_UUID_A,
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        createdAt: 1000,
        updatedAt: 1000,
      }

      // Before upsert: not in cache
      expect(repo.getByConversationAndType('test-001', 'project')).toBeUndefined()

      // Await the confirmed upsert
      await repo.upsert(record)

      // After confirmed write: in cache
      const fetched = repo.getByConversationAndType('test-001', 'project')
      expect(fetched).toBeDefined()
      expect(fetched!.projectId).toBe(PROJECT_UUID_A)
    })

    it('7. upsert awaits Supabase write (confirmed persistence, not fire-and-forget)', async () => {
      const { insert: insertFn } = mockFromWithInsert([], { error: null })

      const record = {
        id: 'ta_project_test-002',
        conversationId: 'test-002',
        artifactType: 'project' as const,
        projectId: PROJECT_UUID_A,
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        createdAt: 1000,
        updatedAt: 2000,
      }

      // await confirms the write is complete before the Promise resolves
      await repo.upsert(record)

      expect(insertFn).toHaveBeenCalledOnce()
      const rowArg = insertFn.mock.calls[0][0] as Record<string, unknown>
      expect(rowArg.id).toBe('ta_project_test-002')
      expect(rowArg.conversation_id).toBe('test-002')
      expect(rowArg.artifact_type).toBe('project')
      expect(rowArg.project_id).toBe(PROJECT_UUID_A)
    })

    it('8. Supabase failure rolls back cache and throws (hard failure over false success)', async () => {
      const { insert: insertFn } = mockFromWithInsert([], {
        error: { message: 'DB constraint violation' },
      })

      const record = {
        id: 'ta_project_fail-001',
        conversationId: 'fail-001',
        artifactType: 'project' as const,
        projectId: PROJECT_UUID_A,
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        createdAt: 1000,
        updatedAt: 1000,
      }

      // upsert must throw when Supabase write fails
      await expect(repo.upsert(record)).rejects.toBeTruthy()

      // Supabase write was attempted
      expect(insertFn).toHaveBeenCalledOnce()
      // Persistence failure was recorded
      expect(recordPersistenceFailure).toHaveBeenCalledOnce()
      expect(vi.mocked(recordPersistenceFailure).mock.calls[0][0].domain).toBe('thread_artifacts')

      // Cache was rolled back — record must NOT be present after failure
      const fetched = repo.getByConversationAndType('fail-001', 'project')
      expect(fetched).toBeUndefined()
    })

    it('upsert updates existing record in cache (not duplicate)', async () => {
      // First call → INSERT (new record); second call → UPDATE with CAS
      vi.mocked(supabase.from).mockReturnValue({
        insert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({ data: [{ id: 'ta_project_upd-001' }], error: null }),
            }),
          }),
        }),
      } as MockUpsertBuilder as never)

      const record1 = {
        id: 'ta_project_upd-001',
        conversationId: 'upd-001',
        artifactType: 'project' as const,
        projectId: PROJECT_UUID_A,
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        createdAt: 1000,
        updatedAt: 1000,
      }
      const record2 = {
        ...record1,
        projectId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        updatedAt: 2000,
      }

      await repo.upsert(record1)
      await repo.upsert(record2)

      const all = repo.getByConversationId('upd-001')
      expect(all).toHaveLength(1) // no duplicate
      expect(all[0].projectId).toBe('b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e')
      expect(all[0].updatedAt).toBe(2000)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // C. AUTH LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════

  describe('C. Auth lifecycle', () => {
    it('9. SIGNED_IN event triggers reload for new user', async () => {
      mockNoSession()
      let authCallback: ((event: string, session: unknown) => void) | null = null
      vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((cb) => {
        authCallback = cb
        return { data: { subscription: { unsubscribe: vi.fn() } } } as never
      })

      await repo.initialize()
      expect(repo.getAll()).toHaveLength(0)

      // Simulate SIGNED_IN event
      mockFromLoad([makeArtifactRow()])
      authCallback!('SIGNED_IN', { user: { id: CUSTOMER_UID } })

      // Wait for async load
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(repo.getAll()).toHaveLength(1)
    })

    it('10. SIGNED_OUT event clears the cache', async () => {
      mockSession(CUSTOMER_UID)
      let authCallback: ((event: string, session: unknown) => void) | null = null
      vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((cb) => {
        authCallback = cb
        return { data: { subscription: { unsubscribe: vi.fn() } } } as never
      })
      mockFromLoad([makeArtifactRow()])
      await repo.initialize()
      expect(repo.getAll()).toHaveLength(1)

      // Simulate SIGNED_OUT
      authCallback!('SIGNED_OUT', null)

      expect(repo.getAll()).toHaveLength(0)
    })

    it('11. TOKEN_REFRESHED event triggers reload', async () => {
      mockNoSession()
      let authCallback: ((event: string, session: unknown) => void) | null = null
      vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((cb) => {
        authCallback = cb
        return { data: { subscription: { unsubscribe: vi.fn() } } } as never
      })

      await repo.initialize()
      expect(repo.getAll()).toHaveLength(0)

      mockFromLoad([makeArtifactRow()])
      authCallback!('TOKEN_REFRESHED', { user: { id: CUSTOMER_UID } })

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(repo.getAll()).toHaveLength(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // D. PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('D. Participant scoping', () => {
    it('12. only loads artifacts for conversations where user is participant (RLS enforced at DB level)', async () => {
      // The actual scoping is enforced by Supabase RLS in production.
      // Here we verify the repository only loads what the DB returns.
      mockSession(CUSTOMER_UID)
      // Supabase returns only the customer's own artifacts (RLS filters the rest)
      mockFromLoad([makeArtifactRow()])

      await repo.initialize()

      expect(repo.getAll()).toHaveLength(1)
      expect(repo.getAll()[0].customerUserId).toBe(CUSTOMER_UID)
    })

    it('13. after SIGNED_OUT, no artifacts visible (cache cleared)', async () => {
      mockSession(CUSTOMER_UID)
      let authCallback: ((event: string, session: unknown) => void) | null = null
      vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((cb) => {
        authCallback = cb
        return { data: { subscription: { unsubscribe: vi.fn() } } } as never
      })
      mockFromLoad([makeArtifactRow(), makeOfferArtifactRow()])
      await repo.initialize()
      expect(repo.getAll()).toHaveLength(2)

      authCallback!('SIGNED_OUT', null)

      // All artifacts cleared — no cross-account leakage
      expect(repo.getAll()).toHaveLength(0)
      expect(repo.getByConversationAndType(CONV_ID_A, 'project')).toBeUndefined()
      expect(repo.getByConversationAndType(CONV_ID_A, 'offer')).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // E. RELOAD SURVIVAL SCENARIOS
  // ═══════════════════════════════════════════════════════════════════════

  describe('E. Reload survival scenarios', () => {
    it('14. project artifact survives reload for customer', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([
        makeArtifactRow({
          id: `ta_project_${CONV_ID_A}`,
          conversation_id: CONV_ID_A,
          artifact_type: 'project',
          project_id: PROJECT_UUID_A,
          customer_user_id: CUSTOMER_UID,
          craftsman_user_id: CRAFTSMAN_UID,
        }),
      ])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'project')
      expect(record).toBeDefined()
      expect(record!.projectId).toBe(PROJECT_UUID_A)
      expect(record!.customerUserId).toBe(CUSTOMER_UID)
    })

    it('14b. project artifact survives reload for craftsman', async () => {
      mockSession(CRAFTSMAN_UID)
      mockFromLoad([
        makeArtifactRow({
          customer_user_id: CUSTOMER_UID,
          craftsman_user_id: CRAFTSMAN_UID,
        }),
      ])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'project')
      expect(record).toBeDefined()
      expect(record!.projectId).toBe(PROJECT_UUID_A)
      expect(record!.craftsmanUserId).toBe(CRAFTSMAN_UID)
    })

    it('15. offer artifact survives reload for customer', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([makeOfferArtifactRow()])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'offer')
      expect(record).toBeDefined()
      expect(record!.offerId).toBe(OFFER_ID_A)
      expect(record!.phase).toBe('sent')
    })

    it('15b. offer artifact survives reload for craftsman', async () => {
      mockSession(CRAFTSMAN_UID)
      mockFromLoad([makeOfferArtifactRow()])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'offer')
      expect(record).toBeDefined()
      expect(record!.offerId).toBe(OFFER_ID_A)
    })

    it('16. declined offer artifact survives reload with declined phase', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([makeOfferArtifactRow({ phase: 'declined' })])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'offer')
      expect(record).toBeDefined()
      expect(record!.phase).toBe('declined')
    })

    it('17. accepted/payment_due artifact survives reload', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([
        makeOfferArtifactRow({
          phase: 'payment_due',
          job_id: 'job-accepted-001',
        }),
      ])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'offer')
      expect(record).toBeDefined()
      expect(record!.phase).toBe('payment_due')
      expect(record!.jobId).toBe('job-accepted-001')
    })

    it('18. both project + offer artifacts coexist after reload', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([
        makeArtifactRow(),
        makeOfferArtifactRow({ phase: 'payment_due', job_id: 'job-coexist-001' }),
      ])

      await repo.initialize()

      const projectRecord = repo.getByConversationAndType(CONV_ID_A, 'project')
      const offerRecord = repo.getByConversationAndType(CONV_ID_A, 'offer')

      // Both are present and independent
      expect(projectRecord).toBeDefined()
      expect(offerRecord).toBeDefined()
      expect(projectRecord!.artifactType).toBe('project')
      expect(offerRecord!.artifactType).toBe('offer')
      expect(projectRecord!.projectId).toBe(PROJECT_UUID_A)
      expect(offerRecord!.phase).toBe('payment_due')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // F. REGRESSION
  // ═══════════════════════════════════════════════════════════════════════

  describe('F. Regression', () => {
    it('19. no regression to auth/bootstrap foundation — initialize() resolves without throwing', async () => {
      mockNoSession()
      await expect(repo.initialize()).resolves.not.toThrow()
    })

    it('20. repository interface satisfied — all methods return correct types', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([makeArtifactRow(), makeOfferArtifactRow()])

      await repo.initialize()

      // getAll() → array
      expect(Array.isArray(repo.getAll())).toBe(true)
      expect(repo.getAll()).toHaveLength(2)

      // getByConversationId() → filtered array
      const byConv = repo.getByConversationId(CONV_ID_A)
      expect(Array.isArray(byConv)).toBe(true)
      expect(byConv).toHaveLength(2)

      // getByConversationAndType() → single record or undefined
      const single = repo.getByConversationAndType(CONV_ID_A, 'project')
      expect(single).toBeDefined()
      expect(single!.conversationId).toBe(CONV_ID_A)

      // getByConversationAndType() for non-existent → undefined
      const missing = repo.getByConversationAndType('nonexistent', 'project')
      expect(missing).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // G. COMPACT SNAPSHOT FIELD MAPPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('G. Compact snapshot field mapping', () => {
    it('21. project artifact row with compact snapshot fields survives round-trip through load', async () => {
      const rowWithCompactFields = makeArtifactRow({
        snapshot_title: 'Heizungswartung',
        snapshot_status: 'request',
        snapshot_summary: 'Heizung',
        snapshot_category: 'Heizung',
        snapshot_location: 'Hamburg',
        snapshot_budget: 'unter 500 €',
        snapshot_timing: 'So schnell wie möglich',
      })

      mockSession(CUSTOMER_UID)
      mockFromLoad([rowWithCompactFields])

      await repo.initialize()

      const records = repo.getByConversationId(CONV_ID_A)
      expect(records).toHaveLength(1)

      const record = records[0]
      expect(record.snapshotTitle).toBe('Heizungswartung')
      expect(record.snapshotStatus).toBe('request')
      expect(record.snapshotSummary).toBe('Heizung')
      expect(record.snapshotCategory).toBe('Heizung')
      expect(record.snapshotLocation).toBe('Hamburg')
      expect(record.snapshotBudget).toBe('unter 500 €')
      expect(record.snapshotTiming).toBe('So schnell wie möglich')
    })

    it('22. upsert sends compact snapshot fields to Supabase', async () => {
      mockSession(CUSTOMER_UID)
      const mock = mockFromWithInsert([])

      await repo.initialize()

      await repo.upsert({
        id: 'ta_project_compact-test',
        conversationId: CONV_ID_A,
        artifactType: 'project',
        projectId: PROJECT_UUID_A,
        snapshotTitle: 'Fliesen',
        snapshotStatus: 'request',
        snapshotCategory: 'Fliesen',
        snapshotLocation: 'Berlin',
        snapshotBudget: '3.000 – 5.000 €',
        snapshotTiming: 'Innerhalb 4 Wochen',
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        createdAt: 2000,
        updatedAt: 2000,
      })

      expect(mock.insert).toHaveBeenCalledTimes(1)
      const row = mock.insert!.mock.calls[0][0]
      expect(row.snapshot_category).toBe('Fliesen')
      expect(row.snapshot_location).toBe('Berlin')
      expect(row.snapshot_budget).toBe('3.000 – 5.000 €')
      expect(row.snapshot_timing).toBe('Innerhalb 4 Wochen')
    })

    it('23. insert sends compact snapshot fields to Supabase', async () => {
      mockSession(CUSTOMER_UID)
      const insertFn = vi.fn().mockResolvedValue({ error: null })
      vi.mocked(supabase.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        insert: insertFn,
      } as never)

      await repo.initialize()

      await repo.insert({
        id: 'ta_project_insert-compact',
        conversationId: CONV_ID_A,
        artifactType: 'project',
        projectId: PROJECT_UUID_A,
        snapshotTitle: 'Dachreparatur',
        snapshotStatus: 'request',
        snapshotCategory: 'Dach',
        snapshotLocation: 'Frankfurt',
        snapshotBudget: 'über 10.000 €',
        snapshotTiming: 'Nächsten Monat',
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        createdAt: 3000,
        updatedAt: 3000,
      })

      expect(insertFn).toHaveBeenCalledTimes(1)
      const row = insertFn.mock.calls[0][0]
      expect(row.snapshot_category).toBe('Dach')
      expect(row.snapshot_location).toBe('Frankfurt')
      expect(row.snapshot_budget).toBe('über 10.000 €')
      expect(row.snapshot_timing).toBe('Nächsten Monat')
    })

    it('24. null compact snapshot fields in DB row do not create undefined record properties', async () => {
      const rowWithNulls = makeArtifactRow({
        snapshot_title: 'Minimal',
        snapshot_status: 'request',
        snapshot_category: null,
        snapshot_location: null,
        snapshot_budget: null,
        snapshot_timing: null,
      })

      mockSession(CUSTOMER_UID)
      mockFromLoad([rowWithNulls])

      await repo.initialize()

      const record = repo.getByConversationId(CONV_ID_A)[0]
      expect(record.snapshotTitle).toBe('Minimal')
      // Null fields should not appear as properties (conditional spread pattern)
      expect('snapshotCategory' in record).toBe(false)
      expect('snapshotLocation' in record).toBe(false)
      expect('snapshotBudget' in record).toBe(false)
      expect('snapshotTiming' in record).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // H. FUNDING STEP FIELD MAPPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('H. Funding step field mapping', () => {
    it('25. loads funding_step artifact row with funding_request_id and escrow_plan_id', async () => {
      mockSession(CRAFTSMAN_UID)
      mockFromLoad([makeFundingStepArtifactRow()])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'funding_step')
      expect(record).toBeDefined()
      expect(record!.artifactType).toBe('funding_step')
      expect(record!.fundingRequestId).toBe(FUNDING_REQUEST_ID_A)
      expect(record!.escrowPlanId).toBe(ESCROW_PLAN_ID_A)
      expect(record!.jobId).toBe(JOB_ID_A)
      expect(record!.phase).toBe('sent')
    })

    it('26. funding_step snapshot fields survive round-trip through load', async () => {
      mockSession(CRAFTSMAN_UID)
      mockFromLoad([makeFundingStepArtifactRow()])

      await repo.initialize()

      const record = repo.getByConversationAndType(CONV_ID_A, 'funding_step')
      expect(record!.snapshotPrice).toBe('5.000,00 €')
      expect(record!.snapshotPhaseLabel).toBe('Zahlung angefordert')
    })

    it('27. upsert sends funding_request_id and escrow_plan_id to Supabase', async () => {
      mockSession(CRAFTSMAN_UID)
      const mock = mockFromWithInsert([])

      await repo.initialize()

      await repo.upsert({
        id: 'ta_funding_upsert-test',
        conversationId: CONV_ID_A,
        artifactType: 'funding_step',
        jobId: JOB_ID_A,
        fundingRequestId: FUNDING_REQUEST_ID_A,
        escrowPlanId: ESCROW_PLAN_ID_A,
        phase: 'sent',
        snapshotPrice: '5.000,00 €',
        snapshotPhaseLabel: 'Zahlung angefordert',
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        createdAt: 5000,
        updatedAt: 5000,
      })

      expect(mock.insert).toHaveBeenCalledTimes(1)
      const row = mock.insert.mock.calls[0][0]
      expect(row.artifact_type).toBe('funding_step')
      expect(row.funding_request_id).toBe(FUNDING_REQUEST_ID_A)
      expect(row.escrow_plan_id).toBe(ESCROW_PLAN_ID_A)
      expect(row.job_id).toBe(JOB_ID_A)
      expect(row.phase).toBe('sent')
      expect(row.snapshot_price).toBe('5.000,00 €')
      expect(row.snapshot_phase_label).toBe('Zahlung angefordert')
    })

    it('28. null funding fields in DB row do not create undefined record properties', async () => {
      const rowWithNullFunding = makeArtifactRow({
        id: 'ta_project_nullfunding',
        artifact_type: 'project',
        funding_request_id: null,
        escrow_plan_id: null,
      })

      mockSession(CUSTOMER_UID)
      mockFromLoad([rowWithNullFunding])

      await repo.initialize()

      const record = repo.getByConversationId(CONV_ID_A)[0]
      expect('fundingRequestId' in record).toBe(false)
      expect('escrowPlanId' in record).toBe(false)
    })

    it('29. funding_step artifact coexists with project and offer artifacts', async () => {
      mockSession(CUSTOMER_UID)
      mockFromLoad([
        makeArtifactRow(),
        makeOfferArtifactRow(),
        makeFundingStepArtifactRow(),
      ])

      await repo.initialize()

      expect(repo.getByConversationId(CONV_ID_A)).toHaveLength(3)
      expect(repo.getByConversationAndType(CONV_ID_A, 'project')).toBeDefined()
      expect(repo.getByConversationAndType(CONV_ID_A, 'offer')).toBeDefined()
      expect(repo.getByConversationAndType(CONV_ID_A, 'funding_step')).toBeDefined()

      const funding = repo.getByConversationAndType(CONV_ID_A, 'funding_step')!
      expect(funding.fundingRequestId).toBe(FUNDING_REQUEST_ID_A)
      expect(funding.escrowPlanId).toBe(ESCROW_PLAN_ID_A)
    })

    it('30. absent fundingRequestId and escrowPlanId are stripped from DB payload', async () => {
      mockSession(CUSTOMER_UID)
      const mock = mockFromWithInsert([])

      await repo.initialize()

      await repo.upsert({
        id: 'ta_project_nofunding',
        conversationId: CONV_ID_A,
        artifactType: 'project',
        projectId: PROJECT_UUID_A,
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        createdAt: 6000,
        updatedAt: 6000,
      })

      const row = mock.insert.mock.calls[0][0]
      // Null columns are stripped by stripNullColumns to prevent PostgREST
      // "column not found" errors when the DB schema is behind the code.
      expect(row).not.toHaveProperty('funding_request_id')
      expect(row).not.toHaveProperty('escrow_plan_id')
    })
  })
})
