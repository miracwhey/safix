import { describe, it, expect } from 'vitest'
import {
  searchOperatorPriorityCases,
  searchOperatorPilotCases,
  filterOperatorPriorityCases,
  filterOperatorPilotCases,
} from '../../src/lib/operators/searchSelectors'
import type { OperatorPriorityCase } from '../../src/lib/jobs/operatorPrioritySelectors'
import type { OperatorCase } from '../../src/lib/operators/operatorCaseSelectors'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRIORITY_CASES: OperatorPriorityCase[] = [
  {
    jobId: 'job-1',
    type: 'dispute',
    label: 'Dispute: Badezimmer renovieren',
    severity: 'high',
    actionRoute: '/craftsman/disputes',
  },
  {
    jobId: 'job-2',
    type: 'stale_payment',
    label: 'Stale Payment: Dachdeckerarbeiten',
    severity: 'high',
    actionRoute: '/craftsman/jobs/job-2',
  },
  {
    jobId: 'job-3',
    type: 'stuck_job',
    label: 'Stuck in Scheduling: Malerarbeiten',
    severity: 'medium',
    actionRoute: '/craftsman/jobs/job-3',
  },
]

const PILOT_CASES: OperatorCase[] = [
  {
    type: 'open_dispute',
    severity: 'critical',
    jobId: 'job-1',
    title: 'Badezimmer renovieren',
    description: 'Streitfall geöffnet: Qualitätsmangel',
    ageHours: 48,
  },
  {
    type: 'stuck_inquiry',
    severity: 'medium',
    jobId: 'job-4',
    title: 'Fußbodenheizung',
    description: 'Neue Anfrage ohne Angebot',
    ageHours: 0,
  },
  {
    type: 'payment_release_pending',
    severity: 'high',
    jobId: 'job-5',
    title: 'Küchenumbau',
    description: 'Zahlung wartet auf Freigabe seit 36h',
    ageHours: 36,
  },
]

// ---------------------------------------------------------------------------
// searchOperatorPriorityCases
// ---------------------------------------------------------------------------

describe('searchOperatorPriorityCases – empty query', () => {
  it('returns all cases when query is empty', () => {
    expect(searchOperatorPriorityCases('', PRIORITY_CASES)).toHaveLength(3)
  })

  it('returns all cases when query is whitespace', () => {
    expect(searchOperatorPriorityCases('   ', PRIORITY_CASES)).toHaveLength(3)
  })
})

