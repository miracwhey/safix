/**
 * Provider Tax Profile Service — Integration Tests (Block 7.1B1)
 *
 * Validiert:
 *   - `rowToProviderProfile` mappt die neuen Steuer-/Bankspalten korrekt
 *     auf das Domain-Modell und liefert Defaults für fehlende rows.
 *   - `updateProviderTaxProfile` schreibt nur die tax/bank-spezifischen
 *     Spalten (kein Touch von companyName, handle, city, is_public, …).
 *   - Kein versehentliches Erzeugen einer leeren providers-Row, wenn das
 *     Basisprofil noch nicht angelegt wurde.
 *
 * Supabase wird als Modul gemockt; tests greifen NICHT auf eine echte DB.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Override the global setup.ts mock and use the real provider service so we
// can validate the actual rowToProviderProfile mapping and the
// updateProviderTaxProfile write path. The Supabase client itself is mocked
// below so no network access happens.
vi.mock('../../src/lib/providers/providerProfileService', async () => {
  return await vi.importActual<
    typeof import('../../src/lib/providers/providerProfileService')
  >('../../src/lib/providers/providerProfileService')
})

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
    from: vi.fn(),
  },
}))

import { supabase } from '../../src/lib/supabase'
import {
  getMyProviderProfile,
  updateProviderTaxProfile,
} from '../../src/lib/providers/providerProfileService'

type MaybeSingleResult = { data: unknown; error: unknown }

function buildSelectChain(result: MaybeSingleResult) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  }
}

function buildUpdateChain(result: { data: unknown; error: unknown }) {
  const eq = vi.fn().mockReturnThis()
  const select = vi.fn().mockResolvedValue(result)
  const update = vi.fn().mockReturnValue({ eq, select })
  // Nach .eq() wird .select() aufgerufen — Chain mit gleichem Objekt-Pointer
  eq.mockReturnValue({ select })
  return { update, eq, select }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: { user: { id: 'user-1' } } },
    error: null,
  } as never)
})

describe('rowToProviderProfile (via getMyProviderProfile)', () => {
  it('mappt die neuen Steuer-/Bankspalten in profile.taxProfile', async () => {
    const chain = buildSelectChain({
      data: {
        id: 'prov-1',
        profile_id: 'user-1',
        company_name: 'Muster GmbH',
        handle: '@muster',
        description: null,
        city: 'Berlin',
        trade_categories: 'Sanitär',
        avatar_url: null,
        is_public: true,
        business_address: 'Hauptstr. 1, 10115 Berlin',
        tax_number: '12/345/67890',
        vat_id: 'DE123456789',
        legal_form: 'gmbh',
        is_kleinunternehmer: false,
        default_vat_rate: '19.00',
        iban: 'DE89370400440532013000',
        bic: 'COBADEFFXXX',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
      error: null,
    })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    const profile = await getMyProviderProfile()

    expect(profile).not.toBeNull()
    expect(profile!.taxProfile).toEqual({
      taxNumber: '12/345/67890',
      vatId: 'DE123456789',
      legalForm: 'gmbh',
      isKleinunternehmer: false,
      defaultVatRate: 19,
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
    })
  })

  it('liefert sichere Defaults, wenn Steuerspalten leer sind', async () => {
    const chain = buildSelectChain({
      data: {
        id: 'prov-1',
        profile_id: 'user-1',
        company_name: 'Muster',
        handle: '@m',
        description: null,
        city: 'Berlin',
        trade_categories: null,
        avatar_url: null,
        is_public: false,
        business_address: null,
        tax_number: null,
        vat_id: null,
        legal_form: null,
        is_kleinunternehmer: null,
        default_vat_rate: null,
        iban: null,
        bic: null,
        created_at: null,
        updated_at: null,
      },
      error: null,
    })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    const profile = await getMyProviderProfile()
    expect(profile!.taxProfile).toEqual({
      taxNumber: null,
      vatId: null,
      legalForm: null,
      isKleinunternehmer: false,
      defaultVatRate: 19,
      iban: null,
      bic: null,
    })
  })

  it('verwirft unbekannte legal_form-Werte und mappt auf null', async () => {
    const chain = buildSelectChain({
      data: {
        id: 'prov-1',
        profile_id: 'user-1',
        company_name: 'X',
        handle: '@x',
        description: null,
        city: 'Berlin',
        trade_categories: null,
        avatar_url: null,
        is_public: false,
        business_address: null,
        tax_number: '12/345/67890',
        vat_id: null,
        legal_form: 'startup', // nicht im Enum
        is_kleinunternehmer: false,
        default_vat_rate: 19,
        iban: null,
        bic: null,
        created_at: null,
        updated_at: null,
      },
      error: null,
    })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    const profile = await getMyProviderProfile()
    expect(profile!.taxProfile.legalForm).toBeNull()
  })
})

describe('updateProviderTaxProfile', () => {
  it('schreibt nur tax/bank-Spalten + updated_at und filtert auf den eigenen profile_id', async () => {
    const chain = buildUpdateChain({ data: [{ id: 'prov-1' }], error: null })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    await updateProviderTaxProfile({
      taxNumber: '12/345/67890',
      vatId: 'DE123456789',
      legalForm: 'gmbh',
      isKleinunternehmer: false,
      defaultVatRate: 19,
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
    })

    expect(chain.update).toHaveBeenCalledTimes(1)
    const writePayload = chain.update.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(writePayload).sort()).toEqual(
      [
        'tax_number',
        'vat_id',
        'legal_form',
        'is_kleinunternehmer',
        'default_vat_rate',
        'iban',
        'bic',
        'updated_at',
      ].sort(),
    )
    // Keine Profile-Identitätsfelder in der Payload — der Onboarding-Save
    // bleibt unangetastet.
    expect(writePayload).not.toHaveProperty('company_name')
    expect(writePayload).not.toHaveProperty('handle')
    expect(writePayload).not.toHaveProperty('city')
    expect(writePayload).not.toHaveProperty('is_public')

    expect(chain.eq).toHaveBeenCalledWith('profile_id', 'user-1')
  })

  it('wirft, wenn der Nutzer noch keine providers-Row hat', async () => {
    const chain = buildUpdateChain({ data: [], error: null })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    await expect(
      updateProviderTaxProfile({
        taxNumber: '12/345/67890',
        vatId: null,
        legalForm: null,
        isKleinunternehmer: false,
        defaultVatRate: 19,
        iban: null,
        bic: null,
      }),
    ).rejects.toThrow(/Betriebsprofil noch nicht angelegt/)
  })

  it('reicht Supabase-Fehler als user-readable message weiter', async () => {
    const chain = buildUpdateChain({
      data: null,
      error: { message: 'permission denied', code: '42501' },
    })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    await expect(
      updateProviderTaxProfile({
        taxNumber: '12/345/67890',
        vatId: null,
        legalForm: null,
        isKleinunternehmer: false,
        defaultVatRate: 19,
        iban: null,
        bic: null,
      }),
    ).rejects.toThrow(/Steuerdaten konnten nicht gespeichert werden/)
  })

  it('verlangt eine aktive Session', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    } as never)

    await expect(
      updateProviderTaxProfile({
        taxNumber: '12/345/67890',
        vatId: null,
        legalForm: null,
        isKleinunternehmer: false,
        defaultVatRate: 19,
        iban: null,
        bic: null,
      }),
    ).rejects.toThrow(/Nicht angemeldet/)
  })
})
