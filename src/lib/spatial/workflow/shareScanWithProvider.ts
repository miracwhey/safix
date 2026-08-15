/**
 * Spatial · CAD Lane V1.5.1 Phase B · shareScanWithProvider
 *
 * Customer-side workflow that direct-shares a Self-Scan with one specific
 * HW. Surface: the "Direkt an Handwerker"-target of {@link SpatialShareSheet}
 * (Mockup 06).
 *
 * Why a separate path next to {@link linkScanToJob}:
 *   - `linkScanToJob` requires an existing job that the Customer already
 *     opened as an Anfrage. The HW only becomes visible AFTER they accept
 *     and `jobs.craftsman_user_id` is populated.
 *   - This workflow lets the Customer pre-share their scan with a known HW
 *     (Saved-Providers list, profile page, search result) BEFORE filing an
 *     Anfrage. The HW sees the scan in their dashboard immediately — the
 *     Hannover-Pilot lead-conversion USP.
 *
 * Architecture:
 *   - Direct 1:1 link via `scans.shared_with_provider_id` (M1 migration,
 *     20260525234500). Single-target by design; multi-HW share is V1.6.
 *   - The picker hands us a `providerBusinessId` (= `providers.id`). The
 *     RLS gate compares `auth.users.id`, so we resolve `providers.profile_id`
 *     server-side before writing.
 *
 * Guardrails on top of RLS:
 *   - Scan must be `owner_type='customer'` (Self-Scan only).
 *   - Caller must equal `scan.capturedBy`.
 *   - Target HW must resolve to a non-NULL `providers.profile_id`.
 *   - Idempotent: re-sharing to the same HW is a no-op success.
 *
 * Unshare path: pass `providerBusinessId = null`. Sets the column back to
 * NULL; the M1 trigger appends an `'unshared'` audit row.
 */

import { supabase } from '../../supabase'
import { logError, logInfo } from '../../observability'
import { getSpatialRepository } from '../repository/registry'
import type { Scan } from '../types'

export type ShareScanWithProviderFailure =
  | 'not_authenticated'
  | 'scan_not_found'
  | 'scan_not_self_scan'
  | 'scan_not_owned_by_caller'
  | 'provider_not_found'
  | 'provider_missing_profile'
  | 'update_failed'

export type ShareScanWithProviderResult =
  | { ok: true; scan: Scan; alreadyShared: boolean; providerUserId: string | null }
  | { ok: false; reason: ShareScanWithProviderFailure; message: string }

/**
 * @param scanId               the Self-Scan id to (un)share.
 * @param providerBusinessId   the `providers.id` to share with, or `null`
 *                             to clear an existing share.
 */
export async function shareScanWithProvider(
  scanId: string,
  providerBusinessId: string | null,
): Promise<ShareScanWithProviderResult> {
  const { data: authUser } = await supabase.auth.getUser()
  const uid = authUser.user?.id
  if (!uid) {
    return { ok: false, reason: 'not_authenticated', message: 'Anmeldung erforderlich.' }
  }

  const repo = getSpatialRepository()
  const scan = await repo.getScan(scanId)
  if (!scan) {
    return { ok: false, reason: 'scan_not_found', message: 'Aufmaß nicht gefunden.' }
  }
  if (scan.ownerType !== 'customer') {
    return {
      ok: false,
      reason: 'scan_not_self_scan',
      message: 'Nur eigene Aufmaße können direkt mit einem Handwerker geteilt werden.',
    }
  }
  if (scan.capturedBy !== uid) {
    return {
      ok: false,
      reason: 'scan_not_owned_by_caller',
      message: 'Dieses Aufmaß gehört nicht dir.',
    }
  }

  // Resolve providers.profile_id (= auth.users.id) for the picker's
  // business-id input. Customer picks an HW by business identity; the
  // shared_with_provider_id column stores the auth.users.id so RLS
  // (`s.shared_with_provider_id = auth.uid()`) can compare directly.
  let providerUserId: string | null = null
  if (providerBusinessId) {
    const { data: providerRow, error: providerErr } = await supabase
      .from('providers')
      .select('profile_id')
      .eq('id', providerBusinessId)
      .maybeSingle<{ profile_id: string | null }>()
    if (providerErr) {
      logError('spatial.shareScanWithProvider.provider_lookup_failed', providerErr, {
        scanId,
        providerBusinessId,
      })
      return {
        ok: false,
        reason: 'provider_not_found',
        message: 'Handwerker konnte nicht aufgelöst werden.',
      }
    }
    if (!providerRow) {
      return {
        ok: false,
        reason: 'provider_not_found',
        message: 'Handwerker nicht gefunden.',
      }
    }
    if (!providerRow.profile_id) {
      return {
        ok: false,
        reason: 'provider_missing_profile',
        message: 'Dieser Handwerker hat noch kein Profil — Direkt-Teilen nicht möglich.',
      }
    }
    providerUserId = providerRow.profile_id
  }

  // Idempotency: skip the round-trip when the target already matches.
  if (scan.sharedWithProviderId === providerUserId) {
    return { ok: true, scan, alreadyShared: true, providerUserId }
  }

  const { error: updErr } = await supabase
    .from('scans')
    .update({ shared_with_provider_id: providerUserId })
    .eq('id', scanId)
  if (updErr) {
    logError('spatial.shareScanWithProvider.update_failed', updErr, {
      scanId,
      providerUserId,
      uid,
    })
    return {
      ok: false,
      reason: 'update_failed',
      message: updErr.message || 'Aufmaß konnte nicht geteilt werden.',
    }
  }

  logInfo('spatial.shareScanWithProvider.shared', {
    scanId,
    providerUserId,
    uid,
    direction: providerUserId ? 'share' : 'unshare',
  })

  const refreshed = await repo.getScan(scanId)
  return {
    ok: true,
    scan: refreshed ?? scan,
    alreadyShared: false,
    providerUserId,
  }
}
