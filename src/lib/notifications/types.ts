import type { ProjectTimelineEventType } from '../timeline'

export type NotificationPriority = 'info' | 'action' | 'alert'

export type NotificationSignal = {
  id: string
  jobId: string
  type: ProjectTimelineEventType
  priority: NotificationPriority
  read: boolean
  occurredAt: number
  recipientRole: 'customer' | 'craftsman'
  // A.2 — inline-action fields; present only when the push has Lockscreen buttons.
  entityId?: string
  entityType?: string
  actionType?: string
  roleTarget?: string
  expectedStatus?: string
  expiresAt?: number
}

export type NotificationItem = NotificationSignal & {
  title: string
  description: string
  label: string
}

// ---------------------------------------------------------------------------
// Attention system types
// ---------------------------------------------------------------------------

export type AttentionRole = 'customer' | 'craftsman' | 'admin'

export type AttentionSeverity = 'urgent' | 'action' | 'waiting' | 'info'

export type AttentionCategory =
  | 'dispute'
  | 'payment'
  | 'scheduling'
  | 'job'
  | 'message'

/**
 * Optional inline call-to-action embedded in an `AttentionItem`. When set,
 * UI renderers should surface a primary action button alongside the normal
 * navigation target so the user can act without going through the detail
 * screen first. Selectors set `primaryAction` only when the underlying
 * domain state actually permits the action — Mockup-Edge: never render a
 * phantom button on read-only states. (Block N3c.)
 */
export type AttentionPrimaryAction = {
  /** Button label (de-DE), e.g. "Stellungnahme senden". */
  label: string
  /** Route target — typically same as `linkTo`, but explicit for clarity. */
  to: string
}

export type AttentionItem = {
  id: string
  jobId: string
  severity: AttentionSeverity
  category: AttentionCategory
  title: string
  description: string
  icon: string
  /** Roles for which this item is relevant */
  roles: AttentionRole[]
  occurredAt: number
  /** Deep-link target for the item */
  linkTo: string
  /**
   * Optional customer-side override for `linkTo`. Set on items whose `roles`
   * array contains 'customer' alongside other roles, so customer viewers
   * route to their project surface (`/projects/:projectId`) while craftsman
   * and admin viewers stay on `/craftsman/jobs/:jobId`. The render layer
   * picks the appropriate target via the viewer's role. (Block 7.2.8 —
   * fixes Customer-linkTo-Routing for multi-role attention items.)
   */
  customerLinkTo?: string
  /** Optional inline action — see `AttentionPrimaryAction`. */
  primaryAction?: AttentionPrimaryAction
}

export type AttentionSummary = {
  urgentCount: number
  actionCount: number
  waitingCount: number
  totalCount: number
  items: AttentionItem[]
}
