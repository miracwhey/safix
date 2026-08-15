/**
 * Spatial · Hub · hubFilterModel (V1.5 · Phase B-P3)
 *
 * Value-types + helpers for the Hub-Filter sheet. Lives in its own file so the
 * sheet component file stays exclusively component-exports (Vite fast-refresh
 * needs that to hot-swap React components without losing state).
 */

export type HubFilterStatus = 'all' | 'neu' | 'quoting' | 'aktiv' | 'fertig' | 'presales'
export type HubFilterDate = 'all' | 'today' | 'week' | 'month'
export type HubFilterSource = 'all' | 'job' | 'presales'

export interface HubFilterValue {
  status: HubFilterStatus
  date: HubFilterDate
  source: HubFilterSource
}

export const DEFAULT_HUB_FILTER: HubFilterValue = {
  status: 'all',
  date: 'all',
  source: 'all',
}

export function isHubFilterActive(value: HubFilterValue): boolean {
  return (
    value.status !== DEFAULT_HUB_FILTER.status ||
    value.date !== DEFAULT_HUB_FILTER.date ||
    value.source !== DEFAULT_HUB_FILTER.source
  )
}
