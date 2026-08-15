import type { OperatorCase, OperatorCaseType } from './operatorCaseSelectors'

export type OperatorIssueCategoryId = 'disputes' | 'payments' | 'scheduling' | 'inquiries'

export type OperatorIssueGroup = {
  categoryId: OperatorIssueCategoryId
  label: string
  icon: string
  totalCount: number
  criticalCount: number
  highCount: number
  actionRoute: string
}

const CATEGORY_FOR_TYPE: Record<OperatorCaseType, OperatorIssueCategoryId> = {
  open_dispute: 'disputes',
  payment_release_pending: 'payments',
  payout_error: 'payments',
  execution_stuck: 'scheduling',
  execution_overdue: 'scheduling',
  scheduling_stuck: 'scheduling',
  proposal_pending: 'inquiries',
  stuck_inquiry: 'inquiries',
}

const GROUP_META: Record<OperatorIssueCategoryId, { label: string; icon: string; actionRoute: string }> = {
  disputes: { label: 'Streitfälle', icon: '⚖️', actionRoute: '/craftsman/disputes' },
  payments: { label: 'Zahlungen', icon: '💳', actionRoute: '/craftsman/finance' },
  scheduling: { label: 'Aufträge', icon: '🔨', actionRoute: '/craftsman/jobs' },
  inquiries: { label: 'Anfragen', icon: '📋', actionRoute: '/craftsman/jobs' },
}

/**
 * Groups operator cases into actionable categories.
 *
 * Returns groups sorted by urgency: critical first, then high, then total.
 * Only returns groups that have at least one case.
 *
 * Pure function — no store reads, no side effects.
 */
export function deriveOperatorIssueGroups(cases: OperatorCase[]): OperatorIssueGroup[] {
  const counts = {} as Record<OperatorIssueCategoryId, { total: number; critical: number; high: number }>
  for (const id of Object.keys(GROUP_META) as OperatorIssueCategoryId[]) {
    counts[id] = { total: 0, critical: 0, high: 0 }
  }

  for (const c of cases) {
    const cat = CATEGORY_FOR_TYPE[c.type]
    counts[cat].total++
    if (c.severity === 'critical') counts[cat].critical++
    else if (c.severity === 'high') counts[cat].high++
  }

  return (Object.keys(GROUP_META) as OperatorIssueCategoryId[])
    .filter((id) => counts[id].total > 0)
    .map((id) => ({
      categoryId: id,
      ...GROUP_META[id],
      totalCount: counts[id].total,
      criticalCount: counts[id].critical,
      highCount: counts[id].high,
    }))
    .sort((a, b) => {
      if (b.criticalCount !== a.criticalCount) return b.criticalCount - a.criticalCount
      if (b.highCount !== a.highCount) return b.highCount - a.highCount
      return b.totalCount - a.totalCount
    })
}

/**
 * Returns true if any group has at least one critical or high issue.
 * Useful for showing an "attention required" indicator.
 */
export function hasUrgentIssues(groups: OperatorIssueGroup[]): boolean {
  return groups.some((g) => g.criticalCount > 0 || g.highCount > 0)
}
