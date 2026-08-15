import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, FileText, Save } from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  getMyCustomerBillingProfile,
  upsertCustomerBillingProfile,
  type CustomerBillingProfileForm,
} from '../lib/customer/customerBillingProfileService'
import {
  validateCustomerBillingProfileForm,
  type CustomerBillingValidationIssue,
} from '../lib/customer/customerBillingProfileSelectors'
import { updateCustomerContext } from '../lib/customer/customerContextStore'
import { useSmartBack } from '../hooks/useSmartBack'

const ISSUE_LABELS: Record<CustomerBillingValidationIssue, string> = {
  billing_name_missing: 'Bitte einen Namen für die Rechnung eintragen.',
  address_line1_missing: 'Bitte Strasse und Hausnummer eintragen.',
  postal_code_missing: 'Bitte Postleitzahl eintragen.',
  postal_code_format: 'Postleitzahl hat ein ungewöhnliches Format. Bitte prüfen.',
  city_missing: 'Bitte Stadt eintragen.',
  country_missing: 'Bitte Land wählen.',
  country_format: 'Länderkürzel muss 2 Buchstaben sein (z. B. DE).',
  business_name_missing: 'Bitte Firmenname eintragen.',
  vat_id_format: 'USt-IdNr. hat ein ungewöhnliches Format (z. B. DE123456789).',
  email_format: 'E-Mail-Adresse hat ein ungewöhnliches Format.',
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Speichern fehlgeschlagen'
}

/**
 * CustomerBillingProfileScreen — `/account/billing-profile`
 *
 * Edit-Screen für Customer-Rechnungsdaten (Block 7.1B2). Wird aus dem
 * Konto-Bereich oder als In-Flow-CTA aus dem Funding-Screen erreicht.
 *
 * Nach erfolgreichem Save navigiert der Screen zurück (`navigate(-1)`),
 * damit der Customer ohne Neustart in den ursprünglichen Funding-Flow
 * zurückkehrt. Bei Direktaufruf (z. B. aus dem Konto) bleibt der Standard-
 * Zurück-Pfad erhalten.
 */
