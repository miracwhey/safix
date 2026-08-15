import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { Job } from '../../src/lib/jobs/types'
import { setJobRepository } from '../../src/lib/jobs/repository'
import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { addJob, getJobById, markProposalSent, markProposalAccepted } from '../../src/lib/jobs/service'

// ---------------------------------------------------------------------------
// jobs schema alignment guard
//
// Ensures the runtime persistence layer (SupabaseJobRepository) and the
// migration SQL stay aligned with the live public.jobs table.
//
// Root cause this guards against:
//   "Could not find the 'activities' column of 'jobs' in the schema cache"
//   "Could not find the 'amount' column of 'jobs' in the schema cache"
//
// As of Block 1 + follow-up, jobToRow writes 25 truth-critical columns to
// the live public.jobs table.  Two fields remain intentionally non-persisted:
//   amount           – canonical price lives in the Offer entity, not the Job
//   activities       – session-only in-memory log, rebuilt each session
//
// Schema verification notes:
//   The projects table uses `source_job_id` (NOT `job_id`) to link to jobs.
//   The disputes table uses `job_id` to link to jobs.
//   Do NOT confuse these — a failed "column job_id does not exist" error
//   on the projects table is expected; projects use source_job_id instead.
// ---------------------------------------------------------------------------

const migrationPath = resolve(
  __dirname,
  '../../supabase/migrations/20240101000000_jobs_projects_schema.sql'
)
const migrationSql = readFileSync(migrationPath, 'utf-8')

// SupabaseJobRepository source — used to verify jobToRow payload at the source level
const repoSourcePath = resolve(
  __dirname,
  '../../src/lib/jobs/repository/SupabaseJobRepository.ts'
)
const repoSource = readFileSync(repoSourcePath, 'utf-8')

// Columns from migration 20240101000000 that remain client-side only.
// Most columns from 20240101000000 are now live and persisted via jobToRow.
// Only this column is still NOT written to the DB:
//   amount           – canonical price lives in the Offer entity
// Note: craftsman_user_id is now persisted (Block 1 closure fix)
const MIGRATION_01_CLIENT_ONLY_COLUMNS = [
  'amount',
]

// Complete set of columns that must NEVER appear in the write payload.
// Client-side-only fields + legacy columns that are not truth-critical.
const FORBIDDEN_WRITE_COLUMNS = [
  ...MIGRATION_01_CLIENT_ONLY_COLUMNS,
  'activities',             // client-side-only, never in any migration
]

// ---------------------------------------------------------------------------
// 1. Migration SQL does NOT define client-side-only columns
// ---------------------------------------------------------------------------

