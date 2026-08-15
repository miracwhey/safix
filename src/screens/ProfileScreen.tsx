import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { User, ChevronRight, Bell, Users, Bookmark, Building2, UserCheck } from 'lucide-react'
import AppShell from '../components/AppShell'
import ProfileAccountCard from '../components/profile/ProfileAccountCard'
import ProfileActionsCard from '../components/profile/ProfileActionsCard'
import CustomerProfileSummaryCard from '../components/profile/CustomerProfileSummaryCard'
import CustomerContextCard from '../components/profile/CustomerContextCard'
import CustomerBillingProfileSection from '../components/profile/CustomerBillingProfileSection'
import CustomerProfileSpatialEntry from '../components/profile/CustomerProfileSpatialEntry'
import IdentitySettingsSection from '../components/messages/IdentitySettingsSection'
import SubscriptionCard from '../components/subscription/SubscriptionCard'
import { useSession } from '../hooks/useSession'
import { useSubscription } from '../hooks/useSubscription'
import { useSavedFolders } from '../lib/savedReels/useSavedFolders'
import { useSavedProviders } from '../lib/savedProviders/useSavedProviders'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import { getProjects } from '../lib/projects/projectsStore'
import { deriveCustomerProjectSummary } from '../lib/jobs/customerProfileSelectors'
import {
  getCustomerContext,
  subscribeCustomerContext,
  type CustomerContext,
} from '../lib/customer/customerContextStore'
import {
  deriveCustomerSetupReadiness,
} from '../lib/customer/customerSetupSelectors'

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="text-[11px] font-extrabold uppercase tracking-[0.22em] text-slate-400 pt-2">
      {label}
    </div>
  )
}

