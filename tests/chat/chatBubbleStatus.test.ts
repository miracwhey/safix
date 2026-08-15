import { describe, it, expect } from 'vitest'
import {
  bubbleStatusToken,
  bubbleStatusToneClass,
  shouldRenderBubbleStatus,
} from '../../src/components/chat/chatBubbleStatus'

describe('bubbleStatusToken', () => {
  it('maps pending to a clock glyph in the pending tone', () => {
    const token = bubbleStatusToken('pending')
    expect(token.glyph).toBe('clock')
    expect(token.tone).toBe('pending')
    expect(token.label).toMatch(/sendet/i)
  })

  it('maps sent to a single check in the muted tone', () => {
    const token = bubbleStatusToken('sent')
    expect(token.glyph).toBe('check')
    expect(token.tone).toBe('muted')
  })

  it('maps delivered to a double-check in the normal tone', () => {
    const token = bubbleStatusToken('delivered')
    expect(token.glyph).toBe('check-double')
    expect(token.tone).toBe('normal')
  })

  it('maps read to a double-check in the read tone (Cyan-jump anchor)', () => {
    const token = bubbleStatusToken('read')
    expect(token.glyph).toBe('check-double')
    expect(token.tone).toBe('read')
  })

  it('maps failed to an x-glyph in the error tone', () => {
    const token = bubbleStatusToken('failed')
    expect(token.glyph).toBe('x')
    expect(token.tone).toBe('error')
  })
})

describe('bubbleStatusToneClass', () => {
  it('returns cyan-300 on own bubbles for the read tone', () => {
    const cls = bubbleStatusToneClass('read', true)
    expect(cls).toContain('cyan-300')
  })

  it('returns a slate/cyan tone on peer bubbles', () => {
    const ownRead = bubbleStatusToneClass('read', true)
    const peerRead = bubbleStatusToneClass('read', false)
    expect(ownRead).not.toBe(peerRead)
  })

  it('returns visually distinct classes for each tone on own bubbles', () => {
    const tones: Array<'pending' | 'muted' | 'normal' | 'read' | 'error'> = [
      'pending', 'muted', 'normal', 'read', 'error',
    ]
    const classes = tones.map((t) => bubbleStatusToneClass(t, true))
    const unique = new Set(classes)
    // Read + error are required to be unique. The first three may collapse
    // to neighbouring whites, so we only require at least 4 distinct tones.
    expect(unique.size).toBeGreaterThanOrEqual(4)
    expect(classes[3]).toContain('cyan')
    expect(classes[4]).toContain('rose')
  })
})

describe('shouldRenderBubbleStatus', () => {
  it('renders only on own bubbles', () => {
    expect(shouldRenderBubbleStatus(true)).toBe(true)
    expect(shouldRenderBubbleStatus(false)).toBe(false)
  })
})
