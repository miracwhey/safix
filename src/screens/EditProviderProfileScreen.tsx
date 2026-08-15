import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, Eye, EyeOff } from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  getMyCraftsmanBusinessProfile,
  upsertCraftsmanBusinessProfile,
} from '../lib/craftsman/craftsmanProfileService'
import { updateProviderProfile } from '../lib/providers/providerProfileService'
import { logError } from '../lib/observability'

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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return 'Speichern fehlgeschlagen'
}

export default function EditProviderProfileScreen() {
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [businessName, setBusinessName] = useState('')
  const [location, setLocation] = useState('')
  const [bio, setBio] = useState('')
  const [phone, setPhone] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [isPublic, setIsPublic] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Preserved from loaded profile — passed through on save, not shown in form
  const [handle, setHandle] = useState('')
  const [servicesOffered, setServicesOffered] = useState<string[]>([])
  const [serviceRadiusKm, setServiceRadiusKm] = useState(25)

  useEffect(() => {
    let cancelled = false
    getMyCraftsmanBusinessProfile()
      .then((profile) => {
        if (cancelled || !profile) return
        setBusinessName(profile.businessName ?? '')
        setLocation(profile.location ?? '')
        setBio(profile.bio ?? '')
        setPhone(profile.phone ?? '')
        setSelectedCategories(profile.tradeCategories ?? [])
        setIsPublic(profile.isPublic ?? true)
        setHandle(profile.handle ?? '')
        setServicesOffered(profile.servicesOffered ?? [])
        setServiceRadiusKm(profile.serviceRadiusKm ?? 25)
      })
      .catch((err) => {
        logError('ui.edit_profile.load_failed', err, {})
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const isValid = businessName.trim().length > 0 && location.trim().length > 0 && selectedCategories.length > 0

  function toggleCategory(cat: string) {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    )
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!isValid || saving) return
    setError(null)
    setSaving(true)
    try {
      await updateProviderProfile({
        companyName: businessName.trim(),
        handle,
        city: location.trim(),
        description: bio.trim() || null,
        trades: selectedCategories,
        isPublic,
      })

      try {
        await upsertCraftsmanBusinessProfile({
          businessName: businessName.trim(),
          handle,
          bio: bio.trim(),
          location: location.trim(),
          tradeCategories: selectedCategories,
          servicesOffered,
          serviceRadiusKm,
          phone: phone.trim() || undefined,
        })
      } catch (legacyErr) {
        console.warn('[EditProviderProfileScreen] legacy write failed (non-blocking):', legacyErr)
      }

      navigate('/craftsman/profile', { replace: true })
    } catch (err) {
      logError('ui.edit_profile.save_failed', err, {})
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppShell active="profile" noSafeTop>
      <form onSubmit={handleSave} className="mx-auto w-full max-w-[420px]">
        {/* Topbar */}
        <div className="sticky top-0 z-30 flex h-[calc(env(safe-area-inset-top,0px)+48px)] items-end gap-2 bg-canvas/95 px-3 pb-2 backdrop-blur">
          <button
            type="button"
            onClick={() => navigate('/craftsman/profile')}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
            aria-label="Zurück"
          >
            <ArrowLeft size={18} className="text-ink" aria-hidden />
          </button>
          <span className="flex-1 text-[15px] font-semibold text-ink">Profil bearbeiten</span>
          <button
            type="submit"
            disabled={!isValid || saving}
            className="flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-[13px] font-semibold text-white disabled:opacity-40"
          >
            <Check size={14} aria-hidden />
            {saving ? 'Speichern …' : 'Speichern'}
          </button>
        </div>

        {loading ? (
          <div className="space-y-4 px-4 pt-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-100" />
            ))}
          </div>
        ) : (
          <div className="space-y-6 px-4 pb-8 pt-4">
            {/* Betriebsname */}
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
                Betriebsname <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="z. B. Müller Elektrotechnik"
                className="w-full rounded-xl bg-surface px-3 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
                autoComplete="organization"
              />
            </div>

            {/* Standort */}
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
                Stadt / Standort <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="z. B. München"
                className="w-full rounded-xl bg-surface px-3 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
                autoComplete="address-level2"
              />
            </div>

            {/* Gewerke */}
            <div>
              <label className="mb-2 block text-[12px] font-semibold text-ink-muted">
                Gewerke <span className="text-danger">*</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {TRADE_CATEGORIES.map((cat) => {
                  const selected = selectedCategories.includes(cat)
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggleCategory(cat)}
                      className={`rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition active:scale-[0.97] ${
                        selected
                          ? 'bg-brand text-white ring-brand'
                          : 'bg-surface text-ink ring-edge'
                      }`}
                    >
                      {cat}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Bio */}
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
                Kurzbeschreibung
              </label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value.slice(0, 300))}
                placeholder="Was macht deinen Betrieb besonders?"
                rows={3}
                className="w-full resize-none rounded-xl bg-surface px-3 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
              <p className="mt-1 text-right text-[11px] text-ink-muted">{bio.length} / 300</p>
            </div>

            {/* Telefon */}
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
                Telefon (optional)
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+49 123 456789"
                className="w-full rounded-xl bg-surface px-3 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
                autoComplete="tel"
              />
            </div>

            {/* Sichtbarkeit */}
            <div className="rounded-xl bg-surface px-3 py-3 ring-1 ring-edge">
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                    isPublic ? 'bg-brand/10 text-brand' : 'bg-danger/10 text-danger'
                  }`}
                  aria-hidden
                >
                  {isPublic ? <Eye size={18} /> : <EyeOff size={18} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-ink">Profil öffentlich sichtbar</p>
                  <p className="mt-0.5 text-[12px] text-ink-muted">
                    {isPublic
                      ? 'Deine Reels und dein Profil erscheinen für alle Nutzer.'
                      : 'Versteckt — niemand außer dir sieht deine Reels und dein Profil.'}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPublic}
                  aria-label="Profil öffentlich sichtbar"
                  onClick={() => setIsPublic((v) => !v)}
                  className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
                    isPublic ? 'bg-brand' : 'bg-edge'
                  }`}
                >
                  <span
                    className={`absolute top-[2px] h-6 w-6 rounded-full bg-white shadow transition-all ${
                      isPublic ? 'left-[22px]' : 'left-[2px]'
                    }`}
                  />
                </button>
              </div>
            </div>

            {error && (
              <p className="text-[13px] text-danger">{error}</p>
            )}
          </div>
        )}
      </form>
    </AppShell>
  )
}
