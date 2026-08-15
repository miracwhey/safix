import type { CustomerContext } from './customerContextStore'

/**
 * Describes how complete the customer's own profile setup is.
 *
 * 'empty'    – no fields filled; the customer has not personalised their setup.
 * 'partial'  – at least one field is present but the setup is not yet complete.
 * 'complete' – all key setup fields are present.
 */
export type CustomerSetupReadiness = 'empty' | 'partial' | 'complete'

export type CustomerSetupViewModel = {
  readiness: CustomerSetupReadiness
  /** True only when every key setup field is present. */
  isComplete: boolean
  hasDisplayName: boolean
  hasCity: boolean
  /**
   * Short German label suitable for a badge or subtitle.
   * e.g. "Profil vollständig" / "Profil unvollständig"
   */
  setupLabel: string
  /**
   * Short hint for the customer about what is still missing.
   * Empty string when the setup is already complete.
   */
  setupHint: string
}

/**
 * Describes whether the customer can start a new service request from the
 * profile area, and what context would be pre-filled from their setup.
 */
export type NewRequestReadinessViewModel = {
  /**
   * Whether the customer has enough context to start a meaningful request.
   * True when at least one of name or city is set.
   */
  canStart: boolean
  /**
   * Location value to pre-fill the request location field.
   * Empty string when city is not set.
   */
  prefillLocation: string
  /**
   * Name to use as the sender in the new request thread.
   */
  prefillName: string
  /**
   * Hint shown beneath the entry card when setup is incomplete.
   * Empty when no hint is needed.
   */
  setupNudge: string
}

/**
 * Derives a `CustomerSetupViewModel` from the customer context.
 *
 * Pure function — performs no state mutations.
 */
export function deriveCustomerSetupReadiness(
  context: CustomerContext
): CustomerSetupViewModel {
  const hasDisplayName = context.displayName.trim().length > 0
  const hasCity = context.city.trim().length > 0

  let readiness: CustomerSetupReadiness
  if (hasDisplayName && hasCity) {
    readiness = 'complete'
  } else if (hasDisplayName || hasCity) {
    readiness = 'partial'
  } else {
    readiness = 'empty'
  }

  const setupLabel =
    readiness === 'complete' ? 'Profil vollständig' : 'Profil unvollständig'

  let setupHint = ''
  if (readiness !== 'complete') {
    const missing: string[] = []
    if (!hasDisplayName) missing.push('Name')
    if (!hasCity) missing.push('Ort')
    setupHint = `Noch ausstehend: ${missing.join(', ')}`
  }

  return {
    readiness,
    isComplete: readiness === 'complete',
    hasDisplayName,
    hasCity,
    setupLabel,
    setupHint,
  }
}

/**
 * Derives a `NewRequestReadinessViewModel` from the customer context.
 *
 * Determines what context is available to pre-fill a new service request
 * and whether the customer should be nudged to complete their profile first.
 *
 * Pure function — performs no state mutations.
 */
export function deriveNewRequestReadiness(
  context: CustomerContext
): NewRequestReadinessViewModel {
  const name = context.displayName.trim()
  const city = context.city.trim()

  const canStart = name.length > 0 || city.length > 0

  const missing: string[] = []
  if (!name) missing.push('Name')
  if (!city) missing.push('Ort')

  const setupNudge =
    missing.length > 0
      ? `Tipp: Mit vollständigem Profil (${missing.join(', ')}) wird deine Anfrage besser.`
      : ''

  return {
    canStart,
    prefillLocation: city,
    prefillName: name || 'Kunde',
    setupNudge,
  }
}
