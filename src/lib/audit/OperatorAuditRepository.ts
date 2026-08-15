import { supabase } from '../supabase'
import { logError } from '../observability'
import type { AuditEntry, AuditRepository } from './AuditRepository'

/**
 * Supabase-backed operator audit repository.
 *
 * Writes are fire-and-forget: the local workflow is never blocked or thrown
 * by an audit persistence failure. Errors are logged via logError so they
 * surface in Sentry without disrupting the caller.
 */
export class OperatorAuditRepository implements AuditRepository {
  insertAuditEntry(entry: AuditEntry): void {
    supabase
      .from('operator_action_audit')
      .insert({
        operator_id: entry.operatorId,
        action_type: entry.actionType,
        entity_type: entry.entityType,
        entity_id: entry.entityId ?? null,
        metadata: entry.metadata ?? null,
        created_at: Date.now(),
      })
      .then(({ error }) => {
        if (error) {
          logError('repository.audit.insert_failed', error, {
            operatorId: entry.operatorId,
            actionType: entry.actionType,
            entityType: entry.entityType,
            entityId: entry.entityId,
          })
        }
      })
  }
}
