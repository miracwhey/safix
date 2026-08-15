import { describe, it, expect, beforeEach, vi } from 'vitest'

const { scheduleMock } = vi.hoisted(() => ({
  scheduleMock: vi.fn(async () => undefined),
}))

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: scheduleMock,
  },
}))

import {
  emitSuccessNotif,
  emitFailureNotif,
  __testOnly_resetFeedbackDedup,
} from '../../src/lib/notifications/pushActionFeedback'

const NOW = 1_746_374_400_000

beforeEach(() => {
  __testOnly_resetFeedbackDedup()
  scheduleMock.mockClear()
  scheduleMock.mockImplementation(async () => undefined)
})

describe('Block A3 · pushActionFeedback — emitSuccessNotif', () => {
  it('schedules a German "Korrektur angenommen" notification for APPROVE', async () => {
    await emitSuccessNotif(
      { entityType: 'correction', entityId: 'c-1', action: 'APPROVE' },
      { now: NOW },
    )
    expect(scheduleMock).toHaveBeenCalledTimes(1)
    const arg = scheduleMock.mock.calls[0][0]
    expect(arg.notifications[0]).toMatchObject({
      title: 'Korrektur angenommen',
      body: 'Der Vorschlag wurde übernommen.',
    })
  })

  it('schedules a German "Korrektur abgelehnt" notification for REJECT', async () => {
    await emitSuccessNotif(
      { entityType: 'correction', entityId: 'c-2', action: 'REJECT' },
      { now: NOW },
    )
    expect(scheduleMock).toHaveBeenCalledTimes(1)
    expect(scheduleMock.mock.calls[0][0].notifications[0]).toMatchObject({
      title: 'Korrektur abgelehnt',
    })
  })

  it('dedupes a duplicate emit within 30s', async () => {
    await emitSuccessNotif(
      { entityType: 'correction', entityId: 'c-1', action: 'APPROVE' },
      { now: NOW },
    )
    await emitSuccessNotif(
      { entityType: 'correction', entityId: 'c-1', action: 'APPROVE' },
      { now: NOW + 5_000 },
    )
    expect(scheduleMock).toHaveBeenCalledTimes(1)
  })

  it('does not crash if the plugin throws — falls back to logged error', async () => {
    scheduleMock.mockRejectedValueOnce(new Error('plugin-not-available'))
    await expect(
      emitSuccessNotif(
        { entityType: 'correction', entityId: 'c-1', action: 'APPROVE' },
        { now: NOW },
      ),
    ).resolves.toBeUndefined()
  })
})

describe('Block A3 · pushActionFeedback — emitFailureNotif', () => {
  it('uses the user-readable body for expired actions', async () => {
    await emitFailureNotif({ reason: 'expired' }, { now: NOW })
    expect(scheduleMock).toHaveBeenCalledTimes(1)
    expect(scheduleMock.mock.calls[0][0].notifications[0].body).toBe(
      'Veraltete Aktion. App öffnen für aktuellen Stand.',
    )
  })

  it('uses the role_mismatch copy when the wrong account is logged in', async () => {
    await emitFailureNotif({ reason: 'role_mismatch' }, { now: NOW })
    expect(scheduleMock.mock.calls[0][0].notifications[0].body).toContain('Konto wechseln')
  })

  it('skips silently for duplicate_tap (no nag-notif)', async () => {
    await emitFailureNotif({ reason: 'duplicate_tap' }, { now: NOW })
    expect(scheduleMock).not.toHaveBeenCalled()
  })

  it('uses the workflow_failed copy after a failed sheet-submit', async () => {
    await emitFailureNotif({ reason: 'workflow_failed' }, { now: NOW })
    expect(scheduleMock.mock.calls[0][0].notifications[0].body).toBe(
      'App öffnen — Aktion konnte nicht ausgeführt werden.',
    )
  })
})
