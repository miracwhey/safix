import { supabase } from '../supabase'
import {
  getMyProviderProfile,
  getProviderProfile,
} from '../providers/providerProfileService'
import type { ProviderProfile } from '../providers/providerProfileService'
import type { CraftsmanBusinessProfile, CraftsmanBusinessProfileInput } from './types'

// ── Legacy craftsman_profiles row type ──────────────────────────────────────

type CraftsmanProfileRow = {
  user_id: string
  business_name: string
  handle: string
  avatar_url: string | null
  bio: string | null
  location: string
  business_address: string | null
  trade_categories: string[]
  services_offered: string[] | null
  service_radius_km: number | null
  years_in_business: number | null
  completed_jobs_count: number | null
  phone: string | null
  website: string | null
  onboarding_completed: boolean
  created_at: string
  updated_at: string
}

/**
 * Extended fields that only exist in the legacy `craftsman_profiles` table.
 * Used to enrich the canonical `providers` data when both rows exist.
 */
type LegacyExtendedFields = {
  businessAddress?: string
  servicesOffered: string[]
  serviceRadiusKm: number
  yearsInBusiness?: number
  completedJobsCount?: number
  phone?: string
  website?: string
  onboardingCompleted: boolean
}

function rowToLegacyExtended(row: CraftsmanProfileRow): LegacyExtendedFields {
  return {
    businessAddress: row.business_address ?? undefined,
    servicesOffered: row.services_offered ?? [],
    serviceRadiusKm: row.service_radius_km ?? 25,
    yearsInBusiness: row.years_in_business ?? undefined,
    completedJobsCount: row.completed_jobs_count ?? undefined,
    phone: row.phone ?? undefined,
    website: row.website ?? undefined,
    onboardingCompleted: row.onboarding_completed,
  }
}

/** Maps a legacy-only row to a full CraftsmanBusinessProfile (fallback). */
function rowToProfile(row: CraftsmanProfileRow): CraftsmanBusinessProfile {
  return {
    userId: row.user_id,
    businessName: row.business_name,
    handle: row.handle,
    avatarUrl: row.avatar_url ?? undefined,
    bio: row.bio ?? undefined,
    location: row.location,
    businessAddress: row.business_address ?? '',
    tradeCategories: row.trade_categories ?? [],
    servicesOffered: row.services_offered ?? [],
    serviceRadiusKm: row.service_radius_km ?? 25,
    yearsInBusiness: row.years_in_business ?? undefined,
    completedJobsCount: row.completed_jobs_count ?? undefined,
    phone: row.phone ?? undefined,
    website: row.website ?? undefined,
    onboardingCompleted: row.onboarding_completed,
    // Legacy-only profile has no providers row → can't be feed-hidden; visible.
    isPublic: true,
    // Legacy-only fallback hat keinen Zugriff auf providers.tax_* — der
    // Steuerdaten-Block bleibt für diese (sehr alten) Profile null und
    // wird von der UI als „nicht gepflegt" angezeigt.
    taxProfile: null,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  }
}

/**
 * Builds a {@link CraftsmanBusinessProfile} from the canonical `providers`
 * row, optionally enriched with extended fields from `craftsman_profiles`.
 */
function providerToProfile(
  provider: ProviderProfile,
  legacy: LegacyExtendedFields | null
): CraftsmanBusinessProfile {
  return {
    userId: provider.profileId,
    providerId: provider.id,
    businessName: provider.companyName,
    handle: provider.handle,
    avatarUrl: provider.avatarUrl ?? undefined,
    bio: provider.description ?? undefined,
    location: provider.city,
    businessAddress: legacy?.businessAddress ?? provider.businessAddress ?? '',
    tradeCategories: provider.tradeCategories,
    // Extended fields: prefer legacy when available, otherwise defaults
    servicesOffered: legacy?.servicesOffered ?? [],
    serviceRadiusKm: legacy?.serviceRadiusKm ?? 25,
    yearsInBusiness: legacy?.yearsInBusiness,
    completedJobsCount: legacy?.completedJobsCount,
    phone: legacy?.phone,
    website: legacy?.website,
    // A `providers` row only exists once the craftsman saved their business
    // profile, so its existence implies onboarding produced it → default true.
    // Deliberately NOT derived from `provider.isPublic` anymore: a craftsman
    // can now toggle themselves hidden (is_public=false) without being bounced
    // back into the onboarding flow.
    onboardingCompleted: legacy?.onboardingCompleted ?? true,
    isPublic: provider.isPublic,
    taxProfile: provider.taxProfile,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  }
}

