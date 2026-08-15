/**
 * Customer Billing Profile Service — Integration Tests (Block 7.1B2)
 *
 * Validiert:
 *   - `getMyCustomerBillingProfile` mappt Rows korrekt + liefert null bei
 *     fehlender Session bzw. fehlender Row.
 *   - `upsertCustomerBillingProfile` schreibt nur Billing-Spalten + ist auf
 *     `user_id` als Conflict-Key. Berührt keine Profile-/Identitätsfelder.
 *   - Geschäftskunde-Toggle: business_name/vat_id werden nur geschrieben,
 *     wenn `isBusiness=true` — sonst null.
 *   - Auth-Pfad: ohne aktive Session wird `Nicht angemeldet` geworfen.
 *
 * Supabase-Modul ist gemockt; kein Netzwerkzugriff.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
  getMyCustomerBillingProfile,
  upsertCustomerBillingProfile,
} from '../../src/lib/customer/customerBillingProfileService'

type MaybeSingleResult = { data: unknown; error: unknown }

function buildSelectChain(result: MaybeSingleResult) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  }
}

function buildUpsertChain(result: { data: unknown; error: unknown }) {
  const upsert = vi.fn().mockResolvedValue(result)
  return { upsert }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: { user: { id: 'user-1' } } },
    error: null,
  } as never)
})

describe('getMyCustomerBillingProfile', () => {
  it('liefert null, wenn keine Session aktiv ist', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    } as never)

    const profile = await getMyCustomerBillingProfile()
    expect(profile).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('liefert null, wenn keine Row für den User existiert', async () => {
    const chain = buildSelectChain({ data: null, error: null })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    const profile = await getMyCustomerBillingProfile()
    expect(profile).toBeNull()
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
  })

  it('mappt eine vollständige Row in das Domain-Modell', async () => {
    const chain = buildSelectChain({
      data: {
        id: 'cbp-1',
        user_id: 'user-1',
        billing_name: 'Anna Beispiel',
        billing_address_line1: 'Beispielweg 12',
        billing_address_line2: '3. OG',
        billing_postal_code: '10115',
        billing_city: 'Berlin',
        billing_country: 'DE',
        billing_email: 'anna@example.com',
        billing_phone: '+49 30 12345678',
        is_business: true,
        business_name: 'Beispiel GmbH',
        vat_id: 'DE123456789',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
      error: null,
    })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    const profile = await getMyCustomerBillingProfile()
    expect(profile).not.toBeNull()
    expect(profile).toMatchObject({
      id: 'cbp-1',
      userId: 'user-1',
      billingName: 'Anna Beispiel',
      billingAddressLine1: 'Beispielweg 12',
      billingAddressLine2: '3. OG',
      billingPostalCode: '10115',
      billingCity: 'Berlin',
      billingCountry: 'DE',
      billingEmail: 'anna@example.com',
      billingPhone: '+49 30 12345678',
      isBusiness: true,
      businessName: 'Beispiel GmbH',
      vatId: 'DE123456789',
    })
  })

  it('liefert sichere Defaults für null-Spalten', async () => {
    const chain = buildSelectChain({
      data: {
        id: 'cbp-1',
        user_id: 'user-1',
        billing_name: null,
        billing_address_line1: null,
        billing_address_line2: null,
        billing_postal_code: null,
        billing_city: null,
        billing_country: null,
        billing_email: null,
        billing_phone: null,
        is_business: null,
        business_name: null,
        vat_id: null,
        created_at: null,
        updated_at: null,
      },
      error: null,
    })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    const profile = await getMyCustomerBillingProfile()
    expect(profile).not.toBeNull()
    expect(profile!.billingCountry).toBe('DE')
    expect(profile!.isBusiness).toBe(false)
    expect(profile!.billingName).toBeNull()
  })
})

describe('upsertCustomerBillingProfile', () => {
  it('schreibt nur Billing-Spalten und konfliktet auf user_id', async () => {
    const chain = buildUpsertChain({ data: null, error: null })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    await upsertCustomerBillingProfile({
      billingName: 'Anna Beispiel',
      billingAddressLine1: 'Beispielweg 12',
      billingAddressLine2: null,
      billingPostalCode: '10115',
      billingCity: 'Berlin',
      billingCountry: 'DE',
      billingEmail: null,
      billingPhone: null,
      isBusiness: false,
      businessName: null,
      vatId: null,
    })

    expect(chain.upsert).toHaveBeenCalledTimes(1)
    const [payload, options] = chain.upsert.mock.calls[0]!
    const writePayload = payload as Record<string, unknown>

    expect(writePayload.user_id).toBe('user-1')
    expect(writePayload.billing_name).toBe('Anna Beispiel')
    expect(writePayload.billing_country).toBe('DE')
    expect(writePayload).not.toHaveProperty('display_name')
    expect(writePayload).not.toHaveProperty('role')
    expect(options).toEqual({ onConflict: 'user_id' })
  })

  it('verwirft business_name und vat_id, wenn isBusiness=false', async () => {
    const chain = buildUpsertChain({ data: null, error: null })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    await upsertCustomerBillingProfile({
      billingName: 'Anna',
      billingAddressLine1: 'Beispielweg 12',
      billingAddressLine2: null,
      billingPostalCode: '10115',
      billingCity: 'Berlin',
      billingCountry: 'DE',
      billingEmail: null,
      billingPhone: null,
      isBusiness: false,
      businessName: 'Sollte ignoriert werden',
      vatId: 'DE123456789',
    })

    const [payload] = chain.upsert.mock.calls[0]!
    const writePayload = payload as Record<string, unknown>
    expect(writePayload.is_business).toBe(false)
    expect(writePayload.business_name).toBeNull()
    expect(writePayload.vat_id).toBeNull()
  })

  it('schreibt business_name und vat_id, wenn isBusiness=true', async () => {
    const chain = buildUpsertChain({ data: null, error: null })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    await upsertCustomerBillingProfile({
      billingName: 'Ansprechpartner',
      billingAddressLine1: 'Beispielweg 12',
      billingAddressLine2: null,
      billingPostalCode: '10115',
      billingCity: 'Berlin',
      billingCountry: 'DE',
      billingEmail: null,
      billingPhone: null,
      isBusiness: true,
      businessName: 'Beispiel GmbH',
      vatId: 'DE123456789',
    })

    const [payload] = chain.upsert.mock.calls[0]!
    const writePayload = payload as Record<string, unknown>
    expect(writePayload.is_business).toBe(true)
    expect(writePayload.business_name).toBe('Beispiel GmbH')
    expect(writePayload.vat_id).toBe('DE123456789')
  })

  it('reicht Supabase-Fehler als user-readable Message weiter', async () => {
    const chain = buildUpsertChain({
      data: null,
      error: { message: 'permission denied', code: '42501' },
    })
    vi.mocked(supabase.from).mockReturnValue(chain as never)

    await expect(
      upsertCustomerBillingProfile({
        billingName: 'Anna',
        billingAddressLine1: 'Beispielweg 12',
        billingAddressLine2: null,
        billingPostalCode: '10115',
        billingCity: 'Berlin',
        billingCountry: 'DE',
        billingEmail: null,
        billingPhone: null,
        isBusiness: false,
        businessName: null,
        vatId: null,
      }),
    ).rejects.toThrow(/Rechnungsdaten konnten nicht gespeichert werden/)
  })

  it('verlangt eine aktive Session', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    } as never)

    await expect(
      upsertCustomerBillingProfile({
        billingName: 'Anna',
        billingAddressLine1: 'Beispielweg 12',
        billingAddressLine2: null,
        billingPostalCode: '10115',
        billingCity: 'Berlin',
        billingCountry: 'DE',
        billingEmail: null,
        billingPhone: null,
        isBusiness: false,
        businessName: null,
        vatId: null,
      }),
    ).rejects.toThrow(/Nicht angemeldet/)
  })
})
