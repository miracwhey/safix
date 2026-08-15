/**
 * ProSubscriptionScreen — A+ v5 "3D-Karten überall"
 *
 * Buy mode  (trial_available / expired): light cream page, top header bar,
 *   blue gradient hero with hex pattern + glow + 3 angled 3D-cards,
 *   3 separate package buttons, sticky CTA with trust line inside wrapper.
 * Manage mode (trial_active / active / grace / canceled): dark navy nav-only hero
 *   + state card + details card + manage controls.
 *
 * Apple compliance:
 *   - Prices fetched from StoreKit via RevenueCat (pkg.product.priceString). No hardcoded amounts.
 *   - "Kauf wiederherstellen" always visible (App Store guideline 3.1.1).
 *   - Subscription management via RevenueCatUI.presentCustomerCenter().
 *   - Package error: error card with retry, no fallback prices.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check } from 'lucide-react'
import AppShell from '../components/AppShell'
import SubscriptionPreviewCards from '../components/subscription/SubscriptionPreviewCards'
import { useSubscription } from '../hooks/useSubscription'
import { useSmartBack } from '../hooks/useSmartBack'
import {
  getProPackages,
  purchasePkg,
  restorePurchases,
  presentCustomerCenter,
  hasActiveProEntitlement,
  getRevenueCatStatus,
  type ProPackage,
  type ProPackages,
  type PurchaseResult,
} from '../lib/subscription/revenueCat'
import type { EffectiveSubscriptionStatus } from '../lib/subscription/types'
import { recordWithdrawalConsent } from '../lib/subscription/withdrawalConsent'

// ── Feature lists (manage mode reminder + success overlay) ────────────────

const PRO_FEATURES_SHORT = [
  'Mitarbeiter verwalten',
  'Stunden & Schichten',
  'Einsatzplanung & Kalender',
  'Interne Team-Chats',
  'Finanz-Cockpit',
]

const PRO_FEATURES_FULL: { label: string; sub: string }[] = [
  { label: 'Mitarbeiter verwalten',       sub: 'Rollen, Aufgaben, Zugriff' },
  { label: 'Stunden & Schichten',         sub: 'Zeiterfassung pro Mitarbeiter' },
  { label: 'Einsatzplanung & Kalender',   sub: 'Termine, Routen, Auslastung im Team' },
  { label: 'Interne Team-Chats',          sub: 'Kommunikation mit deinem Team' },
  { label: 'Finanz-Cockpit',              sub: 'Umsatz, offene Posten, USt.' },
  { label: 'Korrekturen',                 sub: 'Ergänzende Aufträge revisionssicher' },
  { label: 'Unbegrenzte Highlights',      sub: 'Top-Platzierung deiner Profile' },
]

// ── State sets ────────────────────────────────────────────────────────────

const MANAGE_STATES: ReadonlySet<EffectiveSubscriptionStatus> = new Set([
  'trial_active',
  'active',
  'grace',
  'canceled',
])

// ── Manage state pills (on light/white card background) ───────────────────

const MANAGE_PILLS: Record<string, { label: string; textColor: string; bgColor: string; dotColor: string }> = {
  trial_active: { label: 'Trial läuft',  textColor: '#1D4ED8', bgColor: 'rgba(29,78,216,0.09)',    dotColor: '#1D4ED8' },
  active:       { label: 'Betrieb aktiv',textColor: '#0E7A46', bgColor: 'rgba(14,122,70,0.10)',    dotColor: '#0E7A46' },
  grace:        { label: 'Kulanzzeit',   textColor: '#B45309', bgColor: 'rgba(180,83,9,0.09)',     dotColor: '#B45309' },
  canceled:     { label: 'Gekündigt',    textColor: '#6B7280', bgColor: 'rgba(107,114,128,0.10)', dotColor: '#9CA3AF' },
}

// ── Buy mode tokens ───────────────────────────────────────────────────────

const PAGE_BG = 'rgb(246,245,241)'

const HERO_GRADIENT =
  'linear-gradient(168deg, rgb(36,86,194) 0%, rgb(27,63,139) 60%, rgb(18,43,102) 100%)'

const HERO_OUTER_SHADOW =
  'rgba(14,31,71,0.6) 0px 18px 36px -16px, rgba(255,255,255,0.07) 0px 0px 0px 0.5px inset'

const CTA_SHADOW = [
  'rgba(255,255,255,0.18) 0 1px 0 0 inset',
  'rgba(0,0,0,0.15) 0 -1px 0 0 inset',
  'rgb(19,48,140) 0 2px 0 0',
  'rgba(8,18,48,0.30) 0 6px 12px',
  'rgba(31,70,200,0.55) 0 16px 26px -8px',
  'rgba(8,18,48,0.50) 0 30px 44px -16px',
].join(', ')

const PKG_SHADOW_SELECTED = [
  'rgba(255,255,255,0.85) 0 1px 0 0 inset',
  'rgba(8,18,48,0.10) 0 2px 4px',
  'rgba(8,18,48,0.12) 0 8px 18px -6px',
  'rgba(31,70,200,0.33) 0 0 0 1px',
].join(', ')

const PKG_SHADOW_DEFAULT = [
  'rgba(255,255,255,0.75) 0 1px 0 0 inset',
  'rgba(8,18,48,0.06) 0 1px 2px',
  'rgba(8,18,48,0.08) 0 6px 14px -6px',
  'rgba(15,20,38,0.10) 0 0 0 0.5px',
].join(', ')

// ── Main screen ───────────────────────────────────────────────────────────

export default function ProSubscriptionScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/profile')
  const subscription = useSubscription()

  const [packages, setPackages] = useState<ProPackages | null>(null)
  const [packagesError, setPackagesError] = useState(false)
  const [selectedPkg, setSelectedPkg] = useState<ProPackage | null>(null)
  // § 356 Abs. 4 BGB: explicit consent to immediate start + Wertersatz on early
  // withdrawal. Non-pre-checked, gates the order button.
  const [consentGiven, setConsentGiven] = useState(false)
  const [phase, setPhase] = useState<
    'idle' | 'purchasing' | 'restoring' | 'success' | 'error' | 'opening_center'
  >('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [rcError, setRcError] = useState<string | null>(null)
  const loadAttemptRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // App scroll lives in [data-app-scroll] (AppShell Body→Container), so
    // window.scrollTo is a no-op there — scroll the container, window fallback.
    const scroller = document.querySelector<HTMLElement>('[data-app-scroll]')
    if (scroller) scroller.scrollTo(0, 0)
    else window.scrollTo(0, 0)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const state = subscription.effectiveState ?? 'trial_available'
  const isManageMode = MANAGE_STATES.has(state)

  const loadPackages = useCallback(() => {
    const attempt = ++loadAttemptRef.current
    getProPackages().then((pkgs) => {
      if (attempt !== loadAttemptRef.current) return
      if (!pkgs || pkgs.ordered.length === 0) {
        const rcStatus = getRevenueCatStatus()
        setRcError(rcStatus.error)
        setPackagesError(true)
        return
      }
      setPackagesError(false)
      setRcError(null)
      setPackages(pkgs)
      setSelectedPkg(pkgs.monthly ?? pkgs.ordered[0] ?? null)
    })
  }, [])

  useEffect(() => {
    if (!isManageMode) loadPackages()
  }, [isManageMode, loadPackages])

  const handlePurchase = useCallback(async () => {
    if (phase !== 'idle' || !selectedPkg || !consentGiven) return
    setPhase('purchasing')
    setErrorMessage(null)

    const result: PurchaseResult = await purchasePkg(selectedPkg.pkg)

    if (result === 'success') {
      void hasActiveProEntitlement()
      // § 356 Abs. 4 BGB: record the immediate-start / withdrawal-waiver consent
      // as an append-only audit trail. Best-effort — never undo a successful
      // purchase if the audit write fails.
      try {
        await recordWithdrawalConsent(selectedPkg.id)
      } catch (err) {
        // Never undo a successful purchase if the audit write fails. Log so a
        // missed § 356 consent row is traceable (e.g. before migration apply).
        console.warn('recordWithdrawalConsent failed (purchase succeeded):', err)
      }
      subscription.refetch()
      setPhase('success')
    } else if (result === 'cancelled') {
      setPhase('idle')
    } else {
      setPhase('error')
      setErrorMessage('Kauf konnte nicht abgeschlossen werden. Bitte versuche es erneut.')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => { setPhase('idle'); setErrorMessage(null) }, 4000)
    }
  }, [phase, selectedPkg, consentGiven, subscription])

  const handleRestore = useCallback(async () => {
    if (phase !== 'idle') return
    setPhase('restoring')
    setErrorMessage(null)
    const restored = await restorePurchases()
    if (restored) {
      subscription.refetch()
      setPhase('success')
    } else {
      setPhase('error')
      setErrorMessage('Kein aktives Abo gefunden.')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => { setPhase('idle'); setErrorMessage(null) }, 3000)
    }
  }, [phase, subscription])

  const handleCustomerCenter = useCallback(async () => {
    if (phase !== 'idle') return
    const rcStatus = getRevenueCatStatus()
    if (!rcStatus.ready) {
      setPhase('error')
      setErrorMessage('In-App-Käufe nicht verfügbar. Bitte App aktualisieren.')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => { setPhase('idle'); setErrorMessage(null) }, 4000)
      return
    }
    setPhase('opening_center')
    const result = await presentCustomerCenter()
    setPhase('idle')
    if (result === 'error') {
      setErrorMessage('Abo-Verwaltung konnte nicht geöffnet werden. Bitte verwalte dein Abo unter iOS Einstellungen → Apple‑ID → Abonnements.')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => { setErrorMessage(null) }, 7000)
    }
  }, [phase])

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString('de-DE', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : null

  return (
    <AppShell active="profile" noSafeTop hideBottomNav>
      {phase === 'success' && (
        <SuccessOverlay onContinue={goBack} />
      )}

      <div
        className="mx-auto w-full max-w-[420px]"
        style={isManageMode ? undefined : { background: PAGE_BG, minHeight: '100dvh' }}
      >
        {isManageMode ? (
          <>
            <DarkManageHero onClose={goBack} />
            <ManageContent
              state={state}
              row={subscription.row}
              fmt={fmt}
              phase={phase}
              errorMessage={errorMessage}
              onCustomerCenter={() => void handleCustomerCenter()}
              onRestore={() => void handleRestore()}
              onOpenLegal={(section) => navigate(`/legal/${section}`)}
              onWiderruf={() => navigate('/craftsman/subscription/widerruf')}
            />
          </>
        ) : (
          <>
            <BuyHeaderBar
              phase={phase}
              onClose={goBack}
              onRestore={() => void handleRestore()}
            />
            <BlueBuyHero state={state} />
            <BuyContent
              packages={packages}
              packagesError={packagesError}
              rcError={rcError}
              selectedPkg={selectedPkg}
              errorMessage={errorMessage}
              onSelectPkg={setSelectedPkg}
              onRetryPackages={loadPackages}
              onOpenLegal={(section) => navigate(`/legal/${section}`)}
            />
          </>
        )}

        {!isManageMode && phase !== 'success' && (
          <StickyBuyCta
            state={state}
            phase={phase}
            selectedPkg={selectedPkg}
            consentGiven={consentGiven}
            onToggleConsent={setConsentGiven}
            onPurchase={() => void handlePurchase()}
            onOpenWiderruf={() => navigate('/legal/widerruf')}
          />
        )}
      </div>
    </AppShell>
  )
}

// ── Buy mode: top header bar (light background, above hero) ───────────────

function BuyHeaderBar({
  phase,
  onClose,
  onRestore,
}: {
  phase: string
  onClose: () => void
  onRestore: () => void
}) {
  return (
    <div
      style={{
        background: PAGE_BG,
        paddingTop: 'max(44px, calc(env(safe-area-inset-top, 0px) + 8px))',
        paddingBottom: 4,
        paddingLeft: 16,
        paddingRight: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 'auto',
        gap: 8,
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Zurück"
        className="flex h-8 w-8 items-center justify-center rounded-full transition active:scale-90"
        style={{ background: 'rgba(120,120,128,0.14)' }}
      >
        <ArrowLeft size={16} style={{ color: '#5A6178' }} aria-hidden strokeWidth={2.2} />
      </button>
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '-0.1px',
          color: 'rgb(90,97,120)',
        }}
      >
        SaFix Betrieb
      </span>
      <button
        type="button"
        disabled={phase !== 'idle'}
        onClick={onRestore}
        className="rounded-md px-2 py-1.5 transition disabled:opacity-40 active:scale-95"
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: 'rgb(31,70,200)',
        }}
      >
        {phase === 'restoring' ? '…' : 'Wiederherstellen'}
      </button>
    </div>
  )
}

// ── Buy mode: blue hero with hex pattern + glow + cards ───────────────────

function BlueBuyHero({ state }: { state: EffectiveSubscriptionStatus }) {
  const headline =
    state === 'expired'
      ? 'Weitermachen wo du aufgehört hast.'
      : 'Dein Betrieb. Voll digital.'

  return (
    <div style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 8 }}>
      <div
        style={{
          position: 'relative',
          background: HERO_GRADIENT,
          borderRadius: 22,
          boxShadow: HERO_OUTER_SHADOW,
          overflow: 'hidden',
          paddingTop: 14,
          paddingBottom: 14,
          paddingLeft: 20,
          paddingRight: 20,
        }}
      >
        {/* Hex pattern */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            opacity: 0.18,
            pointerEvents: 'none',
            maskImage:
              'radial-gradient(130% 100% at 70% 30%, rgb(0,0,0) 25%, rgba(0,0,0,0.7) 55%, rgba(0,0,0,0.25) 80%, rgba(0,0,0,0) 100%)',
            WebkitMaskImage:
              'radial-gradient(130% 100% at 70% 30%, rgb(0,0,0) 25%, rgba(0,0,0,0.7) 55%, rgba(0,0,0,0.25) 80%, rgba(0,0,0,0) 100%)',
          }}
        >
          <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="fixup-hex-bg" width="22" height="20" patternUnits="userSpaceOnUse">
                <path
                  d="M11 0L22 6V14L11 20L0 14V6L11 0Z"
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="0.6"
                />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#fixup-hex-bg)" />
          </svg>
        </div>

        {/* Glow top-right */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(80% 60% at 85% 0%, rgba(132,165,235,0.22), rgba(0,0,0,0) 70%)',
            pointerEvents: 'none',
          }}
        />

        {/* Content */}
        <div style={{ position: 'relative', zIndex: 1 }}>
          {/* Header row: SaFix + PRO  ·  EDITION 2026 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span
              style={{
                color: 'rgb(239,233,220)',
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: '-0.2px',
              }}
            >
              SaFix{' '}
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: '1.6px',
                  textTransform: 'uppercase',
                }}
              >
                Betrieb
              </span>
            </span>
            <span
              style={{
                color: 'rgba(239,233,220,0.7)',
                fontSize: 8.5,
                fontWeight: 600,
                letterSpacing: '1.6px',
                textTransform: 'uppercase',
              }}
            >
              Edition 2026
            </span>
          </div>

          {/* Headline */}
          <h1
            style={{
              marginTop: 12,
              fontSize: 26,
              fontWeight: 700,
              lineHeight: '28.08px',
              letterSpacing: '-0.5px',
              color: 'rgb(239,233,220)',
              maxWidth: 290,
            }}
          >
            {headline}
          </h1>

          {/* Subtitle */}
          <p
            style={{
              marginTop: 6,
              fontSize: 13.5,
              fontWeight: 400,
              lineHeight: '20.92px',
              color: 'rgba(239,233,220,0.78)',
              maxWidth: 300,
            }}
          >
            Kostenlos für jeden Handwerker: Anfragen, Angebote, Aufträge,
            Rechnungen, Auszahlung — alles ohne Abo. SaFix Betrieb: wenn du ein
            Team führst.
          </p>

          {/* 3D Cards */}
          <div style={{ marginTop: 16, marginBottom: 4 }}>
            <SubscriptionPreviewCards />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Dark hero — manage mode (nav bar only) ───────────────────────────────