describe('jobs migration — no client-side-only columns', () => {
  it('does not add an activities column to the jobs table', () => {
    // Activities are a client-side in-memory log, not a DB-persisted field.
    expect(migrationSql).not.toMatch(/ADD COLUMN\s+(IF NOT EXISTS\s+)?activities/i)
  })

  it('still defines all required persisted application columns', () => {
    // These columns are persisted to DB and must be defined in the migration.
    // Note: 'amount' is deliberately excluded — it is a client-side-only field.
    const requiredColumns = [
      'project_id',
      'customer',
      'location',
      'date_label',
      'payment_state',
      'documentation_status',
      'assigned_member_ids',
      'notes',
      'photo_count',
      'intake_context',
      'proposal_timing_note',
      'proposal_sent_at',
      'proposal_accepted_at',
      'work_completed_at',
      'payment_released_at',
    ]
    for (const col of requiredColumns) {
      expect(migrationSql).toContain(col)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. jobToRow must NOT include any column absent from the live schema
// ---------------------------------------------------------------------------

describe('jobToRow — live-schema-only write payload', () => {
  it('Job type still carries activities for in-memory use', () => {
    const job: Job = makeTestJob()
    expect(job).toHaveProperty('activities')
    expect(Array.isArray(job.activities)).toBe(true)
  })

  it('Job type still carries amount for in-memory use', () => {
    const job: Job = makeTestJob({ amount: '2.500 €' })
    expect(job).toHaveProperty('amount')
    expect(job.amount).toBe('2.500 €')
  })

  it('activities field is present in the Job model but is client-side only', () => {
    const job = makeTestJob({ activities: [{ id: 'a1', type: 'system', text: 'test', createdAtLabel: 'now' }] })
    expect(job.activities).toHaveLength(1)

    // Verify the migration explicitly does NOT have activities
    expect(migrationSql).not.toMatch(/ADD COLUMN\s+(IF NOT EXISTS\s+)?activities/i)
  })

  it('SupabaseJobRepository jobToRow does not include activities in persisted payload', () => {
    const jobToRowMatch = repoSource.match(/function jobToRow\b[\s\S]*?^\s*\}/m)
    expect(jobToRowMatch).toBeTruthy()
    const jobToRowBody = jobToRowMatch![0]
    expect(jobToRowBody).not.toMatch(/^\s+activities\s*:/m)
  })

  it('SupabaseJobRepository jobToRow does not include amount in persisted payload', () => {
    const jobToRowMatch = repoSource.match(/function jobToRow\b[\s\S]*?^\s*\}/m)
    expect(jobToRowMatch).toBeTruthy()
    const jobToRowBody = jobToRowMatch![0]
    expect(jobToRowBody).not.toMatch(/^\s+amount\s*:/m)
  })

  it('JobWriteRow interface does not include amount field', () => {
    const jobWriteRowMatch = repoSource.match(/interface JobWriteRow\s*\{[\s\S]*?^\s*\}/m)
    expect(jobWriteRowMatch).toBeTruthy()
    const body = jobWriteRowMatch![0]
    expect(body).not.toMatch(/^\s+amount\s*:/m)
  })

  it('SupabaseJobRepository jobToRow includes assigned_member_ids for persistence', () => {
    const jobToRowMatch = repoSource.match(/function jobToRow\b[\s\S]*?^\s*\}/m)
    expect(jobToRowMatch).toBeTruthy()
    const jobToRowBody = jobToRowMatch![0]
    expect(jobToRowBody).toMatch(/^\s+assigned_member_ids\s*:/m)
  })

  // -------------------------------------------------------------------------
  // Comprehensive: no client-side-only column in write payload
  // -------------------------------------------------------------------------

  for (const col of FORBIDDEN_WRITE_COLUMNS) {
    it(`jobToRow does not include forbidden column: ${col}`, () => {
      const jobToRowMatch = repoSource.match(/function jobToRow\b[\s\S]*?^\s*\}/m)
      expect(jobToRowMatch).toBeTruthy()
      const jobToRowBody = jobToRowMatch![0]
      const re = new RegExp(`^\\s+${col}\\s*:`, 'm')
      expect(jobToRowBody).not.toMatch(re)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. Offer acceptance path — neither missing columns block job creation
// ---------------------------------------------------------------------------

describe('offer acceptance — job creation works without missing DB columns', () => {
  beforeEach(() => {
    setJobRepository(new InMemoryJobRepository())
  })

  it('creates a job with activities: [] and persists successfully', async () => {
    const job = makeTestJob({
      proposalSentAt: Date.now() - 10_000,
      proposalAcceptedAt: Date.now(),
    })

    await addJob(job)
    const persisted = getJobById(job.id)

    expect(persisted).toBeDefined()
    expect(persisted!.id).toBe(job.id)
    expect(persisted!.proposalAcceptedAt).toBeDefined()
    // Activities are in-memory — they survive in the local cache
    expect(persisted!.activities).toEqual([])
  })

  it('creates a job with amount set and persists successfully (amount stays in-memory)', async () => {
    const job = makeTestJob({
      amount: '3.000 €',
      proposalSentAt: Date.now() - 10_000,
      proposalAcceptedAt: Date.now(),
    })

    await addJob(job)
    const persisted = getJobById(job.id)

    expect(persisted).toBeDefined()
    expect(persisted!.id).toBe(job.id)
    // amount survives in the in-memory cache
    expect(persisted!.amount).toBe('3.000 €')
  })

  it('creates a job with assignedMemberIds and persists (stays in-memory only)', async () => {
    const job = makeTestJob({
      assignedMemberIds: ['member-1', 'member-2'],
      proposalSentAt: Date.now() - 10_000,
      proposalAcceptedAt: Date.now(),
    })

    await addJob(job)
    const persisted = getJobById(job.id)

    expect(persisted).toBeDefined()
    // assignedMemberIds survives in the in-memory cache
    expect(persisted!.assignedMemberIds).toEqual(['member-1', 'member-2'])
  })

  it('markProposalSent appends an activity in-memory without DB column', async () => {
    const job = makeTestJob()
    const repo = new InMemoryJobRepository()
    setJobRepository(repo)
    await repo.add(job)

    await markProposalSent(job.id, Date.now())

    const updated = getJobById(job.id)
    expect(updated).toBeDefined()
    expect(updated!.proposalSentAt).toBeDefined()
    // Activity was appended in-memory
    expect(updated!.activities.length).toBeGreaterThan(0)
    expect(updated!.activities[0].text).toContain('Angebot')
  })

  it('markProposalAccepted appends an activity in-memory without DB column', async () => {
    const job = makeTestJob({ proposalSentAt: Date.now() - 5000 })
    const repo = new InMemoryJobRepository()
    setJobRepository(repo)
    await repo.add(job)

    await markProposalAccepted(job.id)

    const updated = getJobById(job.id)
    expect(updated).toBeDefined()
    expect(updated!.proposalAcceptedAt).toBeDefined()
    expect(updated!.activities.length).toBeGreaterThan(0)
    expect(updated!.activities[0].text).toContain('angenommen')
  })

  it('accepted state persists after reload (re-fetching from repository)', async () => {
    const job = makeTestJob({ proposalSentAt: Date.now() - 5000 })
    const repo = new InMemoryJobRepository()
    setJobRepository(repo)
    await repo.add(job)

    await markProposalAccepted(job.id)

    // Simulate reload: re-read from the same repository
    const reloaded = getJobById(job.id)
    expect(reloaded).toBeDefined()
    expect(reloaded!.proposalAcceptedAt).toBeDefined()
    expect(reloaded!.status).toBe('new')
  })
})

// ---------------------------------------------------------------------------
// 4. Complete accept-flow column coverage — ONLY live columns in payload
// ---------------------------------------------------------------------------

describe('accept-flow column coverage — only live-confirmed columns in payload', () => {
  it('jobToRow only emits live-confirmed columns', () => {
    // Extract the column names from jobToRow
    const jobToRowMatch = repoSource.match(/function jobToRow\b[\s\S]*?^\s*\}/m)
    expect(jobToRowMatch).toBeTruthy()
    const jobToRowBody = jobToRowMatch![0]

    // Extract all "key:" assignments (column names written to DB)
    const columnMatches = jobToRowBody.match(/^\s+(\w+)\s*:/gm) ?? []
    const columns = columnMatches.map(m => m.trim().replace(/:$/, ''))

    // These are the columns persisted to the live table:
    //   Seed: id, title, description, status, provider_id
    //   Migration 20240101000000: project_id, customer, location, date_label,
    //     payment_state, documentation_status, assigned_member_ids, notes,
    //     photo_count, intake_context, proposal_timing_note, proposal_sent_at,
    //     proposal_accepted_at, payment_released_at
    //   Migration 20240200000000: dispute_status
    //   Migration 20240900000000: customer_user_id
    //   Migration 20260317000012: source_conversation_id
    //   Migration 20260325000003: source_offer_id
    //   Migration 20260325000006: work_completed_at
    //   Migration 20260409000004: commercial_origin
    //   Migration 20260410000002: attribution_status
    //   Migration 20260412000005: job_kind (Paket 2)
    //   Migration 20260501000001: work_marked_complete_at,
    //                              work_confirmed_complete_at (Block 7.2.1b)
    const liveConfirmedColumns = [
      'id', 'title', 'description', 'status', 'provider_id', 'customer_user_id',
      'craftsman_user_id', 'source_offer_id', 'work_completed_at',
      'work_marked_complete_at', 'work_confirmed_complete_at',
      'project_id', 'customer', 'location', 'date_label',
      'payment_state', 'documentation_status', 'assigned_member_ids', 'notes',
      'photo_count', 'intake_context', 'proposal_timing_note',
      'proposal_sent_at', 'proposal_accepted_at', 'payment_released_at',
      'dispute_status', 'source_conversation_id',
      'commercial_origin',
      'attribution_status',
      'job_kind',
    ]

    // Every column in jobToRow must be in the live-confirmed set
    for (const col of columns) {
      expect(liveConfirmedColumns).toContain(col)
    }

    // And the live-confirmed columns must all be present
    for (const col of liveConfirmedColumns) {
      expect(columns).toContain(col)
    }
  })

  it('no client-side-only column is sent to Supabase', () => {
    const jobToRowMatch = repoSource.match(/function jobToRow\b[\s\S]*?^\s*\}/m)
    expect(jobToRowMatch).toBeTruthy()
    const jobToRowBody = jobToRowMatch![0]

    const columnMatches = jobToRowBody.match(/^\s+(\w+)\s*:/gm) ?? []
    const columns = columnMatches.map(m => m.trim().replace(/:$/, ''))

    // None of these forbidden columns may appear in the write payload
    for (const col of FORBIDDEN_WRITE_COLUMNS) {
      expect(columns).not.toContain(col)
    }
  })

  it('jobToRow return type is JobWriteRow, not the full JobRow', () => {
    // Guard: jobToRow must declare JobWriteRow as its return type,
    // which is the minimal live-only write payload.
    expect(repoSource).toMatch(/function jobToRow\(.*\):\s*JobWriteRow\b/)
  })

  it('acceptOfferWorkflow uses offer.price not job.amount for payment setup', () => {
    // Guard: the accept flow must use offer.price (the canonical source)
    // and not job.amount (client-side only) for payment calculations.
    const workflowPath = resolve(__dirname, '../../src/lib/workflow/offerWorkflow.ts')
    const workflowSource = readFileSync(workflowPath, 'utf-8')

    // The accept workflow should reference offer.price for parseJobAmount
    expect(workflowSource).toContain('parseJobAmount(offer.price)')
    // It should NOT reference job.amount or existingJob.amount for parseJobAmount
    expect(workflowSource).not.toMatch(/parseJobAmount\(\s*(?:existing)?[Jj]ob\.amount\s*\)/)
  })
})

// ---------------------------------------------------------------------------
// 5. In-memory domain model retains all fields
// ---------------------------------------------------------------------------

describe('in-memory domain model — all fields retained', () => {
  it('Job type still carries all in-memory fields', () => {
    const job = makeTestJob({
      projectId: 'proj-1',
      customer: 'Max Mustermann',
      location: 'Berlin',
      dateLabel: 'Morgen',
      amount: '5.000 €',
      paymentState: 'deposit_required',
      documentationStatus: 'Noch keine',
      assignedMemberIds: ['m1'],
      notes: ['n1'],
      photoCount: 3,
      activities: [{ id: 'a1', type: 'system', text: 'test', createdAtLabel: 'now' }],
      intakeContext: { origin: 'direct', originLabel: 'Direkt' },
      proposalTimingNote: 'Nächste Woche',
      proposalSentAt: 1000,
      proposalAcceptedAt: 2000,
      workCompletedAt: 3000,
      paymentReleasedAt: 4000,
      sourceConversationId: 'conv-1',
      craftsmanUserId: 'craft-1',
      customerUserId: 'cust-1',
    })

    // All fields present on the domain object
    expect(job.projectId).toBe('proj-1')
    expect(job.customer).toBe('Max Mustermann')
    expect(job.location).toBe('Berlin')
    expect(job.dateLabel).toBe('Morgen')
    expect(job.amount).toBe('5.000 €')
    expect(job.paymentState).toBe('deposit_required')
    expect(job.documentationStatus).toBe('Noch keine')
    expect(job.assignedMemberIds).toEqual(['m1'])
    expect(job.notes).toEqual(['n1'])
    expect(job.photoCount).toBe(3)
    expect(job.activities).toHaveLength(1)
    expect(job.intakeContext?.origin).toBe('direct')
    expect(job.proposalTimingNote).toBe('Nächste Woche')
    expect(job.proposalSentAt).toBe(1000)
    expect(job.proposalAcceptedAt).toBe(2000)
    expect(job.workCompletedAt).toBe(3000)
    expect(job.paymentReleasedAt).toBe(4000)
    expect(job.sourceConversationId).toBe('conv-1')
    expect(job.craftsmanUserId).toBe('craft-1')
    expect(job.customerUserId).toBe('cust-1')
  })
})

// ---------------------------------------------------------------------------
// 6. Job UUID guardrail — accept-offer flow must use UUID-compatible IDs
// ---------------------------------------------------------------------------

describe('job UUID guardrail — accept-offer creates UUID-compatible IDs', () => {
  it('acceptOfferWorkflow uses generateUUID() for job ID, not string templates', () => {
    const workflowPath = resolve(__dirname, '../../src/lib/workflow/offerWorkflow.ts')
    const workflowSource = readFileSync(workflowPath, 'utf-8')

    // Must use the central generateUUID() helper for the job ID
    expect(workflowSource).toContain("import { generateUUID } from '../shared/generateUUID'")
    expect(workflowSource).toMatch(/const jobId\s*=\s*generateUUID\(\)/)

    // Must NOT use the old string-template job-… pattern
    expect(workflowSource).not.toMatch(/`job-\$\{/)
  })

  it('acceptOfferWorkflow uses generateProjectId() for fallback project ID', () => {
    const workflowPath = resolve(__dirname, '../../src/lib/workflow/offerWorkflow.ts')
    const workflowSource = readFileSync(workflowPath, 'utf-8')

    // Fallback project ID must come from generateProjectId(), not a string template
    expect(workflowSource).not.toMatch(/`project-\$\{jobId\}`/)
    expect(workflowSource).toMatch(/generateProjectId\(\)/)
  })

  it('job created via accept-offer gets a UUID-compatible id (runtime)', async () => {
    const { isValidUUID } = await import('../../src/lib/shared/generateUUID')
    const { setOfferRepository } = await import('../../src/lib/offers/repository')
    const { InMemoryOfferRepository } = await import('../../src/lib/offers/repository/InMemoryOfferRepository')
    const { createOfferWorkflow, acceptOfferWorkflow } = await import('../../src/lib/workflow/offerWorkflow')
    const { getJobRepository } = await import('../../src/lib/jobs/repository')
    const { setMessageRepository } = await import('../../src/lib/messages/repository')
    const { InMemoryMessageRepository } = await import('../../src/lib/messages/repository/InMemoryMessageRepository')

    setOfferRepository(new InMemoryOfferRepository())
    setMessageRepository(new InMemoryMessageRepository())
    setJobRepository(new InMemoryJobRepository())

    const offer = await createOfferWorkflow({
      conversationId: 'conv-uuid-guard',
      customerUserId: 'cust-uuid',
      craftsmanUserId: 'craft-uuid',
      price: '2.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted).toBeDefined()
    expect(accepted!.createdJobId).toBeDefined()

    // The job ID must be a valid UUID
    expect(isValidUUID(accepted!.createdJobId!)).toBe(true)

    // The job must exist in the repository
    const job = getJobRepository().getById(accepted!.createdJobId!)
    expect(job).toBeDefined()
    expect(isValidUUID(job!.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. provider_id alignment — jobs.provider_id must use providers.id, not auth UID
// ---------------------------------------------------------------------------

describe('provider_id alignment — jobs.provider_id uses providers.id', () => {
  it('jobToRow uses job.providerId for provider_id, not craftsmanUserId', () => {
    const jobToRowMatch = repoSource.match(/function jobToRow\b[\s\S]*?^\s*\}/m)
    expect(jobToRowMatch).toBeTruthy()
    const jobToRowBody = jobToRowMatch![0]

    // provider_id must reference providerId (the canonical providers.id)
    expect(jobToRowBody).toMatch(/provider_id:\s*job\.providerId/)
    // Must NOT reference craftsmanUserId for provider_id
    expect(jobToRowBody).not.toMatch(/provider_id:\s*job\.craftsmanUserId/)
  })

  it('rowToJob maps provider_id to providerId field', () => {
    const rowToJobMatch = repoSource.match(/function rowToJob\b[\s\S]*?^\}/m)
    expect(rowToJobMatch).toBeTruthy()
    const rowToJobBody = rowToJobMatch![0]

    // Must populate providerId from row.provider_id
    expect(rowToJobBody).toMatch(/providerId:\s*row\.provider_id/)
  })

  it('acceptOfferWorkflow resolves providerId before creating job', () => {
    const workflowPath = resolve(__dirname, '../../src/lib/workflow/offerWorkflow.ts')
    const workflowSource = readFileSync(workflowPath, 'utf-8')

    // Must resolve the canonical providers.id through getProviderIdByAuthUid.
    // (This wraps the SECURITY DEFINER resolver spatial_user_provider_org —
    // acceptance runs in the customer session where the owner-only providers RLS
    // hides the craftsman row, so a direct getProviderProfile read returns 0 rows.)
    expect(workflowSource).toContain("getProviderIdByAuthUid")
    // Must call resolveProviderId before job creation
    expect(workflowSource).toContain('resolveProviderId')
    // The new job must include providerId
    expect(workflowSource).toMatch(/providerId[,\s]/)
  })

  it('Job type includes providerId field for providers.id FK', () => {
    const job = makeTestJob({ providerId: 'real-provider-db-id' })
    expect(job.providerId).toBe('real-provider-db-id')
  })

  it('providerId and craftsmanUserId are independent fields', () => {
    const job = makeTestJob({
      providerId: 'provider-db-uuid',
      craftsmanUserId: 'auth-user-uuid',
    })
    expect(job.providerId).toBe('provider-db-uuid')
    expect(job.craftsmanUserId).toBe('auth-user-uuid')
    expect(job.providerId).not.toBe(job.craftsmanUserId)
  })

  it('offer acceptance creates job with providerId set (runtime)', async () => {
    const { setOfferRepository } = await import('../../src/lib/offers/repository')
    const { InMemoryOfferRepository } = await import('../../src/lib/offers/repository/InMemoryOfferRepository')
    const { createOfferWorkflow, acceptOfferWorkflow } = await import('../../src/lib/workflow/offerWorkflow')
    const { getJobRepository } = await import('../../src/lib/jobs/repository')
    const { setMessageRepository } = await import('../../src/lib/messages/repository')
    const { InMemoryMessageRepository } = await import('../../src/lib/messages/repository/InMemoryMessageRepository')

    setOfferRepository(new InMemoryOfferRepository())
    setMessageRepository(new InMemoryMessageRepository())
    setJobRepository(new InMemoryJobRepository())

    const offer = await createOfferWorkflow({
      conversationId: 'conv-provider-align',
      customerUserId: 'cust-pa',
      craftsmanUserId: 'craft-pa',
      price: '1.500 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted).toBeDefined()
    expect(accepted!.createdJobId).toBeDefined()

    const job = getJobRepository().getById(accepted!.createdJobId!)
    expect(job).toBeDefined()
    // craftsmanUserId is the auth user ID (preserved for in-memory use)
    expect(job!.craftsmanUserId).toBe('craft-pa')
    // In test (no Supabase), providerId is resolved best-effort (undefined)
    // but the field exists on the domain model
    expect('providerId' in job!).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-test-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'project-1',
    title: 'Test Auftrag',
    customer: 'Testkundin',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '1.000 €',
    description: 'Testbeschreibung',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}
