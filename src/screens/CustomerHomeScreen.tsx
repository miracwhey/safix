import { useEffect, useMemo } from 'react'
import AppShell from '../components/AppShell'
import SectionEyebrow from '../components/primitives/SectionEyebrow'
import GuidedEntryCard from '../components/customer/GuidedEntryCard'
import CustomerAnswerCard, {
  CustomerAnswerCardSkeleton,
} from '../components/customer/CustomerAnswerCard'
import CustomerHomeHeader from '../components/customer/CustomerHomeHeader'
import HomeSearchCard from '../components/customer/HomeSearchCard'
import HomeProjectsRow from '../components/customer/HomeProjectsRow'
import { CustomerSpatialHomeCard } from '../components/home/CustomerSpatialHomeCard'
import { setDiscoveryProviderCache } from '../lib/discovery'
import { getExploreProviderCards } from '../lib/explore/exploreProfileService'
import { useCustomerAnswerCard } from '../hooks/useHomeState'
import { useCustomerContext } from '../hooks/useCustomerContext'

/**
 * Customer home — JTBD / Frage→Antwort.
 *
 * Column: Header → Greeting → adaptive Answer-Card (active project) OR
 * GuidedEntry (new customer) → Schnellzugriff (Search) → Meine Räume (3D) →
 * Alle-Projekte row.
 *
 * The answer card's lifecycle/tone/route truth is owned by `useCustomerAnswerCard`
 * (canonical projection + `deriveCustomerNextAction`); this screen is the shell.
 */
export default function CustomerHomeScreen() {
  const { topProject, model, activeProjectCount, isHydrated } = useCustomerAnswerCard()

  // Greeting name: derive the FIRST name from the canonical full name
  // (customer_billing_profiles.billing_name, projected into the context store).
  const { displayName: fullName } = useCustomerContext()
  const firstName = useMemo(() => fullName.trim().split(/\s+/)[0] || null, [fullName])

  const greetingDate = useMemo(
    () => new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }),
    [],
  )

  // Money-path warm-load: caches explore provider cards so downstream inquiry
  // workflows resolve providers without another roundtrip (feeds
  // `findCachedProviderByCategory`). Display-only `providerCount` was removed;
  // the cache itself is load-bearing and MUST stay.
  useEffect(() => {
    let cancelled = false
    getExploreProviderCards()
      .then((cards) => {
        if (cancelled) return
        if (cards.length > 0) setDiscoveryProviderCache(cards)
      })
      .catch(() => {
        // non-blocking
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <AppShell active="home" noSafeTop>
      {/* Background tint. Starts at the native status-bar colour (#F5F6FA, set
          in capacitor.config + bootstrap) so the non-overlay status bar blends
          seamlessly — no white bar at the top — then a subtle blue glow.
          `noSafeTop` + a tight own top pad: with overlaysWebView:false the OS
          already insets below the status bar, so AppShell's 48px fallback would
          double-pad. env() keeps it safe if overlay is ever turned on. */}
      <section className="min-h-[100dvh] bg-[linear-gradient(180deg,#F5F6FA_0%,#EAF0FB_28%,#F4F6FB_66%)] px-4 pb-6 pt-[max(16px,env(safe-area-inset-top,0px))]">
        <div className="mx-auto w-full max-w-[420px] space-y-4">

          {/* ── Header ── */}
          <CustomerHomeHeader />

          {/* ── Greeting ── */}
          <div className="px-1">
            <h1 className="text-[26px] font-bold leading-[1.1] tracking-[-0.02em] text-ink">
              Guten Tag{firstName ? `, ${firstName}` : ''}
            </h1>
            <p className="mt-1 text-[13px] text-ink-muted">{greetingDate}</p>
          </div>

          {/* ── Answer card (active project) OR GuidedEntry (new customer) ── */}
          {!isHydrated ? (
            <CustomerAnswerCardSkeleton />
          ) : topProject && model ? (
            <CustomerAnswerCard model={model} />
          ) : (
            <GuidedEntryCard />
          )}

          {/* ── Schnellzugriff — generic browse (manual mode = 9 % platform path) ── */}
          <div className="space-y-2.5">
            <SectionEyebrow>Schnellzugriff</SectionEyebrow>
            <HomeSearchCard
              to="/search"
              state={{ mode: 'manual' }}
              title="Handwerker finden"
              subtitle="Betriebe in deiner Nähe entdecken"
            />
          </div>

          {/* ── Meine Räume — 3D-Aufmaße ── */}
          <div className="space-y-2.5">
            <SectionEyebrow>Meine Räume</SectionEyebrow>
            <CustomerSpatialHomeCard />
          </div>

          {/* ── Alle Projekte — single tappable row → /projects ── */}
          <HomeProjectsRow
            to="/projects"
            count={isHydrated ? activeProjectCount : undefined}
          />

        </div>
      </section>
    </AppShell>
  )
}