function DarkManageHero({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        background: '#0E1426',
        paddingTop: 'max(44px, calc(env(safe-area-inset-top, 0px) + 8px))',
        paddingBottom: 8,
        paddingLeft: 20,
        paddingRight: 20,
        borderBottomLeftRadius: 28,
        borderBottomRightRadius: 28,
      }}
    >
      <div className="flex items-center" style={{ height: 36 }}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zurück"
          className="flex h-8 w-8 items-center justify-center rounded-full transition active:scale-90"
          style={{ background: 'rgba(239,233,220,0.10)' }}
        >
          <ArrowLeft size={15} style={{ color: '#EFE9DC' }} aria-hidden />
        </button>
        <span
          className="flex-1 text-center text-[13px] font-medium"
          style={{ color: 'rgba(239,233,220,0.70)' }}
        >
          SaFix Betrieb
        </span>
        <div style={{ width: 32 }} aria-hidden />
      </div>
    </div>
  )
}

// ── Buy content (light section: section labels + 3 packages + footer) ─────

function BuyContent({
  packages,
  packagesError,
  rcError,
  selectedPkg,
  errorMessage,
  onSelectPkg,
  onRetryPackages,
  onOpenLegal,
}: {
  packages: ProPackages | null
  packagesError: boolean
  rcError: string | null
  selectedPkg: ProPackage | null
  errorMessage: string | null
  onSelectPkg: (pkg: ProPackage) => void
  onRetryPackages: () => void
  onOpenLegal: (section: 'agb' | 'datenschutz' | 'impressum') => void
}) {
  return (
    <div style={{ paddingBottom: 'calc(var(--bottom-nav-h) + 160px)' }}>
      {/* Section labels */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 22,
          paddingRight: 22,
          paddingTop: 14,
          paddingBottom: 8,
        }}
      >
        <p
          style={{
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: '1.6px',
            textTransform: 'uppercase',
            color: 'rgb(90,97,120)',
            margin: 0,
          }}
        >
          Wähle dein Paket
        </p>
        <p
          style={{
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '0.6px',
            color: 'rgb(90,97,120)',
            margin: 0,
          }}
        >
          {packages ? `${packages.ordered.length} Pakete` : '3 Pakete'}
        </p>
      </div>

      {/* Packages */}
      {packagesError ? (
        rcError ? (
          <div className="mx-4 rounded-[16px] bg-tone-warning-bg p-4 text-center ring-1 ring-tone-warning-fg/20">
            <p className="text-[14px] font-medium text-tone-warning-fg">
              In-App-Käufe nicht verfügbar
            </p>
            <p className="mt-1 text-[12px] text-tone-warning-fg/80">
              SDK-Konfigurationsfehler. Bitte App aktualisieren.
            </p>
          </div>
        ) : (
          <div className="mx-4 rounded-[16px] bg-tone-danger-bg p-4 text-center ring-1 ring-tone-danger-fg/20">
            <p className="text-[14px] text-tone-danger-fg">
              Preise konnten nicht geladen werden.
            </p>
            <button
              type="button"
              onClick={onRetryPackages}
              className="mt-2 text-[13px] font-medium text-tone-danger-fg underline"
            >
              Erneut versuchen
            </button>
          </div>
        )
      ) : packages ? (
        <div style={{ paddingLeft: 16, paddingRight: 16 }}>
          {packages.ordered.map((pkg) => (
            <PackageButton
              key={pkg.id}
              pkg={pkg}
              selected={selectedPkg?.id === pkg.id}
              onSelect={() => onSelectPkg(pkg)}
            />
          ))}
        </div>
      ) : (
        <div style={{ paddingLeft: 16, paddingRight: 16 }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                height: 70,
                background: '#fff',
                borderRadius: 14,
                marginBottom: 10,
                boxShadow: PKG_SHADOW_DEFAULT,
                opacity: 0.6,
              }}
              className="animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Error message */}
      {errorMessage && (
        <div className="mx-4 mt-2 rounded-[12px] bg-tone-danger-bg px-4 py-3 text-[13px] text-tone-danger-fg ring-1 ring-tone-danger-fg/20">
          {errorMessage}
        </div>
      )}

      {/* Section label: Was du bekommst */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 24,
          paddingBottom: 8,
          paddingLeft: 22,
          paddingRight: 22,
        }}
      >
        <p
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
            color: 'rgb(90,97,120)',
            margin: 0,
          }}
        >
          Was du bekommst
        </p>
        <p
          style={{
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '0.3px',
            color: 'rgb(90,97,120)',
            margin: 0,
          }}
        >
          7 Funktionen
        </p>
      </div>

      {/* Feature list card */}
      <div
        style={{
          marginLeft: 16,
          marginRight: 16,
          borderRadius: 16,
          background: '#fff',
          overflow: 'hidden',
          boxShadow: PKG_SHADOW_DEFAULT,
        }}
      >
        {PRO_FEATURES_FULL.map((feature, i) => (
          <div
            key={feature.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '11px 16px',
              borderTop: i > 0 ? '0.5px solid rgba(15,20,38,0.08)' : 'none',
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: 'rgb(238,242,251)',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              aria-hidden
            >
              <Check size={12} strokeWidth={2.5} style={{ color: 'rgb(31,70,200)' }} />
            </div>
            <div>
              <p style={{ fontSize: 14.5, fontWeight: 500, color: 'rgb(14,20,38)', margin: 0 }}>
                {feature.label}
              </p>
              <p style={{ fontSize: 12, color: 'rgb(90,97,120)', margin: 0, marginTop: 1 }}>
                {feature.sub}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Trust badges */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          margin: '14px 16px 0',
        }}
      >
        {([
          { top: '§14 UStG', sub: 'rechtssicher' },
          { top: 'Apple Pay', sub: null },
          { top: 'Zahlung', sub: null },
          { top: 'Made in DE 🇩🇪', sub: null },
        ] as { top: string; sub: string | null }[]).map(({ top, sub }) => (
          <div
            key={top}
            style={{
              display: 'flex',
              flexDirection: 'column',
              padding: '5px 10px',
              borderRadius: 8,
              background: 'rgba(15,20,38,0.05)',
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 600, color: 'rgb(14,20,38)', letterSpacing: '-0.1px' }}>
              {top}
            </span>
            {sub && (
              <span style={{ fontSize: 9, color: 'rgb(90,97,120)', marginTop: 1 }}>
                {sub}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Subscription disclaimer */}
      <p
        style={{
          textAlign: 'center',
          fontSize: 11.5,
          fontWeight: 400,
          color: 'rgb(122,128,148)',
          lineHeight: '17px',
          padding: '20px 24px 4px',
          margin: 0,
        }}
      >
        14 Tage kostenlos. Danach verlängert sich das Abo zum gewählten Preis
        automatisch. Kündigung jederzeit in den Apple-Einstellungen möglich.
      </p>

      {/* Legal footer links — underlined, centered, subtle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: '4px 12px',
          padding: '8px 24px 4px',
        }}
      >
        {([
          { label: 'AGB', section: 'agb' },
          { label: 'Datenschutz', section: 'datenschutz' },
          { label: 'Impressum', section: 'impressum' },
        ] as const).map(({ label, section }, i, arr) => (
          <span
            key={section}
            style={{ display: 'flex', alignItems: 'center', gap: 12 }}
          >
            <button
              type="button"
              onClick={() => onOpenLegal(section)}
              style={{
                fontSize: 11,
                fontWeight: 400,
                color: 'rgb(90,97,120)',
                textDecoration: 'underline',
                textUnderlineOffset: 2,
                background: 'none',
                border: 'none',
                padding: 0,
                margin: 0,
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              {label}
            </button>
            {i < arr.length - 1 && (
              <span style={{ color: 'rgb(122,128,148)', fontSize: 10 }} aria-hidden>
                ·
              </span>
            )}
          </span>
        ))}
      </div>

      {/* Spacer so sticky CTA doesn't cover legal links */}
      <div style={{ height: 100 }} aria-hidden />
    </div>
  )
}

// ── Package button (3 separate cards, NOT one container) ──────────────────

function PackageButton({
  pkg,
  selected,
  onSelect,
}: {
  pkg: ProPackage
  selected: boolean
  onSelect: () => void
}) {
  const badgeStyle = badgeStyleFor(pkg.id)

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 12,
        padding: '11px 16px',
        marginBottom: 8,
        background: selected ? 'rgb(232,237,253)' : 'rgb(255,255,255)',
        borderRadius: 14,
        boxShadow: selected ? PKG_SHADOW_SELECTED : PKG_SHADOW_DEFAULT,
        transform: selected ? 'translateY(-1px)' : 'translateY(0)',
        transition: 'transform 140ms ease, background 140ms ease, box-shadow 140ms ease',
        textAlign: 'left',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {/* Radio circle */}
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: selected ? 'rgb(31,70,200)' : 'rgba(15,20,38,0.06)',
          border: selected ? 'none' : '1.5px solid rgba(15,20,38,0.18)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected && (
          <Check size={12} strokeWidth={3} style={{ color: '#fff' }} aria-hidden />
        )}
      </span>

      {/* Label + sub */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '-0.1px',
              color: 'rgb(14,20,38)',
            }}
          >
            {pkg.label}
          </span>
          {pkg.badge && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                padding: '2px 6px',
                borderRadius: 4,
                background: badgeStyle.bg,
                color: badgeStyle.fg,
              }}
            >
              {pkg.badge}
            </span>
          )}
        </div>
        {pkg.monthlyEquivalent && (
          <p
            style={{
              marginTop: 2,
              fontSize: 12.5,
              fontWeight: 400,
              color: 'rgb(90,97,120)',
              margin: 0,
            }}
          >
            {pkg.monthlyEquivalent}
          </p>
        )}
      </div>

      {/* Price */}
      <div style={{ flexShrink: 0, textAlign: 'right' }}>
        <p
          style={{
            fontSize: 16.5,
            fontWeight: 700,
            letterSpacing: '-0.3px',
            color: 'rgb(14,20,38)',
            fontVariantNumeric: 'tabular-nums',
            margin: 0,
          }}
        >
          {pkg.localizedPrice}
        </p>
        {pkg.dailyPrice && (
          <p
            style={{
              marginTop: 1,
              fontSize: 11,
              fontWeight: 400,
              color: 'rgb(122,128,148)',
              fontVariantNumeric: 'tabular-nums',
              margin: 0,
            }}
          >
            {pkg.dailyPrice}
          </p>
        )}
      </div>
    </button>
  )
}

