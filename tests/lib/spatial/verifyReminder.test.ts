/**
 * Verify-flow Reminder — `verifyReminder.ts` (Block 3.11 · VF-4).
 *
 * Covers the 24 h push / 72 h email cadence, the recipient-eligibility gate
 * (only `not_started` / `in_progress`), and the signal payload.
 */
import { describe, it, expect } from 'vitest'

import {
  isVerifyReminderEligible,
  resolveVerifyReminderChannel,
  buildVerifyReminderSignal,
  verifyReminderRoute,
  VERIFY_REMINDER_PUSH_MS,
  VERIFY_REMINDER_EMAIL_MS,
} from '../../../src/lib/spatial/workflow/verifyReminder'

const NOW = 1_700_000_000_000

describe('isVerifyReminderEligible', () => {
  it('is true only for unfinished verify states', () => {
    expect(isVerifyReminderEligible('not_started')).toBe(true)
    expect(isVerifyReminderEligible('in_progress')).toBe(true)
    expect(isVerifyReminderEligible('approved')).toBe(false)
    expect(isVerifyReminderEligible('rejected')).toBe(false)
    expect(isVerifyReminderEligible('expired')).toBe(false)
  })
})

describe('resolveVerifyReminderChannel · cadence', () => {
  it('returns `none` less than 24 h after last activity', () => {
    const lastActive = NOW - (VERIFY_REMINDER_PUSH_MS - 1)
    expect(resolveVerifyReminderChannel('not_started', lastActive, NOW)).toBe('none')
  })

  it('returns `push` at 24 h and before 72 h', () => {
    expect(
      resolveVerifyReminderChannel('not_started', NOW - VERIFY_REMINDER_PUSH_MS, NOW),
    ).toBe('push')
    expect(
      resolveVerifyReminderChannel('in_progress', NOW - (VERIFY_REMINDER_EMAIL_MS - 1), NOW),
    ).toBe('push')
  })

  it('returns `email` at and beyond 72 h', () => {
    expect(
      resolveVerifyReminderChannel('not_started', NOW - VERIFY_REMINDER_EMAIL_MS, NOW),
    ).toBe('email')
    expect(
      resolveVerifyReminderChannel('in_progress', NOW - VERIFY_REMINDER_EMAIL_MS * 2, NOW),
    ).toBe('email')
  })
})

describe('resolveVerifyReminderChannel · gating', () => {
  it('returns `none` for a finished verify regardless of elapsed time', () => {
    const long = NOW - VERIFY_REMINDER_EMAIL_MS * 10
    expect(resolveVerifyReminderChannel('approved', long, NOW)).toBe('none')
    expect(resolveVerifyReminderChannel('rejected', long, NOW)).toBe('none')
    expect(resolveVerifyReminderChannel('expired', long, NOW)).toBe('none')
  })

  it('returns `none` when there is no last-activity anchor', () => {
    expect(resolveVerifyReminderChannel('not_started', null, NOW)).toBe('none')
    expect(resolveVerifyReminderChannel('not_started', Number.NaN, NOW)).toBe('none')
  })
})

describe('buildVerifyReminderSignal', () => {
  it('returns null when no reminder is due', () => {
    expect(
      buildVerifyReminderSignal('scene-1', 'proj-1', 'not_started', NOW - 1000, NOW),
    ).toBeNull()
    expect(
      buildVerifyReminderSignal('scene-1', 'proj-1', 'approved', NOW - VERIFY_REMINDER_EMAIL_MS, NOW),
    ).toBeNull()
  })

  it('builds a push signal at 24 h with the verify-flow-spec §5 route', () => {
    const signal = buildVerifyReminderSignal(
      'scene-1',
      'proj-1',
      'not_started',
      NOW - VERIFY_REMINDER_PUSH_MS,
      NOW,
    )
    expect(signal).not.toBeNull()
    expect(signal).toMatchObject({
      sceneId: 'scene-1',
      projectId: 'proj-1',
      channel: 'push',
      verifyState: 'not_started',
      route: '/customer/projects/proj-1/spatial/verify',
    })
    expect(signal?.title).toBeTruthy()
    expect(signal?.body).toBeTruthy()
  })

  it('builds an email signal at 72 h', () => {
    const signal = buildVerifyReminderSignal(
      'scene-1',
      'proj-1',
      'in_progress',
      NOW - VERIFY_REMINDER_EMAIL_MS,
      NOW,
    )
    expect(signal?.channel).toBe('email')
    expect(signal?.verifyState).toBe('in_progress')
  })
})

