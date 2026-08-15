/**
 * Block 7.2.1e — `deriveDueReminders` selector contract.
 *
 * The cron uses the result of this selector to decide which customer
 * reminders to push for a given pending acceptance. The cases below lock
 * every branch the cron may take so a regression cannot silently drop or
 * double-fire a reminder.
 */
import { describe, it, expect } from 'vitest'

import {
  deriveDueReminders,
  REMINDER_OFFSET_24H_MS,
  REMINDER_OFFSET_60H_MS,
} from '../../src/lib/acceptance/reminderSelectors'
import type { Acceptance } from '../../src/lib/acceptance/types'

const HOUR_MS = 60 * 60 * 1000
const ACCEPTANCE_DEADLINE_MS = 72 * HOUR_MS

type AcceptanceFixture = Pick<
  Acceptance,
  'status' | 'createdAt' | 'expiresAt' | 'remindersSent'
>

function makeAcceptance(overrides: Partial<AcceptanceFixture> = {}): AcceptanceFixture {
  const createdAt = overrides.createdAt ?? 0
  const expiresAt =
    'expiresAt' in overrides ? overrides.expiresAt : createdAt + ACCEPTANCE_DEADLINE_MS
  return {
    status: overrides.status ?? 'pending',
    createdAt,
    expiresAt,
    remindersSent: overrides.remindersSent ?? {},
  }
}

describe('deriveDueReminders', () => {
  it('all-fresh: just-created pending acceptance has no reminders due', () => {
    const acc = makeAcceptance({ createdAt: 0 })
    expect(deriveDueReminders(acc, 1_000)).toEqual({
      customer_24h: false,
      customer_60h: false,
    })
  })

  it('24h-due: at the +24h mark, only customer_24h fires', () => {
    const acc = makeAcceptance({ createdAt: 0 })
    expect(deriveDueReminders(acc, REMINDER_OFFSET_24H_MS)).toEqual({
      customer_24h: true,
      customer_60h: false,
    })
  })

  it('60h-due: at the +60h mark with 24h already sent, only customer_60h fires', () => {
    const acc = makeAcceptance({
      createdAt: 0,
      remindersSent: { customer_24h: true },
    })
    expect(deriveDueReminders(acc, REMINDER_OFFSET_60H_MS)).toEqual({
      customer_24h: false,
      customer_60h: true,
    })
  })

  it('both-due: at +60h with no flag set yet, both reminders fire on the same tick', () => {
    const acc = makeAcceptance({ createdAt: 0 })
    expect(deriveDueReminders(acc, REMINDER_OFFSET_60H_MS)).toEqual({
      customer_24h: true,
      customer_60h: true,
    })
  })

  it('already-sent-24h: 24h flag suppresses re-fire in the +24h..+60h window', () => {
    const acc = makeAcceptance({
      createdAt: 0,
      remindersSent: { customer_24h: true },
    })
    expect(deriveDueReminders(acc, REMINDER_OFFSET_24H_MS + HOUR_MS)).toEqual({
      customer_24h: false,
      customer_60h: false,
    })
  })

  it('already-sent-60h: both flags suppress further fires in the late window', () => {
    const acc = makeAcceptance({
      createdAt: 0,
      remindersSent: { customer_24h: true, customer_60h: true },
    })
    expect(deriveDueReminders(acc, REMINDER_OFFSET_60H_MS + HOUR_MS)).toEqual({
      customer_24h: false,
      customer_60h: false,
    })
  })

  it('past-deadline-no-reminder: once `now >= expiresAt` no customer reminder fires', () => {
    const acc = makeAcceptance({ createdAt: 0 })
    expect(deriveDueReminders(acc, ACCEPTANCE_DEADLINE_MS + HOUR_MS)).toEqual({
      customer_24h: false,
      customer_60h: false,
    })
  })

  it('pre-24h-no-reminder: anything strictly before +24h fires nothing', () => {
    const acc = makeAcceptance({ createdAt: 0 })
    expect(deriveDueReminders(acc, REMINDER_OFFSET_24H_MS - 1)).toEqual({
      customer_24h: false,
      customer_60h: false,
    })
  })

  it('customer-released-no-reminder: an `accepted` acceptance never produces a reminder', () => {
    const acc = makeAcceptance({ status: 'accepted', createdAt: 0 })
    expect(deriveDueReminders(acc, REMINDER_OFFSET_60H_MS)).toEqual({
      customer_24h: false,
      customer_60h: false,
    })
  })

  it('disputed-no-reminder: a `disputed` acceptance never produces a reminder', () => {
    const acc = makeAcceptance({ status: 'disputed', createdAt: 0 })
    expect(deriveDueReminders(acc, REMINDER_OFFSET_60H_MS)).toEqual({
      customer_24h: false,
      customer_60h: false,
    })
  })

  it('auto-released-no-customer-reminder: an `accepted` row produced by auto-release no longer reminds', () => {
    // Auto-release rewrites `status` from 'pending' to 'accepted' even though
    // `expiresAt` has already passed. This is the canonical no-reminder case.
    const acc = makeAcceptance({
      status: 'accepted',
      createdAt: 0,
      expiresAt: ACCEPTANCE_DEADLINE_MS,
    })
    expect(deriveDueReminders(acc, ACCEPTANCE_DEADLINE_MS + HOUR_MS)).toEqual({
      customer_24h: false,
      customer_60h: false,
    })
  })

  it('expiresAt-missing: a row without an expiresAt cannot produce a reminder', () => {
    const acc = makeAcceptance({ createdAt: 0, expiresAt: undefined })
    expect(deriveDueReminders(acc, REMINDER_OFFSET_60H_MS)).toEqual({
      customer_24h: false,
      customer_60h: false,
    })
  })
})
