import type { DisputeCenterItem } from './disputeSelectors'

/**
 * Filters dispute center items by a free-text search query.
 *
 * Matches against title, description, reason label, status label, and job ID.
 * Case-insensitive. Returns all items when the query is empty.
 *
 * Pure function — no store reads, no side effects.
 */
export function searchDisputeCenterItems(
  query: string,
  items: DisputeCenterItem[]
): DisputeCenterItem[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return items

  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(normalized) ||
      item.description.toLowerCase().includes(normalized) ||
      item.reasonLabel.toLowerCase().includes(normalized) ||
      item.statusLabel.toLowerCase().includes(normalized) ||
      item.jobId.toLowerCase().includes(normalized)
  )
}

export type DisputeUrgencyFilter = 'critical' | 'elevated' | 'normal'

/**
 * Filters dispute center items by urgency level.
 *
 * Returns all items when urgency is null (no active filter).
 *
 * Pure function — no store reads, no side effects.
 */
export function filterDisputeItems(
  urgency: DisputeUrgencyFilter | null,
  items: DisputeCenterItem[]
): DisputeCenterItem[] {
  if (!urgency) return items
  return items.filter((item) => item.urgencyLevel === urgency)
}
