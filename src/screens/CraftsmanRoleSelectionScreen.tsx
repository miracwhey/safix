import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, Wrench } from 'lucide-react'
import AppShell from '../components/AppShell'
import { getCurrentUser, signOut } from '../lib/auth'
import { setMyCraftsmanRole, type CraftsmanRole } from '../lib/profile'
import { refreshSession, applyRoleToSession } from '../lib/session'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Speichern fehlgeschlagen'
}

export default function CraftsmanRoleSelectionScreen() {
  const navigate = useNavigate()

  const [saving, setSaving] = useState<CraftsmanRole | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = async (role: CraftsmanRole) => {
    setError(null)
    setSaving(role)

    try {
      const user = await getCurrentUser()

      if (!user) {
        navigate('/login', { replace: true })
        return
      }

      await setMyCraftsmanRole(role)
      applyRoleToSession('craftsman', role)
      void refreshSession()

      if (role === 'owner') {
        navigate('/onboarding/craftsman-profile', { replace: true })
      } else {
        navigate('/onboarding/worker', { replace: true })
      }
    } catch (error) {
      setError(getErrorMessage(error))
    } finally {
      setSaving(null)
    }
  }

  const cardBase =
    'w-full text-left bg-surface rounded-container ring-1 ring-edge p-5 flex items-center gap-4 transition active:scale-[0.99]'
  const shadow = 'shadow-elevated'
  const disabled = 'opacity-60 pointer-events-none'

  return (
    <AppShell hideBottomNav>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="flex flex-col items-center text-center">
            <div className="h-16 w-16 rounded-card bg-brand shadow-elevated flex items-center justify-center">
              <span className="text-white text-2xl font-extrabold">F</span>
            </div>

            <h1 className="mt-4 text-[22px] font-semibold text-ink">
              Wie nutzt du SaFix als Handwerker?
            </h1>
            <p className="mt-1 text-[14px] text-ink-muted">
              Wähle aus, ob du den Betrieb führst oder als Mitarbeiter arbeitest.
            </p>

            {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}
          </div>

          <div className="mt-6 space-y-4">
            <button
              type="button"
              onClick={() => choose('owner')}
              disabled={!!saving}
              className={[cardBase, shadow, saving ? disabled : ''].join(' ')}
            >
              <div className="h-12 w-12 rounded-card bg-brand/10 flex items-center justify-center">
                <Building2 size={22} className="text-brand" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="text-[16px] font-semibold text-ink">Ich führe den Betrieb</div>
                <div className="mt-0.5 text-[13px] text-ink-muted">
                  Geschäftsführer, Inhaber oder Admin mit Backoffice-Zugriff
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => choose('worker')}
              disabled={!!saving}
              className={[cardBase, shadow, saving ? disabled : ''].join(' ')}
            >
              <div className="h-12 w-12 rounded-card bg-brand/10 flex items-center justify-center">
                <Wrench size={22} className="text-brand" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="text-[16px] font-semibold text-ink">Ich arbeite im Betrieb</div>
                <div className="mt-0.5 text-[13px] text-ink-muted">
                  Mitarbeiter mit Fokus auf Jobs, Termine und Ausführung
                </div>
              </div>
            </button>
          </div>

          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-4 w-full py-2 text-[13px] text-slate-400 hover:text-slate-600 transition"
          >
            Abmelden
          </button>
        </div>
      </section>
    </AppShell>
  )
}
