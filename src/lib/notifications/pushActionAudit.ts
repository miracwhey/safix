/**
 * Push-Action Audit-Adapter · Block A · M1
 *
 * Dünner Wrapper um den `record_push_action_attempt` RPC (Migration
 * `20260507000006_push_action_audit.sql`). Wird von der Push-Bridge
 * synchron-async aufgerufen, nachdem der Dispatcher `navigate_with_sheet`
 * zurückgibt — bevor wirklich navigiert wird.
 *
 * Architektur-Begründung: separater Adapter (kein direkter `supabase.rpc`-Call
 * in der Bridge), damit Tests gegen die Bridge die Bridge-Logik isolieren
 * können, ohne den Supabase-Client mocken zu müssen. Memory-Pflicht:
 * `feedback_workflow_layer_rbac_pflicht` — Repository/Adapter-Layer ist die
 * einzige Stelle, die persistente Idempotenz wirft.
 */

import { supabase } from '../supabase'
import { logError } from '../observability'

/**
 * Versucht, einen Push-Action-Tap atomar im Audit-Log zu registrieren.
 *
 * Returns:
 *   true  — erste Aufzeichnung dieses (notification_id, action_id)-Paars
 *           für den eingeloggten User. Caller darf weiternavigieren.
 *   false — Duplikat (Re-Tap aus Notification-Center nach App-Kill),
 *           fehlende Auth-Session, ungültige action_id, oder transient
 *           DB-Fehler. Caller MUSS abort + Failure-Notif emitten.
 *
 * Wirft nicht — RPC-Errors werden geloggt + als false returned. Das
 * sichere Default: bei jeder Unsicherheit nicht navigieren, damit der User
 * keine doppelte Workflow-Auslösung sieht.
 */
export async function recordPushActionAttempt(
  notificationId: string,
  actionId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('record_push_action_attempt', {
      p_notification_id: notificationId,
      p_action_id: actionId,
    })
    if (error) {
      logError('push.action.audit_rpc_error', error, {
        notificationId,
        actionId,
      })
      return false
    }
    return data === true
  } catch (err) {
    logError(
      'push.action.audit_rpc_threw',
      err instanceof Error ? err : undefined,
      { notificationId, actionId },
    )
    return false
  }
}
