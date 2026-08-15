import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchDiscoveryProviders, fetchDiscoveryProvider } from '../../src/lib/discovery/discoveryService'
import { supabase } from '../../src/lib/supabase'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn() },
}))

type DiscoveryProviderRow = {
  provider_id: string
  profile_id: string
  company_name: string
  description: string | null
  city: string
  trade_categories: string | string[] | null
  avatar_url: string | null
  rating: number | null
  rating_count: number | null
  verified: boolean | null
  is_public: boolean | null
  provider_created_at: string
  provider_updated_at: string
  display_name: string | null
  craftsman_role: string | null
  onboarding_done: boolean | null
  is_operator: boolean | null
}

function mockSupabaseRows(rows: DiscoveryProviderRow[]) {
  const order = vi.fn().mockResolvedValue({ data: rows, error: null })
  const maybeSingle = vi.fn().mockResolvedValue({ data: rows[0] ?? null, error: null })
  const eq = vi.fn().mockReturnValue({ order, maybeSingle })
  const select = vi.fn().mockReturnValue({ eq, order })
  vi.mocked(supabase.from).mockReturnValue({ select } as unknown as ReturnType<typeof supabase.from>)
  return { order, maybeSingle, eq, select }
}

const baseRow: DiscoveryProviderRow = {
  provider_id: 'prov-1',
  profile_id: 'craftsman-1',
  company_name: 'Elektro Muster GmbH',
  description: 'Meisterbetrieb',
  city: 'Berlin',
  trade_categories: 'Elektrik, Sanitär',
  avatar_url: null,
  rating: 4.6,
  rating_count: 12,
  verified: true,
  is_public: true,
  provider_created_at: '2024-01-01T00:00:00Z',
  provider_updated_at: '2024-01-02T00:00:00Z',
  display_name: 'Max Muster',
  craftsman_role: null,
  onboarding_done: true,
  is_operator: false,
}

describe('discoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads from the visible_discovery_providers view (no PII surface)', async () => {
    mockSupabaseRows([baseRow])

    await fetchDiscoveryProviders()

    expect(vi.mocked(supabase.from)).toHaveBeenCalledWith('visible_discovery_providers')
  })

  it('returns ready providers from the view inkl. ratingCount-Mapping aus DB-Spalte', async () => {
    const { order } = mockSupabaseRows([baseRow])

    const providers = await fetchDiscoveryProviders()

    expect(order).toHaveBeenCalled()
    expect(providers).toHaveLength(1)
    expect(providers[0]?.id).toBe(baseRow.provider_id)
    expect(providers[0]?.profileId).toBe(baseRow.profile_id)
    expect(providers[0]?.onboardingDone).toBe(true)
    expect(providers[0]?.ratingCount).toBe(12) // aus DB-Spalte rating_count
  })

  it('Pass-Through: liefert Provider mit unvollständigem Profil aus, anstatt sie zu verstecken', async () => {
    // DB-View hätte is_public=false hart gefiltert; im Mock kommt die Row aber
    // durch — wir prüfen, dass der JS-Selektor sie NICHT mehr clientseitig filtert.
    const incompleteRow = {
      ...baseRow,
      provider_id: 'prov-incomplete',
      city: '',
      trade_categories: null,
    }
    mockSupabaseRows([incompleteRow])

    const providers = await fetchDiscoveryProviders()

    expect(providers).toHaveLength(1)
    expect(providers[0]?.id).toBe('prov-incomplete')
  })

  it('Pass-Through: Operator-Handwerker bleibt sichtbar', async () => {
    const operatorRow = { ...baseRow, provider_id: 'prov-op', is_operator: true }
    mockSupabaseRows([operatorRow])

    const providers = await fetchDiscoveryProviders()

    expect(providers).toHaveLength(1)
    expect(providers[0]?.id).toBe('prov-op')
    // is_operator wird seit der PII-Härtung (2026-06-02) nicht mehr aus der
    // Discovery-View gelesen (View redactet zu NULL, Service selektiert es nicht)
    // → immer false, unabhängig von der Row. Sichtbarkeit (length/id) bleibt.
    expect(providers[0]?.isOperator).toBe(false)
  })

  it('allows fetching a single ready provider for the profile route', async () => {
    const { maybeSingle } = mockSupabaseRows([baseRow])

    const provider = await fetchDiscoveryProvider(baseRow.profile_id)

    expect(maybeSingle).toHaveBeenCalled()
    expect(provider?.id).toBe(baseRow.provider_id)
    expect(provider?.onboardingDone).toBe(true)
    expect(provider?.ratingCount).toBe(12)
  })

  it('returns the provider even if profile incomplete (Soft-Penalty in UI, not hidden in DB)', async () => {
    const incompleteRow = { ...baseRow, city: '' }
    mockSupabaseRows([incompleteRow])

    const provider = await fetchDiscoveryProvider(incompleteRow.profile_id)

    expect(provider).not.toBeNull()
    // Empty-String-City wird durchgereicht; UI rendert „Standort fehlt"-Badge
    expect(provider?.city).toBe('')
  })
})
