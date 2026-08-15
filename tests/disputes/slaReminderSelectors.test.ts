import { describe, it, expect } from 'vitest'
import {
  deriveDueDisputeSlaReminders,
  getSlaTargetRole,
  SLA_THRESHOLDS_MS,
  DISPUTE_SLA_REMINDER_TYPE,
  DISPUTE_SLA_REMINDER_PRIORITY,
} from '../../src/lib/disputes/slaReminderSelectors'

const NOW = 1_700_000_000_000

describe('getSlaTargetRole', () => {
  it('customer_waiting → customer', () => {
    expect(getSlaTargetRole('customer_waiting')).toBe('customer')
  })
  it('provider_waiting → craftsman', () => {
    expect(getSlaTargetRole('provider_waiting')).toBe('craftsman')
  })
  it('non-waiting status → null', () => {
    expect(getSlaTargetRole('open')).toBeNull()
    expect(getSlaTargetRole('under_review')).toBeNull()
    expect(getSlaTargetRole('resolved')).toBeNull()
    expect(getSlaTargetRole('closed')).toBeNull()
  })
})

describe('deriveDueDisputeSlaReminders', () => {
  it('non-waiting status emits no reminders', () => {
    const r = deriveDueDisputeSlaReminders(
      { status: 'open', waitingSinceMs: NOW - SLA_THRESHOLDS_MS.h72, remindersSent: {} },
      NOW,
    )
    expect(r).toEqual({ h24: false, h48: false, h72: false, targetRole: null })
  })

  it('elapsed < 24h: no reminder due', () => {
    const r = deriveDueDisputeSlaReminders(
      {
        status: 'customer_waiting',
        waitingSinceMs: NOW - SLA_THRESHOLDS_MS.h24 + 60_000,
        remindersSent: {},
      },
      NOW,
    )
    expect(r.h24).toBe(false)
    expect(r.h48).toBe(false)
    expect(r.h72).toBe(false)
    expect(r.targetRole).toBe('customer')
  })

  it('elapsed exactly 24h: 24h reminder due (boundary inclusive)', () => {
    const r = deriveDueDisputeSlaReminders(
      {
        status: 'customer_waiting',
        waitingSinceMs: NOW - SLA_THRESHOLDS_MS.h24,
        remindersSent: {},
      },
      NOW,
    )
    expect(r.h24).toBe(true)
    expect(r.h48).toBe(false)
    expect(r.h72).toBe(false)
  })

  it('elapsed 50h with no reminders sent: 24h+48h fire together (cron tick recovery)', () => {
    const r = deriveDueDisputeSlaReminders(
      {
        status: 'provider_waiting',
        waitingSinceMs: NOW - 50 * 60 * 60 * 1000,
        remindersSent: {},
      },
      NOW,
    )
    expect(r.h24).toBe(true)
    expect(r.h48).toBe(true)
    expect(r.h72).toBe(false)
    expect(r.targetRole).toBe('craftsman')
  })

  it('elapsed 80h with all earlier reminders sent: 72h fires alone', () => {
    const r = deriveDueDisputeSlaReminders(
      {
        status: 'customer_waiting',
        waitingSinceMs: NOW - 80 * 60 * 60 * 1000,
        remindersSent: { h24: true, h48: true },
      },
      NOW,
    )
    expect(r.h24).toBe(false)
    expect(r.h48).toBe(false)
    expect(r.h72).toBe(true)
  })

  it('all reminders already sent: nothing more fires', () => {
    const r = deriveDueDisputeSlaReminders(
      {
        status: 'customer_waiting',
        waitingSinceMs: NOW - 200 * 60 * 60 * 1000,
        remindersSent: { h24: true, h48: true, h72: true },
      },
      NOW,
    )
    expect(r.h24).toBe(false)
    expect(r.h48).toBe(false)
    expect(r.h72).toBe(false)
  })

  it('clock skew (waitingSince in future): no reminders', () => {
    const r = deriveDueDisputeSlaReminders(
      {
        status: 'customer_waiting',
        waitingSinceMs: NOW + 60_000,
        remindersSent: {},
      },
      NOW,
    )
    expect(r.h24).toBe(false)
    expect(r.h48).toBe(false)
    expect(r.h72).toBe(false)
    expect(r.targetRole).toBe('customer')
  })
})

describe('DISPUTE_SLA_REMINDER_TYPE / PRIORITY mapping', () => {
  it('type strings match the notification-config canon', () => {
    expect(DISPUTE_SLA_REMINDER_TYPE.h24).toBe('dispute_sla_reminder_24h')
    expect(DISPUTE_SLA_REMINDER_TYPE.h48).toBe('dispute_sla_reminder_48h')
    expect(DISPUTE_SLA_REMINDER_TYPE.h72).toBe('dispute_sla_reminder_72h')
  })

  it('priorities escalate at the 72h threshold', () => {
    expect(DISPUTE_SLA_REMINDER_PRIORITY.h24).toBe('action')
    expect(DISPUTE_SLA_REMINDER_PRIORITY.h48).toBe('action')
    expect(DISPUTE_SLA_REMINDER_PRIORITY.h72).toBe('alert')
  })
})
