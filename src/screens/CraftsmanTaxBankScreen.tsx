import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ShieldCheck, Save } from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  getMyProviderProfile,
  updateProviderTaxProfile,
  PROVIDER_LEGAL_FORMS,
  type ProviderLegalForm,
  type ProviderTaxProfileForm,
} from '../lib/providers'
import {
  ALLOWED_DEFAULT_VAT_RATES,
  validateTaxProfileForm,
  type TaxProfileValidationIssue,
} from '../lib/providers/taxProfileSelectors'
import { useSmartBack } from '../hooks/useSmartBack'

const LEGAL_FORM_LABELS: Record<ProviderLegalForm, string> = {
  einzelunternehmer: 'Einzelunternehmen',
  gbr: 'GbR',
  gmbh: 'GmbH',
  ug: 'UG (haftungsbeschränkt)',
  ag: 'AG',
  kg: 'KG',
  ohg: 'OHG',
  sonstige: 'Sonstige',
}

const ISSUE_LABELS: Record<TaxProfileValidationIssue, string> = {
  tax_identification_missing:
    'Bitte mindestens Steuernummer oder USt-IdNr. eintragen.',
  tax_number_format:
    'Steuernummer hat ein ungewöhnliches Format. Bitte prüfen.',
  vat_id_format:
    'USt-IdNr. hat ein ungewöhnliches Format (z. B. „DE123456789").',
  legal_form_invalid: 'Bitte eine gültige Rechtsform wählen.',
  iban_format:
    'IBAN hat ein ungewöhnliches Format. Bitte ohne Leerzeichen eingeben.',
  bic_format: 'BIC hat ein ungewöhnliches Format.',
  default_vat_rate_invalid: 'Bitte einen Standard-USt-Satz wählen (0, 7 oder 19 %).',
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Speichern fehlgeschlagen'
}

