import { supabase } from '../supabase'

export interface ProviderProfileForm {
  companyName: string
  handle: string
  city: string
  description: string | null
  trades: string[]
  businessAddress?: string | null
  /**
   * Public-discovery visibility (`providers.is_public`). When omitted the save
   * defaults to `true` — saving the business profile remains an opt-in to
   * public discovery for the onboarding flow. The edit screen passes the
   * explicit toggle value so a craftsman who hid their profile stays hidden.
   */
  isPublic?: boolean
}

/**
 * Erlaubte Rechtsformen für `providers.legal_form`.
 *
 * App-seitige Validierung; in der DB als TEXT gespeichert, damit künftige
 * Erweiterungen (z. B. KGaA, Genossenschaft) keine Migration erfordern.
 */
export const PROVIDER_LEGAL_FORMS = [
  'einzelunternehmer',
  'gbr',
  'gmbh',
  'ug',
  'ag',
  'kg',
  'ohg',
  'sonstige',
] as const
export type ProviderLegalForm = (typeof PROVIDER_LEGAL_FORMS)[number]

/**
 * Steuer- und Bankprofil eines Providers.
 *
 * Block 7.1B1 — Datenbasis für spätere §14-UStG-konforme Rechnungs-Issuance
 * (kommt in 7.1B2+). In B1 nur erfasst und sichtbar gemacht; noch nicht
 * blockierend.
 *
 * Quelle: Spalten auf der `providers`-Tabelle (kein zweites Modell, keine
 * Doppelhaltung in `craftsman_profiles`). Stripe-Connect-Auszahlungslogik
 * bleibt in `provider_payout_accounts` — iban/bic hier sind Profil-/
 * Anzeigedaten, nicht Payout-Truth.
 */
export type ProviderTaxProfile = {
  taxNumber: string | null
  vatId: string | null
  legalForm: ProviderLegalForm | null
  isKleinunternehmer: boolean
  /** Mehrwertsteuersatz in Prozent (z. B. 19, 7, 0). DB-DEFAULT 19. */
  defaultVatRate: number
  iban: string | null
  bic: string | null
}

/**
 * Eingabeshape für {@link updateProviderTaxProfile}.
 *
 * Bewusst getrennt von {@link ProviderProfileForm}, damit der Onboarding-
 * Save-Pfad die Steuer-/Bankfelder NICHT versehentlich überschreibt
 * (Onboarding kennt diese Felder nicht).
 */
export interface ProviderTaxProfileForm {
  taxNumber: string | null
  vatId: string | null
  legalForm: ProviderLegalForm | null
  isKleinunternehmer: boolean
  defaultVatRate: number
  iban: string | null
  bic: string | null
}

/**
 * Shape of the row returned when reading the current user's provider profile.
 */
type ProviderRow = {
  id: string
  profile_id: string
  company_name: string | null
  handle: string | null
  description: string | null
  city: string | null
  trade_categories: string | string[] | null
  avatar_url: string | null
  is_public: boolean | null
  business_address: string | null
  tax_number: string | null
  vat_id: string | null
  legal_form: string | null
  is_kleinunternehmer: boolean | null
  default_vat_rate: number | string | null
  iban: string | null
  bic: string | null
  created_at: string | null
  updated_at: string | null
}

/**
 * Canonical provider profile returned by {@link getMyProviderProfile}.
 *
 * This represents the authoritative business-profile data stored in the
 * `providers` table. Fields that are only tracked in the legacy
 * `craftsman_profiles` table (e.g. `servicesOffered`, `serviceRadiusKm`) are
 * intentionally absent here; callers that need those extended fields should
 * use the enriched read from `craftsmanProfileService`.
 */
export type ProviderProfile = {
  /** providers.id (DB-generated UUID) */
  id: string
  /** providers.profile_id = auth.users.id */
  profileId: string
  companyName: string
  handle: string
  description: string | null
  city: string
  businessAddress: string | null
  tradeCategories: string[]
  avatarUrl: string | null
  isPublic: boolean
  /**
   * Steuer- und Bankprofil. Immer present (DB-DEFAULTs für
   * is_kleinunternehmer und default_vat_rate sorgen dafür); leere Felder
   * werden als null bzw. den jeweiligen Defaults exposed.
   */
  taxProfile: ProviderTaxProfile
  createdAt: number
  updatedAt: number
}

function parseTradeCategories(raw: string | string[] | null): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isProviderLegalForm(value: unknown): value is ProviderLegalForm {
  return (
    typeof value === 'string' &&
    (PROVIDER_LEGAL_FORMS as readonly string[]).includes(value)
  )
}

function parseDefaultVatRate(raw: number | string | null): number {
  if (raw === null || raw === undefined) return 19
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw
  return Number.isFinite(value) ? value : 19
}

