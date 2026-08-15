/**
 * Company code rotation domain.
 *
 * Owner-only operation that:
 *   1. Locks the active code row server-side via SECURITY DEFINER RPC.
 *   2. Generates a new code with CSPRNG (gen_random_bytes).
 *   3. Marks the old code as `rotated` (no re-join possible) but keeps
 *      every existing team_member row intact.
 *   4. Writes an immutable audit-log entry.
 *
 * RBAC and rate-limiting are enforced inside the RPC.
 * The TS layer is a thin transport wrapper plus an audit-log read for the UI.
 */

import { supabase } from '../supabase'
import { apiUrl } from '../api/baseUrl'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RotateCodeResult =
  | { ok: true; newCode: string; newCodeId: string }
  | {
      ok: false
      error: string
      code: 'rate_limit_exceeded' | 'rbac_owner_required' | 'no_active_code' | 'unknown'
    }

export type CodeAuditEntry = {
  id: string
  providerId: string
  oldCodeId: string | null
  newCodeId: string | null
  rotatedBy: string
  rotatedAt: string
  reason: string | null
}

// ---------------------------------------------------------------------------
// rotateCompanyCode
// ---------------------------------------------------------------------------
// Calls SECURITY DEFINER RPC. Server returns one row { new_code, new_code_id }.
// Client-side never writes to company_join_codes or company_code_audit.
// ---------------------------------------------------------------------------

export async function rotateCompanyCode(
  providerId: string,
  reason?: string,
): Promise<RotateCodeResult> {
  const { data, error } = await supabase.rpc('rotate_company_code', {
    p_provider_id: providerId,
    p_reason: reason ?? null,
  })

  if (error) {
    const msg = error.message ?? ''
    if (msg.includes('rate_limit_exceeded')) {
      return {
        ok: false,
        error: 'Du hast das tägliche Limit (5 Rotationen) erreicht. Bitte morgen erneut versuchen.',
        code: 'rate_limit_exceeded',
      }
    }
    if (msg.includes('rbac_owner_required') || msg.includes('unauthenticated')) {
      return {
        ok: false,
        error: 'Nur der Betriebs-Inhaber darf den Code rotieren.',
        code: 'rbac_owner_required',
      }
    }
    if (msg.includes('no_active_code')) {
      return {
        ok: false,
        error: 'Kein aktiver Code gefunden. Bitte Support kontaktieren.',
        code: 'no_active_code',
      }
    }
    return { ok: false, error: 'Code-Rotation fehlgeschlagen.', code: 'unknown' }
  }

  // RPC returns TABLE → array of { new_code, new_code_id }
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row.new_code !== 'string') {
    return { ok: false, error: 'Code-Rotation fehlgeschlagen.', code: 'unknown' }
  }

  return {
    ok: true,
    newCode: row.new_code as string,
    newCodeId: row.new_code_id as string,
  }
}

// ---------------------------------------------------------------------------
// getCodeAuditLog
// ---------------------------------------------------------------------------
// Owner-facing read of the rotation history. RLS enforces the owner-self gate.
// ---------------------------------------------------------------------------

export async function getCodeAuditLog(
  providerId: string,
  limit = 20,
): Promise<CodeAuditEntry[]> {
  const { data, error } = await supabase
    .from('company_code_audit')
    .select('id, provider_id, old_code_id, new_code_id, rotated_by, rotated_at, reason')
    .eq('provider_id', providerId)
    .order('rotated_at', { ascending: false })
    .limit(limit)

  if (error || !data) return []

  return data.map((row) => ({
    id: row.id as string,
    providerId: row.provider_id as string,
    oldCodeId: (row.old_code_id as string | null) ?? null,
    newCodeId: (row.new_code_id as string | null) ?? null,
    rotatedBy: row.rotated_by as string,
    rotatedAt: row.rotated_at as string,
    reason: (row.reason as string | null) ?? null,
  }))
}

// ---------------------------------------------------------------------------
// sendCodeByEmail
// ---------------------------------------------------------------------------
// Calls /api/account/team-code-email. Server resolves the owner email,
// loads the active code, and dispatches via Resend. Returns the masked
// recipient email so the UI can show "Code wurde an o***@example.com geschickt".
// ---------------------------------------------------------------------------

export async function sendCodeByEmail(
  options: { to?: string } = {},
): Promise<{ ok: true; maskedEmail: string } | { ok: false; error: string }> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData?.session?.access_token
  if (!token) {
    return { ok: false, error: 'Bitte erneut anmelden.' }
  }

  const payload =
    options.to && options.to.trim().length > 0 ? { to: options.to.trim() } : {}

  try {
    const response = await fetch(apiUrl('/api/account/team-code-email'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })

    const body = (await response.json().catch(() => ({}))) as {
      sent?: boolean
      maskedEmail?: string
      error?: string
    }

    if (!response.ok || body.sent !== true) {
      return {
        ok: false,
        error: body.error ?? 'E-Mail konnte nicht gesendet werden.',
      }
    }

    return { ok: true, maskedEmail: body.maskedEmail ?? '' }
  } catch {
    return { ok: false, error: 'Netzwerkfehler beim E-Mail-Versand.' }
  }
}