function badgeStyleFor(pkgId: ProPackage['id']): { bg: string; fg: string } {
  switch (pkgId) {
    case 'six_months':
      return { bg: 'rgb(226,241,234)', fg: 'rgb(14,124,87)' }
    case 'monthly':
      return { bg: 'rgb(229,236,247)', fg: 'rgb(27,63,139)' }
    case 'weekly':
      return { bg: 'rgb(236,237,241)', fg: 'rgb(90,97,120)' }
  }
}

// ── Manage content (light section) ───────────────────────────────────────

function ManageContent({
  state,
  row,
  fmt,
  phase,
  errorMessage,
  onCustomerCenter,
  onRestore,
  onOpenLegal,
  onWiderruf,
}: {
  state: EffectiveSubscriptionStatus
  row: ReturnType<typeof useSubscription>['row']
  fmt: (iso: string | null) => string | null
  phase: string
  errorMessage: string | null
  onCustomerCenter: () => void
  onRestore: () => void
  onOpenLegal: (section: 'agb' | 'datenschutz' | 'impressum') => void
  onWiderruf: () => void
}) {
  const pill = MANAGE_PILLS[state] ?? {
    label: state,
    textColor: '#6B7280',
    bgColor: 'rgba(107,114,128,0.10)',
    dotColor: '#9CA3AF',
  }

  const stateSubtitle: string = (() => {
    switch (state) {
      case 'trial_active':
        return row?.trial_ends_at
          ? `Trial endet am ${fmt(row.trial_ends_at)}`
          : '14-Tage Testzeitraum'
      case 'active':
        return 'Alle Betrieb-Funktionen aktiv'
      case 'grace':
        return 'Zahlung ausstehend'
      case 'canceled':
        return row?.current_period_end
          ? `Aktiv bis ${fmt(row.current_period_end)}`
          : 'Abo wurde gekündigt'
      default:
        return ''
    }
  })()

  const thirdRowLabel =
    state === 'trial_active' ? 'Nach Trial' :
    state === 'canceled'     ? 'Reaktivierung' :
    'Plan-Wechsel'

  const thirdRowValue =
    state === 'trial_active' ? 'Abo wählbar' :
    state === 'canceled'     ? 'Möglich' :
    'In Verwaltung möglich'

  return (
    <div className="pb-10">
      {/* ── State card: pill + title + subtitle ── */}
      <div className="mx-4 mt-4 overflow-hidden rounded-[16px] bg-white ring-1 ring-edge">
        <div className="px-4 pb-5 pt-5">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-[5px] text-[11px] font-semibold uppercase tracking-[0.5px]"
            style={{ color: pill.textColor, background: pill.bgColor }}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: pill.dotColor }}
              aria-hidden
            />
            {pill.label}
          </span>
          <h2 className="mt-2.5 text-[26px] font-extrabold tracking-[-0.5px] text-ink">
            SaFix Betrieb
          </h2>
          <p className="mt-1 text-[13.5px] text-ink-sub">{stateSubtitle}</p>
        </div>
      </div>

      {/* ── Details card ── */}
      <div className="mx-4 mt-3 overflow-hidden rounded-[16px] bg-white ring-1 ring-edge">
        {state === 'trial_active' && row?.trial_ends_at && (
          <DetailRow label="Trial endet" value={fmt(row.trial_ends_at) ?? '—'} />
        )}
        {state === 'active' && row?.current_period_end && (
          <DetailRow label="Nächste Verlängerung" value={fmt(row.current_period_end) ?? '—'} />
        )}
        {state === 'canceled' && row?.current_period_end && (
          <DetailRow label="Aktiv bis" value={fmt(row.current_period_end) ?? '—'} />
        )}
        {state === 'grace' && row?.grace_started_at && (
          <DetailRow label="Kulanzzeit seit" value={fmt(row.grace_started_at) ?? '—'} />
        )}
        <DetailRow label="Zahlungsart" value="Apple Pay" divider />
        <DetailRow label={thirdRowLabel} value={thirdRowValue} divider />
      </div>

      {/* ── Abo verwalten button ── */}
      <div className="mx-4 mt-4">
        <button
          type="button"
          disabled={phase !== 'idle'}
          onClick={onCustomerCenter}
          className="w-full rounded-[14px] bg-brand py-[15px] text-[16px] font-semibold text-white transition disabled:opacity-60 active:scale-[0.98]"
          style={{ boxShadow: 'var(--shadow-brand-glow)' }}
        >
          {phase === 'opening_center' ? 'Wird geöffnet…' : 'Abo verwalten'}
        </button>
      </div>

      {/* § 356a BGB Widerrufsfunktion — leicht zugänglich während der Frist */}
      <div className="mx-4 mt-2">
        <button
          type="button"
          onClick={onWiderruf}
          className="w-full rounded-[14px] bg-white py-[13px] text-[14px] font-medium text-ink-sub ring-1 ring-edge transition active:scale-[0.98]"
        >
          Vertrag widerrufen
        </button>
      </div>

      {/* Error message */}
      {errorMessage && (
        <div className="mx-4 mt-3 rounded-[12px] bg-tone-danger-bg px-4 py-3 text-[13px] text-tone-danger-fg ring-1 ring-tone-danger-fg/20">
          {errorMessage}
        </div>
      )}

      {/* ── Features reminder ── */}
      <div className="mt-6 flex items-center justify-between px-[22px] pb-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.6px] text-[#5A6178]">
          In deinem Abo enthalten
        </p>
      </div>
      <div className="mx-4 overflow-hidden rounded-[16px] bg-surface ring-1 ring-edge">
        {PRO_FEATURES_SHORT.map((f, i) => (
          <div
            key={f}
            className={`flex items-center gap-3 px-4 py-[13px] ${i > 0 ? 'border-t border-edge' : ''}`}
          >
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-tint">
              <Check size={11} className="text-brand" aria-hidden />
            </div>
            <span className="text-[14px] font-medium text-ink">{f}</span>
          </div>
        ))}
      </div>

      {/* ── Footer links ── */}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pb-8 pt-6 text-[12px] text-ink-sub">
        {([
          { label: 'AGB', section: 'agb' },
          { label: 'Datenschutz', section: 'datenschutz' },
          { label: 'Impressum', section: 'impressum' },
        ] as const).map(({ label, section }, i, arr) => (
          <span key={section} className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onOpenLegal(section)}
              className="text-ink-sub underline-offset-2 hover:underline"
            >
              {label}
            </button>
            {i < arr.length - 1 && (
              <span className="text-ink-muted" aria-hidden>·</span>
            )}
          </span>
        ))}
        <span className="text-ink-muted" aria-hidden>·</span>
        <button
          type="button"
          disabled={phase !== 'idle'}
          onClick={onRestore}
          className="underline-offset-2 hover:underline disabled:opacity-50"
        >
          Wiederherstellen
        </button>
      </div>
    </div>
  )
}