function rowToTaxProfile(row: ProviderRow): ProviderTaxProfile {
  return {
    taxNumber: row.tax_number ?? null,
    vatId: row.vat_id ?? null,
    legalForm: isProviderLegalForm(row.legal_form) ? row.legal_form : null,
    isKleinunternehmer: row.is_kleinunternehmer ?? false,
    defaultVatRate: parseDefaultVatRate(row.default_vat_rate),
    iban: row.iban ?? null,
    bic: row.bic ?? null,
  }
}

function rowToProviderProfile(row: ProviderRow): ProviderProfile {
  return {
    id: row.id,
    profileId: row.profile_id,
    companyName: row.company_name ?? '',
    handle: row.handle ?? '',
    description: row.description ?? null,
    city: row.city ?? '',
    businessAddress: row.business_address ?? null,
    tradeCategories: parseTradeCategories(row.trade_categories),
    avatarUrl: row.avatar_url ?? null,
    isPublic: row.is_public ?? false,
    taxProfile: rowToTaxProfile(row),
    createdAt: row.created_at ? new Date(row.created_at).getTime() : 0,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  }
}

const PROVIDERS_SELECT_COLUMNS =
  'id, profile_id, company_name, handle, description, city, trade_categories, avatar_url, is_public, business_address, tax_number, vat_id, legal_form, is_kleinunternehmer, default_vat_rate, iban, bic, created_at, updated_at'

/**
 * Fetches the current authenticated user's canonical provider profile from the
 * `providers` table.
 *
 * Returns `null` when no session is active or no row exists. Throws on
 * authentication or database errors.
 */
export async function getMyProviderProfile(): Promise<ProviderProfile | null> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) throw sessionError

  const user = session?.user
  if (!user) return null

  const { data, error } = await supabase
    .from('providers')
    .select(PROVIDERS_SELECT_COLUMNS)
    .eq('profile_id', user.id)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  return rowToProviderProfile(data as ProviderRow)
}

/**
 * Fetches a provider profile by the user's auth UID (`profile_id`).
 *
 * Returns `null` when no row exists. Throws on database errors.
 */
export async function getProviderProfile(
  profileId: string
): Promise<ProviderProfile | null> {
  const { data, error } = await supabase
    .from('providers')
    .select(PROVIDERS_SELECT_COLUMNS)
    .eq('profile_id', profileId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  return rowToProviderProfile(data as ProviderRow)
}

/**
 * Fetches just the company name for a given provider UUID.
 *
 * Block 7.1G: Liest aus der View `discovery_providers` statt direkt aus der
 * `providers`-Tabelle. Damit funktioniert der Worker-Hook ohne Owner-Kontext
 * weiter, ohne dass die Tabelle für Non-Owner-Reads geöffnet werden muss.
 * Returns `null` when not found. Callers should degrade gracefully on null.
 */
export async function getProviderCompanyNameById(
  providerId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('discovery_providers')
    .select('company_name')
    .eq('provider_id', providerId)
    .maybeSingle()

  if (error || !data) return null
  return (data.company_name as string | null) ?? null
}

/**
 * Resolves the canonical `providers.id` (DB UUID) from a craftsman's auth uid
 * (`providers.profile_id`), bypassing the owner-only `providers` RLS.
 *
 * Why this exists: offer acceptance runs in the CUSTOMER's session. The
 * `providers` SELECT policy is owner-only (`profile_id = auth.uid()`), so a
 * direct `getProviderProfile(craftsmanUserId)` read returns zero rows for the
 * counterparty and leaves `provider_id` unresolved. Persisting an escrow plan
 * then fell back to the craftsman's auth uid — a different id space — which
 * violates `escrow_payment_plans.provider_id → providers.id` (23503) on every
 * accept. This resolver goes through `spatial_user_provider_org`, a
 * `SECURITY DEFINER` function (authenticated has EXECUTE) that maps any auth
 * uid → `providers.id` (owner OR active team member) without exposing the
 * provider row itself — it returns only the id mapping. Returns `null` when the
 * uid has no provider org or the lookup fails; callers degrade gracefully.
 */
export async function getProviderIdByAuthUid(
  authUid: string
): Promise<string | null> {
  const { data, error } = await supabase.rpc('spatial_user_provider_org', {
    p_uid: authUid,
  })
  if (error) {
    console.error('[providerProfileService] getProviderIdByAuthUid failed:', error)
    return null
  }
  return (data as string | null) ?? null
}

/**
 * Upserts the current user's row in the `providers` table.
 *
 * Uses `profile_id` (the Supabase auth UID) as the conflict key so that:
 *   - If no row exists yet for this craftsman, one is created automatically.
 *   - If a row already exists, it is updated in-place.
 *
 * `is_public` is set to `true` on the first insert and left unchanged on
 * subsequent updates (the DB upsert only writes the provided columns).
 *
 * `trade_categories` is serialised as a comma-separated text string to match
 * the current TEXT column type in the schema.
 *
 * Throws with a user-readable message on authentication failure or Supabase
 * error so the calling screen can surface the failure visibly.
 */
export async function updateProviderProfile(form: ProviderProfileForm): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) throw sessionError

  const user = session?.user
  if (!user) throw new Error('Nicht angemeldet')

  const { error } = await supabase
    .from('providers')
    .upsert(
      {
        profile_id: user.id,
        company_name: form.companyName,
        handle: form.handle,
        city: form.city,
        description: form.description,
        trade_categories: form.trades.join(', '),
        business_address: form.businessAddress ?? null,
        // Visibility for public discovery. Defaults to `true` (saving the
        // profile is an opt-in to discovery for onboarding), but the edit
        // screen now passes the explicit toggle value so a craftsman can
        // deliberately stay hidden — and, conversely, re-publish themselves
        // after the review seed (or an admin) flipped them to false.
        is_public: form.isPublic ?? true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'profile_id' }
    )

  if (error) {
    // Detect handle uniqueness violation (PostgreSQL code 23505) and surface
    // a field-specific message instead of the generic save error.
    if (error.code === '23505') {
      const detail = error.details ?? ''
      const msg = error.message ?? ''
      if (/handle/i.test(detail) || /handle/i.test(msg)) {
        throw new Error('Dieser Handle ist bereits vergeben. Bitte wähle einen anderen.')
      }
    }
    console.error('[providerProfileService] updateProviderProfile failed:', error)
    throw new Error('Betriebsprofil konnte nicht gespeichert werden. Bitte versuche es erneut.')
  }
}

