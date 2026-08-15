/**
 * Company-code rotation workflow.
 *
 * Three defense layers (mirrors 7.2.1c hardening pattern):
 *   1. UI gate (OwnerRouteGate) protects the screen.
 *   2. Workflow gate (assertOwnerRole) protects the imperative call.
 *   3. RPC-internal RBAC + RLS protect the database row.
 *
 * Members do NOT receive a server push from this workflow. The push
 * infrastructure (APNs send-side) is not present in the current codebase —
 * device-token registration exists, but no edge function dispatches to APNs.
 * In-app notification of existing members is intentionally deferred to the
 * server-push block; existing members do not need the new code (they are
 * already in team_members), so this is informational only.
 */

import type { SessionState } from '../session'
import { assertOwnerRole } from '../auth/rbacGuards'
import {
  rotateCompanyCode,
  sendCodeByEmail,
  type RotateCodeResult,
} from '../company/codeRotation'

export async function rotateCompanyCodeWorkflow(
  providerId: string,
  reason: string | undefined,
  session?: SessionState,
): Promise<RotateCodeResult> {
  assertOwnerRole(session)
  return rotateCompanyCode(providerId, reason)
}

/**
 * Mail-after-rotate result.
 *
 * Rotation is the primary action: when it fails, callers can stop. The mail
 * dispatch is best-effort — if the API rejects (rate limit, no stub match,
 * Resend outage) we still surface the new code so the owner sees the rotation
 * succeeded. The `mail` sub-shape lets the UI show "Code rotiert; Mail nicht
 * gesendet" without losing the rotation outcome.
 */
export type RotateAndMailStubResult =
  | {
      ok: true
      newCode: string
      newCodeId: string
      mail:
        | { sent: true; maskedEmail: string }
        | { sent: false; error: string }
    }
  | Extract<RotateCodeResult, { ok: false }>

/**
 * Owner-driven combo: rotate the code and immediately email the new code
 * to a specific stub member. Used by the Block 2 RotateCodeConfirmDialog
 * combo-button when exactly one stub still waits to join.
 *
 * The rotation runs first; only on success do we dispatch the email. This
 * way a mail-system outage cannot silently leave the active code unchanged.
 */
export async function rotateAndMailStubWorkflow(
  providerId: string,
  stubEmail: string,
  reason: string | undefined,
  session?: SessionState,
): Promise<RotateAndMailStubResult> {
  assertOwnerRole(session)
  const rotation = await rotateCompanyCode(providerId, reason)
  if (!rotation.ok) return rotation

  const mail = await sendCodeByEmail({ to: stubEmail })
  return {
    ok: true,
    newCode: rotation.newCode,
    newCodeId: rotation.newCodeId,
    mail: mail.ok
      ? { sent: true, maskedEmail: mail.maskedEmail }
      : { sent: false, error: mail.error },
  }
}
