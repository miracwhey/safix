export type {
  NotificationPriority,
  NotificationSignal,
  NotificationItem,
  AttentionRole,
  AttentionSeverity,
  AttentionCategory,
  AttentionItem,
  AttentionSummary,
} from './types'

export {
  NOTIFICATION_EVENT_CONFIG,
  getNotificationPriority,
  isNotifiableEventType,
  NOTIFICATION_ROLE_RELEVANCE,
  getNotificationRoleRelevance,
} from './notificationConfig'

export {
  subscribeNotifications,
  getNotificationSignals,
  getNotificationSignalsForJob,
  getUnreadNotificationSignals,
  isNotificationRepositoryHydrated,
} from './notificationStore'

export {
  addNotificationSignal,
  markNotificationRead,
  markAllNotificationsRead,
} from './notificationService'

export {
  mapSignalToNotificationItem,
  buildNotificationItems,
  buildNotificationItemsForRole,
  groupNotificationsByPriority,
} from './notificationSelectors'

export {
  startNotificationBridge,
  stopNotificationBridge,
} from './notificationBridge'

export {
  deriveAttentionItems,
  getAttentionItemsForRole,
  getAttentionItemsByCategory,
  buildAttentionSummary,
} from './attentionSelectors'

export type { NotificationRepository } from './repository'
export { getNotificationRepository, setNotificationRepository, initializeNotificationRepository, SupabaseNotificationRepository } from './repository'
