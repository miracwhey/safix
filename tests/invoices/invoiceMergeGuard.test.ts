import { describe, it, expect } from 'vitest'
import {
  INVOICE_FSM_RANK,
  shouldReplaceCached,
} from '../../src/lib/invoices/repository/invoiceMergeGuard'
import type { Invoice, InvoiceStatus } from '../../src/lib/invoices/types'

/**
 * R3 — realtime two-writer clock seam.
 *
 * invoices now have two writers: the provider client (device wall-clock
 * updatedAt) and the server settle trigger (DB epoch_ms updatedAt). The cache
 * merge guard must rank by FSM status, NOT wall-clock, so a server 'paid' echo
 * survives even when its DB clock lands below an ahead device-clock 'sent'.
 */

function makeInvoice(status: InvoiceStatus, updatedAt: number): Invoice {
  return { id: 'inv_1', jobId: 'job_1', status, updatedAt } as unknown as Invoice
}

describe('R3 invoice merge guard — FSM-rank, clock-agnostic', () => {
  it('applies a server "paid" echo even when its clock is BELOW an ahead device "sent" (the R3 bug)', () => {
    const cachedSent = makeInvoice('sent', 9_999_999_999_999) // device clock ahead
    const serverPaid = makeInvoice('paid', 1) // DB epoch_ms, far lower
    expect(shouldReplaceCached(serverPaid, cachedSent)).toBe(true)
  })

  it('drops a strict FSM regression regardless of clock (issued echo vs cached sent)', () => {
    const cachedSent = makeInvoice('sent', 1)
    const staleIssued = makeInvoice('issued', 9_999_999_999_999)
    expect(shouldReplaceCached(staleIssued, cachedSent)).toBe(false)
  })

  it('same status: drops an older-clock field echo, applies a newer/equal one', () => {
    const cached = makeInvoice('sent', 1000)
    expect(shouldReplaceCached(makeInvoice('sent', 999), cached)).toBe(false)
    expect(shouldReplaceCached(makeInvoice('sent', 1000), cached)).toBe(true)
    expect(shouldReplaceCached(makeInvoice('sent', 1001), cached)).toBe(true)
  })

  it('paid is terminal-forward: paid never regresses to sent/issued', () => {
    const cachedPaid = makeInvoice('paid', 1)
    expect(shouldReplaceCached(makeInvoice('sent', 9_999_999_999_999), cachedPaid)).toBe(false)
    expect(shouldReplaceCached(makeInvoice('issued', 9_999_999_999_999), cachedPaid)).toBe(false)
  })

  it('rank ordering is monotonic draft<issued<sent<paid<cancelled', () => {
    expect(INVOICE_FSM_RANK.draft).toBeLessThan(INVOICE_FSM_RANK.issued)
    expect(INVOICE_FSM_RANK.issued).toBeLessThan(INVOICE_FSM_RANK.sent)
    expect(INVOICE_FSM_RANK.sent).toBeLessThan(INVOICE_FSM_RANK.paid)
    expect(INVOICE_FSM_RANK.paid).toBeLessThan(INVOICE_FSM_RANK.cancelled)
  })
})