export default function CustomerBillingProfileScreen() {
  const navigate = useNavigate()
  const location = useLocation()
  const goBack = useSmartBack('/profile')

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [billingName, setBillingName] = useState('')
  const [addressLine1, setAddressLine1] = useState('')
  const [addressLine2, setAddressLine2] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [city, setCity] = useState('')
  const [country, setCountry] = useState('DE')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [isBusiness, setIsBusiness] = useState(false)
  const [businessName, setBusinessName] = useState('')
  const [vatId, setVatId] = useState('')

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // ?return=<pfad> erlaubt dem Funding-Flow, den Customer nach Save direkt
  // zurück in die Zahlungsseite zu schicken.
  const returnTo = useMemo(() => {
    const params = new URLSearchParams(location.search)
    const value = params.get('return')
    if (!value) return null
    if (!value.startsWith('/')) return null
    return value
  }, [location.search])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    getMyCustomerBillingProfile()
      .then((profile) => {
        if (cancelled || !profile) return
        setBillingName(profile.billingName ?? '')
        setAddressLine1(profile.billingAddressLine1 ?? '')
        setAddressLine2(profile.billingAddressLine2 ?? '')
        setPostalCode(profile.billingPostalCode ?? '')
        setCity(profile.billingCity ?? '')
        setCountry(profile.billingCountry || 'DE')
        setEmail(profile.billingEmail ?? '')
        setPhone(profile.billingPhone ?? '')
        setIsBusiness(profile.isBusiness)
        setBusinessName(profile.businessName ?? '')
        setVatId(profile.vatId ?? '')
      })
      .catch((err) => {
        console.error('[CustomerBillingProfileScreen] load failed:', err)
        if (!cancelled) setLoadError(getErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const formForValidation = useMemo<CustomerBillingProfileForm>(() => {
    return {
      billingName: billingName.trim() || null,
      billingAddressLine1: addressLine1.trim() || null,
      billingAddressLine2: addressLine2.trim() || null,
      billingPostalCode: postalCode.trim() || null,
      billingCity: city.trim() || null,
      billingCountry: country.trim().toUpperCase() || 'DE',
      billingEmail: email.trim() || null,
      billingPhone: phone.trim() || null,
      isBusiness,
      businessName: isBusiness ? businessName.trim() || null : null,
      vatId: isBusiness ? vatId.trim() || null : null,
    }
  }, [
    billingName,
    addressLine1,
    addressLine2,
    postalCode,
    city,
    country,
    email,
    phone,
    isBusiness,
    businessName,
    vatId,
  ])

  const validation = useMemo(
    () => validateCustomerBillingProfileForm(formForValidation),
    [formForValidation],
  )

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (saving) return

    setSaveError(null)
    setSavedAt(null)

    if (!validation.isValid) {
      setSaveError('Bitte korrigiere die markierten Felder.')
      return
    }

    setSaving(true)
    try {
      await upsertCustomerBillingProfile(formForValidation)
      // Write-through to the in-memory projection so the greeting + Konto
      // overview reflect the new name/city immediately (canonical source is the
      // billing profile we just persisted).
      updateCustomerContext({ displayName: billingName.trim(), city: city.trim() })
      setSavedAt(Date.now())
      if (returnTo) {
        navigate(returnTo, { replace: true })
      }
    } catch (err) {
      setSaveError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const inputBase =
    'w-full rounded-2xl bg-white px-4 py-3 text-[15px] text-slate-900 placeholder:text-slate-400 ring-1 ring-slate-200/70 shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)] focus:outline-none focus:ring-2 focus:ring-[#2563EB]'

  if (loading) {
    return (
      <AppShell>
        <div className="px-4 py-10 text-sm text-slate-500">
          Lade Rechnungsdaten …
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[480px]">
          <button
            type="button"
            onClick={goBack}
            className="flex items-center gap-1 text-[13px] text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft size={14} aria-hidden /> Zurück
          </button>

          <header className="mt-4 flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#2563EB]/10 text-[#2563EB]">
              <FileText size={20} aria-hidden />
            </div>
            <div>
              <h1 className="text-[20px] font-semibold text-slate-900">
                Persönliche Daten
              </h1>
              <p className="mt-1 text-[13px] text-slate-500">
                Dein vollständiger Name und deine Anschrift. Wir nutzen sie für
                deine Begrüßung, zum Vorausfüllen von Anfragen und für
                rechtssichere Rechnungen (§ 14 UStG) — bitte vollständig und
                korrekt eingeben. Ersetzt keine Steuerberatung.
              </p>
            </div>
          </header>

          {loadError ? (
            <div className="mt-4 rounded-xl bg-red-50 p-3 text-left ring-1 ring-red-200">
              <p className="text-[13px] font-semibold text-red-700">
                Daten konnten nicht geladen werden
              </p>
              <p className="mt-0.5 text-xs text-red-600 break-words">{loadError}</p>
            </div>
          ) : null}

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <fieldset className="space-y-3">
              <legend className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Name & Anschrift
              </legend>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Vollständiger Name
                </label>
                <input
                  type="text"
                  placeholder="z. B. Anna Beispiel"
                  value={billingName}
                  onChange={(e) => setBillingName(e.target.value)}
                  className={inputBase}
                  autoComplete="name"
                />
                <p className="mt-1 text-[12px] text-slate-400">
                  Vor- und Nachname. Aus dem Vornamen wird deine Begrüßung
                  abgeleitet.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Strasse und Hausnummer
                </label>
                <input
                  type="text"
                  placeholder="z. B. Beispielweg 12"
                  value={addressLine1}
                  onChange={(e) => setAddressLine1(e.target.value)}
                  className={inputBase}
                  autoComplete="address-line1"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Adresszusatz (optional)
                </label>
                <input
                  type="text"
                  placeholder="z. B. 3. OG, Hinterhaus"
                  value={addressLine2}
                  onChange={(e) => setAddressLine2(e.target.value)}
                  className={inputBase}
                  autoComplete="address-line2"
                />
              </div>

              <div className="flex gap-3">
                <div className="w-[120px]">
                  <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                    PLZ
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="10115"
                    value={postalCode}
                    onChange={(e) => setPostalCode(e.target.value)}
                    className={inputBase}
                    autoComplete="postal-code"
                  />
                </div>
                <div className="flex-1">
                  <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                    Stadt
                  </label>
                  <input
                    type="text"
                    placeholder="Berlin"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    className={inputBase}
                    autoComplete="address-level2"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Land
                </label>
                <input
                  type="text"
                  placeholder="DE"
                  value={country}
                  onChange={(e) => setCountry(e.target.value.toUpperCase())}
                  maxLength={2}
                  className={inputBase}
                  autoComplete="country"
                />
                <p className="mt-1 text-[12px] text-slate-400">
                  Länderkürzel (2 Buchstaben), z. B. DE.
                </p>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Kontakt (optional)
              </legend>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  E-Mail
                </label>
                <input
                  type="email"
                  placeholder="z. B. anna@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputBase}
                  autoComplete="email"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Telefon
                </label>
                <input
                  type="tel"
                  placeholder="z. B. +49 30 12345678"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={inputBase}
                  autoComplete="tel"
                />
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Geschäftskunde
              </legend>

              <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200/70">
                <input
                  type="checkbox"
                  checked={isBusiness}
                  onChange={(e) => setIsBusiness(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="block text-[13px] font-semibold text-slate-800">
                    Ich beauftrage als Unternehmen
                  </span>
                  <span className="mt-0.5 block text-[12px] text-slate-500">
                    Aktiviere dies, wenn die Rechnung auf eine Firma ausgestellt
                    werden soll.
                  </span>
                </span>
              </label>

              {isBusiness ? (
                <>
                  <div>
                    <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                      Firmenname
                    </label>
                    <input
                      type="text"
                      placeholder="z. B. Beispiel GmbH"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      className={inputBase}
                      autoComplete="organization"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                      USt-IdNr. (optional)
                    </label>
                    <input
                      type="text"
                      placeholder="z. B. DE123456789"
                      value={vatId}
                      onChange={(e) => setVatId(e.target.value.toUpperCase())}
                      autoCapitalize="characters"
                      className={inputBase}
                    />
                  </div>
                </>
              ) : null}
            </fieldset>

            {validation.issues.length > 0 ? (
              <ul className="space-y-1 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
                {validation.issues.map((issue) => (
                  <li key={issue} className="text-[12px] text-amber-700">
                    • {ISSUE_LABELS[issue]}
                  </li>
                ))}
              </ul>
            ) : null}

            {saveError ? (
              <div className="rounded-xl bg-red-50 p-3 ring-1 ring-red-200">
                <p className="text-[13px] font-semibold text-red-700">
                  Speichern fehlgeschlagen
                </p>
                <p className="mt-0.5 text-xs text-red-600 break-words">{saveError}</p>
              </div>
            ) : null}

            {savedAt ? (
              <div className="rounded-xl bg-emerald-50 p-3 ring-1 ring-emerald-200">
                <p className="text-[13px] font-semibold text-emerald-700">
                  Rechnungsdaten gespeichert.
                </p>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={saving || !validation.isValid}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-[#2563EB] py-3.5 text-[15px] font-semibold text-white shadow-[0_12px_28px_-18px_rgba(37,99,235,0.7)] transition disabled:pointer-events-none disabled:opacity-50"
            >
              <Save size={16} aria-hidden />
              {saving ? 'Wird gespeichert …' : 'Speichern'}
            </button>
          </form>
        </div>
      </section>
    </AppShell>
  )
}
