import { supabase } from '../supabase'
import type { ProPackage } from './revenueCat'

/**
 * § 356 Abs. 4 BGB Consent-Audit.
 *
 * Beim Pro-Kauf bestätigt der Nutzer den sofortigen Leistungsbeginn und das
 * Erlöschen des Widerrufsrechts. `recordWithdrawalConsent` schreibt diesen
 * Verzicht append-only nach `subscription_withdrawal_consents` (RLS-scoped auf
 * die eigene user_id) als Beweis-Trail.
 *
 * Best-effort: wird erst NACH erfolgreichem Kauf aufgerufen. Schlägt das
 * Schreiben fehl, darf der Kauf-Erfolg nicht zurückgenommen werden — der
 * Aufrufer fängt Fehler ab und fährt fort.
 */

/** Version des Consent-Textes (StickyBuyCta). Bei Textänderung hochzählen. */
export const WITHDRAWAL_CONSENT_TEXT_VERSION = 'v1'

export async function recordWithdrawalConsent(packageId: ProPackage['id']): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) throw sessionError

  const user = session?.user
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase.from('subscription_withdrawal_consents').insert({
    user_id: user.id,
    package_id: packageId,
    consent_text_version: WITHDRAWAL_CONSENT_TEXT_VERSION,
  })

  if (error) throw error
}
