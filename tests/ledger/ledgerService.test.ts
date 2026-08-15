import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { createLedgerEntry } from '../../src/lib/payments/ledger/ledgerService'
import { getLedgerRepository } from '../../src/lib/payments/ledger/repository/registry'

describe('Ledger Service – createLedgerEntry', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('stores an escrow_created entry in the repository', () => {
    createLedgerEntry({
      paymentId: 'pay-1',
      jobId: 'job-1',
      type: 'escrow_created',
      amount: 2000,
      note: 'Zahlungsvorgang angelegt',
    })

    const entries = getLedgerRepository().getForJob('job-1')
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('escrow_created')
    expect(entries[0].amount).toBe(2000)
    expect(entries[0].currency).toBe('EUR')
  })

  it('stores a payout entry with correct fields', () => {
    createLedgerEntry({
      paymentId: 'pay-2',
      jobId: 'job-2',
      type: 'payout',
      amount: 880,
    })

    const entries = getLedgerRepository().getForJob('job-2')
    expect(entries[0].type).toBe('payout')
    expect(entries[0].amount).toBe(880)
    expect(entries[0].paymentId).toBe('pay-2')
  })

  it('stores a dispute_hold entry and links the disputeId', () => {
    createLedgerEntry({
      paymentId: 'pay-3',
      jobId: 'job-3',
      type: 'dispute_hold',
      amount: 1500,
      disputeId: 'dispute-xyz',
    })

    const entries = getLedgerRepository().getForJob('job-3')
    const holdEntry = entries.find((e) => e.type === 'dispute_hold')
    expect(holdEntry).toBeDefined()
    expect(holdEntry!.disputeId).toBe('dispute-xyz')
  })

  it('generates a unique id for each entry', () => {
    createLedgerEntry({ paymentId: 'pay-4', jobId: 'job-4', type: 'payout', amount: 100 })
    createLedgerEntry({ paymentId: 'pay-4', jobId: 'job-4', type: 'platform_fee', amount: 12 })

    const entries = getLedgerRepository().getForJob('job-4')
    expect(entries).toHaveLength(2)
    expect(entries[0].id).not.toBe(entries[1].id)
  })

  it('stores multiple entries for the same job', () => {
    createLedgerEntry({ paymentId: 'pay-5', jobId: 'job-5', type: 'escrow_created', amount: 1000 })
    createLedgerEntry({ paymentId: 'pay-5', jobId: 'job-5', type: 'deposit_paid', amount: 250 })
    createLedgerEntry({ paymentId: 'pay-5', jobId: 'job-5', type: 'final_paid', amount: 750 })

    const entries = getLedgerRepository().getForJob('job-5')
    expect(entries).toHaveLength(3)
  })
})

describe('Ledger Service – deduplication guard', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('suppresses a duplicate non-repeating entry type for the same payment', () => {
    createLedgerEntry({ paymentId: 'pay-dup1', jobId: 'job-dup1', type: 'escrow_created', amount: 1000 })
    createLedgerEntry({ paymentId: 'pay-dup1', jobId: 'job-dup1', type: 'escrow_created', amount: 1000 })

    const entries = getLedgerRepository().getForJob('job-dup1')
    expect(entries.filter((e) => e.type === 'escrow_created')).toHaveLength(1)
  })

  it('returns the existing entry when a duplicate is suppressed', () => {
    const first = createLedgerEntry({ paymentId: 'pay-dup2', jobId: 'job-dup2', type: 'payout', amount: 880 })
    const second = createLedgerEntry({ paymentId: 'pay-dup2', jobId: 'job-dup2', type: 'payout', amount: 880 })

    expect(first.id).toBe(second.id)
  })

  it('allows different non-repeating types for the same payment', () => {
    createLedgerEntry({ paymentId: 'pay-dup3', jobId: 'job-dup3', type: 'escrow_created', amount: 1000 })
    createLedgerEntry({ paymentId: 'pay-dup3', jobId: 'job-dup3', type: 'deposit_paid', amount: 250 })
    createLedgerEntry({ paymentId: 'pay-dup3', jobId: 'job-dup3', type: 'payout', amount: 880 })

    const entries = getLedgerRepository().getForJob('job-dup3')
    expect(entries).toHaveLength(3)
  })

  it('allows the same entry type for different payments', () => {
    createLedgerEntry({ paymentId: 'pay-dup4a', jobId: 'job-dup4', type: 'payout', amount: 880 })
    createLedgerEntry({ paymentId: 'pay-dup4b', jobId: 'job-dup4', type: 'payout', amount: 880 })

    const entries = getLedgerRepository().getForJob('job-dup4')
    expect(entries).toHaveLength(2)
  })

  it('suppresses duplicate dispute_hold for the same payment', () => {
    createLedgerEntry({ paymentId: 'pay-dup5', jobId: 'job-dup5', type: 'dispute_hold', amount: 1000, disputeId: 'disp-1' })
    createLedgerEntry({ paymentId: 'pay-dup5', jobId: 'job-dup5', type: 'dispute_hold', amount: 1000, disputeId: 'disp-1' })

    const entries = getLedgerRepository().getForJob('job-dup5')
    expect(entries.filter((e) => e.type === 'dispute_hold')).toHaveLength(1)
  })

  it('suppresses duplicate platform_fee for the same payment', () => {
    createLedgerEntry({ paymentId: 'pay-dup6', jobId: 'job-dup6', type: 'platform_fee', amount: 120 })
    createLedgerEntry({ paymentId: 'pay-dup6', jobId: 'job-dup6', type: 'platform_fee', amount: 120 })

    const entries = getLedgerRepository().getForJob('job-dup6')
    expect(entries.filter((e) => e.type === 'platform_fee')).toHaveLength(1)
  })
})
