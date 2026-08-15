import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  getMyCraftsmanBusinessProfile,
  upsertCraftsmanBusinessProfile,
} from '../lib/craftsman/craftsmanProfileService'
import { updateProviderProfile, getMyProviderProfile } from '../lib/providers/providerProfileService'
import { signOut } from '../lib/auth'
import { acceptProviderTerms } from '../lib/profile'
import { recordAnalyticsEventOnce } from '../lib/analytics'
import { ensureOwnerTeamMembership } from '../lib/company/ownerMembership'
import { generateJoinCodeForProvider } from '../lib/company/joinCode'
import { ensureSubscriptionRow } from '../lib/subscription/trialService'
import { invalidateCraftsmanProfileCache } from '../hooks/useCraftsmanProfileReady'
import { useSmartBack } from '../hooks/useSmartBack'

const TRADE_CATEGORIES = [
  'Elektrik',
  'Sanitär',
  'Bad',
  'Fliesen',
  'Schreinerei',
  'Malerei',
  'Böden',
  'Heizung',
  'Dach',
  'Garten',
  'Küche',
  'Trockenbau',
]

const SERVICES_OFFERED_OPTIONS = [
  'Notdienst',
  'Kostenloser Kostenvoranschlag',
  'Altbausanierung',
  'Neubau',
  'Reparatur & Wartung',
  'Versicherungsschäden',
  'Barrierefreiheit',
  'Energieeffizienz',
]

const SERVICE_RADIUS_OPTIONS = [10, 25, 50, 100]

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return 'Speichern fehlgeschlagen'
}

export default function CraftsmanOnboardingProfileScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/profile')

  const [profileLoading, setProfileLoading] = useState(true)
  const [preFillError, setPreFillError] = useState(false)
  const [isReturningUser, setIsReturningUser] = useState(false)
  const [businessName, setBusinessName] = useState('')
  const [handle, setHandle] = useState('')
  const [location, setLocation] = useState('')
  const [businessAddress, setBusinessAddress] = useState('')
  const [bio, setBio] = useState('')
  const [phone, setPhone] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [selectedServices, setSelectedServices] = useState<string[]>([])
  const [serviceRadiusKm, setServiceRadiusKm] = useState<number>(25)
  const [yearsInBusiness, setYearsInBusiness] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [acceptedProviderTerms, setAcceptedProviderTerms] = useState(false)
  const [profileWarning, setProfileWarning] = useState<string | null>(null)

  // Pre-fill form fields from any existing profile data (resume support).
  useEffect(() => {
    let cancelled = false

    getMyCraftsmanBusinessProfile()
      .then((profile) => {
        if (cancelled || !profile) return
        setBusinessName(profile.businessName ?? '')
        setHandle(profile.handle ?? '')
        setLocation(profile.location ?? '')
        setBusinessAddress(profile.businessAddress ?? '')
        setBio(profile.bio ?? '')
        setPhone(profile.phone ?? '')
        setSelectedCategories(profile.tradeCategories ?? [])
        setSelectedServices(profile.servicesOffered ?? [])
        setServiceRadiusKm(profile.serviceRadiusKm ?? 25)
        setYearsInBusiness(
          profile.yearsInBusiness != null ? String(profile.yearsInBusiness) : ''
        )
        // Detect returning user: if they already completed onboarding,
        // they are editing an existing profile — not going through initial setup.
        if (profile.onboardingCompleted) {
          setIsReturningUser(true)
        }
      })
      .catch((err) => {
        console.error('[CraftsmanOnboardingProfileScreen] Failed to load existing profile:', err)
        if (!cancelled) setPreFillError(true)
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const isValid =
    businessName.trim().length > 0 &&
    handle.trim().length > 0 &&
    location.trim().length > 0 &&
    businessAddress.trim().length > 0 &&
    selectedCategories.length > 0 &&
    acceptedProviderTerms

  function toggleCategory(cat: string) {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    )
  }

  function toggleService(service: string) {
    setSelectedServices((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service]
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid || saving) return

    setError(null)
    setSaving(true)

    try {
      const trimmedHandle = handle.trim()
      const normalizedHandle = trimmedHandle.startsWith('@') ? trimmedHandle : `@${trimmedHandle}`
      const trimmedBio = bio.trim()
      const years = yearsInBusiness.trim() ? parseInt(yearsInBusiness.trim(), 10) : undefined

      // Write the canonical providers row first – this is the authoritative
      // source for public discovery and must succeed for the save to count.
      await updateProviderProfile({
        companyName: businessName.trim(),
        handle: normalizedHandle,
        city: location.trim(),
        description: trimmedBio || null,
        trades: selectedCategories,
        businessAddress: businessAddress.trim() || null,
      })

      // Record acceptance of the Anbieterbedingungen (B2B-AGB) + AVV.
      await acceptProviderTerms()

      // Invalidate the module-level profile-ready cache so HomeGate re-fetches
      // after navigation instead of reading the stale 'incomplete' value that
      // was cached before this save. Without this, HomeGate redirects back here.
      invalidateCraftsmanProfileCache()

      // Ensure the owner has a team_members row and an active join code.
      // Best-effort: failures must not block onboarding — the providers row
      // is the canonical record and already succeeded above.
      // For existing owners this is idempotent (unique partial index absorbs it).
      try {
        const providerProfile = await getMyProviderProfile()
        if (providerProfile) {
          await ensureOwnerTeamMembership(
            providerProfile.profileId,
            providerProfile.id,
            businessName.trim(),
          )
          await generateJoinCodeForProvider(providerProfile.id)
        }
      } catch (membershipErr) {
        console.warn(
          '[CraftsmanOnboardingProfileScreen] membership/join-code setup failed (non-blocking):',
          membershipErr,
        )
      }

      // Ensure subscription row exists for this owner.
      // BLOCKING: ProActionGuard treats a missing row (effectiveState === null)
      // as full passthrough — all pro actions execute without trial or upgrade
      // gating. The row must exist before onboarding completes.
      // Idempotent via ON CONFLICT DO NOTHING in the RPC.
      // Non-owners are silently skipped (ensureSubscriptionRow swallows not_owner).
      await ensureSubscriptionRow()

      // Write the craftsman_profiles row as best-effort.  If the legacy table
      // write fails it must not block the onboarding flow because the
      // providers row (above) is the canonical record for all downstream reads.
      try {
        await upsertCraftsmanBusinessProfile({
          businessName: businessName.trim(),
          handle: normalizedHandle,
          bio: trimmedBio,
          location: location.trim(),
          businessAddress: businessAddress.trim() || undefined,
          tradeCategories: selectedCategories,
          servicesOffered: selectedServices,
          serviceRadiusKm,
          yearsInBusiness: years && !isNaN(years) ? years : undefined,
          phone: phone.trim() || undefined,
        })
      } catch (craftsmanErr) {
        // Non-blocking: providers row is canonical — navigation continues.
        // Show a dismissible warning so the user knows extended fields
        // (services, radius, years) may not have been saved.
        console.warn(
          '[CraftsmanOnboardingProfileScreen] craftsman_profiles write failed (non-blocking):',
          craftsmanErr
        )
        setProfileWarning(
          'Erweitertes Profil konnte nicht vollständig gespeichert werden. Bitte bearbeite es später im Profil-Bereich.'
        )
      }

      // Record supply-side analytics events for the completed onboarding.
      // These fire on every successful save; the analytics layer is append-only
      // so downstream selectors simply count occurrences per time window.
      recordAnalyticsEventOnce({
        eventType: 'onboarding_completed',
        entityType: 'provider',
        entityId: normalizedHandle,
      })
      recordAnalyticsEventOnce({
        eventType: 'provider_discovery_ready',
        entityType: 'provider',
        entityId: normalizedHandle,
      })

      // Returning users go back to their profile view;
      // new users completing onboarding see the success screen.
      if (isReturningUser) {
        navigate('/craftsman/profile', { replace: true })
      } else {
        navigate('/onboarding/craftsman-success', { replace: true })
      }
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const inputBase =
    'w-full rounded-2xl bg-white px-4 py-3 text-[15px] text-slate-900 placeholder:text-slate-400 ring-1 ring-slate-200/70 shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)] focus:outline-none focus:ring-2 focus:ring-[#2563EB]'

  // Initial onboarding hides the BottomNav for focused setup. Returning-user
  // edits should NOT feel like onboarding — keep the tab context so the user
  // can leave the edit and return to a regular tab. Until a dedicated
  // /craftsman/profile/edit route exists, this is the minimal, safe fix
  // for the OwnerHero "Profil vervollständigen" target friction (Block 5 N4).
  const hideBottomNavForOnboarding = !isReturningUser

  if (profileLoading) {
    return (
      <AppShell hideBottomNav={hideBottomNavForOnboarding}>
        <div className="px-4 py-10 text-sm text-slate-500">Lade Profildaten …</div>
      </AppShell>
    )
  }

  return (
    <AppShell hideBottomNav={hideBottomNavForOnboarding} noSafeTop={isReturningUser}>
      {isReturningUser ? (
        // Edit mode: sticky-Topbar im Block-2-Style (←Back · „Profil bearbeiten")
        // statt zentriertem F-Logo. Onboarding-Erstaufruf behält den alten Hero.
        <div className="sticky top-0 z-40 flex h-[calc(env(safe-area-inset-top,0px)+48px)] items-end gap-2 bg-canvas/95 px-3 pb-2 backdrop-blur">
          <button
            type="button"
            onClick={goBack}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
            aria-label="Zurück"
          >
            <ArrowLeft size={18} className="text-ink" aria-hidden />
          </button>
          <span className="flex-1 truncate text-center text-[14px] font-semibold text-ink">
            Profil bearbeiten
          </span>
          <span className="h-9 w-9" aria-hidden />
        </div>
      ) : null}
      <section className={isReturningUser ? 'px-4 pt-2 pb-6' : 'px-4 py-6'}>
        <div className="mx-auto w-full max-w-[420px]">
          <div className={`flex flex-col text-center ${isReturningUser ? 'items-stretch' : 'items-center'}`}>
            {!isReturningUser ? (
              <div className="h-16 w-16 self-center rounded-[18px] bg-[#2563EB] shadow-[0_10px_30px_rgba(37,99,235,0.25)] flex items-center justify-center">
                <span className="text-white text-2xl font-extrabold">F</span>
              </div>
            ) : null}

            {!isReturningUser ? (
              <>
                <h1 className="mt-4 text-[22px] font-semibold text-slate-900">
                  Dein Betriebsprofil
                </h1>
                <p className="mt-1 text-[14px] text-slate-500">
                  Kunden finden dich über diese Angaben auf SaFix.
                </p>
              </>
            ) : (
              <p className="text-[13px] text-slate-500">
                Aktualisiere deine Angaben für Kunden auf SaFix.
              </p>
            )}

            {preFillError ? (
              <div className="mt-3 w-full rounded-xl bg-amber-50 p-3 text-left ring-1 ring-amber-200">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[13px] text-amber-700">
                    Vorherige Angaben konnten nicht geladen werden. Bitte Formular manuell ausfüllen.
                  </p>
                  <button
                    type="button"
                    onClick={() => setPreFillError(false)}
                    className="shrink-0 text-[16px] font-bold leading-none text-amber-400 hover:text-amber-700"
                    aria-label="Hinweis schließen"
                  >
                    ×
                  </button>
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="mt-3 rounded-xl bg-red-50 p-3 text-left">
                <p className="text-[13px] font-semibold text-red-700">Speichern fehlgeschlagen</p>
                <p className="mt-0.5 text-xs text-red-600 break-words">{error}</p>
              </div>
            ) : null}

            {profileWarning ? (
              <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-left ring-1 ring-amber-200/70">
                <p className="flex-1 text-[12px] text-amber-700">{profileWarning}</p>
                <button
                  type="button"
                  onClick={() => setProfileWarning(null)}
                  className="shrink-0 text-[16px] font-bold leading-none text-amber-400 hover:text-amber-700"
                  aria-label="Warnung schließen"
                >
                  ×
                </button>
              </div>
            ) : null}
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Betriebsname *
              </label>
              <input
                type="text"
                placeholder="z. B. Elektro Weber GmbH"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className={inputBase}
                autoComplete="organization"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Handle *
              </label>
              <input
                type="text"
                placeholder="z. B. @elektroweber"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                className={inputBase}
                autoComplete="off"
                autoCapitalize="none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Stadt / Standort *
              </label>
              <input
                type="text"
                placeholder="z. B. Hannover"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className={inputBase}
                autoComplete="address-level2"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Rechnungsadresse *
              </label>
              <input
                type="text"
                placeholder="z. B. Hauptstraße 5, 30159 Hannover"
                value={businessAddress}
                onChange={(e) => setBusinessAddress(e.target.value)}
                className={inputBase}
                autoComplete="street-address"
              />
              <p className="mt-1 text-[12px] text-slate-400">
                Vollständige Adresse mit Straße, Hausnummer und PLZ — wird auf Rechnungen gedruckt.
              </p>
            </div>

            <div>
              <label className="mb-2 block text-[13px] font-semibold text-slate-700">
                Gewerke *
              </label>
              <div className="flex flex-wrap gap-2">
                {TRADE_CATEGORIES.map((cat) => {
                  const active = selectedCategories.includes(cat)
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggleCategory(cat)}
                      className={[
                        'rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition',
                        active
                          ? 'bg-[#2563EB] text-white shadow-[0_4px_12px_-4px_rgba(37,99,235,0.4)]'
                          : 'bg-white text-slate-700 ring-1 ring-slate-200/70',
                      ].join(' ')}
                    >
                      {cat}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <label className="mb-2 block text-[13px] font-semibold text-slate-700">
                Angebotene Leistungen
              </label>
              <div className="flex flex-wrap gap-2">
                {SERVICES_OFFERED_OPTIONS.map((service) => {
                  const active = selectedServices.includes(service)
                  return (
                    <button
                      key={service}
                      type="button"
                      onClick={() => toggleService(service)}
                      className={[
                        'rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition',
                        active
                          ? 'bg-[#2563EB] text-white shadow-[0_4px_12px_-4px_rgba(37,99,235,0.4)]'
                          : 'bg-white text-slate-700 ring-1 ring-slate-200/70',
                      ].join(' ')}
                    >
                      {service}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Einsatzradius
              </label>
              <div className="flex gap-2">
                {SERVICE_RADIUS_OPTIONS.map((km) => (
                  <button
                    key={km}
                    type="button"
                    onClick={() => setServiceRadiusKm(km)}
                    className={[
                      'flex-1 rounded-2xl py-2.5 text-[13px] font-semibold transition',
                      serviceRadiusKm === km
                        ? 'bg-[#2563EB] text-white shadow-[0_4px_12px_-4px_rgba(37,99,235,0.4)]'
                        : 'bg-white text-slate-700 ring-1 ring-slate-200/70',
                    ].join(' ')}
                  >
                    {km} km
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Kurzbeschreibung
              </label>
              <textarea
                placeholder="Kurz beschreiben, was ihr macht und was euch auszeichnet …"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={3}
                className={[inputBase, 'resize-none leading-relaxed'].join(' ')}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Jahre im Betrieb (optional)
              </label>
              <input
                type="number"
                placeholder="z. B. 12"
                min={0}
                max={100}
                value={yearsInBusiness}
                onChange={(e) => setYearsInBusiness(e.target.value)}
                className={inputBase}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-slate-700">
                Telefon (optional)
              </label>
              <input
                type="tel"
                placeholder="z. B. +49 511 123456"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className={inputBase}
                autoComplete="tel"
              />
            </div>

            <label className="flex cursor-pointer items-start gap-3 pt-1">
              <input
                type="checkbox"
                checked={acceptedProviderTerms}
                onChange={(e) => setAcceptedProviderTerms(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-blue-600"
              />
              <span className="text-[13px] leading-relaxed text-slate-600">
                Ich akzeptiere die{' '}
                <a
                  href="/legal/anbieter_agb"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-blue-600 underline"
                >
                  Anbieterbedingungen
                </a>{' '}
                und die{' '}
                <a
                  href="/legal/avv"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-blue-600 underline"
                >
                  Auftragsverarbeitung (AVV)
                </a>
                .
              </span>
            </label>

            <button
              type="submit"
              disabled={!isValid || saving}
              className="w-full rounded-full bg-[#2563EB] py-3.5 text-[15px] font-semibold text-white shadow-[0_12px_28px_-18px_rgba(37,99,235,0.7)] disabled:opacity-50 disabled:pointer-events-none transition"
            >
              {saving
                ? 'Wird gespeichert …'
                : isReturningUser
                  ? 'Änderungen speichern'
                  : 'Profil speichern & loslegen'}
            </button>

            <button
              type="button"
              onClick={() => void signOut()}
              className="mt-4 w-full py-2 text-[13px] text-slate-400 hover:text-slate-600 transition"
            >
              Abmelden
            </button>
          </form>
        </div>
      </section>
    </AppShell>
  )
}
