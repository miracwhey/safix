import { describe, it, expect } from 'vitest'
import {
  FOCUS_SECTION_IDS,
  isAttentionFocus,
  resolveSectionId,
  withFocus,
  type AttentionFocus,
} from '../../src/lib/notifications/focusAnchors'

describe('focusAnchors registry', () => {
  it('enumerates the canonical focus → section-id pairs', () => {
    const expected: Record<AttentionFocus, string> = {
      payment: 'job-section-payment',
      dispute: 'job-section-dispute',
      documents: 'job-section-documents',
      timeline: 'job-section-timeline',
      offer: 'job-section-offer',
      assignment: 'job-section-assignment',
    }
    expect(FOCUS_SECTION_IDS).toEqual(expected)
  })

  it('drops `correction` from the whitelist (corrections live in their own surface)', () => {
    expect((FOCUS_SECTION_IDS as Record<string, string>).correction).toBeUndefined()
    expect(isAttentionFocus('correction')).toBe(false)
    expect(resolveSectionId('correction')).toBeNull()
  })

  it('isAttentionFocus rejects unknown / nullish values without throwing', () => {
    expect(isAttentionFocus('unknown')).toBe(false)
    expect(isAttentionFocus('')).toBe(false)
    expect(isAttentionFocus(null)).toBe(false)
    expect(isAttentionFocus(undefined)).toBe(false)
  })

  it('isAttentionFocus accepts every known focus', () => {
    for (const key of Object.keys(FOCUS_SECTION_IDS)) {
      expect(isAttentionFocus(key)).toBe(true)
    }
  })

  it('resolveSectionId returns the canonical id or null', () => {
    expect(resolveSectionId('payment')).toBe('job-section-payment')
    expect(resolveSectionId('assignment')).toBe('job-section-assignment')
    expect(resolveSectionId('not-a-focus')).toBeNull()
    expect(resolveSectionId(null)).toBeNull()
  })

  it('withFocus appends focus param using ? when path has no query', () => {
    expect(withFocus('/craftsman/jobs/abc', 'dispute')).toBe(
      '/craftsman/jobs/abc?focus=dispute',
    )
  })

  it('withFocus appends focus param using & when path already has a query', () => {
    expect(withFocus('/craftsman/jobs/abc?ref=push', 'payment')).toBe(
      '/craftsman/jobs/abc?ref=push&focus=payment',
    )
  })
})