/**
 * Flips ONLY `providers.is_public` for the current user's row — the focused
 * write behind the "Dein Profil ist versteckt" banner CTA and the visibility
 * toggle. Touches no other column, so it can never clobber companyName /
 * handle / city the way a full-form upsert would.
 *
 * Runs in the craftsman's own session and is covered by the owner-scoped
 * `providers` UPDATE policy (`profile_id = auth.uid()`). Throws a user-readable
 * message on failure so the caller can surface it.
 */
export async function setProviderVisibility(isPublic: boolean): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) throw sessionError

  const user = session?.user
  if (!user) throw new Error('Nicht angemeldet')

  const { error } = await supabase
    .from('providers')
    .update({ is_public: isPublic, updated_at: new Date().toISOString() })
    .eq('profile_id', user.id)

  if (error) {
    console.error('[providerProfileService] setProviderVisibility failed:', error)
    throw new Error('Sichtbarkeit konnte nicht geändert werden. Bitte versuche es erneut.')
  }
}

/**
 * Aktualisiert ausschließlich die Steuer- und Bankfelder am bestehenden
 * `providers`-Row des aktuell angemeldeten Nutzers.
 *
 * Bewusst getrennt von {@link updateProviderProfile}, damit:
 *   - Der Onboarding-Save-Pfad keine Steuerdaten überschreibt (er kennt
 *     diese Felder nicht).
 *   - Der Tax/Bank-Edit-Screen weder Handle/Stadt/Bio noch is_public
 *     versehentlich verändert.
 *
 * Erwartet, dass für den Nutzer bereits eine `providers`-Row existiert
 * (Tax/Bank-Edit ist nur erreichbar, nachdem das Basisprofil angelegt wurde).
 * Falls keine Row existiert, wird ein Fehler geworfen statt eine leere Row
 * zu erzeugen — das würde stille Datenverluste an Pflichtfeldern wie
 * companyName / handle / city verursachen.
 */
export async function updateProviderTaxProfile(
  form: ProviderTaxProfileForm,
): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) throw sessionError

  const user = session?.user
  if (!user) throw new Error('Nicht angemeldet')

  const { data: updateData, error } = await supabase
    .from('providers')
    .update({
      tax_number: form.taxNumber,
      vat_id: form.vatId,
      legal_form: form.legalForm,
      is_kleinunternehmer: form.isKleinunternehmer,
      default_vat_rate: form.defaultVatRate,
      iban: form.iban,
      bic: form.bic,
      updated_at: new Date().toISOString(),
    })
    .eq('profile_id', user.id)
    .select('id')

  if (error) {
    console.error('[providerProfileService] updateProviderTaxProfile failed:', error)
    throw new Error(
      'Steuerdaten konnten nicht gespeichert werden. Bitte versuche es erneut.',
    )
  }

  if (!updateData || updateData.length === 0) {
    throw new Error(
      'Betriebsprofil noch nicht angelegt. Bitte zuerst das Profil speichern.',
    )
  }
}
