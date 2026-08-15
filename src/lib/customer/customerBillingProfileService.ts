import { supabase } from '../supabase'

/**
 * Customer Billing Profile (Block 7.1B2).
 *
 * Persistente Rechnungsdaten des Auftraggebers — eindeutig pro `user_id`.
 * Datenbasis für §14-UStG-konforme Rechnungs-Issuance, die in Folgeblöcken
 * (7.1B3+) als Hard-Gate scharfgeschaltet wird. In B2 wird das Profil
 * ausschliesslich erfasst und vor dem Funding-Confirm sichtbar gemacht;
 * Issuance-Logik wird hier weder verändert noch gateet.
 */
export type CustomerBillingProfile = {
  /** customer_billing_profiles.id (DB-generated UUID). */
  id: string
  /** Owner-Key — auth.uid() / profiles.id. */
  userId: string
  billingName: string | null
  billingAddressLine1: string | null
  billingAddressLine2: string | null
  billingPostalCode: string | null
  billingCity: string | null
  /** ISO-3166-1-Alpha-2 (z. B. "DE"). DB-DEFAULT 'DE'. */
  billingCountry: string
  billingEmail: string | null
  billingPhone: string | null
  isBusiness: boolean
  businessName: string | null
  vatId: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Eingabeshape für {@link upsertCustomerBillingProfile}.
 *
 * Bewusst eigenes Shape, kein Wiederverwenden von `CustomerContext` —
 * Account-Display-Daten und Rechnungs-Pflichtdaten sind unterschiedliche
 * Sources of Truth (Memory `feedback_no_second_billing_source`).
 */
export interface CustomerBillingProfileForm {
  billingName: string | null
  billingAddressLine1: string | null
  billingAddressLine2: string | null
  billingPostalCode: string | null
  billingCity: string | null
  billingCountry: string
  billingEmail: string | null
  billingPhone: string | null
  isBusiness: boolean
  businessName: string | null
  vatId: string | null
}

type CustomerBillingProfileRow = {
  id: string
  user_id: string
  billing_name: string | null
  billing_address_line1: string | null
  billing_address_line2: string | null
  billing_postal_code: string | null
  billing_city: string | null
  billing_country: string | null
  billing_email: string | null
  billing_phone: string | null
  is_business: boolean | null
  business_name: string | null
  vat_id: string | null
  created_at: string | null
  updated_at: string | null
}

const SELECT_COLUMNS =
  'id, user_id, billing_name, billing_address_line1, billing_address_line2, billing_postal_code, billing_city, billing_country, billing_email, billing_phone, is_business, business_name, vat_id, created_at, updated_at'

function rowToProfile(row: CustomerBillingProfileRow): CustomerBillingProfile {
  return {
    id: row.id,
    userId: row.user_id,
    billingName: row.billing_name ?? null,
    billingAddressLine1: row.billing_address_line1 ?? null,
    billingAddressLine2: row.billing_address_line2 ?? null,
    billingPostalCode: row.billing_postal_code ?? null,
    billingCity: row.billing_city ?? null,
    billingCountry: row.billing_country ?? 'DE',
    billingEmail: row.billing_email ?? null,
    billingPhone: row.billing_phone ?? null,
    isBusiness: row.is_business ?? false,
    businessName: row.business_name ?? null,
    vatId: row.vat_id ?? null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : 0,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  }
}

/**
 * Provider-seitiger Snapshot-Lookup auf das Customer-Billing-Profile für
 * einen konkreten Job. Geht bewusst NICHT direkt auf
 * `customer_billing_profiles` (RLS verbietet Cross-User-Reads), sondern über
 * die SECURITY-DEFINER-RPC `get_customer_billing_for_invoice(p_job_id)` aus
 * Block 7.1B3.
 *
 * Liefert `null`, wenn der Customer noch kein Profile angelegt hat — der
 * IssueSheet zeigt in dem Fall einen klaren Hinweis, dass der Kunde seine
 * Rechnungsdaten ergänzen muss. Wirft, wenn der Aufrufer nicht der
 * Craftsman des Jobs ist (RPC-Authorisation).
 */
export async function getCustomerBillingForInvoice(
  jobId: string,
): Promise<Pick<
  CustomerBillingProfile,
  | 'userId'
  | 'billingName'
  | 'billingAddressLine1'
  | 'billingAddressLine2'
  | 'billingPostalCode'
  | 'billingCity'
  | 'billingCountry'
  | 'billingEmail'
  | 'billingPhone'
  | 'isBusiness'
  | 'businessName'
  | 'vatId'
> | null> {
  const { data, error } = await supabase.rpc(
    'get_customer_billing_for_invoice',
    { p_job_id: jobId },
  )
  if (error) {
    console.error(
      '[customerBillingProfileService] get_customer_billing_for_invoice failed:',
      error,
    )
    throw new Error(
      'Rechnungsdaten des Kunden konnten nicht geladen werden. Bitte versuche es erneut.',
    )
  }
  if (!data) return null
  const row = data as {
    userId: string
    billingName: string | null
    billingAddressLine1: string | null
    billingAddressLine2: string | null
    billingPostalCode: string | null
    billingCity: string | null
    billingCountry: string | null
    billingEmail: string | null
    billingPhone: string | null
    isBusiness: boolean | null
    businessName: string | null
    vatId: string | null
  }
  return {
    userId: row.userId,
    billingName: row.billingName,
    billingAddressLine1: row.billingAddressLine1,
    billingAddressLine2: row.billingAddressLine2,
    billingPostalCode: row.billingPostalCode,
    billingCity: row.billingCity,
    billingCountry: row.billingCountry ?? 'DE',
    billingEmail: row.billingEmail,
    billingPhone: row.billingPhone,
    isBusiness: row.isBusiness ?? false,
    businessName: row.businessName,
    vatId: row.vatId,
  }
}

/**
 * Lädt das Customer-Billing-Profile des aktuell angemeldeten Nutzers.
 *
 * Liefert `null`, wenn keine Session aktiv ist oder der Nutzer noch keine
 * Billing-Row angelegt hat. Der Funding-Flow muss diesen Null-Zustand als
 * "Profil unvollständig" interpretieren und den Billing-CTA anzeigen.
 */
/**
 * Loads a customer billing profile by user id — performs NO session read, so
 * callers that already hold the authenticated user (e.g. session hydration) do
 * not trigger an extra `auth.getSession()` roundtrip on every refresh.
 */
export async function getCustomerBillingProfileByUserId(
  userId: string,
): Promise<CustomerBillingProfile | null> {
  const { data, error } = await supabase
    .from('customer_billing_profiles')
    .select(SELECT_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  return rowToProfile(data as CustomerBillingProfileRow)
}

export async function getMyCustomerBillingProfile(): Promise<CustomerBillingProfile | null> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) throw sessionError
  const user = session?.user
  if (!user) return null

  return getCustomerBillingProfileByUserId(user.id)
}

