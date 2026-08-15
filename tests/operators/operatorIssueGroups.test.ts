import { describe, it, expect } from 'vitest'
import {
  deriveOperatorIssueGroups,
  hasUrgentIssues,
} from '../../src/lib/operators/operatorIssueGroups'
import type { OperatorCase } from '../../src/lib/operators/operatorCaseSelectors'

function makeCase(
  type: OperatorCase['type'],
  severity: OperatorCase['severity'],
  id = 'job-1'
): OperatorCase {
  return {
    type,
    severity,
    jobId: id,
    title: 'Test Job',
    description: 'Test',
    ageHours: 10,
  }
}

describe('deriveOperatorIssueGroups', () => {
  it('returns empty array for no cases', () => {
    expect(deriveOperatorIssueGroups([])).toEqual([])
  })

  it('groups open_dispute into disputes category', () => {
    const groups = deriveOperatorIssueGroups([makeCase('open_dispute', 'critical')])
    expect(groups).toHaveLength(1)
    expect(groups[0].categoryId).toBe('disputes')
    expect(groups[0].totalCount).toBe(1)
    expect(groups[0].criticalCount).toBe(1)
  })

  it('groups payment_release_pending into payments category', () => {
    const groups = deriveOperatorIssueGroups([makeCase('payment_release_pending', 'high')])
    expect(groups).toHaveLength(1)
    expect(groups[0].categoryId).toBe('payments')
    expect(groups[0].highCount).toBe(1)
  })

  it('groups execution_stuck and scheduling_stuck into scheduling category', () => {
    const groups = deriveOperatorIssueGroups([
      makeCase('execution_stuck', 'high', 'job-1'),
      makeCase('scheduling_stuck', 'medium', 'job-2'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].categoryId).toBe('scheduling')
    expect(groups[0].totalCount).toBe(2)
    expect(groups[0].highCount).toBe(1)
  })

  it('groups stuck_inquiry and proposal_pending into inquiries category', () => {
    const groups = deriveOperatorIssueGroups([
      makeCase('stuck_inquiry', 'medium', 'job-1'),
      makeCase('proposal_pending', 'medium', 'job-2'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].categoryId).toBe('inquiries')
    expect(groups[0].totalCount).toBe(2)
  })

  it('returns multiple groups when multiple categories have cases', () => {
    const groups = deriveOperatorIssueGroups([
      makeCase('open_dispute', 'critical', 'job-1'),
      makeCase('payment_release_pending', 'high', 'job-2'),
      makeCase('stuck_inquiry', 'medium', 'job-3'),
    ])
    expect(groups.length).toBe(3)
  })

  it('sorts groups by criticalCount DESC then highCount DESC then totalCount DESC', () => {
    const groups = deriveOperatorIssueGroups([
      makeCase('stuck_inquiry', 'medium', 'job-1'),
      makeCase('payment_release_pending', 'high', 'job-2'),
      makeCase('open_dispute', 'critical', 'job-3'),
    ])
    expect(groups[0].categoryId).toBe('disputes')
    expect(groups[1].categoryId).toBe('payments')
    expect(groups[2].categoryId).toBe('inquiries')
  })

  it('each group has the correct actionRoute', () => {
    const groups = deriveOperatorIssueGroups([
      makeCase('open_dispute', 'critical'),
    ])
    expect(groups[0].actionRoute).toBe('/craftsman/disputes')
  })
})

describe('hasUrgentIssues', () => {
  it('returns false for empty groups', () => {
    expect(hasUrgentIssues([])).toBe(false)
  })

  it('returns true when any group has criticalCount > 0', () => {
    const groups = deriveOperatorIssueGroups([makeCase('open_dispute', 'critical')])
    expect(hasUrgentIssues(groups)).toBe(true)
  })

  it('returns true when any group has highCount > 0', () => {
    const groups = deriveOperatorIssueGroups([makeCase('payment_release_pending', 'high')])
    expect(hasUrgentIssues(groups)).toBe(true)
  })

  it('returns false when all groups are medium severity', () => {
    const groups = deriveOperatorIssueGroups([makeCase('stuck_inquiry', 'medium')])
    expect(hasUrgentIssues(groups)).toBe(false)
  })
})
