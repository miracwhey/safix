export type InAppNotificationType =
  | 'rating_received'
  | 'proposal_received'
  | 'job_completed'
  | 'payment_released'
  | 'payment_refunded'
  | 'payment_requested'
  | 'dispute_opened'
  | 'dispute_resolved'
  | 'onboarding_completed'
  | 'job_scheduled'
  | 'tranche_released'

export type InAppNotificationEntityType =
  | 'job'
  | 'payment'
  | 'dispute'
  | 'rating'
  | 'profile'
  | ''

export type InAppNotification = {
  id: string
  userId: string
  type: InAppNotificationType
  entityType: InAppNotificationEntityType
  entityId: string
  title: string
  message: string
  isRead: boolean
  createdAt: number
  recipientRole?: 'customer' | 'craftsman'
}