/**
 * Legt das Billing-Profile des aktuell angemeldeten Nutzers an oder
 * aktualisiert es. Es gibt genau eine Row pro `user_id` (UNIQUE-Constraint
 * + Upsert auf `user_id`).
 *
 * Schreibt ausschließlich Billing-Felder + `updated_at`; berührt keine
 * `profiles`-Felder, keine `craftsman_profiles`-Felder, keine Job-/
 * Invoice-Daten. Wirft eine user-readable Message bei Auth- oder DB-Fehler,
 * damit der Form-Save-Pfad sie sichtbar machen kann.
 */
export async function upsertCustomerBillingProfile(
  form: CustomerBillingProfileForm,
): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) throw sessionError
  const user = session?.user
  if (!user) throw new Error('Nicht angemeldet')

  const country = form.billingCountry.trim() || 'DE'

  const { error } = await supabase
    .from('customer_billing_profiles')
    .upsert(
      {
        user_id: user.id,
        billing_name: form.billingName,
        billing_address_line1: form.billingAddressLine1,
        billing_address_line2: form.billingAddressLine2,
        billing_postal_code: form.billingPostalCode,
        billing_city: form.billingCity,
        billing_country: country,
        billing_email: form.billingEmail,
        billing_phone: form.billingPhone,
        is_business: form.isBusiness,
        business_name: form.isBusiness ? form.businessName : null,
        vat_id: form.isBusiness ? form.vatId : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

  if (error) {
    console.error(
      '[customerBillingProfileService] upsertCustomerBillingProfile failed:',
      error,
    )
    throw new Error(
      'Rechnungsdaten konnten nicht gespeichert werden. Bitte versuche es erneut.',
    )
  }
}
