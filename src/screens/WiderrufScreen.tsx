/**
 * WiderrufScreen — § 356a BGB Widerrufsfunktion für das SaFix-Pro-Abo.
 *
 * Erreichbar über den „Vertrag widerrufen"-Eintrag im Abo-Verwalten-Bereich
 * (ProSubscriptionScreen, Manage-Modus). Zeigt die Widerrufsmaske: Vertrag
 * (fix = SaFix Pro), Kontakt-E-Mail (vorausgefüllt aus dem Konto) und die
 * zweite Schaltfläche „Widerruf bestätigen". Nach Bestätigung erscheint die
 * On-Screen-Eingangsbestätigung; die rechtlich maßgebliche Bestätigung folgt
 * per E-Mail (dauerhafter Datenträger, § 356a Abs. 3).
 *
 * Hinweis: Für die Handwerksleistung selbst ist der jeweilige Anbieter
 * Vertragspartner — nur für das SaFix-Pro-Abo ist SaFix Vertragspartner.
 */

import { useEffect, useState } from 'react'
import { ArrowLeft, Check } from 'lucide-react'
import AppShell from '../components/AppShell'
import { supabase } from '../lib/supabase'
import { submitWiderruf } from '../lib/widerruf/widerrufService'
import { useSmartBack } from '../hooks/useSmartBack'

const CONTRACT_LABEL = 'SaFix Pro Abonnement'

export default function WiderrufScreen() {
  const goBack = useSmartBack('/craftsman/subscription')
  const [contactEmail, setContactEmail] = useState('')
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done'>('form')
  const [error, setError] = useState<string | null>(null)
  const [maskedEmail, setMaskedEmail] = useState('')
  const [confirmationSent, setConfirmationSent] = useState(false)

  useEffect(() => {
    // App scroll lives in [data-app-scroll] (AppShell Body→Container), so
    // window.scrollTo is a no-op there — scroll the container, window fallback.
    const scroller = document.querySelector<HTMLElement>('[data-app-scroll]')
    if (scroller) scroller.scrollTo(0, 0)
    else window.scrollTo(0, 0)
  }, [])

  // Prefill the contact email from the signed-in account.
  useEffect(() => {
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      const email = data.session?.user?.email
      if (email) setContactEmail((prev) => (prev.length === 0 ? email : prev))
    })
    return () => {
      active = false
    }
  }, [])

  const handleConfirm = async () => {
    if (phase === 'submitting') return
    setError(null)
    const trimmed = contactEmail.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Bitte gib eine gültige E-Mail-Adresse an.')
      return
    }
    setPhase('submitting')
    const result = await submitWiderruf(trimmed)
    if (result.ok) {
      setMaskedEmail(result.maskedEmail)
      setConfirmationSent(result.confirmationSent)
      setPhase('done')
    } else {
      setError(result.error)
      setPhase('form')
    }
  }

  return (
    <AppShell active="profile" noSafeTop hideBottomNav>
      <div className="mx-auto w-full max-w-[420px] pb-16">
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4"
          style={{
            paddingTop: 'max(44px, calc(env(safe-area-inset-top, 0px) + 8px))',
            paddingBottom: 8,
          }}
        >
          <button
            type="button"
            onClick={goBack}
            aria-label="Zurück"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[rgba(120,120,128,0.14)] transition active:scale-90"
          >
            <ArrowLeft size={16} className="text-ink-sub" aria-hidden strokeWidth={2.2} />
          </button>
          <span className="text-[15px] font-semibold text-ink">Widerruf</span>
        </div>

        {phase === 'done' ? (
          <div className="px-4">
            <div className="mt-4 overflow-hidden rounded-[16px] bg-white p-5 ring-1 ring-edge">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint">
                <Check size={24} className="text-brand" aria-hidden strokeWidth={2.5} />
              </div>
              <h2 className="mt-3 text-[20px] font-bold tracking-[-0.3px] text-ink">
                Widerruf eingegangen
              </h2>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-sub">
                Wir haben deinen Widerruf zum {CONTRACT_LABEL} erfasst.
                {confirmationSent
                  ? ` Eine Eingangsbestätigung wurde an ${maskedEmail} gesendet.`
                  : ' Die Eingangsbestätigung per E-Mail folgt in Kürze.'}
              </p>
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-muted">
                Die laufende Abrechnung des Abos läuft über den App Store. Du kannst
                das Abo zusätzlich jederzeit unter iOS-Einstellungen → Apple-ID →
                Abonnements verwalten.
              </p>
            </div>
            <button
              type="button"
              onClick={goBack}
              className="mt-4 w-full rounded-[14px] bg-brand py-[15px] text-[16px] font-semibold text-white transition active:scale-[0.98]"
            >
              Fertig
            </button>
          </div>
        ) : (
          <div className="px-4">
            <p className="mt-1 text-[13.5px] leading-relaxed text-ink-sub">
              Hier kannst du dein kostenpflichtiges {CONTRACT_LABEL} widerrufen. Für
              die Handwerksleistung selbst ist der jeweilige Anbieter
              Vertragspartner — dieser Widerruf betrifft ausschließlich das Abo
              gegenüber SaFix.
            </p>

            {/* Contract (fixed) */}
            <div className="mt-4 overflow-hidden rounded-[16px] bg-white ring-1 ring-edge">
              <div className="flex items-center justify-between px-4 py-[13px]">
                <span className="text-[13px] text-ink-sub">Vertrag</span>
                <span className="text-[14px] font-medium text-ink">{CONTRACT_LABEL}</span>
              </div>
              <div className="border-t border-edge px-4 py-[13px]">
                <label htmlFor="widerruf-email" className="text-[13px] text-ink-sub">
                  Kontakt-E-Mail für die Bestätigung
                </label>
                <input
                  id="widerruf-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="name@beispiel.de"
                  className="mt-2 w-full rounded-[10px] bg-surface px-3 py-2.5 text-[14px] text-ink ring-1 ring-edge outline-none focus:ring-brand"
                />
              </div>
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">
              Hinweis zu den Folgen: Hast du den sofortigen Leistungsbeginn verlangt,
              schuldest du für die bis zum Widerruf erbrachte Leistung anteiligen
              Wertersatz. Erstattungen erfolgen über das ursprüngliche Zahlungsmittel.
            </p>

            {error && (
              <div className="mt-3 rounded-[12px] bg-tone-danger-bg px-4 py-3 text-[13px] text-tone-danger-fg ring-1 ring-tone-danger-fg/20">
                {error}
              </div>
            )}

            <button
              type="button"
              disabled={phase === 'submitting'}
              onClick={() => void handleConfirm()}
              className="mt-4 w-full rounded-[14px] bg-brand py-[15px] text-[16px] font-semibold text-white transition disabled:opacity-60 active:scale-[0.98]"
            >
              {phase === 'submitting' ? 'Wird übermittelt…' : 'Widerruf bestätigen'}
            </button>
          </div>
        )}
      </div>
    </AppShell>
  )
}
