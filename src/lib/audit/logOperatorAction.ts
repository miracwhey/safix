import { logInfo } from '../observability'
import { getAuditRepository } from './registry'

interface OperatorActionParams {
  operatorId: string
  actionType: string
  entityType: string
  entityId?: string
  metadata?: Record<string, unknown>
}

/**
 * Log a privileged operator action to the persistent audit trail and to the
 * observability layer.
 *
 * This function never throws. Failures in the underlying repository are
 * caught by the repository itself and logged via logError; the workflow
 * that called logOperatorAction is never disrupted.
 */
export function logOperatorAction(params: OperatorActionParams): void {
  const { operatorId, actionType, entityType, entityId, metadata } = params

  getAuditRepository().insertAuditEntry({
    operatorId,
    actionType,
    entityType,
    entityId,
    metadata,
  })

  logInfo('audit.operator_action', { operatorId, actionType, entityType, entityId })
}
