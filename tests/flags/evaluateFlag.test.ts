import { describe, it, expect } from 'vitest'
import { evaluateFlag } from '../../src/lib/flags/evaluateFlag'
import type { FeatureFlag } from '../../src/lib/flags/types'

function flag(partial: Partial<FeatureFlag>): FeatureFlag {
  return {
    key: partial.key ?? 'f',
    enabled: partial.enabled ?? true,
    rolloutPct: partial.rolloutPct ?? 100,
    targetRoles: partial.targetRoles ?? [],
    targetRegions: partial.targetRegions ?? [],
  }
}

const actor = { userId: 'user-1', role: 'customer' }

describe('evaluateFlag — fail-closed', () => {
  it('absent flag is OFF', () => {
    expect(evaluateFlag(undefined, actor)).toBe(false)
  })

  it('disabled flag is OFF even at 100% rollout', () => {
    expect(evaluateFlag(flag({ enabled: false, rolloutPct: 100 }), actor)).toBe(false)
  })

  it('enabled + 100% + no targeting is ON', () => {
    expect(evaluateFlag(flag({ enabled: true, rolloutPct: 100 }), actor)).toBe(true)
  })

  it('0% rollout is OFF', () => {
    expect(evaluateFlag(flag({ rolloutPct: 0 }), actor)).toBe(false)
  })
})

describe('evaluateFlag — role targeting', () => {
  it('OFF when the actor role is not in a non-empty allowlist', () => {
    expect(evaluateFlag(flag({ targetRoles: ['owner'] }), { userId: 'u', role: 'customer' })).toBe(false)
  })

  it('ON when the actor role is in the allowlist', () => {
    expect(evaluateFlag(flag({ targetRoles: ['owner', 'customer'] }), { userId: 'u', role: 'customer' })).toBe(true)
  })

  it('OFF when targeted but the actor has no resolvable role', () => {
    expect(evaluateFlag(flag({ targetRoles: ['owner'] }), { userId: 'u' })).toBe(false)
  })

  it('empty allowlist targets everyone', () => {
    expect(evaluateFlag(flag({ targetRoles: [] }), { userId: 'u', role: 'employee' })).toBe(true)
  })
})

describe('evaluateFlag — staged rollout bucket', () => {
  it('anonymous actor is OFF for a partial rollout (cannot bucket)', () => {
    expect(evaluateFlag(flag({ rolloutPct: 50 }), { role: 'customer' })).toBe(false)
  })

  it('is deterministic for the same key + user', () => {
    const f = flag({ key: 'stable', rolloutPct: 50 })
    const a = { userId: 'abc', role: 'customer' }
    expect(evaluateFlag(f, a)).toBe(evaluateFlag(f, a))
  })

  it('is monotonic in rollout_pct for a fixed user (in at X ⟹ in at >X)', () => {
    const a = { userId: 'monotonic-user', role: 'customer' }
    const inAt30 = evaluateFlag(flag({ key: 'k', rolloutPct: 30 }), a)
    const inAt60 = evaluateFlag(flag({ key: 'k', rolloutPct: 60 }), a)
    if (inAt30) expect(inAt60).toBe(true)
  })

  it('distributes roughly proportionally across users at 50%', () => {
    let on = 0
    const N = 400
    for (let i = 0; i < N; i++) {
      if (evaluateFlag(flag({ key: 'dist', rolloutPct: 50 }), { userId: `u${i}`, role: 'customer' })) on++
    }
    // Loose bounds — just assert it's neither all-on nor all-off.
    expect(on).toBeGreaterThan(N * 0.3)
    expect(on).toBeLessThan(N * 0.7)
  })
})

describe('evaluateFlag — region reserved', () => {
  it('ignores targetRegions (does not block while region is unavailable)', () => {
    expect(evaluateFlag(flag({ targetRegions: ['hannover'] }), actor)).toBe(true)
  })
})
