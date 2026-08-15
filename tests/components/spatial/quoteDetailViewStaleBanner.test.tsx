// @vitest-environment jsdom
/**
 * QuoteDetailView · Spatial QUOTE-STALE banner (VF-2)
 *
 * Verifies the banner contract introduced after R7 audit: when the verifyReQuote
 * workflow flips `offer.isStale = true` on a `pending` offer, the customer view
 * surfaces it with a clear "not current" hint. Closed-loop with
 * `verifyReQuote.planMarkQuotesStale` (only `pending` offers flagged) and
 * `applyStalePlan` (sets isStale + staleReason + staleMarkedAt).
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import QuoteDetailView from '../../../src/components/quotes/QuoteDetailView'
import type { Offer, OfferStaleReason } from '../../../src/lib/offers/types'

function buildOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'stale-offer-1',
    conversationId: 'conv-1',
    customerUserId: 'cust-1',
    craftsmanUserId: 'craft-1',
    price: '1.000 €',
    grossTotal: 100_000,
    netTotal: 84_034,
    vatAmount: 15_966,
    vatRate: 19,
    currency: 'EUR',
    status: 'pending',
    documentType: 'binding_offer',
    createdAt: 1700_000_000_000,
    updatedAt: 1700_000_000_000,
    sentAt: 1700_000_000_000,
    ...overrides,
  } as Offer
}

function renderView(offer: Offer, isCustomer = true) {
  return render(
    <MemoryRouter>
      <QuoteDetailView offer={offer} isCustomer={isCustomer} />
    </MemoryRouter>,
  )
}

describe('QuoteDetailView · stale banner', () => {
  it('does NOT render the banner when isStale is undefined', () => {
    renderView(buildOffer())
    expect(screen.queryByTestId('quote-stale-banner')).toBeNull()
  })

  it('does NOT render the banner when isStale = false', () => {
    renderView(buildOffer({ isStale: false }))
    expect(screen.queryByTestId('quote-stale-banner')).toBeNull()
  })

  it('does NOT render the banner when status is not pending (even if isStale = true)', () => {
    // planMarkQuotesStale only marks pending — guard against malformed data.
    renderView(buildOffer({ isStale: true, status: 'accepted', acceptedAt: 1700_000_500_000 }))
    expect(screen.queryByTestId('quote-stale-banner')).toBeNull()
  })

  it('renders the banner when isStale = true on a pending offer', () => {
    renderView(
      buildOffer({
        isStale: true,
        staleReason: 'measurement_changed',
        staleMarkedAt: 1700_000_300_000,
      }),
    )
    const banner = screen.getByTestId('quote-stale-banner')
    expect(banner).toBeTruthy()
    expect(banner.textContent).toMatch(/nicht mehr aktuell/i)
  })

  it.each<[OfferStaleReason, RegExp]>([
    ['measurement_changed', /Wand-Höhe.*5 ?%/i],
    ['high_severity_pin_added', /Schadens-Pin.*hoher Priorität/i],
    ['layout_changed', /Wand oder.*Öffnung/i],
  ])('uses the correct reason copy for %s', (reason, pattern) => {
    renderView(buildOffer({ isStale: true, staleReason: reason }))
    const banner = screen.getByTestId('quote-stale-banner')
    expect(banner.textContent).toMatch(pattern)
  })

  it('shows the customer-tailored hint copy when isCustomer = true', () => {
    renderView(buildOffer({ isStale: true, staleReason: 'measurement_changed' }), true)
    const banner = screen.getByTestId('quote-stale-banner')
    expect(banner.textContent).toMatch(/aktualisiertes Angebot anzufordern/i)
  })

  it('shows the provider-tailored hint copy when isCustomer = false', () => {
    renderView(buildOffer({ isStale: true, staleReason: 'measurement_changed' }), false)
    const banner = screen.getByTestId('quote-stale-banner')
    expect(banner.textContent).toMatch(/aktualisiertes Angebot zu senden/i)
  })

  it('shows the staleMarkedAt timestamp when provided', () => {
    renderView(
      buildOffer({
        isStale: true,
        staleReason: 'layout_changed',
        staleMarkedAt: new Date('2026-04-15T10:30:00Z').getTime(),
      }),
    )
    const banner = screen.getByTestId('quote-stale-banner')
    expect(banner.textContent).toMatch(/Markiert am/i)
    expect(banner.textContent).toMatch(/15\.04\.2026/)
  })

  it('omits the timestamp line when staleMarkedAt is missing', () => {
    renderView(buildOffer({ isStale: true, staleReason: 'measurement_changed' }))
    const banner = screen.getByTestId('quote-stale-banner')
    expect(banner.textContent).not.toMatch(/Markiert am/i)
  })

  it('uses role=status and aria-live=polite for screen-reader compatibility', () => {
    renderView(buildOffer({ isStale: true, staleReason: 'measurement_changed' }))
    const banner = screen.getByTestId('quote-stale-banner')
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.getAttribute('aria-live')).toBe('polite')
  })
})
