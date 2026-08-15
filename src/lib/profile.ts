import { supabase } from './supabase';
import type { Role, CraftsmanRole } from '../types/role';
import type { GuidedEntryState } from './customerEntry/guidedEntryTypes';

export type { Role, CraftsmanRole };

export type MyProfile = {
  role: Role | null;
  craftsman_role: CraftsmanRole | null;
  is_operator: boolean;
  guided_entry_state: GuidedEntryState | null;
  tos_accepted_at: string | null;
  provider_terms_accepted_at: string | null;
};

// ---------------------------------------------------------------------------
// Canonical role validation
// ---------------------------------------------------------------------------

const CANONICAL_ROLES: ReadonlySet<string> = new Set<string>(['customer', 'craftsman']);
const CANONICAL_CRAFTSMAN_ROLES: ReadonlySet<string> = new Set<string>(['owner', 'worker']);

/**
 * Strictly validates a raw role value from the database.
 *
 * Only exact canonical values ('customer', 'craftsman') are accepted.
 * Everything else — including malformed/quoted/legacy values like
 * "'customer'" — returns null.
 *
 * This is the ONLY validation used for role gating / app-entry decisions.
 * Malformed values must NOT be silently upgraded into valid app access.
 */
export function strictCanonicalRole(raw: unknown): Role | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  if (CANONICAL_ROLES.has(raw)) return raw as Role;
  return null;
}

/**
 * Strictly validates a raw craftsman_role value from the database.
 *
 * Only exact canonical values ('owner', 'worker') are accepted.
 * Everything else returns null.
 *
 * This mirrors {@link strictCanonicalRole} for the craftsman sub-role and
 * prevents malformed DB values from granting incorrect operational access.
 */
export function strictCanonicalCraftsmanRole(raw: unknown): CraftsmanRole | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  if (CANONICAL_CRAFTSMAN_ROLES.has(raw)) return raw as CraftsmanRole;
  return null;
}

/**
 * Normalizes a raw role value from the database to a canonical Role or null.
 *
 * Handles legacy/malformed values that have been observed in production:
 *   - "'customer'"  → customer
 *   - '"craftsman"' → craftsman
 *   - " customer "  → customer
 *   - mixed case    → customer / craftsman
 *
 * Returns null when the value cannot be safely mapped to a canonical role.
 *
 * NOTE: This function is for data-repair / migration purposes ONLY.
 * For role gating and app-entry decisions, use {@link strictCanonicalRole}
 * which rejects anything that is not an exact canonical value.
 */
export function normalizeRole(raw: unknown): Role | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;

  // Strip surrounding whitespace, then strip any wrapping single/double quotes
  let cleaned = raw.trim();
  // Iteratively strip outer quotes (handles nested like "'customer'")
  while (
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  const lower = cleaned.toLowerCase();

  if (CANONICAL_ROLES.has(lower)) return lower as Role;
  return null;
}

export async function getMyRole(): Promise<Role | null> {
  const profile = await getMyProfile();
  return profile.role;
}

export async function getMyCraftsmanRole(): Promise<CraftsmanRole | null> {
  const profile = await getMyProfile();
  return profile.craftsman_role;
}

/**
 * Verifies a profile row exists for the given user id.
 *
 * Row creation is owned by the `on_auth_user_created` trigger
 * (SECURITY DEFINER) which runs on every `auth.users` insert — every
 * authenticated user is guaranteed to have a profile row from that path.
 * A client-side upsert here is redundant AND racy: during the
 * `USER_UPDATED` handler that fires after `updateUser({ password })` in
 * the password-reset flow, `signOut()` clears the access token before the
 * upsert request leaves the client. The INSERT then runs as anon, and
 * `WITH CHECK (auth.uid() = id)` rejects it with "new row violates
 * row-level security policy for table profiles". SELECT-only confirms the
 * trigger did its job without triggering any INSERT RLS evaluation.
 */
export async function ensureProfileExists(userId: string): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
}

