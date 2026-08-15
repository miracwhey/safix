import { supabase } from '../supabase'
import { logInfo } from '../observability'
import type { DiscoveryProvider } from './discoveryTypes'
import { deriveDiscoveryReadiness, isDiscoveryVisible } from './discoverySelectors'

/**
 * Shape of a row returned by the `visible_discovery_providers` view.
 *
 * Block 7.1G: Public-Discovery-Reads laufen über die SECURITY-DEFINER-View,
 * nicht mehr direkt über die `providers`-Tabelle. Damit bleiben PII-Spalten
 * (tax_number, vat_id, iban, bic, business_address, is_kleinunternehmer,
 * default_vat_rate) aus dem öffentlichen Read-Surface. Seit 2026-06-02 entfernt
 * die View zusätzlich phone (PII) + role und redactet is_operator zu NULL
 * (Operator-Enumeration); dieser Read selektiert is_operator daher nicht mehr.
 *
 * `trade_categories` wird weiter robust normalisiert (TEXT vs ARRAY).
 */
type DiscoveryProviderRow = {
  provider_id: string
  profile_id: string
  company_name: string | null
  description: string | null
  city: string | null
  trade_categories: string | string[] | null
  avatar_url: string | null
  rating: number | null
  rating_count: number | null
  verified: boolean | null
  is_public: boolean | null
  provider_created_at: string | null
  provider_updated_at: string | null
  display_name: string | null
  craftsman_role: string | null
  onboarding_done: boolean | null
  handle: string | null
}

function parseTradeCategories(raw: string | string[] | null): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function rowToDiscoveryProvider(row: DiscoveryProviderRow): DiscoveryProvider {
  const onboardingDone = row.onboarding_done ?? row.is_public ?? false
  return {
    id: row.provider_id,
    profileId: row.profile_id,
    companyName: row.company_name ?? '',
    displayName: row.display_name ?? null,
    description: row.description ?? null,
    city: row.city ?? null,
    tradeCategories: parseTradeCategories(row.trade_categories),
    avatarUrl: row.avatar_url ?? null,
    rating: row.rating ?? null,
    ratingCount: row.rating_count ?? 0,
    verified: row.verified ?? false,
    isPublic: row.is_public ?? false,
    onboardingDone,
    craftsmanRole: row.craftsman_role ?? null,
    isOperator: false,
    handle: row.handle ?? null,
    createdAt: row.provider_created_at ? new Date(row.provider_created_at).getTime() : 0,
    updatedAt: row.provider_updated_at ? new Date(row.provider_updated_at).getTime() : 0,
  }
}

const DISCOVERY_PROVIDER_COLUMNS = `
  provider_id,
  profile_id,
  company_name,
  description,
  city,
  trade_categories,
  avatar_url,
  rating,
  rating_count,
  verified,
  is_public,
  provider_created_at,
  provider_updated_at,
  display_name,
  craftsman_role,
  onboarding_done,
  handle
`

/**
 * Fetches all Discovery-visible providers via the
 * `visible_discovery_providers` view (filters `is_public = true` AND
 * `onboarding_done = true`). The view exposes only non-PII columns; PII fields
 * on the underlying `providers` table are off-limits to public reads.
 *
 * Returns an empty array on error so callers remain robust.
 */
export async function fetchDiscoveryProviders(): Promise<DiscoveryProvider[]> {
  const { data, error } = await supabase
    .from('visible_discovery_providers')
    .select(DISCOVERY_PROVIDER_COLUMNS)
    .order('provider_created_at', { ascending: false })

  if (error) {
    console.error('fetchDiscoveryProviders error:', error)
    return []
  }

  const providers = (data as unknown as DiscoveryProviderRow[] ?? [])
    .map(rowToDiscoveryProvider)

  // Telemetry: melde Provider, deren Profil noch unvollständig ist (city /
  // companyName / tradeCategories fehlen oder is_operator). isDiscoveryVisible
  // ist Pass-Through; readiness wird in der UI als Badge gezeigt.
  for (const provider of providers) {
    const readiness = deriveDiscoveryReadiness(provider)
    if (!readiness.isReady) {
      logInfo('discovery.client_drop', {
        providerId: provider.id,
        profileId: provider.profileId,
        missingFields: readiness.missingFields,
        reason: 'profile_incomplete_soft',
      })
    }
  }

  return providers.filter(isDiscoveryVisible)
}

/**
 * Fetches a single Discovery-visible provider by `profile_id` via the
 * `visible_discovery_providers` view. Returns `null` when not found, not
 * visible, or on DB error.
 */
export async function fetchDiscoveryProvider(
  profileId: string
): Promise<DiscoveryProvider | null> {
  const { data, error } = await supabase
    .from('visible_discovery_providers')
    .select(DISCOVERY_PROVIDER_COLUMNS)
    .eq('profile_id', profileId)
    .maybeSingle()

  if (error) {
    console.error('fetchDiscoveryProvider error:', error)
    return null
  }

  if (!data) return null

  const provider = rowToDiscoveryProvider(data as unknown as DiscoveryProviderRow)

  if (!isDiscoveryVisible(provider)) return null

  const readiness = deriveDiscoveryReadiness(provider)
  if (!readiness.isReady) {
    logInfo('discovery.client_drop', {
      providerId: provider.id,
      profileId: provider.profileId,
      missingFields: readiness.missingFields,
      reason: 'profile_incomplete_soft',
      surface: 'profile_detail',
    })
  }

  return provider
}

/**
 * Fetches a provider by `profile_id` for the profile-detail route, using the
 * broader `discovery_providers` view instead of `visible_discovery_providers`.
 *
 * The feed surface queries `discovery_providers WHERE is_public=true` —
 * providers with `onboarding_done=false` can therefore appear in the reel feed
 * while `visible_discovery_providers` (which also requires `onboarding_done=true`)
 * returns null for them, causing a silent redirect. This function matches the
 * feed's visibility criteria so any provider whose reel a user tapped is
 * reachable via their profile.
 */
export async function fetchDiscoveryProviderForProfile(
  profileId: string
): Promise<DiscoveryProvider | null> {
  const { data, error } = await supabase
    .from('discovery_providers')
    .select(DISCOVERY_PROVIDER_COLUMNS)
    .eq('profile_id', profileId)
    .eq('is_public', true)
    .maybeSingle()

  if (error) {
    console.error('fetchDiscoveryProviderForProfile error:', error)
    return null
  }

  if (!data) return null

  return rowToDiscoveryProvider(data as unknown as DiscoveryProviderRow)
}
