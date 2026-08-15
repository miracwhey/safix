/**
 * Invoice UUID Contract
 *
 * Verifies the fix for the 22P02 "invalid input syntax for type uuid" root
 * cause: job-derived invoices were created with `id: \`inv_${job.id}\``
 * (not a UUID) and sent to the `invoices.id uuid` Postgres column.
 *
 * Contracts enforced here:
 *   1. createInvoiceFromJob produces id === job.id (plain UUID, no prefix)
 *   2. No "inv_" prefix appears anywhere in the generated invoice's id
 *   3. jobId is preserved separately so getByJobId lookups still work
 *   4. id === jobId (1:1 domain invariant)
 *   5. Different jobs produce different invoice ids
 *   6. Migration v2→v3 purges inv_* invoice/draft mutations from the queue
 *   7. Migration is idempotent — second call is a no-op
 *   8. Migration does NOT remove non-invoice mutations with inv_*-like entityIds
 *   9. Migration does NOT remove invoice mutations with valid UUID entityIds
 *  10. v0→v3 upgrade applies all three steps
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isValidUUID } from '../../src/lib/shared/generateUUID'
import { createInvoiceFromJob } from '../../src/lib/invoices/invoiceEngine'
import type { Job } from '../../src/lib/jobs/types'

// ── localStorage shim ─────────────────────────────────────────────────────────
const memoryStorage = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => { store[k] = v },
    removeItem: (k: string): void => { delete store[k] },
    clear: (): void => { store = {} },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number { return Object.keys(store).length },
  }
})()

vi.stubGlobal('localStorage', memoryStorage)

import {
  enqueuePendingMutation,
  getPendingMutations,
  clearPendingMutations,
  migratePendingMutationsIfNeeded,
  setActiveMutationUser,
} from '../../src/lib/persistence/pendingMutationStore'

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: '59cc07e8-11fd-4abe-9580-8136a7ac8a6a',
    title: 'Badezimmer sanieren',
    customer: 'Max Mustermann',
    customerName: 'Max Mustermann',
    location: 'München',
    status: 'completed',
    dateLabel: 'Heute',
    amount: '1.200 €',
    assignedMemberIds: [],
    providerId: 'provider-uuid-1234',
    ...overrides,
  } as Job
}

beforeEach(() => {
  memoryStorage.clear()
  clearPendingMutations()
  setActiveMutationUser('user-A')
})

// ── 1–5: createInvoiceFromJob ID contract ─────────────────────────────────────

describe('createInvoiceFromJob — id contract', () => {
  it('uses job.id directly as the invoice id', () => {
    const job = makeJob()
    const invoice = createInvoiceFromJob(job)
    expect(invoice.id).toBe(job.id)
  })

  it('produced id is a valid UUID (no prefix)', () => {
    const job = makeJob()
    const invoice = createInvoiceFromJob(job)
    expect(isValidUUID(invoice.id)).toBe(true)
  })

  it('id does NOT start with inv_', () => {
    const job = makeJob()
    const invoice = createInvoiceFromJob(job)
    expect(invoice.id.startsWith('inv_')).toBe(false)
  })

  it('jobId is set separately so getByJobId lookups still resolve', () => {
    const job = makeJob()
    const invoice = createInvoiceFromJob(job)
    expect(invoice.jobId).toBe(job.id)
    expect(invoice.id).toBe(invoice.jobId)
  })

  it('different jobs produce different invoice ids', () => {
    const jobA = makeJob({ id: '11111111-1111-1111-1111-111111111111' })
    const jobB = makeJob({ id: '22222222-2222-2222-2222-222222222222' })
    const invoiceA = createInvoiceFromJob(jobA)
    const invoiceB = createInvoiceFromJob(jobB)
    expect(invoiceA.id).not.toBe(invoiceB.id)
  })
})

// ── 6–10: Migration v2→v3 — inv_* purge ──────────────────────────────────────

describe('migratePendingMutationsIfNeeded v2→v3 — inv_* invoice purge', () => {
  function simulateVersion(v: number): void {
    memoryStorage.setItem('fixup.pending_mutations.schema_version', String(v))
  }

  function enqueue(domain: string, entityId: string): void {
    enqueuePendingMutation({
      operation: 'insert',
      table: domain === 'invoices/draft' ? 'invoices' : domain,
      payload: { id: entityId },
      domain,
      entityId,
    })
  }

  it('purges inv_*-prefixed invoices/draft mutations on upgrade from v2', () => {
    simulateVersion(2)
    enqueue('invoices/draft', 'inv_59cc07e8-11fd-4abe-9580-8136a7ac8a6a')
    enqueue('invoices/draft', 'inv_32367d63-d276-4823-b36c-7112acc06fce')

    const purged = migratePendingMutationsIfNeeded()

    expect(purged).toHaveLength(2)
    expect(purged.every((m) => m.entityId.startsWith('inv_'))).toBe(true)
    expect(getPendingMutations()).toHaveLength(0)
  })

  it('does NOT purge invoices/draft mutations with a valid UUID entityId', () => {
    simulateVersion(2)
    const validUUID = '59cc07e8-11fd-4abe-9580-8136a7ac8a6a'
    enqueue('invoices/draft', validUUID)

    const purged = migratePendingMutationsIfNeeded()

    expect(purged.some((m) => m.entityId === validUUID)).toBe(false)
    expect(getPendingMutations().some((m) => m.entityId === validUUID)).toBe(true)
  })

  it('does NOT purge non-invoice mutations with inv_*-like entityIds', () => {
    simulateVersion(2)
    enqueue('jobs', 'inv_looks-like-invoice-but-is-not')

    const purged = migratePendingMutationsIfNeeded()

    expect(purged.some((m) => m.domain === 'jobs')).toBe(false)
    expect(getPendingMutations().some((m) => m.domain === 'jobs')).toBe(true)
  })

  it('migration is idempotent — second call is a no-op', () => {
    simulateVersion(2)
    enqueue('invoices/draft', 'inv_59cc07e8-11fd-4abe-9580-8136a7ac8a6a')

    migratePendingMutationsIfNeeded()
    const secondCall = migratePendingMutationsIfNeeded()

    expect(secondCall).toHaveLength(0)
  })

  it('v0→v3 upgrade applies all steps: time-based prune + cal_* purge + inv_* purge', () => {
    // No stored version = v0
    enqueue('invoices/draft', 'inv_old-invalid-id')
    enqueue('calendar', 'cal_old-invalid-id')

    // Age both past the 1-hour v0→v1 threshold
    const raw = memoryStorage.getItem('fixup.pending_mutations.v1')!
    const list = JSON.parse(raw)
    const aged = list.map((m: { enqueuedAt: number }) => ({
      ...m,
      enqueuedAt: m.enqueuedAt - 2 * 60 * 60 * 1000,
    }))
    memoryStorage.setItem('fixup.pending_mutations.v1', JSON.stringify(aged))

    const purged = migratePendingMutationsIfNeeded()

    expect(purged.length).toBeGreaterThanOrEqual(2)
    expect(getPendingMutations()).toHaveLength(0)
  })
})
