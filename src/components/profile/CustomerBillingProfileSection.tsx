import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, FileText } from 'lucide-react'
import {
  getMyCustomerBillingProfile,
  type CustomerBillingProfile,
} from '../../lib/customer/customerBillingProfileService'
import { isCustomerBillingProfileComplete } from '../../lib/customer/customerBillingProfileSelectors'

type Phase = 'loading' | 'ready' | 'error'

/**
 * Konto-Section für Customer-Rechnungsdaten (Block 7.1B2).
 *
 * Zeigt einen Vollständigkeits-Badge und verlinkt auf den Edit-Screen.
 * Bewusst kein eigenes Repo/Store — die Section liest direkt aus
 * `customerBillingProfileService` und revalidiert beim Mount. Reload-Pfad
 * für den Status nach Save: User kommt aus dem Edit-Screen via
 * `navigate(-1)` zurück, der Effekt liest dann erneut.
 */
export default function CustomerBillingProfileSection() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [profile, setProfile] = useState<CustomerBillingProfile | null>(null)

  useEffect(() => {
    let cancelled = false

    getMyCustomerBillingProfile()
      .then((p) => {
        if (cancelled) return
        setProfile(p)
        setPhase('ready')
      })
      .catch((err) => {
        console.error('[CustomerBillingProfileSection] load failed:', err)
        if (!cancelled) setPhase('error')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const isComplete = phase === 'ready' && isCustomerBillingProfileComplete(profile)
  // Overview line: show the saved name + place once present, otherwise prompt.
  const overview = [profile?.billingName, profile?.billingCity]
    .map((v) => (v ?? '').trim())
    .filter(Boolean)
    .join(' · ')
  const subtitle =
    phase === 'loading'
      ? 'Status wird geladen …'
      : phase === 'error'
        ? 'Status konnte nicht geladen werden'
        : overview
          ? overview
          : 'Name, Anschrift & Kontakt ergänzen'

  return (
    <Link
      to="/account/billing-profile"
      className="flex w-full items-center justify-between rounded-container bg-surface px-5 py-4 ring-1 ring-edge shadow-elevated transition hover:bg-slate-50 active:scale-[0.99]"
      data-testid="customer-billing-profile-section"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-brand/10">
          <FileText size={20} className="text-brand" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-ink">Persönliche Daten</div>
          <div
            className="truncate text-[12px] text-ink-muted"
            data-testid="customer-billing-profile-status"
          >
            {subtitle}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {phase === 'ready' && !isComplete ? (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-700 ring-1 ring-amber-200">
            Unvollständig
          </span>
        ) : null}
        <ChevronRight size={16} className="shrink-0 text-brand" aria-hidden />
      </div>
    </Link>
  )
}