/**
 * Best-effort fetch of the legacy `craftsman_profiles` row for a given user.
 * Returns `null` silently on any error so it never blocks the caller.
 */
async function fetchLegacyRow(
  userId: string
): Promise<CraftsmanProfileRow | null> {
  try {
    const { data, error } = await supabase
      .from('craftsman_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
    if (error || !data) return null
    return data as CraftsmanProfileRow
  } catch (err) {
    console.warn('[craftsmanProfileService] fetchLegacyRow failed (non-blocking):', err)
    return null
  }
}

/**
 * Fetches the current user's craftsman business profile.
 *
 * Reads from the canonical `providers` table first. If a row exists, the
 * result is enriched with extended fields from the legacy `craftsman_profiles`
 * table (best-effort – a missing or failing legacy read does not block).
 *
 * Falls back to a legacy-only read when no `providers` row exists yet, so
 * profiles created before the migration are still accessible.
 */
export async function getMyCraftsmanBusinessProfile(): Promise<CraftsmanBusinessProfile | null> {
  // 1. Canonical source: providers
  const provider = await getMyProviderProfile()

  if (provider) {
    // Best-effort enrichment with legacy extended fields
    const legacyRow = await fetchLegacyRow(provider.profileId)
    const legacy = legacyRow ? rowToLegacyExtended(legacyRow) : null
    return providerToProfile(provider, legacy)
  }

  // 2. Fallback: legacy craftsman_profiles only (pre-migration profiles)
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) throw sessionError
  const user = session?.user
  if (!user) return null

  const legacyRow = await fetchLegacyRow(user.id)
  return legacyRow ? rowToProfile(legacyRow) : null
}

/**
 * Fetches a craftsman business profile by user ID.
 *
 * Same strategy as {@link getMyCraftsmanBusinessProfile}: canonical `providers`
 * read first, enriched with legacy `craftsman_profiles` extended fields.
 */
export async function getCraftsmanBusinessProfile(
  userId: string
): Promise<CraftsmanBusinessProfile | null> {
  // 1. Canonical source: providers
  const provider = await getProviderProfile(userId)

  if (provider) {
    const legacyRow = await fetchLegacyRow(userId)
    const legacy = legacyRow ? rowToLegacyExtended(legacyRow) : null
    return providerToProfile(provider, legacy)
  }

  // 2. Fallback: legacy craftsman_profiles only
  const legacyRow = await fetchLegacyRow(userId)
  return legacyRow ? rowToProfile(legacyRow) : null
}

/**
 * Increments the `completed_jobs_count` counter for the craftsman identified
 * by `userId`.
 *
 * Called by the payment release workflow whenever a job transitions to
 * `completed` via escrow release. Only increments on successful payment
 * release (not on refunds), reflecting jobs the craftsman has successfully
 * delivered through the platform.
 *
 * Silently no-ops when no craftsman profile row exists for the given user.
 *
 * Note: this uses a read-then-write pattern rather than an atomic SQL
 * expression because the Supabase JS client does not support inline SQL
 * expressions in `.update()`. In practice, concurrent completions for a
 * single craftsman are not expected, so the race window is acceptable.
 * A fully atomic increment can be achieved in the future by introducing
 * a PostgreSQL function via a database migration and calling it with
 * `supabase.rpc()`.
 */
export async function incrementCompletedJobsCount(userId: string): Promise<void> {
  const { error } = await supabase.rpc('increment_craftsman_jobs_count', {
    p_craftsman_user_id: userId,
  })
  if (error) throw error
}

export async function upsertCraftsmanBusinessProfile(
  input: CraftsmanBusinessProfileInput
): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) throw sessionError

  const user = session?.user
  if (!user) throw new Error('Not authenticated')

  const now = new Date().toISOString()

  const { error } = await supabase.from('craftsman_profiles').upsert(
    {
      user_id: user.id,
      business_name: input.businessName,
      handle: input.handle,
      avatar_url: input.avatarUrl ?? null,
      bio: input.bio ?? null,
      location: input.location,
      business_address: input.businessAddress ?? null,
      trade_categories: input.tradeCategories,
      services_offered: input.servicesOffered,
      service_radius_km: input.serviceRadiusKm,
      years_in_business: input.yearsInBusiness ?? null,
      phone: input.phone ?? null,
      website: input.website ?? null,
      onboarding_completed: true,
      created_at: now,
      updated_at: now,
    },
    { onConflict: 'user_id', ignoreDuplicates: false }
  )

  if (error) {
    console.error('[craftsmanProfileService] upsertCraftsmanBusinessProfile failed:', error)
    throw new Error('Profil konnte nicht gespeichert werden. Bitte versuche es erneut.')
  }
}
