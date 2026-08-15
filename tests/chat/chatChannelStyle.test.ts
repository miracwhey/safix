import { describe, it, expect } from 'vitest'
import { channelStyle } from '../../src/components/chat/chatChannelStyle'

const ALL_CHANNELS = ['customer', 'office', 'team', 'assignment', 'dispute'] as const

describe('channelStyle', () => {
  it('returns a non-empty style for every channel type', () => {
    for (const c of ALL_CHANNELS) {
      const s = channelStyle(c)
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.ringClass).toMatch(/^ring-/)
      expect(s.pillBgClass).toMatch(/^bg-/)
      expect(s.pillTextClass).toMatch(/^text-/)
      expect(s.stripeClass).toMatch(/^bg-/)
    }
  })

  it('applies the canonical channel palette (ADR D-2)', () => {
    expect(channelStyle('customer').ringClass).toContain('blue')
    expect(channelStyle('office').ringClass).toContain('slate')
    expect(channelStyle('team').ringClass).toContain('emerald')
    expect(channelStyle('assignment').ringClass).toContain('amber')
    expect(channelStyle('dispute').ringClass).toContain('rose')
  })

  it('returns visually distinct stripes for each channel', () => {
    const stripes = ALL_CHANNELS.map((c) => channelStyle(c).stripeClass)
    expect(new Set(stripes).size).toBe(ALL_CHANNELS.length)
  })
})