describe('searchOperatorPriorityCases – label match', () => {
  it('finds a case by job title substring in label', () => {
    const results = searchOperatorPriorityCases('badezimmer', PRIORITY_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-1')
  })

  it('is case-insensitive', () => {
    const results = searchOperatorPriorityCases('BADEZIMMER', PRIORITY_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-1')
  })
})

describe('searchOperatorPriorityCases – type match', () => {
  it('finds cases by type keyword', () => {
    const results = searchOperatorPriorityCases('stale_payment', PRIORITY_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-2')
  })

  it('finds cases by dispute type', () => {
    const results = searchOperatorPriorityCases('dispute', PRIORITY_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-1')
  })
})

describe('searchOperatorPriorityCases – severity match', () => {
  it('finds all high-severity cases', () => {
    const results = searchOperatorPriorityCases('high', PRIORITY_CASES)
    expect(results).toHaveLength(2)
  })

  it('finds medium-severity cases', () => {
    const results = searchOperatorPriorityCases('medium', PRIORITY_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-3')
  })
})

describe('searchOperatorPriorityCases – jobId match', () => {
  it('finds a case by exact job ID', () => {
    const results = searchOperatorPriorityCases('job-3', PRIORITY_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('stuck_job')
  })
})

describe('searchOperatorPriorityCases – no match', () => {
  it('returns empty array when no cases match', () => {
    expect(searchOperatorPriorityCases('xyz-no-match', PRIORITY_CASES)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// searchOperatorPilotCases
// ---------------------------------------------------------------------------

describe('searchOperatorPilotCases – empty query', () => {
  it('returns all cases when query is empty', () => {
    expect(searchOperatorPilotCases('', PILOT_CASES)).toHaveLength(3)
  })
})

describe('searchOperatorPilotCases – title match', () => {
  it('finds a case by title substring', () => {
    const results = searchOperatorPilotCases('badezimmer', PILOT_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-1')
  })

  it('is case-insensitive', () => {
    const results = searchOperatorPilotCases('KÜCHE', PILOT_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-5')
  })
})

describe('searchOperatorPilotCases – description match', () => {
  it('finds a case by description keyword', () => {
    const results = searchOperatorPilotCases('freigabe', PILOT_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('payment_release_pending')
  })
})

describe('searchOperatorPilotCases – type match', () => {
  it('finds cases by type keyword', () => {
    const results = searchOperatorPilotCases('stuck_inquiry', PILOT_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-4')
  })
})

describe('searchOperatorPilotCases – severity match', () => {
  it('finds critical cases by severity', () => {
    const results = searchOperatorPilotCases('critical', PILOT_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].severity).toBe('critical')
  })
})

describe('searchOperatorPilotCases – no match', () => {
  it('returns empty array when no cases match', () => {
    expect(searchOperatorPilotCases('xyz-no-match', PILOT_CASES)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// filterOperatorPriorityCases
// ---------------------------------------------------------------------------

describe('filterOperatorPriorityCases – no filter', () => {
  it('returns all cases when severity is null', () => {
    expect(filterOperatorPriorityCases(null, PRIORITY_CASES)).toHaveLength(3)
  })
})

describe('filterOperatorPriorityCases – severity filter', () => {
  it('returns only high-severity cases', () => {
    const results = filterOperatorPriorityCases('high', PRIORITY_CASES)
    expect(results).toHaveLength(2)
    results.forEach((c) => expect(c.severity).toBe('high'))
  })

  it('returns only medium-severity cases', () => {
    const results = filterOperatorPriorityCases('medium', PRIORITY_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-3')
  })

  it('returns empty array when no cases match severity', () => {
    expect(filterOperatorPriorityCases('low', PRIORITY_CASES)).toHaveLength(0)
  })
})

describe('filterOperatorPriorityCases – combined with search', () => {
  it('filter then search: high severity + label keyword', () => {
    const filtered = filterOperatorPriorityCases('high', PRIORITY_CASES)
    const searched = filtered.filter((c) => c.label.toLowerCase().includes('badezimmer'))
    expect(searched).toHaveLength(1)
    expect(searched[0].jobId).toBe('job-1')
  })
})

// ---------------------------------------------------------------------------
// filterOperatorPilotCases
// ---------------------------------------------------------------------------

describe('filterOperatorPilotCases – no filter', () => {
  it('returns all cases when severity is null', () => {
    expect(filterOperatorPilotCases(null, PILOT_CASES)).toHaveLength(3)
  })
})

describe('filterOperatorPilotCases – severity filter', () => {
  it('returns only critical cases', () => {
    const results = filterOperatorPilotCases('critical', PILOT_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].severity).toBe('critical')
  })

  it('returns only high-severity cases', () => {
    const results = filterOperatorPilotCases('high', PILOT_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-5')
  })

  it('returns only medium-severity cases', () => {
    const results = filterOperatorPilotCases('medium', PILOT_CASES)
    expect(results).toHaveLength(1)
    expect(results[0].jobId).toBe('job-4')
  })

  it('returns empty array for severity with no matches', () => {
    const casesWithNoMedium: OperatorCase[] = PILOT_CASES.filter((c) => c.severity !== 'medium')
    expect(filterOperatorPilotCases('medium', casesWithNoMedium)).toHaveLength(0)
  })
})

describe('filterOperatorPilotCases – combined with search', () => {
  it('filter then search: critical severity + title keyword', () => {
    const filtered = filterOperatorPilotCases('critical', PILOT_CASES)
    const searched = filtered.filter((c) => c.title.toLowerCase().includes('badezimmer'))
    expect(searched).toHaveLength(1)
    expect(searched[0].jobId).toBe('job-1')
  })

  it('filter then search: no match when criteria do not overlap', () => {
    const filtered = filterOperatorPilotCases('critical', PILOT_CASES)
    const searched = filtered.filter((c) => c.title.toLowerCase().includes('küche'))
    expect(searched).toHaveLength(0)
  })
})
