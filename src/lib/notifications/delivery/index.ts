export type {
  NotificationDeliveryRecipientRole,
  NotificationDeliveryPayload,
  DeliveryResult,
} from './types.js'
export type { NotificationDeliveryType } from './types.js'
export { VALID_DELIVERY_TYPES } from './types.js'

export { buildEmailContent } from './templates.js'
export type { EmailContent } from './templates.js'

export {
  sendProposalReceivedEmail,
  sendScheduleCreatedEmail,
  sendScheduleUpdatedEmail,
  sendWorkCompletedEmail,
  sendPaymentReleaseRequestedEmail,
  sendDisputeOpenedEmail,
  sendDisputeEvidenceRequestedEmail,
  sendEscrowLockedEmail,
  sendPaymentReleasedEmail,
  sendPayoutHandoffInitiatedEmail,
} from './deliveryService.js'
