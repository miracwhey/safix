/**
 * RevenueCat integration — Block E (revised: 3-product offering)
 *
 * Wraps @revenuecat/purchases-capacitor and @revenuecat/purchases-capacitor-ui.
 * Handles: initialization, offerings fetch, purchase, restore, Customer Center.
 *
 * Product IDs (Apple App Store Connect):
 *   fixup_pro_6_months  — 749,99 € / 6 Monate
 *   fixup_pro_monthly   — 149,99 € / Monat
 *   fixup_pro_weekly    —  49,99 € / Woche
 *
 * All three map to RevenueCat entitlement "pro".
 *
 * External setup required:
 *   1. App Store Connect: 3 products created in subscription group "SaFix Pro"
 *   2. RevenueCat dashboard:
 *      - Entitlement "pro" → all 3 products mapped
 *      - Offering "default" with 3 packages (identifiers match product IDs)
 *   3. Env: VITE_REVENUECAT_PUBLIC_SDK_KEY in .env + Vercel
 *   4. Xcode: In-App Purchase capability, npx cap sync ios
 */

import { Purchases, LOG_LEVEL } from '@revenuecat/purchases-capacitor'
import { RevenueCatUI } from '@revenuecat/purchases-capacitor-ui'
import type { PurchasesPackage } from '@revenuecat/purchases-capacitor'
import { isNative } from '../platform'

// ── Product ID constants ──────────────────────────────────────────────────

export const RC_PRODUCT_IDS = {
  SIX_MONTHS: 'fixup_pro_6_months',
  MONTHLY: 'fixup_pro_monthly',
  WEEKLY: 'fixup_pro_weekly',
} as const

export const RC_ENTITLEMENT_ID = 'pro'

// ── Types ─────────────────────────────────────────────────────────────────

export type ProPackageId = 'six_months' | 'monthly' | 'weekly'

export type ProPackage = {
  id: ProPackageId
  pkg: PurchasesPackage
  productId: string
  /** StoreKit-localized price string, e.g. "149,99 €". Apple-compliant. */
  localizedPrice: string
  /** Display label, e.g. "6 Monate" */
  label: string
  /** Period suffix for secondary labels, e.g. "/ 6 Monate" */
  period: string
  /** Approximate daily price, e.g. "≈ 5,00 €/Tag". Computed from StoreKit price. */
  dailyPrice: string | null
  /** Monthly equivalent for 6M plan, e.g. "≈ 125 €/Monat". Null for other plans. */
  monthlyEquivalent: string | null
  /** Optional badge text */
  badge: string | null
}

export type ProPackages = {
  sixMonths: ProPackage | null
  monthly: ProPackage | null
  weekly: ProPackage | null
  /** Ordered for display: 6M first, then monthly, then weekly */
  ordered: ProPackage[]
}

// ── Singleton state ────────────────────────────────────────────────────────

let _initialized = false
let _initError: string | null = null

export function getRevenueCatStatus(): { ready: boolean; error: string | null } {
  return { ready: _initialized, error: _initError }
}

// ── Initialization ─────────────────────────────────────────────────────────

export async function initializeRevenueCat(userId: string): Promise<void> {
  if (!isNative()) return

  if (_initialized) {
    try {
      await Purchases.logIn({ appUserID: userId })
    } catch (e) {
      console.error('[RevenueCat] logIn failed:', e)
      // Reset so next initializeRevenueCat() call retries configure() with the correct userId
      _initialized = false
      _initError = e instanceof Error ? e.message : 'logIn() failed'
    }
    return
  }

  const apiKey = import.meta.env.VITE_REVENUECAT_PUBLIC_SDK_KEY as string | undefined
  if (!apiKey) {
    _initError = 'VITE_REVENUECAT_PUBLIC_SDK_KEY not set'
    console.error('[RevenueCat] VITE_REVENUECAT_PUBLIC_SDK_KEY not set — IAP unavailable')
    return
  }

  if (!apiKey.startsWith('appl_')) {
    _initError = `Invalid SDK key (expected appl_…, got "${apiKey.slice(0, 8)}…")`
    console.error('[RevenueCat] iOS SDK key must start with appl_. Found:', apiKey.slice(0, 8) + '…')
    return
  }

  try {
    await Purchases.configure({ apiKey, appUserID: userId })

    if (import.meta.env.DEV) {
      await Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG })
    }

    _initialized = true
    _initError = null
  } catch (e) {
    _initError = e instanceof Error ? e.message : 'configure() failed'
    console.error('[RevenueCat] configure() failed:', e)
  }
}

