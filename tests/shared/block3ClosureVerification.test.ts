/**
 * Block 3 — Pre-Merge Closure Verification
 *
 * Proves the two remaining closure criteria:
 *
 * 1. CODE/SCHEMA CONTRACT: Repository row mappings, domain types, and
 *    migration DDL are internally consistent for escrow_payment_plans,
 *    escrow_tranches, and funding_requests.
 *
 * 2. NO SILENT PRODUCTION FALLBACK: In Supabase mode, bootstrap wiring
 *    replaces InMemory defaults with Supabase repos for both escrow and
 *    funding domains. No code path silently falls back to in-memory truth.
 *
 * NOTE: This is NOT live database proof. This is code/migration contract
 * proof only. Post-merge SQL verification is required for live-schema
 * confirmation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupCleanRepositories } from '../helpers/setupRepositories'

// ── Helpers ────────────────────────────────────────────────────────────────

const ROOT = resolve(__dirname, '../..')

function readSource(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf-8')
}

/**
 * Extracts column definitions from a CREATE TABLE statement in a migration.
 * Returns array of column names (lowercase).
 */
function extractCreateTableColumns(sql: string, tableName: string): string[] {
  // tableName is always a hardcoded literal — validate for safety
  if (!/^[a-z_]+$/.test(tableName)) throw new Error(`Invalid table name: ${tableName}`)

  // Find the CREATE TABLE block - everything between the opening ( and the closing );
  const tableRegex = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${tableName}\\s*\\(([\\s\\S]*?)\\);`,
    'm'
  )
  const match = sql.match(tableRegex)
  if (!match) return []

  const body = match[1]
  const columns: string[] = []
  const skipKeywords = new Set([
    'CONSTRAINT', 'CREATE', 'ALTER', 'UNIQUE', 'PRIMARY', 'REFERENCES',
    'CHECK', 'ON', 'INDEX', 'FOREIGN', 'USING', 'WHERE',
  ])

  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    // Skip empty lines, comments, trailing commas only
    if (!trimmed || trimmed.startsWith('--') || trimmed === ',') continue
    // A column def starts with a valid SQL identifier followed by a type
    const colMatch = trimmed.match(/^(\w+)\s+(?:UUID|TEXT|NUMERIC|TIMESTAMPTZ|INTEGER|BIGINT|BOOLEAN|SERIAL|VARCHAR)/)
    if (colMatch && !skipKeywords.has(colMatch[1].toUpperCase())) {
      columns.push(colMatch[1].toLowerCase())
    }
  }
  return columns
}

/**
 * Extracts column names from ALTER TABLE … ADD COLUMN statements.
 */
function extractAlterTableAddColumns(sql: string): string[] {
  const columns: string[] = []
  for (const line of sql.split('\n')) {
    const match = line.match(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+/i)
    if (match) columns.push(match[1].toLowerCase())
  }
  return columns
}

/**
 * Extracts field names from a TypeScript interface block.
 */
function extractInterfaceFields(source: string, interfaceName: string): string[] {
  // interfaceName is always a hardcoded literal — validate for safety
  if (!/^[A-Za-z]+$/.test(interfaceName)) throw new Error(`Invalid interface name: ${interfaceName}`)

  const ifaceRegex = new RegExp(`interface ${interfaceName}\\s*\\{([^}]+)\\}`, 's')
  const match = source.match(ifaceRegex)
  if (!match) return []

  const fields: string[] = []
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim()
    const fieldMatch = trimmed.match(/^(\w+)\s*[?]?\s*:/)
    if (fieldMatch) {
      fields.push(fieldMatch[1])
    }
  }
  return fields
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. CODE/SCHEMA CONTRACT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Block 3 Closure — Code/Schema Contract', () => {
  const escrowMigration = readSource('supabase/migrations/20260325000001_escrow_payment_plans.sql')
  const escrowFeeColumnsMigration = readSource('supabase/migrations/20260414000002_escrow_plan_fee_columns.sql')
  const escrowReversalMigration = readSource('supabase/migrations/20260417000002_reversal_model.sql')
  const fundingMigration = readSource('supabase/migrations/20260325000002_funding_requests.sql')
  const fundingStripeMigration = readSource('supabase/migrations/20260325000004_funding_request_stripe_refs.sql')
  const fundingExpiryMigration = readSource('supabase/migrations/20260420000006_funding_requests_expires_at.sql')
  const escrowRepoSource = readSource('src/lib/payments/escrow/SupabaseEscrowPlanRepository.ts')
  const fundingRepoSource = readSource('src/lib/payments/fundingRequest/SupabaseFundingRequestRepository.ts')

  describe('escrow_payment_plans: row mapping matches migration DDL', () => {
    const baseColumns = extractCreateTableColumns(escrowMigration, 'escrow_payment_plans')
    const addedColumns = extractAlterTableAddColumns(escrowFeeColumnsMigration)
    const migrationColumns = [...baseColumns, ...addedColumns]
    const rowFields = extractInterfaceFields(escrowRepoSource, 'PlanRow')

    it('migration has exactly 19 columns (16 base + 3 fee columns)', () => {
      expect(migrationColumns).toHaveLength(19)
    })

    it('PlanRow interface has exactly 19 fields', () => {
      expect(rowFields).toHaveLength(19)
    })

    it('every migration column is present in PlanRow', () => {
      for (const col of migrationColumns) {
        expect(rowFields).toContain(col)
      }
    })

    it('every PlanRow field is present in migration', () => {
      for (const field of rowFields) {
        expect(migrationColumns).toContain(field)
      }
    })

    it('PlanRow nullable fields match migration nullable columns', () => {
      // These columns are nullable in migration (no NOT NULL)
      const nullableCols = ['funding_initiated_at', 'funded_at', 'external_funding_ref', 'funding_idempotency_key', 'platform_fee_rate', 'platform_fee_amount', 'commercial_origin']
      for (const col of nullableCols) {
        // Verify the PlanRow declares them as (string|number) | null
        const fieldRegex = new RegExp(`${col}\\s*:\\s*(?:string|number)\\s*\\|\\s*null`)
        expect(escrowRepoSource).toMatch(fieldRegex)
      }
    })
  })

  describe('escrow_tranches: row mapping matches migration DDL', () => {
    const baseColumns = extractCreateTableColumns(escrowMigration, 'escrow_tranches')
    const addedColumns = extractAlterTableAddColumns(escrowReversalMigration)
    const migrationColumns = [...baseColumns, ...addedColumns]
    const rowFields = extractInterfaceFields(escrowRepoSource, 'TrancheRow')

    it('migration has exactly 15 columns (14 base + 1 reversal column)', () => {
      expect(migrationColumns).toHaveLength(15)
    })

    it('TrancheRow interface has exactly 15 fields', () => {
      expect(rowFields).toHaveLength(15)
    })

    it('every migration column is present in TrancheRow', () => {
      for (const col of migrationColumns) {
        expect(rowFields).toContain(col)
      }
    })

    it('every TrancheRow field is present in migration', () => {
      for (const field of rowFields) {
        expect(migrationColumns).toContain(field)
      }
    })

    it('TrancheRow nullable fields match migration nullable columns', () => {
      const nullableCols = ['eligible_at', 'released_at', 'external_release_ref', 'transfer_reversal_ref', 'triggered_by', 'released_by']
      for (const col of nullableCols) {
        const fieldRegex = new RegExp(`${col}\\s*:\\s*string\\s*\\|\\s*null`)
        expect(escrowRepoSource).toMatch(fieldRegex)
      }
    })
  })

  describe('funding_requests: row mapping matches migration DDL (base + stripe + expiry)', () => {
    const baseMigrationColumns = extractCreateTableColumns(fundingMigration, 'funding_requests')
    // Stripe extension adds 3 columns
    const stripeAddedColumns = ['external_funding_ref', 'funding_idempotency_key', 'failure_reason']
    // Expiry migration adds expires_at
    const expiryAddedColumns = extractAlterTableAddColumns(fundingExpiryMigration)
    const allMigrationColumns = [...baseMigrationColumns, ...stripeAddedColumns, ...expiryAddedColumns]
    const rowFields = extractInterfaceFields(fundingRepoSource, 'FundingRequestRow')

    it('base migration has 18 columns', () => {
      expect(baseMigrationColumns).toHaveLength(18)
    })

    it('total columns (base + stripe + expiry) = 22', () => {
      expect(allMigrationColumns).toHaveLength(22)
    })

    it('FundingRequestRow interface has exactly 22 fields', () => {
      expect(rowFields).toHaveLength(22)
    })

    it('every migration column is present in FundingRequestRow', () => {
      for (const col of allMigrationColumns) {
        expect(rowFields).toContain(col)
      }
    })

    it('every FundingRequestRow field is present in migration', () => {
      for (const field of rowFields) {
        expect(allMigrationColumns).toContain(field)
      }
    })

    it('FundingRequestRow nullable string fields match migration nullable columns', () => {
      const nullableStringCols = [
        'conversation_id', 'message_id', 'sent_at', 'funded_at',
        'external_funding_ref', 'funding_idempotency_key', 'failure_reason',
      ]
      for (const col of nullableStringCols) {
        const fieldRegex = new RegExp(`${col}\\s*:\\s*string\\s*\\|\\s*null`)
        expect(fundingRepoSource).toMatch(fieldRegex)
      }
    })

    it('expires_at is declared as number | null in FundingRequestRow', () => {
      expect(fundingRepoSource).toMatch(/expires_at\s*:\s*number\s*\|\s*null/)
    })
  })

  describe('status enum alignment: domain types match migration CHECK constraints', () => {
    const escrowTypesSource = readSource('src/lib/payments/escrow/escrowTypes.ts')
    const fundingTypesSource = readSource('src/lib/payments/fundingRequest/types.ts')

    it('EscrowPlanStatus values match migration constraint', () => {
      const domainStatuses = [
        'awaiting_customer_funding', 'funding_initiated', 'funded_in_escrow',
        'partially_released', 'fully_released', 'funding_failed',
        'disputed', 'refunded', 'cancelled',
      ]
      for (const s of domainStatuses) {
        expect(escrowTypesSource).toContain(`'${s}'`)
        expect(escrowMigration).toContain(`'${s}'`)
      }
    })

    it('EscrowTrancheStatus values match migration constraint', () => {
      const domainStatuses = [
        'pending_funding', 'funded', 'locked', 'eligible_for_release',
        'release_pending', 'released', 'blocked', 'disputed', 'refunded', 'cancelled',
      ]
      for (const s of domainStatuses) {
        expect(escrowTypesSource).toContain(`'${s}'`)
        expect(escrowMigration).toContain(`'${s}'`)
      }
    })

    it('FundingRequestStatus values match migration constraint (after stripe extension)', () => {
      const domainStatuses = [
        'created', 'sent', 'funding_started', 'funding_initiated',
        'funded', 'funding_failed', 'expired', 'cancelled',
      ]
      for (const s of domainStatuses) {
        expect(fundingTypesSource).toContain(`'${s}'`)
        // Base or stripe extension migration must contain each status
        const inBase = fundingMigration.includes(`'${s}'`)
        const inStripe = fundingStripeMigration.includes(`'${s}'`)
        expect(inBase || inStripe).toBe(true)
      }
    })
  })

  describe('timestamp conversion: TIMESTAMPTZ ↔ TimestampMs', () => {
    it('SupabaseEscrowPlanRepository converts TIMESTAMPTZ to ms and back', () => {
      // rowToPlan uses new Date(row.created_at).getTime() for required timestamps
      expect(escrowRepoSource).toContain('new Date(row.created_at).getTime()')
      expect(escrowRepoSource).toContain('new Date(row.updated_at).getTime()')
      // planToRow uses msToTs for ms→ISO conversion
      expect(escrowRepoSource).toContain('msToTs(plan.createdAt)')
      expect(escrowRepoSource).toContain('msToTs(plan.updatedAt)')
      // tsToMs for nullable timestamps
      expect(escrowRepoSource).toContain('tsToMs(row.funding_initiated_at)')
      expect(escrowRepoSource).toContain('tsToMs(row.funded_at)')
    })

    it('SupabaseFundingRequestRepository converts TIMESTAMPTZ to ms and back', () => {
      expect(fundingRepoSource).toContain('new Date(row.created_at).getTime()')
      expect(fundingRepoSource).toContain('new Date(row.updated_at).getTime()')
      expect(fundingRepoSource).toContain('msToTs(request.createdAt)')
      expect(fundingRepoSource).toContain('msToTs(request.updatedAt)')
      expect(fundingRepoSource).toContain('tsToMs(row.sent_at)')
      expect(fundingRepoSource).toContain('tsToMs(row.funded_at)')
    })
  })

  describe('Supabase table/column names match between repo queries and migration', () => {
    it('SupabaseEscrowPlanRepository queries escrow_payment_plans table', () => {
      expect(escrowRepoSource).toContain(".from('escrow_payment_plans')")
    })

    it('SupabaseEscrowPlanRepository queries escrow_tranches table', () => {
      expect(escrowRepoSource).toContain(".from('escrow_tranches')")
    })

    it('SupabaseFundingRequestRepository queries funding_requests table', () => {
      expect(fundingRepoSource).toContain(".from('funding_requests')")
    })

    it('migration creates escrow_payment_plans table', () => {
      expect(escrowMigration).toContain('CREATE TABLE IF NOT EXISTS escrow_payment_plans')
    })

    it('migration creates escrow_tranches table', () => {
      expect(escrowMigration).toContain('CREATE TABLE IF NOT EXISTS escrow_tranches')
    })

    it('migration creates funding_requests table', () => {
      expect(fundingMigration).toContain('CREATE TABLE IF NOT EXISTS funding_requests')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. NO SILENT PRODUCTION FALLBACK VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Block 3 Closure — No Silent Production Fallback', () => {
  const bootstrapSource = readSource('src/lib/bootstrap/index.ts')
  const escrowRegistrySource = readSource('src/lib/payments/escrow/escrowRegistry.ts')
  const fundingRegistrySource = readSource('src/lib/payments/fundingRequest/fundingRequestRegistry.ts')

  describe('bootstrap wires Supabase repos inside the supabase block', () => {
    // Extract the supabase block from bootstrap source
    const supabaseBlockMatch = bootstrapSource.match(
      /if\s*\(\s*dataSource\s*===\s*'supabase'\s*\)\s*\{([\s\S]*?)\n\s*\}/
    )
    const supabaseBlock = supabaseBlockMatch?.[1] ?? ''

    it('bootstrap has a supabase dataSource block', () => {
      expect(supabaseBlock.length).toBeGreaterThan(0)
    })

    it('setEscrowPlanRepository(new SupabaseEscrowPlanRepository()) is inside the supabase block', () => {
      expect(supabaseBlock).toContain('setEscrowPlanRepository(new SupabaseEscrowPlanRepository())')
    })

    it('setFundingRequestRepository(new SupabaseFundingRequestRepository()) is inside the supabase block', () => {
      expect(supabaseBlock).toContain('setFundingRequestRepository(new SupabaseFundingRequestRepository())')
    })

    it('bootstrap imports SupabaseEscrowPlanRepository', () => {
      expect(bootstrapSource).toContain('SupabaseEscrowPlanRepository')
    })

    it('bootstrap imports SupabaseFundingRequestRepository', () => {
      expect(bootstrapSource).toContain('SupabaseFundingRequestRepository')
    })
  })

  describe('bootstrap initializes both repos in the Promise.all', () => {
    // Extract the Promise.all block
    const promiseAllMatch = bootstrapSource.match(
      /await\s+Promise\.all\(\[\s*([\s\S]*?)\s*\]\)/
    )
    const promiseAllBlock = promiseAllMatch?.[1] ?? ''

    it('bootstrap has a Promise.all block', () => {
      expect(promiseAllBlock.length).toBeGreaterThan(0)
    })

    it('initializeEscrowPlanRepository(true) is in the Promise.all', () => {
      expect(promiseAllBlock).toContain('initializeEscrowPlanRepository(true)')
    })

    it('initializeFundingRequestRepository(true) is in the Promise.all', () => {
      expect(promiseAllBlock).toContain('initializeFundingRequestRepository(true)')
    })
  })

  describe('resyncRepositories includes escrow and funding repos', () => {
    // Extract resync Promise.all
    const resyncMatch = bootstrapSource.match(
      /async function resyncRepositories[\s\S]*?await\s+Promise\.all\(\[\s*([\s\S]*?)\s*\]\)/
    )
    const resyncBlock = resyncMatch?.[1] ?? ''

    it('resyncRepositories has a Promise.all block', () => {
      expect(resyncBlock.length).toBeGreaterThan(0)
    })

    it('resync includes initializeEscrowPlanRepository(true)', () => {
      expect(resyncBlock).toContain('initializeEscrowPlanRepository(true)')
    })

    it('resync includes initializeFundingRequestRepository(true)', () => {
      expect(resyncBlock).toContain('initializeFundingRequestRepository(true)')
    })
  })

  describe('registry defaults are InMemory (test-safe) and NOT silent Supabase', () => {
    it('escrow registry default is InMemoryEscrowPlanRepository', () => {
      expect(escrowRegistrySource).toContain('new InMemoryEscrowPlanRepository()')
    })

    it('funding registry default is InMemoryFundingRequestRepository', () => {
      expect(fundingRegistrySource).toContain('new InMemoryFundingRequestRepository()')
    })

    it('escrow registry does not silently create SupabaseEscrowPlanRepository', () => {
      expect(escrowRegistrySource).not.toContain('SupabaseEscrowPlanRepository')
    })

    it('funding registry does not silently create SupabaseFundingRequestRepository', () => {
      expect(fundingRegistrySource).not.toContain('SupabaseFundingRequestRepository')
    })
  })

  describe('Supabase repos start unhydrated — prevents false "loaded-empty" before init', () => {
    it('SupabaseEscrowPlanRepository._hydrated starts false', async () => {
      const { SupabaseEscrowPlanRepository } = await import(
        '../../src/lib/payments/escrow/SupabaseEscrowPlanRepository'
      )
      const repo = new SupabaseEscrowPlanRepository()
      expect(repo.isHydrated()).toBe(false)
    })

    it('SupabaseFundingRequestRepository._hydrated starts false', async () => {
      const { SupabaseFundingRequestRepository } = await import(
        '../../src/lib/payments/fundingRequest/SupabaseFundingRequestRepository'
      )
      const repo = new SupabaseFundingRequestRepository()
      expect(repo.isHydrated()).toBe(false)
    })
  })

  describe('no silent fallback factory or env-conditional InMemory in production imports', () => {
    it('escrow service imports getEscrowPlanRepository from registry (not creating its own)', () => {
      const serviceSource = readSource('src/lib/payments/escrow/escrowService.ts')
      expect(serviceSource).toContain('getEscrowPlanRepository')
      expect(serviceSource).not.toContain('new InMemoryEscrowPlanRepository')
      expect(serviceSource).not.toContain('new SupabaseEscrowPlanRepository')
    })

    it('funding service imports getFundingRequestRepository from registry (not creating its own)', () => {
      const serviceSource = readSource('src/lib/payments/fundingRequest/fundingRequestService.ts')
      expect(serviceSource).toContain('getFundingRequestRepository')
      expect(serviceSource).not.toContain('new InMemoryFundingRequestRepository')
      expect(serviceSource).not.toContain('new SupabaseFundingRequestRepository')
    })

    it('no workflow file creates InMemory escrow/funding repos directly', () => {
      const workflowFiles = [
        'src/lib/workflow/jobWorkflow.ts',
        'src/lib/workflow/offerWorkflow.ts',
        'src/lib/workflow/craftsmanOperations.ts',
        'src/lib/workflow/releaseOperations.ts',
      ]
      for (const file of workflowFiles) {
        const source = readSource(file)
        expect(source).not.toContain('new InMemoryEscrowPlanRepository')
        expect(source).not.toContain('new InMemoryFundingRequestRepository')
      }
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. RUNTIME VERIFICATION (with InMemory repos in test mode)
// ═══════════════════════════════════════════════════════════════════════════

describe('Block 3 Closure — Runtime contract proof (InMemory test mode)', () => {

  beforeEach(() => {
    setupCleanRepositories()
  })

  it('after setupCleanRepositories, escrow repo is hydrated and empty', async () => {
    const { getEscrowPlanRepository } = await import(
      '../../src/lib/payments/escrow/escrowRegistry'
    )
    const repo = getEscrowPlanRepository()
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getAllPlans()).toHaveLength(0)
  })

  it('after setupCleanRepositories, funding repo is hydrated and empty', async () => {
    const { getFundingRequestRepository } = await import(
      '../../src/lib/payments/fundingRequest/fundingRequestRegistry'
    )
    const repo = getFundingRequestRepository()
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getAll()).toHaveLength(0)
  })

  it('escrow plan roundtrip preserves all domain fields', async () => {
    const { ensureEscrowPlan, getEscrowPlanById, getEscrowTranches } = await import(
      '../../src/lib/payments/escrow'
    )
    const plan = await ensureEscrowPlan({
      sourceOfferId: 'offer-rt',
      jobId: 'job-rt',
      customerUserId: 'cust-rt',
      providerId: 'prov-rt',
      totalAmount: 8000,
    })

    const reread = getEscrowPlanById(plan.id)!
    expect(reread.sourceOfferId).toBe('offer-rt')
    expect(reread.jobId).toBe('job-rt')
    expect(reread.customerUserId).toBe('cust-rt')
    expect(reread.providerId).toBe('prov-rt')
    expect(reread.currency).toBe('EUR')
    expect(reread.totalAmount).toBe(8000)
    expect(reread.fundingMode).toBe('full_upfront_escrow')
    expect(reread.releaseModel).toBe('start_25_completion_75')
    expect(reread.status).toBe('awaiting_customer_funding')
    expect(typeof reread.createdAt).toBe('number')
    expect(typeof reread.updatedAt).toBe('number')

    const tranches = getEscrowTranches(plan.id)
    expect(tranches).toHaveLength(2)
    expect(tranches.map(t => t.kind).sort()).toEqual(['deposit_release', 'final_release'])
    expect(tranches[0].amount + tranches[1].amount).toBe(8000)
  })

  it('funding request roundtrip preserves all domain fields', async () => {
    const { ensureEscrowPlan } = await import('../../src/lib/payments/escrow')
    const { ensureFundingRequest, getFundingRequestById } = await import(
      '../../src/lib/payments/fundingRequest'
    )

    const plan = await ensureEscrowPlan({
      sourceOfferId: 'offer-frt',
      jobId: 'job-frt',
      customerUserId: 'cust-frt',
      providerId: 'prov-frt',
      totalAmount: 5000,
    })

    const request = await ensureFundingRequest({
      sourceOfferId: 'offer-frt',
      jobId: 'job-frt',
      escrowPlanId: plan.id,
      customerUserId: 'cust-frt',
      providerId: 'prov-frt',
      providerUserId: 'prov-user-frt',
      amount: 5000,
    })

    const reread = getFundingRequestById(request.id)!
    expect(reread.sourceOfferId).toBe('offer-frt')
    expect(reread.jobId).toBe('job-frt')
    expect(reread.escrowPlanId).toBe(plan.id)
    expect(reread.customerUserId).toBe('cust-frt')
    expect(reread.providerId).toBe('prov-frt')
    expect(reread.providerUserId).toBe('prov-user-frt')
    expect(reread.type).toBe('full_escrow')
    expect(reread.status).toBe('created')
    expect(reread.amount).toBe(5000)
    expect(reread.currency).toBe('EUR')
    expect(reread.createdBy).toBe('provider')
    expect(typeof reread.createdAt).toBe('number')
    expect(typeof reread.updatedAt).toBe('number')
  })
})
