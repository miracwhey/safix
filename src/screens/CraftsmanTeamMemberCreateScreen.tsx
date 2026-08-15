import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { useSession } from '../hooks/useSession'
import { getMyProviderProfile } from '../lib/providers'
import { createTeamMemberStub } from '../lib/team/ownerActions'
import { useSmartBack } from '../hooks/useSmartBack'

export default function CraftsmanTeamMemberCreateScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/team')
  const { user } = useSession()

  const [providerId, setProviderId] = useState<string | null>(null)
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null)

  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [weeklyHours, setWeeklyHours] = useState('')
  const [dailyHours, setDailyHours] = useState('')

  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!user) return
      try {
        const p = await getMyProviderProfile()
        if (cancelled) return
        if (!p) {
          setProviderLoadError('Kein Betriebsprofil gefunden.')
          return
        }
        setProviderId(p.id)
      } catch {
        if (!cancelled) setProviderLoadError('Betriebsdaten konnten nicht geladen werden.')
      }
    })()
    return () => { cancelled = true }
  }, [user])

  const parsedWeekly = useMemo(() => {
    const t = weeklyHours.trim().replace(',', '.')
    if (t === '') return { ok: true, value: null as number | null }
    const n = Number(t)
    return Number.isFinite(n) && n >= 0 && n <= 168
      ? { ok: true, value: n }
      : { ok: false, value: null }
  }, [weeklyHours])

  const parsedDaily = useMemo(() => {
    const t = dailyHours.trim().replace(',', '.')
    if (t === '') return { ok: true, value: null as number | null }
    const n = Number(t)
    return Number.isFinite(n) && n >= 0 && n <= 24
      ? { ok: true, value: n }
      : { ok: false, value: null }
  }, [dailyHours])

  const hoursValid = parsedWeekly.ok && parsedDaily.ok
  const formValid =
    providerId !== null &&
    fullName.trim().length > 0 &&
    role.trim().length > 0 &&
    hoursValid

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!providerId || !formValid || pending) return
    setPending(true)
    setErrorText(null)
    try {
      const result = await createTeamMemberStub(providerId, {
        fullName: fullName.trim(),
        role:     role.trim(),
        phone:    phone.trim() || null,
        email:    email.trim().toLowerCase() || null,
        weeklyTargetHours: parsedWeekly.value,
        dailyTargetHours:  parsedDaily.value,
      })
      if (result.ok) {
        navigate(`/craftsman/team/${result.memberId}`, { replace: true })
        return
      }
      setErrorText(result.error)
    } catch {
      setErrorText('Anlegen fehlgeschlagen.')
    } finally {
      setPending(false)
    }
  }

  return (
    <AppShell>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[480px] space-y-5">
          <header>
            <button
              type="button"
              onClick={goBack}
              className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-500"
            >
              <ArrowLeft size={14} aria-hidden /> Zurück
            </button>
            <h1 className="mt-2 text-[22px] font-semibold text-slate-900">
              Neuer Mitarbeiter
            </h1>
            <p className="mt-1 text-[13px] text-slate-500">
              Lege den Eintrag jetzt an. Wenn der Mitarbeiter später mit dieser E-Mail dem
              Team über den Beitritts-Code beitritt, wird sein Konto automatisch verknüpft.
            </p>
          </header>

          {providerLoadError ? (
            <div className="rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 text-[13px] text-amber-900">
              {providerLoadError}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)] space-y-3">
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                    Name *
                  </span>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    disabled={pending}
                    autoComplete="name"
                    className="mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                    Rolle / Gewerk *
                  </span>
                  <input
                    type="text"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    disabled={pending}
                    placeholder="z. B. Elektriker, Polier, Lehrling"
                    className="mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                      Telefon
                    </span>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      disabled={pending}
                      autoComplete="tel"
                      className="mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                      E-Mail
                    </span>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={pending}
                      autoComplete="email"
                      className="mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                    />
                    <span className="mt-1 block text-[11px] text-slate-400">
                      Pflicht für Auto-Verknüpfung beim Beitritt.
                    </span>
                  </label>
                </div>
              </div>

              <div className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
                <h2 className="text-[14px] font-semibold text-slate-900">Stundenziele</h2>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  Soll-Stunden für die Kapazitätsplanung. Lohn wird hier nicht hinterlegt.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] font-medium text-slate-500">
                      Wochenstunden
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={weeklyHours}
                      onChange={(e) => setWeeklyHours(e.target.value)}
                      disabled={pending}
                      placeholder="40"
                      className={`mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 focus:outline-none focus:ring-2 disabled:opacity-50 ${
                        parsedWeekly.ok
                          ? 'ring-slate-200 focus:ring-blue-400'
                          : 'ring-rose-300 focus:ring-rose-400'
                      }`}
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-medium text-slate-500">
                      Tagesstunden
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={dailyHours}
                      onChange={(e) => setDailyHours(e.target.value)}
                      disabled={pending}
                      placeholder="8"
                      className={`mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 focus:outline-none focus:ring-2 disabled:opacity-50 ${
                        parsedDaily.ok
                          ? 'ring-slate-200 focus:ring-blue-400'
                          : 'ring-rose-300 focus:ring-rose-400'
                      }`}
                    />
                  </label>
                </div>
                {!hoursValid && (
                  <p className="mt-1 text-[11px] text-rose-600">
                    Ungültiger Wert. Wochen 0–168, Tag 0–24.
                  </p>
                )}
              </div>

              {errorText && (
                <p className="rounded-xl bg-rose-50 px-3 py-2 text-[13px] text-rose-700 ring-1 ring-rose-200">
                  {errorText}
                </p>
              )}

              <button
                type="submit"
                disabled={!formValid || pending}
                data-testid="member-create-submit"
                className="w-full rounded-full bg-slate-900 py-3 text-[14px] font-semibold text-white disabled:bg-slate-300"
              >
                {pending ? 'Lege an…' : 'Mitarbeiter anlegen'}
              </button>
            </form>
          )}
        </div>
      </section>
    </AppShell>
  )
}
