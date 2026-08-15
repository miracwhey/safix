import { describe, it, expect } from 'vitest'
import { resolveEffectiveState } from '../../src/lib/subscription/resolveEffectiveState'
import type { SubscriptionRow } from '../../src/lib/subscription/types'

const NOW = new Date('2026-05-08T12:00:00Z')

function row(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: 'sub-1',
    profile_id: 'u-1',
    status: 'trial_available',
    trial_started_at: null,
    trial_ends_at: null,
    current_period_start: null,
    current_period_end: null,
    canceled_at: null,
    grace_started_at: null,
    billing_provider: null,
    billing_provider_subscription_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('resolveEffectiveState', () => {
  it('trial_available → trial_available', () => {
    expect(resolveEffectiveState(row({ status: 'trial_available' }), NOW)).toBe('trial_available')
  })

  it('active → active', () => {
    expect(resolveEffectiveState(row({ status: 'active' }), NOW)).toBe('active')
  })

  it('grace → grace', () => {
    expect(resolveEffectiveState(row({ status: 'grace' }), NOW)).toBe('grace')
  })

  it('expired → expired', () => {
    expect(resolveEffectiveState(row({ status: 'expired' }), NOW)).toBe('expired')
  })

  describe('trial_active', () => {
    it('trial ends in the future → trial_active', () => {
      const endsAt = new Date(NOW.getTime() + 1000).toISOString()
      expect(resolveEffectiveState(row({ status: 'trial_active', trial_ends_at: endsAt }), NOW)).toBe('trial_active')
    })

    it('trial ends at exactly now → expired', () => {
      expect(resolveEffectiveState(row({ status: 'trial_active', trial_ends_at: NOW.toISOString() }), NOW)).toBe('expired')
    })

    it('trial ended in the past → expired', () => {
      const ended = new Date(NOW.getTime() - 1000).toISOString()
      expect(resolveEffectiveState(row({ status: 'trial_active', trial_ends_at: ended }), NOW)).toBe('expired')
    })

    it('null trial_ends_at → trial_active (no expiry)', () => {
      expect(resolveEffectiveState(row({ status: 'trial_active', trial_ends_at: null }), NOW)).toBe('trial_active')
    })
  })

  describe('canceled', () => {
    it('current_period_end in the future → canceled', () => {
      const future = new Date(NOW.getTime() + 86400_000).toISOString()
      expect(resolveEffectiveState(row({ status: 'canceled', current_period_end: future }), NOW)).toBe('canceled')
    })

    it('current_period_end at exactly now → expired', () => {
      expect(resolveEffectiveState(row({ status: 'canceled', current_period_end: NOW.toISOString() }), NOW)).toBe('expired')
    })

    it('current_period_end in the past → expired', () => {
      const past = new Date(NOW.getTime() - 86400_000).toISOString()
      expect(resolveEffectiveState(row({ status: 'canceled', current_period_end: past }), NOW)).toBe('expired')
    })

    it('null current_period_end → canceled (no expiry boundary → stays canceled)', () => {
      expect(resolveEffectiveState(row({ status: 'canceled', current_period_end: null }), NOW)).toBe('canceled')
    })
  })
})