export async function getMyProfile(): Promise<MyProfile> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;

  const user = session?.user;
  if (!user) {
    return {
      role: null,
      craftsman_role: null,
      is_operator: false,
      guided_entry_state: null,
      tos_accepted_at: null,
      provider_terms_accepted_at: null,
    };
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('role, craftsman_role, is_operator, guided_entry_state, tos_accepted_at, provider_terms_accepted_at')
    .eq('id', user.id)
    .maybeSingle();

  if (error) throw error;

  // Strict canonical role check — only exact 'customer' or 'craftsman' values
  // are accepted for gating.  Malformed/quoted/legacy values are treated as
  // invalid (null) and route the user to role selection.
  const role = strictCanonicalRole(data?.role);

  return {
    role,
    craftsman_role: strictCanonicalCraftsmanRole(data?.craftsman_role),
    is_operator: (data?.is_operator as boolean | null) ?? false,
    guided_entry_state: (data && 'guided_entry_state' in data
      ? (data.guided_entry_state as GuidedEntryState | null)
      : null) ?? null,
    tos_accepted_at: (data && 'tos_accepted_at' in data
      ? (data.tos_accepted_at as string | null)
      : null) ?? null,
    provider_terms_accepted_at: (data && 'provider_terms_accepted_at' in data
      ? (data.provider_terms_accepted_at as string | null)
      : null) ?? null,
  };
}

export async function acceptTos(): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;

  const user = session?.user;
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('profiles')
    .update({ tos_accepted_at: new Date().toISOString() })
    .eq('id', user.id);

  if (error) throw error;
}

/**
 * Records a craftsman owner's acceptance of the Anbieterbedingungen (B2B-AGB)
 * + AVV. Written at craftsman onboarding. Separate from the universal ToS-Gate
 * acceptance (acceptTos), which covers Kunden-AGB / Datenschutz / EULA.
 */
export async function acceptProviderTerms(): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;

  const user = session?.user;
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('profiles')
    .update({ provider_terms_accepted_at: new Date().toISOString() })
    .eq('id', user.id);

  if (error) throw error;
}

export async function setMyRole(role: Role): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;

  const user = session?.user;
  if (!user) throw new Error('Not authenticated');

  // Ensure only exact canonical values are ever written to the database
  const canonical = strictCanonicalRole(role);
  if (!canonical) throw new Error(`Invalid role value: ${role}`);

  const payload =
    canonical === 'customer'
      ? { id: user.id, role: canonical, craftsman_role: null }
      : { id: user.id, role: canonical };

  const { error } = await supabase
    .from('profiles')
    .upsert(payload, { onConflict: 'id' });

  if (error) throw error;
}

export async function setMyCraftsmanRole(craftsmanRole: CraftsmanRole): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;

  const user = session?.user;
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('profiles')
    .upsert(
      {
        id: user.id,
        role: 'craftsman',
        craftsman_role: craftsmanRole,
      },
      { onConflict: 'id' }
    );

  if (error) throw error;
}

export async function clearMyCraftsmanRole(): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;

  const user = session?.user;
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, craftsman_role: null }, { onConflict: 'id' });

  if (error) throw error;
}

/**
 * Persists the guided-entry state to the profiles table (canonical source).
 * Called on every state transition by the guided-entry state machine.
 */
export async function saveGuidedEntryState(state: GuidedEntryState | null): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;

  const user = session?.user;
  if (!user) return; // silently skip if not authenticated

  const { error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, guided_entry_state: state }, { onConflict: 'id' });

  if (error) throw error;
}

// ---------------------------------------------------------------------------
// @-Handle-System — Personen-Identität, Suche, Direktnachrichten-Einstellungen
// (Block H1/H2a; RPCs sind SECURITY DEFINER, nur für authenticated).
// ---------------------------------------------------------------------------

/** Ein Treffer der Personensuche (rpc_search_profiles). PII-minimal. */
export type PersonSearchResult = {
  profileId: string;
  handle: string;
  displayName: string | null;
  role: Role | null;
  craftsmanRole: CraftsmanRole | null;
  /** Firmen-@Handle, falls die Person ein Handwerksbetrieb ist (für Badge). */
  providerHandle: string | null;
};

/** Ergebnis der Live-Verfügbarkeitsprüfung (rpc_check_handle_available). */
export type HandleAvailability = {
  handle: string;
  validFormat: boolean;
  reserved: boolean;
  available: boolean;
};

