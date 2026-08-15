import { getCraftsmanBusinessProfile } from '../craftsman/craftsmanProfileService'
import { logError } from '../observability'

/**
 * Best-effort resolution of craftsman issuer data for invoice draft creation.
 *
 * Returns { issuerName, issuerAddress } when the profile has a non-empty
 * businessName and businessAddress. Both fields are required for a legally
 * complete invoice; the invoice validation layer enforces address format at
 * issuance time.
 *
 * Returns undefined silently when businessAddress is missing or empty, which
 * causes the invoice to be created with placeholder issuer values — the
 * craftsman will then be blocked from issuing until a real address is stored.
 */
export async function resolveIssuerData(
  craftsmanUserId: string | undefined
): Promise<{ issuerName: string; issuerAddress: string } | undefined> {
  if (!craftsmanUserId) return undefined
  try {
    const profile = await getCraftsmanBusinessProfile(craftsmanUserId)
    if (profile?.businessName && profile.businessAddress) {
      return { issuerName: profile.businessName, issuerAddress: profile.businessAddress }
    }
    return undefined
  } catch (err) {
    logError('workflow.issuer_data_fetch_failed', err, { craftsmanUserId })
    return undefined
  }
}
