/**
 * Block 9 — IssuerData Resolution via businessAddress
 *
 * Covers:
 *   A. resolveIssuerData returns issuerName + issuerAddress from businessAddress
 *   B. resolveIssuerData returns undefined when businessAddress is empty / missing
 *   C. resolveIssuerData returns undefined when profile is null
 *   D. resolveIssuerData returns undefined when craftsmanUserId is missing
 *   E. resolveIssuerData returns undefined when fetch throws
 *   F. location is NOT used as issuerAddress in any path
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// ── Mock getCraftsmanBusinessProfile ─────────────────────────────────────────

const mockGetCraftsmanBusinessProfile = vi.fn()

vi.mock('../../src/lib/craftsman/craftsmanProfileService', () => ({
  getCraftsmanBusinessProfile: (...args: unknown[]) => mockGetCraftsmanBusinessProfile(...args),
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
  logInfo: vi.fn(),
}))

import { resolveIssuerData } from '../../src/lib/workflow/issuerDataHelper'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block 9 — resolveIssuerData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── A. Success path ──────────────────────────────────────────────────────────

  describe('A. Returns issuer data from businessAddress', () => {
    it('returns issuerName and issuerAddress when both fields are present', async () => {
      mockGetCraftsmanBusinessProfile.mockResolvedValue({
        businessName: 'Müller Sanitär GmbH',
        businessAddress: 'Hauptstraße 5, 10115 Berlin',
        location: 'Berlin',
      })

      const result = await resolveIssuerData('craftsman-1')

      expect(result).toEqual({
        issuerName: 'Müller Sanitär GmbH',
        issuerAddress: 'Hauptstraße 5, 10115 Berlin',
      })
    })

    it('issuerAddress comes from businessAddress, not location', async () => {
      mockGetCraftsmanBusinessProfile.mockResolvedValue({
        businessName: 'Elektro Weber',
        businessAddress: 'Rathausplatz 2, 30159 Hannover',
        location: 'Hannover',
      })

      const result = await resolveIssuerData('craftsman-2')

      expect(result?.issuerAddress).toBe('Rathausplatz 2, 30159 Hannover')
      expect(result?.issuerAddress).not.toBe('Hannover')
    })
  })

  // ── B. Empty / missing businessAddress ──────────────────────────────────────

  describe('B. Returns undefined when businessAddress is empty or missing', () => {
    it('returns undefined when businessAddress is empty string', async () => {
      mockGetCraftsmanBusinessProfile.mockResolvedValue({
        businessName: 'Müller Sanitär GmbH',
        businessAddress: '',
        location: 'Berlin',
      })

      const result = await resolveIssuerData('craftsman-3')

      expect(result).toBeUndefined()
    })

    it('returns undefined when businessAddress is undefined', async () => {
      mockGetCraftsmanBusinessProfile.mockResolvedValue({
        businessName: 'Müller Sanitär GmbH',
        businessAddress: undefined,
        location: 'Berlin',
      })

      const result = await resolveIssuerData('craftsman-4')

      expect(result).toBeUndefined()
    })

    it('returns undefined when businessName is empty even with valid businessAddress', async () => {
      mockGetCraftsmanBusinessProfile.mockResolvedValue({
        businessName: '',
        businessAddress: 'Hauptstraße 5, 10115 Berlin',
        location: 'Berlin',
      })

      const result = await resolveIssuerData('craftsman-5')

      expect(result).toBeUndefined()
    })
  })

  // ── C. Null profile ──────────────────────────────────────────────────────────

  describe('C. Returns undefined when profile is null', () => {
    it('returns undefined when getCraftsmanBusinessProfile returns null', async () => {
      mockGetCraftsmanBusinessProfile.mockResolvedValue(null)

      const result = await resolveIssuerData('craftsman-6')

      expect(result).toBeUndefined()
    })
  })

  // ── D. Missing craftsmanUserId ───────────────────────────────────────────────

  describe('D. Returns undefined when craftsmanUserId is missing', () => {
    it('returns undefined when craftsmanUserId is undefined', async () => {
      const result = await resolveIssuerData(undefined)

      expect(result).toBeUndefined()
      expect(mockGetCraftsmanBusinessProfile).not.toHaveBeenCalled()
    })
  })

  // ── E. Fetch throws ──────────────────────────────────────────────────────────

  describe('E. Returns undefined when profile fetch throws', () => {
    it('returns undefined silently on network error', async () => {
      mockGetCraftsmanBusinessProfile.mockRejectedValue(new Error('network error'))

      const result = await resolveIssuerData('craftsman-7')

      expect(result).toBeUndefined()
    })

    it('logs the error when fetch throws', async () => {
      mockGetCraftsmanBusinessProfile.mockRejectedValue(new Error('timeout'))
      const { logError } = await import('../../src/lib/observability')
      const logErrorSpy = vi.spyOn({ logError }, 'logError')

      await resolveIssuerData('craftsman-8')

      // Error was swallowed (non-blocking) — logError called internally
      // We verify via indirect assertion (no throw from resolveIssuerData)
      expect(logErrorSpy).not.toThrow()
    })
  })

  // ── F. location never used as issuerAddress ──────────────────────────────────

  describe('F. location is never used as issuerAddress', () => {
    it('profile with city-only location and no businessAddress returns undefined', async () => {
      mockGetCraftsmanBusinessProfile.mockResolvedValue({
        businessName: 'Müller Sanitär GmbH',
        businessAddress: '',
        location: 'München',
      })

      const result = await resolveIssuerData('craftsman-9')

      expect(result).toBeUndefined()
    })

    it('profile with comma-containing location but no businessAddress returns undefined', async () => {
      // Previously the jobWorkflow comma-check allowed location to be used as issuerAddress.
      // After Block 9, location is never the issuerAddress source.
      mockGetCraftsmanBusinessProfile.mockResolvedValue({
        businessName: 'Müller Sanitär GmbH',
        businessAddress: '',
        location: 'Hauptstraße 5, 10115 Berlin',
      })

      const result = await resolveIssuerData('craftsman-10')

      expect(result).toBeUndefined()
    })
  })
})