export default function ProfileScreen() {
  const navigate = useNavigate()
  const { user, role, craftsmanRole, loading, sessionValidated } = useSession()
  const subscription = useSubscription()
  const savedFolders = useSavedFolders()
  const savedProviders = useSavedProviders()

  const [customerContext, setCustomerContext] = useState<CustomerContext>(
    getCustomerContext()
  )

  useEffect(() => {
    return subscribeCustomerContext(() => {
      setCustomerContext(getCustomerContext())
    })
  }, [])

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login', { replace: true })
    }
  }, [loading, user, navigate])

  if (loading || !sessionValidated) {
    return (
      <AppShell active="profile">
        <ScreenSkeleton variant="detail" />
      </AppShell>
    )
  }

  const email = user?.email ?? ''

  return (
    <AppShell active="profile">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px]">
          {/* Page header */}
          <h1 className="text-[22px] font-semibold text-slate-900">Konto</h1>

          {/* --- Profil --- */}
          <div className="mt-5 space-y-3">
            <SectionHeader label="Profil" />
            <ProfileAccountCard email={email} role={role} craftsmanRole={craftsmanRole} />

            {craftsmanRole === 'owner' && (
              <>
                <Link
                  to="/craftsman/profile"
                  className="flex w-full items-center justify-between rounded-container bg-surface px-5 py-4 ring-1 ring-edge shadow-elevated transition hover:bg-slate-50 active:scale-[0.99]"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-brand/10">
                      <User size={20} className="text-brand" aria-hidden />
                    </span>
                    <div>
                      <div className="text-[15px] font-semibold text-ink">Mein Betriebsprofil</div>
                      <div className="text-[12px] text-ink-muted">Profil, Showcase & Medien verwalten</div>
                    </div>
                  </div>
                  <ChevronRight size={16} className="shrink-0 text-brand" aria-hidden />
                </Link>
                <Link
                  to="/craftsman/team"
                  className="flex w-full items-center justify-between rounded-container bg-surface px-5 py-4 ring-1 ring-edge shadow-elevated transition hover:bg-slate-50 active:scale-[0.99]"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-brand/10">
                      <Users size={20} className="text-brand" aria-hidden />
                    </span>
                    <div>
                      <div className="text-[15px] font-semibold text-ink">Mein Team</div>
                      <div className="text-[12px] text-ink-muted">Beitritts-Code rotieren & Mitarbeiter verwalten</div>
                    </div>
                  </div>
                  <ChevronRight size={16} className="shrink-0 text-brand" aria-hidden />
                </Link>
                <Link
                  to="/craftsman/profile/tax-bank"
                  className="flex w-full items-center justify-between rounded-container bg-surface px-5 py-4 ring-1 ring-edge shadow-elevated transition hover:bg-slate-50 active:scale-[0.99]"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-brand/10">
                      <Building2 size={20} className="text-brand" aria-hidden />
                    </span>
                    <div>
                      <div className="text-[15px] font-semibold text-ink">Betriebsdaten</div>
                      <div className="text-[12px] text-ink-muted">IBAN, Steuer & Rechnungsinfo</div>
                    </div>
                  </div>
                  <ChevronRight size={16} className="shrink-0 text-brand" aria-hidden />
                </Link>
              </>
            )}

            {role === 'customer' && (
              <CustomerContextCard
                context={customerContext}
                setup={deriveCustomerSetupReadiness(customerContext)}
              />
            )}
          </div>

          {/* --- Öffentliche Identität — @Handle, Auffindbarkeit, DM-Privatsphäre.
                 Für beide Rollen: die kanonische Personen-Identität, über die man
                 per @Handle gefunden und direkt angeschrieben werden kann. --- */}
          <div className="mt-6">
            <IdentitySettingsSection />
          </div>

          {/* --- Persönliche Daten (Kunden) — Name, Anschrift & Kontakt.
                 Eine kanonische Quelle (customer_billing_profiles); speist auch
                 Begrüßung, Anfrage-Prefill und rechtssichere Rechnungen. --- */}
          {role === 'customer' && (
            <div className="mt-6 space-y-3">
              <SectionHeader label="Persönliche Daten" />
              <CustomerBillingProfileSection />
            </div>
          )}

          {/* --- SaFix Pro (Owner only) — always shown so free-tier users see the promo --- */}
          {craftsmanRole === 'owner' && (
            <div className="mt-6 space-y-3">
              <SectionHeader label="SaFix Pro" />
              <SubscriptionCard
                effectiveState={subscription.effectiveState ?? 'trial_available'}
                row={subscription.row ?? null}
                onPress={() => navigate('/craftsman/subscription')}
              />
            </div>
          )}

          {/* --- Meine Projekte (Kunden) --- */}
          {role === 'customer' && (
            <div className="mt-6 space-y-3">
              <SectionHeader label="Meine Projekte" />
              <CustomerProfileSummaryCard
                summary={deriveCustomerProjectSummary(getProjects())}
              />
            </div>
          )}

          {/* --- Räume & 3D (Kunden) — V1.5.1 3-Welt-Teaser --- */}
          {role === 'customer' && (
            <div className="mt-6 space-y-3">
              <SectionHeader label="Räume & 3D" />
              <CustomerProfileSpatialEntry />
            </div>
          )}

          {/* --- Benachrichtigungen (Kunden) --- */}
          {role === 'customer' && (
            <div className="mt-6 space-y-3">
              <SectionHeader label="Updates" />
              <Link
                to="/notifications"
                className="flex w-full items-center justify-between rounded-container bg-surface px-5 py-4 ring-1 ring-edge shadow-elevated transition hover:bg-slate-50 active:scale-[0.99]"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-brand/10">
                    <Bell size={20} className="text-brand" aria-hidden />
                  </span>
                  <div>
                    <div className="text-[15px] font-semibold text-ink">Benachrichtigungen</div>
                    <div className="text-[12px] text-ink-muted">Updates zu Projekten, Zahlungen & mehr</div>
                  </div>
                </div>
                <ChevronRight size={16} className="shrink-0 text-brand" aria-hidden />
              </Link>
            </div>
          )}

          {/* --- Aktivität --- */}
          <div className="mt-6 space-y-3">
            <SectionHeader label="Aktivität" />
            <Link
              to="/profile/saved-reels"
              className="flex w-full items-center justify-between rounded-container bg-surface px-5 py-4 ring-1 ring-edge shadow-elevated transition hover:bg-slate-50 active:scale-[0.99]"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-brand/10">
                  <Bookmark size={20} className="text-brand" aria-hidden />
                </span>
                <div>
                  <div className="text-[15px] font-semibold text-ink">Gespeicherte Reels</div>
                  <div className="text-[12px] text-ink-muted">
                    {savedFolders.hydrated
                      ? `${savedFolders.totalSaved} ${savedFolders.totalSaved === 1 ? 'Reel' : 'Reels'} · ${savedFolders.folders.length} ${savedFolders.folders.length === 1 ? 'Ordner' : 'Ordner'}`
                      : 'Reels und Ordner verwalten'}
                  </div>
                </div>
              </div>
              <ChevronRight size={16} className="shrink-0 text-brand" aria-hidden />
            </Link>

            <Link
              to="/profile/saved-providers"
              className="flex w-full items-center justify-between rounded-container bg-surface px-5 py-4 ring-1 ring-edge shadow-elevated transition hover:bg-slate-50 active:scale-[0.99]"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-brand/10">
                  <UserCheck size={20} className="text-brand" aria-hidden />
                </span>
                <div>
                  <div className="text-[15px] font-semibold text-ink">Gespeicherte Handwerker</div>
                  <div className="text-[12px] text-ink-muted">
                    {savedProviders.hydrated
                      ? `${savedProviders.entries.length} Handwerker gespeichert`
                      : 'Favoriten verwalten'}
                  </div>
                </div>
              </div>
              <ChevronRight size={16} className="shrink-0 text-brand" aria-hidden />
            </Link>
          </div>

          {/* --- App & Einstellungen --- */}
          <div className="mt-6 space-y-3">
            <SectionHeader label="App & Einstellungen" />
            <ProfileActionsCard role={role} />
          </div>
        </div>
      </section>
    </AppShell>
  )
}