// ── Sticky buy CTA (with trust line INSIDE wrapper) ───────────────────────

function StickyBuyCta({
  state,
  phase,
  selectedPkg,
  consentGiven,
  onToggleConsent,
  onPurchase,
  onOpenWiderruf,
}: {
  state: EffectiveSubscriptionStatus
  phase: string
  selectedPkg: ProPackage | null
  consentGiven: boolean
  onToggleConsent: (v: boolean) => void
  onPurchase: () => void
  onOpenWiderruf: () => void
}) {
  const btnLabel =
    phase === 'purchasing'
      ? 'Wird verarbeitet…'
      : 'Zahlungspflichtig abonnieren'

  const showTrustLine =
    state === 'trial_available' &&
    (selectedPkg == null || selectedPkg.pkg.product.introPrice != null)

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 30,
        margin: '0 auto',
        maxWidth: 420,
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 16,
        paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
        background:
          'linear-gradient(180deg, rgba(246,245,241,0) 0%, rgba(246,245,241,0.96) 30%)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          marginBottom: 10,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={consentGiven}
          onChange={(e) => onToggleConsent(e.target.checked)}
          style={{ marginTop: 2, width: 16, height: 16, flexShrink: 0 }}
        />
        <span style={{ fontSize: 11, lineHeight: 1.45, color: 'rgb(90,97,120)' }}>
          Ich verlange den sofortigen Beginn der Leistung und akzeptiere, dass mein
          Widerrufsrecht mit vollständiger Erfüllung erlischt; bei Widerruf nach
          Beginn schulde ich anteiligen Wertersatz.
        </span>
      </label>
      <button
        type="button"
        onClick={onOpenWiderruf}
        style={{
          alignSelf: 'flex-start',
          marginTop: -4,
          marginBottom: 10,
          marginLeft: 24,
          fontSize: 11,
          fontWeight: 400,
          color: 'rgb(90,97,120)',
          textDecoration: 'underline',
          textUnderlineOffset: 2,
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        Widerrufsbelehrung lesen
      </button>
      <button
        type="button"
        disabled={phase !== 'idle' || !selectedPkg || !consentGiven}
        onClick={onPurchase}
        style={{
          width: '100%',
          height: 50,
          paddingLeft: 18,
          paddingRight: 18,
          background: 'rgb(31,70,200)',
          borderRadius: 14,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: CTA_SHADOW,
          opacity: phase !== 'idle' || !selectedPkg || !consentGiven ? 0.6 : 1,
          transition: 'transform 140ms ease, opacity 140ms ease',
          cursor: phase !== 'idle' || !selectedPkg || !consentGiven ? 'not-allowed' : 'pointer',
          WebkitTapHighlightColor: 'transparent',
        }}
        className="active:scale-[0.98]"
      >
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.2px' }}>
          {btnLabel}
        </span>
        {selectedPkg && phase !== 'purchasing' && (
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: '-0.3px',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {selectedPkg.localizedPrice}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                opacity: 0.78,
              }}
            >
              {selectedPkg.period}
            </span>
          </span>
        )}
      </button>

      {showTrustLine && (
        <p
          style={{
            marginTop: 8,
            textAlign: 'center',
            fontSize: 11.5,
            fontWeight: 400,
            color: 'rgb(90,97,120)',
            letterSpacing: '0.1px',
          }}
        >
          14 Tage kostenlos · jederzeit kündbar
        </p>
      )}
    </div>
  )
}

