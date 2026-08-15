import { describe, it, expect } from 'vitest'
import {
  searchDisputeCenterItems,
  filterDisputeItems,
} from '../../src/lib/disputes/searchSelectors'
import type { DisputeCenterItem } from '../../src/lib/disputes/disputeSelectors'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEMS: DisputeCenterItem[] = [
  {
    id: 'dispute-1',
    jobId: 'job-1',
    title: 'Schlechte Arbeitsqualität beim Badezimmer',
    reasonLabel: 'Arbeitsqualität',
    statusLabel: 'Offen',
    description: 'Das Ergebnis entspricht nicht den Vereinbarungen.',
    canRelease: true,
    canRefund: true,
    isResolved: false,
    dispute: {
      id: 'dispute-1',
      jobId: 'job-1',
      status: 'open',
      reason: 'work_quality',
      title: 'Schlechte Arbeitsqualität beim Badezimmer',
      description: 'Das Ergebnis entspricht nicht den Vereinbarungen.',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    ageDays: 2,
    ageLabel: 'Seit 2 Tagen',
    urgencyLevel: 'normal',
  },
  {
    id: 'dispute-2',
    jobId: 'job-2',
    title: 'Verzögerung bei Dachdeckerarbeiten',
    reasonLabel: 'Verzögerung',
    statusLabel: 'In Prüfung',
    description: 'Die Arbeiten wurden nicht fristgerecht abgeschlossen.',
    canRelease: true,
    canRefund: true,
    isResolved: false,
    dispute: {
      id: 'dispute-2',
      jobId: 'job-2',
      status: 'under_review',
      reason: 'delay',
      title: 'Verzögerung bei Dachdeckerarbeiten',
      description: 'Die Arbeiten wurden nicht fristgerecht abgeschlossen.',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    ageDays: 5,
    ageLabel: 'Seit 5 Tagen',
    urgencyLevel: 'elevated',
  },
  {
    id: 'dispute-3',
    jobId: 'job-3',
    title: 'Zahlungskonflikt Malerarbeiten',
    reasonLabel: 'Zahlungskonflikt',
    statusLabel: 'Freigabe entschieden',
    description: 'Betrag wurde bereits gezahlt.',
    canRelease: false,
    canRefund: false,
    isResolved: true,
    resolvedAt: 1_700_100_000_000,
    dispute: {
      id: 'dispute-3',
      jobId: 'job-3',
      status: 'resolved_release',
      reason: 'payment_conflict',
      title: 'Zahlungskonflikt Malerarbeiten',
      description: 'Betrag wurde bereits gezahlt.',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_100_000_000,
      resolvedAt: 1_700_100_000_000,
    },
    ageDays: 1,
    ageLabel: 'Seit gestern',
    urgencyLevel: 'normal',
  },
]

// ---------------------------------------------------------------------------
// Empty / whitespace queries
// ---------------------------------------------------------------------------

describe('searchDisputeCenterItems – empty query', () => {
  it('returns all items when query is empty', () => {
    expect(searchDisputeCenterItems('', ITEMS)).toHaveLength(3)
  })

  it('returns all items when query is whitespace', () => {
    expect(searchDisputeCenterItems('  ', ITEMS)).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Title match
// ---------------------------------------------------------------------------

describe('searchDisputeCenterItems – title match', () => {
  it('finds an item by title substring', () => {
    const results = searchDisputeCenterItems('badezimmer', ITEMS)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('dispute-1')
  })

  it('is case-insensitive', () => {
    const results = searchDisputeCenterItems('DACHDECKER', ITEMS)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('dispute-2')
  })
})

// ---------------------------------------------------------------------------
// Description match
// ---------------------------------------------------------------------------

describe('searchDisputeCenterItems – description match', () => {
  it('finds an item by description keyword', () => {
    const results = searchDisputeCenterItems('fristgerecht', ITEMS)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('dispute-2')
  })
})

// ---------------------------------------------------------------------------
// Reason label match
// ---------------------------------------------------------------------------

describe('searchDisputeCenterItems – reason label match', () => {
  it('finds items by reason label', () => {
    const results = searchDisputeCenterItems('arbeitsqualität', ITEMS)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('dispute-1')
  })

  it('finds items by partial reason label', () => {
    const results = searchDisputeCenterItems('verzögerung', ITEMS)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('dispute-2')
  })
})

// ---------------------------------------------------------------------------
// Status label match
// ---------------------------------------------------------------------------

describe('searchDisputeCenterItems – status label match', () => {
  it('finds open disputes by status label', () => {
    const results = searchDisputeCenterItems('offen', ITEMS)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('dispute-1')
  })

  it('finds in-review disputes by status label', () => {
    const results = searchDisputeCenterItems('prüfung', ITEMS)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('dispute-2')
  })
})

// ---------------------------------------------------------------------------
// jobId match
// ---------------------------------------------------------------------------

describe('searchDisputeCenterItems – jobId match', () => {
  it('finds an item by exact jobId', () => {
    const results = searchDisputeCenterItems('job-3', ITEMS)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('dispute-3')
  })
})

// ---------------------------------------------------------------------------
// No match
// ---------------------------------------------------------------------------

describe('searchDisputeCenterItems – no match', () => {
  it('returns empty array when nothing matches', () => {
    expect(searchDisputeCenterItems('xyz-no-match-999', ITEMS)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// filterDisputeItems
// ---------------------------------------------------------------------------

describe('filterDisputeItems – no filter', () => {
  it('returns all items when urgency is null', () => {
    expect(filterDisputeItems(null, ITEMS)).toHaveLength(3)
  })
})

describe('filterDisputeItems – urgency filter', () => {
  it('returns only normal-urgency items', () => {
    const results = filterDisputeItems('normal', ITEMS)
    expect(results.length).toBeGreaterThan(0)
    results.forEach((i) => expect(i.urgencyLevel).toBe('normal'))
  })

  it('returns only elevated-urgency items', () => {
    const results = filterDisputeItems('elevated', ITEMS)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('dispute-2')
  })

  it('returns empty array when no items match urgency', () => {
    expect(filterDisputeItems('critical', ITEMS)).toHaveLength(0)
  })
})

describe('filterDisputeItems – combined with search', () => {
  it('filter then search: elevated urgency + title keyword', () => {
    const filtered = filterDisputeItems('elevated', ITEMS)
    const searched = filtered.filter((i) => i.title.toLowerCase().includes('dachdecker'))
    expect(searched).toHaveLength(1)
    expect(searched[0].id).toBe('dispute-2')
  })

  it('filter then search: no match when criteria do not overlap', () => {
    const filtered = filterDisputeItems('elevated', ITEMS)
    const searched = filtered.filter((i) => i.title.toLowerCase().includes('badezimmer'))
    expect(searched).toHaveLength(0)
  })
})