// ── Offerings ─────────────────────────────────────────────────────────────

const DAYS_IN_PERIOD: Record<ProPackageId, number> = {
  six_months: 182,
  monthly: 30,
  weekly: 7,
}

function formatDailyPrice(price: number, id: ProPackageId, currencyCode: string): string {
  const daily = price / DAYS_IN_PERIOD[id]
  const fmt = new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `≈ ${fmt.format(daily)}/Tag`
}

function formatMonthlyEquivalent(price: number, currencyCode: string): string {
  const monthly = price / 6
  const fmt = new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
  return `≈ ${fmt.format(monthly)}/Monat`
}

function buildProPackage(
  pkg: PurchasesPackage,
  id: ProPackageId,
  label: string,
  period: string,
  badge: string | null,
): ProPackage {
  const price = pkg.product.price
  const currencyCode = pkg.product.currencyCode ?? 'EUR'
  return {
    id,
    pkg,
    productId: pkg.product.identifier,
    localizedPrice: pkg.product.priceString,
    label,
    period,
    dailyPrice: formatDailyPrice(price, id, currencyCode),
    monthlyEquivalent: id === 'six_months' ? formatMonthlyEquivalent(price, currencyCode) : null,
    badge,
  }
}

export async function getProPackages(): Promise<ProPackages | null> {
  if (!isNative() || !_initialized) {
    return null
  }

  try {
    const offerings = await Purchases.getOfferings()
    const available = offerings.current?.availablePackages ?? []

    const find = (productId: string) =>
      available.find((p) => p.product.identifier === productId) ?? null

    const sixMonthsPkg = find(RC_PRODUCT_IDS.SIX_MONTHS)
    const monthlyPkg = find(RC_PRODUCT_IDS.MONTHLY)
    const weeklyPkg = find(RC_PRODUCT_IDS.WEEKLY)

    const sixMonths = sixMonthsPkg
      ? buildProPackage(sixMonthsPkg, 'six_months', '6 Monate', '/ 6 Monate', 'Spare 150 €')
      : null
    const monthly = monthlyPkg
      ? buildProPackage(monthlyPkg, 'monthly', 'Monatlich', '/ Monat', 'Empfohlen')
      : null
    const weekly = weeklyPkg
      ? buildProPackage(weeklyPkg, 'weekly', 'Wöchentlich', '/ Woche', 'Zum Testen')
      : null

    const ordered = [sixMonths, monthly, weekly].filter((p): p is ProPackage => p !== null)

    if (ordered.length === 0) return null

    return { sixMonths, monthly, weekly, ordered }
  } catch (e) {
    console.error('[RevenueCat] getProPackages() failed:', e)
    return null
  }
}

// ── Purchase ──────────────────────────────────────────────────────────────

export type PurchaseResult = 'success' | 'cancelled' | 'error'

export async function purchasePkg(pkg: PurchasesPackage): Promise<PurchaseResult> {
  if (!isNative() || !_initialized) return 'error'

  try {
    await Purchases.purchasePackage({ aPackage: pkg })
    return 'success'
  } catch (e: unknown) {
    const err = e as { userCancelled?: boolean | null }
    if (err?.userCancelled === true) return 'cancelled'
    return 'error'
  }
}

// ── Restore ───────────────────────────────────────────────────────────────

export async function restorePurchases(): Promise<boolean> {
  if (!isNative() || !_initialized) return false

  try {
    const { customerInfo } = await Purchases.restorePurchases()
    return RC_ENTITLEMENT_ID in customerInfo.entitlements.active
  } catch {
    return false
  }
}

// ── Entitlement check ─────────────────────────────────────────────────────

export async function hasActiveProEntitlement(): Promise<boolean> {
  if (!isNative() || !_initialized) return false

  try {
    const { customerInfo } = await Purchases.getCustomerInfo()
    return RC_ENTITLEMENT_ID in customerInfo.entitlements.active
  } catch {
    return false
  }
}

// ── Customer Center (RevenueCat UI) ────────────────────────────────────────

export async function presentCustomerCenter(): Promise<'success' | 'error'> {
  if (!isNative() || !_initialized) return 'error'
  try {
    await RevenueCatUI.presentCustomerCenter()
    return 'success'
  } catch (e) {
    console.error('[RevenueCat] presentCustomerCenter() failed:', e)
    return 'error'
  }
}