export default function CraftsmanTaxBankScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/profile')

  const [loading, setLoading] = useState(true)
  const [profileMissing, setProfileMissing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [taxNumber, setTaxNumber] = useState('')
  const [vatId, setVatId] = useState('')
  const [legalForm, setLegalForm] = useState<ProviderLegalForm | ''>('')
  const [isKleinunternehmer, setIsKleinunternehmer] = useState(false)
  const [defaultVatRate, setDefaultVatRate] = useState<number>(19)
  const [iban, setIban] = useState('')
  const [bic, setBic] = useState('')

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    getMyProviderProfile()
      .then((profile) => {
        if (cancelled) return
        if (!profile) {
          setProfileMissing(true)
          return
        }
        const tax = profile.taxProfile
        setTaxNumber(tax.taxNumber ?? '')
        setVatId(tax.vatId ?? '')
        setLegalForm(tax.legalForm ?? '')
        setIsKleinunternehmer(tax.isKleinunternehmer)
        setDefaultVatRate(tax.defaultVatRate)
        setIban(tax.iban ?? '')
        setBic(tax.bic ?? '')
      })
      .catch((err) => {
        console.error('[CraftsmanTaxBankScreen] load failed:', err)
        if (!cancelled) setLoadError(getErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const formForValidation = useMemo<ProviderTaxProfileForm>(() => {
    return {
      taxNumber: taxNumber.trim() || null,
      vatId: vatId.trim() || null,
      legalForm: legalForm === '' ? null : legalForm,
      isKleinunternehmer,
      defaultVatRate,
      iban: iban.trim() || null,
      bic: bic.trim() || null,
    }
  }, [taxNumber, vatId, legalForm, isKleinunternehmer, defaultVatRate, iban, bic])

  const validation = useMemo(
    () => validateTaxProfileForm(formForValidation),
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
      await updateProviderTaxProfile(formForValidation)
      setSavedAt(Date.now())
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
          Lade Steuerdaten …
        </div>
      </AppShell>
    )
  }

  if (profileMissing) {
    return (
      <AppShell>
        <section className="px-4 py-6">
          <div className="mx-auto max-w-[420px] space-y-4">
            <button
              type="button"
              onClick={goBack}
              className="flex items-center gap-1 text-[13px] text-slate-500 hover:text-slate-800"
            >
              <ArrowLeft size={14} aria-hidden /> Zurück
            </button>
            <div className="rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200">
              <p className="text-[14px] font-semibold text-amber-800">
                Betriebsprofil fehlt
              </p>
              <p className="mt-1 text-[13px] text-amber-700">
                Bitte lege zuerst dein Betriebsprofil an, bevor du Steuerdaten
                ergänzt.
              </p>
              <button
                type="button"
                onClick={() => navigate('/onboarding/craftsman-profile')}
                className="mt-3 rounded-full bg-amber-600 px-4 py-2 text-[13px] font-semibold text-white"
              >
                Profil anlegen
              </button>
            </div>
          </div>
        </section>
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
              <ShieldCheck size={20} aria-hidden />
            </div>
            <div>
              <h1 className="text-[20px] font-semibold text-slate-900">
                Steuerdaten & Bankverbindung
              </h1>
              <p className="mt-1 text-[13px] text-slate-500">
                Diese Angaben sind Voraussetzung für korrekte Rechnungen nach §14 UStG.
                IBAN/BIC dienen der Rechnungsanzeige – Auszahlungen laufen unverändert
                über deine Stripe-Verbindung.
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
                Steueridentifikation
              </legend>

              <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200/70">
                <input
                  type="checkbox"
                  checked={isKleinunternehmer}
                  onChange={(e) => setIsKleinunternehmer(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="block text-[13px] font-semibold text-slate-800">
                    Kleinunternehmerregelung (§19 UStG)
                  </span>
                  <span className="mt-0.5 block text-[12px] text-slate-500">
                    Wenn aktiv, weist du auf Rechnungen keine Umsatzsteuer aus.
                  </span>
                </span>
              </label>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Steuernummer
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="z. B. 12/345/67890"
                  value={taxNumber}
                  onChange={(e) => setTaxNumber(e.target.value)}
                  className={inputBase}
                />
                <p className="mt-1 text-[12px] text-slate-400">
                  Vom Finanzamt vergeben.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  USt-IdNr. {isKleinunternehmer ? '(optional)' : ''}
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
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Rechtsform & USt-Satz
              </legend>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Rechtsform
                </label>
                <select
                  value={legalForm}
                  onChange={(e) =>
                    setLegalForm(
                      e.target.value === '' ? '' : (e.target.value as ProviderLegalForm),
                    )
                  }
                  className={inputBase}
                >
                  <option value="">Bitte wählen</option>
                  {PROVIDER_LEGAL_FORMS.map((form) => (
                    <option key={form} value={form}>
                      {LEGAL_FORM_LABELS[form]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  Standard-USt-Satz für neue Rechnungen
                </label>
                <div className="flex gap-2">
                  {ALLOWED_DEFAULT_VAT_RATES.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      onClick={() => setDefaultVatRate(rate)}
                      className={[
                        'flex-1 rounded-2xl py-2.5 text-[13px] font-semibold transition',
                        defaultVatRate === rate
                          ? 'bg-[#2563EB] text-white shadow-[0_4px_12px_-4px_rgba(37,99,235,0.4)]'
                          : 'bg-white text-slate-700 ring-1 ring-slate-200/70',
                      ].join(' ')}
                    >
                      {rate} %
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[12px] text-slate-400">
                  Vorbelegung — pro Rechnung anpassbar.
                </p>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Bankverbindung (Rechnungsanzeige)
              </legend>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  IBAN
                </label>
                <input
                  type="text"
                  placeholder="z. B. DE12 3456 7890 1234 5678 90"
                  value={iban}
                  onChange={(e) => setIban(e.target.value.toUpperCase())}
                  autoCapitalize="characters"
                  className={inputBase}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                  BIC (optional)
                </label>
                <input
                  type="text"
                  placeholder="z. B. COBADEFFXXX"
                  value={bic}
                  onChange={(e) => setBic(e.target.value.toUpperCase())}
                  autoCapitalize="characters"
                  className={inputBase}
                />
              </div>
            </fieldset>

            {validation.issues.length > 0 ? (
              <ul className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200 space-y-1">
                {validation.issues.map((issue) => (
                  <li
                    key={issue}
                    className="text-[12px] text-amber-700"
                  >
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
                  Steuerdaten gespeichert.
                </p>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={saving || !validation.isValid}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-[#2563EB] py-3.5 text-[15px] font-semibold text-white shadow-[0_12px_28px_-18px_rgba(37,99,235,0.7)] disabled:opacity-50 disabled:pointer-events-none transition"
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
