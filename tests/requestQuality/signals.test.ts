import { describe, it, expect } from 'vitest'
import { deriveRequestQualitySignals } from '../../src/lib/requestQuality/signals'

describe('deriveRequestQualitySignals', () => {
  it('maps reel inquiryCriteria into completeness signals', () => {
    const s = deriveRequestQualitySignals({
      inquiryOrigin: 'reel',
      inquiryCriteria: {
        category: 'Bad',
        description: 'Fliesen im Bad komplett erneuern',
        location: 'Linden',
        budget: '2000',
        timing: 'bald',
      },
      hasProjectAttachment: false,
    })
    expect(s.hasCategory).toBe(true)
    expect(s.hasLocation).toBe(true)
    expect(s.hasBudget).toBe(true)
    expect(s.hasTiming).toBe(true)
    expect(s.description).toBe('Fliesen im Bad komplett erneuern')
    expect(s.origin).toBe('reel')
    expect(s.hasStructuredProject).toBe(false)
  })

  it('prefers explicit conversation fields over reel criteria', () => {
    const s = deriveRequestQualitySignals({
      inquiryOrigin: 'category',
      projectDescription: 'Explizite Beschreibung',
      projectLocation: 'List',
      projectCostRange: '5.000 €',
      projectDuration: '2 Wochen',
      inquiryCriteria: { category: 'Elektrik', description: 'reel desc', location: 'reel loc' },
      hasProjectAttachment: false,
    })
    expect(s.description).toBe('Explizite Beschreibung')
    expect(s.hasLocation).toBe(true)
    expect(s.hasBudget).toBe(true)
    expect(s.hasTiming).toBe(true)
    expect(s.hasCategory).toBe(true)
  })

  it('falls back to linked project category + description for project origin', () => {
    const s = deriveRequestQualitySignals({
      inquiryOrigin: 'project',
      linkedProjectCategory: 'Elektrik',
      linkedProjectDescription: 'Neuverkabelung im Altbau, mehrere Räume.',
      hasProjectAttachment: true,
    })
    expect(s.hasCategory).toBe(true)
    expect(s.description).toBe('Neuverkabelung im Altbau, mehrere Räume.')
    expect(s.hasStructuredProject).toBe(true)
  })

  it('treats profile origin (no category/timing) as absent signals', () => {
    const s = deriveRequestQualitySignals({
      inquiryOrigin: 'profile',
      projectLocation: 'Südstadt',
      hasProjectAttachment: false,
    })
    expect(s.hasCategory).toBe(false)
    expect(s.hasTiming).toBe(false)
    expect(s.hasBudget).toBe(false)
    expect(s.hasLocation).toBe(true)
    expect(s.origin).toBe('profile')
  })

  it('ignores blank / whitespace-only fields', () => {
    const s = deriveRequestQualitySignals({
      inquiryOrigin: 'category',
      projectLocation: '   ',
      projectCostRange: '',
      hasProjectAttachment: false,
    })
    expect(s.hasLocation).toBe(false)
    expect(s.hasBudget).toBe(false)
  })

  it('passes enrichment through and leaves deferred signals undefined', () => {
    const s = deriveRequestQualitySignals({
      inquiryOrigin: 'category',
      hasProjectAttachment: true,
      isReturningCustomer: true,
    })
    expect(s.isReturningCustomer).toBe(true)
    expect(s.customerVerified).toBeUndefined()
    expect(s.customerHasRealProfile).toBeUndefined()
    expect(s.hasSpatialScan).toBeUndefined()
  })

  it('passes a null origin through unchanged', () => {
    const s = deriveRequestQualitySignals({
      inquiryOrigin: null,
      hasProjectAttachment: false,
    })
    expect(s.origin).toBeNull()
    expect(s.hasCategory).toBe(false)
  })
})
