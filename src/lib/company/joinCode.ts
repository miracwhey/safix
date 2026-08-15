/**
 * Company join code service.
 *
 * Code normalization rules (apply throughout the entire stack):
 *   - Charset: ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no O/0, no I/1)
 *   - Generated: always uppercase
 *   - Stored: always uppercase
 *   - User input: normalized to uppercase before submission
 *   - RPC lookup: UPPER(TRIM(...)) server-side — normalization is redundant
 *     but applied defensively on both sides
 */

import { supabase } from '../supabase'
import { getMyProviderProfile } from '../providers/providerProfileService'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JoinCodeResult =
  | { ok: true; code: string }
  | { ok: false; error: string }

/**
 * Reason codes returned by the hardened RPC (Block 4). The legacy
 * 'invalid_code' value is preserved so a mid-deploy client (Block-3 build
 * talking to the Block-4 RPC, or vice versa) still maps cleanly.
 */
export type JoinCompanyResultReason =
  | 'invalid_format'
  | 'not_found'
  | 'rotated'
  | 'expired'
  | 'rate_limited'
  | 'invalid_code'
  | 'unknown'

export type JoinCompanyResult =
  | { ok: true; providerId: string; matchedStub?: boolean }
  | { ok: false; error: string; code: JoinCompanyResultReason }

/**
 * Default error copy. The RPC already returns localized German strings —
 * this map is the fallback for cases where `result.error` is missing or
 * the mid-deploy client receives a code it doesn't recognise.
 */
const DEFAULT_REASON_COPY: Record<JoinCompanyResultReason, string> = {
  invalid_format: 'Code muss 6 Zeichen aus A–Z (ohne I, O) und 2–9 sein.',
  not_found: 'Code unbekannt. Bitte den aktuellen Code beim Chef erfragen.',
  rotated: 'Dieser Code wurde geändert. Bitte den neuen Code erfragen.',
  expired: 'Dieser Code ist abgelaufen.',
  rate_limited: 'Zu viele Versuche. Bitte in einer Stunde nochmal.',
  invalid_code: 'Code ungültig.',
  unknown: 'Beitritt fehlgeschlagen. Bitte versuche es erneut.',
}

const KNOWN_REASONS: ReadonlySet<JoinCompanyResultReason> = new Set<JoinCompanyResultReason>([
  'invalid_format',
  'not_found',
  'rotated',
  'expired',
  'rate_limited',
  'invalid_code',
  'unknown',
])

function normaliseReason(code: unknown): JoinCompanyResultReason {
  return typeof code === 'string' && (KNOWN_REASONS as ReadonlySet<string>).has(code)
    ? (code as JoinCompanyResultReason)
    : 'unknown'
}

// ---------------------------------------------------------------------------
// Session-scoped flag for ensureOwnerJoinCodeOnce()
// ---------------------------------------------------------------------------

let ownerJoinCodeEnsured = false