// ── Success overlay ───────────────────────────────────────────────────────

function SuccessOverlay({ onContinue }: { onContinue: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center px-7 pb-9 pt-16 text-center text-white"
      style={{ background: 'linear-gradient(180deg, #2563EB 0%, #1D4ED8 100%)' }}
    >
      <GoldDot className="absolute left-[15%] top-[20%] h-2 w-2" delay="0s" />
      <GoldDot className="absolute right-[20%] top-[30%] h-1.5 w-1.5" delay="0.4s" />
      <GoldDot className="absolute left-[30%] top-[55%] h-2.5 w-2.5" delay="0.8s" />
      <GoldDot className="absolute right-[12%] top-[65%] h-1.5 w-1.5" delay="0.2s" />

      <div
        className="flex h-[92px] w-[92px] items-center justify-center rounded-full ring-[1.5px] ring-white/50"
        style={{
          background: 'rgba(255,255,255,0.14)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <Check size={42} strokeWidth={3} className="text-white" aria-hidden />
      </div>

      <p className="mt-5 text-[12px] font-bold uppercase tracking-[1.6px] text-white/70">
        Betrieb aktiviert
      </p>
      <h2 className="mt-2 text-[32px] font-bold tracking-[-0.6px]">Willkommen.</h2>
      <p className="mt-3 text-[15px] text-white/78">
        Alle Betrieb-Funktionen sind jetzt freigeschaltet.
      </p>

      <div
        className="mt-6 w-full max-w-[320px] rounded-[14px] px-5 py-4 text-left ring-1 ring-white/20"
        style={{ background: 'rgba(255,255,255,0.08)' }}
      >
        {PRO_FEATURES_SHORT.slice(0, 3).map((f) => (
          <div key={f} className="flex items-center gap-2.5 py-1">
            <Check size={14} className="text-pro-gold" aria-hidden />
            <span className="text-[13px] font-medium">{f}</span>
          </div>
        ))}
        <p className="mt-2 text-[12px] text-pro-gold">
          + 2 weitere Funktionen
        </p>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="mt-8 w-full max-w-[320px] rounded-[14px] bg-white py-[15px] text-[15px] font-bold text-brand transition active:scale-[0.98]"
      >
        Weiter
      </button>
    </div>
  )
}

function GoldDot({ className, delay }: { className: string; delay: string }) {
  return (
    <span
      className={`rounded-full bg-pro-gold ${className}`}
      style={{ filter: 'blur(2px)', animationDelay: delay }}
      aria-hidden
    />
  )
}

// ── Detail row ────────────────────────────────────────────────────────────

function DetailRow({
  label,
  value,
  divider = false,
}: {
  label: string
  value: string
  divider?: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between px-4 py-[13px] ${divider ? 'border-t border-edge' : ''}`}
    >
      <span className="text-[13px] text-ink-sub">{label}</span>
      <span className="text-[14px] font-medium text-ink">{value}</span>
    </div>
  )
}