describe('verifyReminderRoute', () => {
  it('builds the §5 customer-verify deep link', () => {
    expect(verifyReminderRoute('proj-42')).toBe('/customer/projects/proj-42/spatial/verify')
  })
})

// ── de-dup (F17 · hourly cron must not re-fire the same channel) ───────────

describe('resolveVerifyReminderChannel · de-dup', () => {
  const lastActive = NOW - VERIFY_REMINDER_PUSH_MS // 24h ago → push due

  it('without de-dup state stays purely time-driven (back-compat)', () => {
    expect(resolveVerifyReminderChannel('not_started', lastActive, NOW)).toBe('push')
  })

  it('suppresses a `push` already sent for the same activity anchor', () => {
    // The cron ran an hour ago, sent the push; this run must NOT re-fire it.
    expect(
      resolveVerifyReminderChannel('not_started', lastActive, NOW, {
        lastReminderSentAtMs: NOW - 60 * 60 * 1000,
        lastReminderChannel: 'push',
      }),
    ).toBe('none')
  })

  it('still escalates to `email` at 72h even though a `push` was already sent', () => {
    const lastActive72 = NOW - VERIFY_REMINDER_EMAIL_MS // 72h ago → email due
    expect(
      resolveVerifyReminderChannel('in_progress', lastActive72, NOW, {
        lastReminderSentAtMs: NOW - VERIFY_REMINDER_PUSH_MS, // push sent 24h-window ago
        lastReminderChannel: 'push',
      }),
    ).toBe('email')
  })

  it('suppresses an `email` already sent for the same activity anchor', () => {
    const lastActive72 = NOW - VERIFY_REMINDER_EMAIL_MS
    expect(
      resolveVerifyReminderChannel('in_progress', lastActive72, NOW, {
        lastReminderSentAtMs: NOW - 60 * 60 * 1000,
        lastReminderChannel: 'email',
      }),
    ).toBe('none')
  })

  it('re-activity newer than the last reminder restarts the cadence', () => {
    // The customer opened the sheet AFTER the prior push — the anchor moved,
    // so a fresh push is due again 24h later.
    expect(
      resolveVerifyReminderChannel('not_started', lastActive, NOW, {
        lastReminderSentAtMs: lastActive - 60 * 60 * 1000, // sent BEFORE last activity
        lastReminderChannel: 'push',
      }),
    ).toBe('push')
  })

  it('does not de-dup when the reminder state is incomplete', () => {
    expect(
      resolveVerifyReminderChannel('not_started', lastActive, NOW, {
        lastReminderSentAtMs: NOW,
        lastReminderChannel: null,
      }),
    ).toBe('push')
    expect(
      resolveVerifyReminderChannel('not_started', lastActive, NOW, {
        lastReminderSentAtMs: null,
        lastReminderChannel: 'push',
      }),
    ).toBe('push')
  })
})

describe('buildVerifyReminderSignal · de-dup', () => {
  it('returns null when the due channel was already sent', () => {
    expect(
      buildVerifyReminderSignal(
        'scene-1',
        'proj-1',
        'not_started',
        NOW - VERIFY_REMINDER_PUSH_MS,
        NOW,
        { lastReminderSentAtMs: NOW - 60 * 60 * 1000, lastReminderChannel: 'push' },
      ),
    ).toBeNull()
  })

  it('still builds the email escalation signal after a prior push', () => {
    const signal = buildVerifyReminderSignal(
      'scene-1',
      'proj-1',
      'in_progress',
      NOW - VERIFY_REMINDER_EMAIL_MS,
      NOW,
      { lastReminderSentAtMs: NOW - VERIFY_REMINDER_PUSH_MS, lastReminderChannel: 'push' },
    )
    expect(signal?.channel).toBe('email')
  })
})