/** Öffentliche Identitäts-/Privatsphäre-Einstellungen des eigenen Profils. */
export type HandleSettings = {
  handle: string | null;
  discoverable: boolean;
  dmPrivacy: 'everyone' | 'nobody';
};

/**
 * Sucht auffindbare Personen (Kunde↔Kunde/Handwerker) per @Handle oder Name.
 * Server filtert Block (beidseitig), discoverable, moderation_state, self und
 * begrenzt auf 300 Suchen/Tag. Query < 2 Zeichen → leere Liste (kein Request-
 * Overhead lohnt, aber wir rufen trotzdem sauber ab).
 */
export async function searchProfiles(query: string): Promise<PersonSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const { data, error } = await supabase.rpc('rpc_search_profiles', { p_query: trimmed });
  if (error) throw error;

  return ((data ?? []) as Array<{
    profile_id: string;
    handle: string;
    display_name: string | null;
    role: string | null;
    craftsman_role: string | null;
    provider_handle: string | null;
  }>).map((r) => ({
    profileId: r.profile_id,
    handle: r.handle,
    displayName: r.display_name,
    role: strictCanonicalRole(r.role),
    craftsmanRole: strictCanonicalCraftsmanRole(r.craftsman_role),
    providerHandle: r.provider_handle,
  }));
}

/**
 * Live-Verfügbarkeitsprüfung für die Handle-Claim-UI. Read-only, kein
 * Rate-Limit; server normalisiert (@ strippen, lowercase).
 */
export async function checkHandleAvailable(handle: string): Promise<HandleAvailability> {
  const { data, error } = await supabase.rpc('rpc_check_handle_available', { p_handle: handle });
  if (error) throw error;
  const j = (data ?? {}) as {
    handle?: string;
    valid_format?: boolean;
    reserved?: boolean;
    available?: boolean;
  };
  return {
    handle: j.handle ?? '',
    validFormat: j.valid_format ?? false,
    reserved: j.reserved ?? false,
    available: j.available ?? false,
  };
}

/** Fehlermeldungen der Claim-RPC → deutscher UI-Text (Message-basiertes Mapping). */
const HANDLE_CLAIM_MESSAGES: Record<string, string> = {
  not_authenticated: 'Bitte melde dich an, um einen Handle zu wählen.',
  handle_invalid_format:
    'Ungültiges Format. Erlaubt: Kleinbuchstaben, Ziffern, Punkt und Unterstrich (3–30 Zeichen).',
  handle_reserved: 'Dieser Handle ist reserviert.',
  handle_change_rate_limited: 'Du kannst deinen Handle nur alle 30 Tage ändern.',
  handle_taken: 'Dieser Handle ist bereits vergeben.',
};

/**
 * Reserviert/ändert den eigenen @Handle über den SECDEF-Chokepoint. Wirft einen
 * Error mit deutscher, anzeigbarer Meldung. Gibt den normalisierten Handle
 * zurück (ohne @, lowercase).
 */
export async function claimHandle(handle: string): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_claim_handle', { p_handle: handle });
  if (error) {
    const mapped = HANDLE_CLAIM_MESSAGES[error.message];
    throw new Error(mapped ?? 'Handle konnte nicht gesetzt werden. Bitte erneut versuchen.');
  }
  return data as string;
}

/** Liest die eigenen Identitäts-/Privatsphäre-Einstellungen. */
export async function getMyHandleSettings(): Promise<HandleSettings | null> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const user = session?.user;
  if (!user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('handle, discoverable, dm_privacy')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;

  return {
    handle: (data?.handle as string | null) ?? null,
    discoverable: (data?.discoverable as boolean | null) ?? true,
    dmPrivacy: ((data?.dm_privacy as string | null) === 'nobody' ? 'nobody' : 'everyone'),
  };
}

/** Schaltet die Auffindbarkeit (discoverable) des eigenen Profils. */
export async function setDiscoverable(value: boolean): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const user = session?.user;
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase.from('profiles').update({ discoverable: value }).eq('id', user.id);
  if (error) throw error;
}

/** Setzt, wer Direktnachrichten schicken darf (everyone | nobody). */
export async function setDmPrivacy(value: 'everyone' | 'nobody'): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const user = session?.user;
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase.from('profiles').update({ dm_privacy: value }).eq('id', user.id);
  if (error) throw error;
}