export function resetOwnerJoinCodeFlag(): void {
  ownerJoinCodeEnsured = false
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

// Unambiguous charset: no O/0, no I/1
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function makeCode(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('')
}

// ---------------------------------------------------------------------------
// generateJoinCodeForProvider
// ---------------------------------------------------------------------------
// Idempotent: returns the existing active code if one exists; generates a
// new one otherwise.
//
// Called by:
//   - CraftsmanOnboardingProfileScreen (new owners, after profile save)
//   - ensureOwnerJoinCodeOnce() (existing owners, lazy self-heal on dashboard open)
// ---------------------------------------------------------------------------

export async function generateJoinCodeForProvider(
  providerId: string,
): Promise<JoinCodeResult> {
  // 1. Return existing active code if present
  const { data: existing, error: fetchErr } = await supabase
    .from('company_join_codes')
    .select('code')
    .eq('provider_id', providerId)
    .eq('status', 'active')
    .maybeSingle()

  if (fetchErr) {
    return { ok: false, error: 'Join-Code konnte nicht geladen werden.' }
  }

  if (existing) {
    // Touch updated_at so the owner can see recency if displayed
    void supabase
      .from('company_join_codes')
      .update({ updated_at: new Date().toISOString() })
      .eq('provider_id', providerId)
      .eq('status', 'active')
    return { ok: true, code: existing.code }
  }

  // 2. Generate a unique code; one collision retry is enough given the ~1B space
  let code = makeCode()
  const { data: collision } = await supabase
    .from('company_join_codes')
    .select('id')
    .eq('code', code)
    .eq('status', 'active')
    .maybeSingle()
  if (collision) code = makeCode()

  const { error: insertErr } = await supabase
    .from('company_join_codes')
    .insert({ provider_id: providerId, code, target_role: 'worker', status: 'active' })

  if (insertErr) {
    // 23505 = unique_violation: parallel generation wrote first; re-fetch
    if (insertErr.code === '23505') {
      const { data: race } = await supabase
        .from('company_join_codes')
        .select('code')
        .eq('provider_id', providerId)
        .eq('status', 'active')
        .maybeSingle()
      if (race) return { ok: true, code: race.code }
    }
    return { ok: false, error: 'Join-Code konnte nicht erstellt werden.' }
  }

  return { ok: true, code }
}

// ---------------------------------------------------------------------------
// ensureOwnerJoinCodeOnce
// ---------------------------------------------------------------------------
// Fire-and-forget. Called from OwnerRouteGate (via useEffect) once per
// session after owner context and profile readiness are confirmed.
//
// Handles existing owners who completed onboarding before this migration and
// therefore have no join code yet. The flag prevents redundant calls across
// component remounts and tab navigations within the same session.
// ---------------------------------------------------------------------------

export function ensureOwnerJoinCodeOnce(): void {
  if (ownerJoinCodeEnsured) return
  ownerJoinCodeEnsured = true

  getMyProviderProfile()
    .then((profile) => {
      if (profile) return generateJoinCodeForProvider(profile.id)
    })
    .catch(() => {
      // Non-critical; reset flag so the next session can retry
      ownerJoinCodeEnsured = false
    })
}

// ---------------------------------------------------------------------------
// getMyCompanyJoinCode
// ---------------------------------------------------------------------------
// Owner-facing read: returns the active join code for the owner's company.
// Returns null if no code has been generated yet (edge case for owners who
// have not yet triggered ensureOwnerJoinCodeOnce).
// ---------------------------------------------------------------------------

export async function getMyCompanyJoinCode(
  userId: string,
): Promise<{ code: string; providerId: string } | null> {
  const { data: provider, error: provErr } = await supabase
    .from('providers')
    .select('id')
    .eq('profile_id', userId)
    .maybeSingle()

  if (provErr || !provider) return null

  const { data, error } = await supabase
    .from('company_join_codes')
    .select('code')
    .eq('provider_id', provider.id)
    .eq('status', 'active')
    .maybeSingle()

  if (error || !data) return null

  return { code: data.code as string, providerId: provider.id as string }
}

// ---------------------------------------------------------------------------
// joinCompanyWithCode
// ---------------------------------------------------------------------------
// Worker-facing: delegates entirely to the SECURITY DEFINER RPC.
// The RPC validates the code, handles idempotency, and inserts the
// team_members row server-side — the client never writes to team_members
// directly.
//
// Code is normalized to uppercase before being passed to the RPC.
// The RPC also applies UPPER(TRIM(...)) as a second-layer normalization.
// ---------------------------------------------------------------------------

export async function joinCompanyWithCode(
  code: string,
  fullName: string,
): Promise<JoinCompanyResult> {
  const normalizedCode = code.trim().toUpperCase()

  const { data, error } = await supabase.rpc('join_company_with_code', {
    p_code: normalizedCode,
    p_full_name: fullName,
  })

  if (error) {
    return {
      ok: false,
      error: 'Verbindung fehlgeschlagen. Bitte versuche es erneut.',
      code: 'unknown',
    }
  }

  // RPC returns JSONB — Supabase deserializes it to a plain object
  const result = data as {
    ok: boolean
    error?: string
    code?: string
    provider_id?: string
    matched_stub?: boolean
  }

  if (!result.ok) {
    const reason = normaliseReason(result.code)
    return {
      ok: false,
      error: result.error ?? DEFAULT_REASON_COPY[reason],
      code: reason,
    }
  }

  return {
    ok: true,
    providerId: result.provider_id as string,
    ...(result.matched_stub ? { matchedStub: true } : {}),
  }
}
