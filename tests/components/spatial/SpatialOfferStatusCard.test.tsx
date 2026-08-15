// @vitest-environment jsdom
/**
 * Spatial C-10 · C10.6 · SpatialOfferStatusCard tests.
 *
 * Verifies role-aware copy + status mapping + null-render contract + repo
 * subscription. Uses InMemoryOfferRepository so the test path matches the
 * Supabase wrapper's local-cache update semantics.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import SpatialOfferStatusCard from '../../../src/components/spatial/SpatialOfferStatusCard'
import { setOfferRepository } from '../../../src/lib/offers/repository/registry'
import { InMemoryOfferRepository } from '../../../src/lib/offers/repository/InMemoryOfferRepository'
import type { Offer } from '../../../src/lib/offers/types'
import type { SpatialScene } from '../../../src/lib/spatial/canonical/repository/SpatialSceneRepository'

const SCENE_ID = '11111111-1111-4111-8111-111111111111'
const OFFER_ID = '22222222-2222-4222-8222-222222222222'

function buildScene(canonicalOfferId: string | null): SpatialScene {
  return {
    id: SCENE_ID,
    sourceScanId: null,
    sourceJobId: 'job-1',
    metadata: canonicalOfferId ? { canonicalOfferId } : {},
  } as unknown as SpatialScene
}

function buildOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: OFFER_ID,
    conversationId: null,
    customerUserId: 'c1',
    craftsmanUserId: 'k1',
    price: '500',
    status: 'pending',
    documentType: 'binding_offer',
    grossTotal: 50_000,
    sourceSpatialSceneId: SCENE_ID,
    createdAt: 1,
    updatedAt: 1,
    sentAt: 1,
    isStale: false,
    ...overrides,
  } as Offer
}

beforeEach(() => {
  setOfferRepository(new InMemoryOfferRepository())
})

describe('SpatialOfferStatusCard · contract', () => {
  it('renders nothing when scene.metadata.canonicalOfferId is missing', () => {
    const { container } = render(
      <SpatialOfferStatusCard scene={buildScene(null)} role="provider" />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the offer lookup misses (cache empty)', () => {
    const { container } = render(
      <SpatialOfferStatusCard scene={buildScene(OFFER_ID)} role="provider" />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for an offer that is not spatial (defensive)', () => {
    const repo = new InMemoryOfferRepository([
      { ...buildOffer(), sourceSpatialSceneId: undefined },
    ])
    setOfferRepository(repo)
    const { container } = render(
      <SpatialOfferStatusCard scene={buildScene(OFFER_ID)} role="provider" />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('SpatialOfferStatusCard · provider role', () => {
  it('shows "gesendet · wartet auf Kund:in" for a pending offer', () => {
    setOfferRepository(new InMemoryOfferRepository([buildOffer()]))
    render(<SpatialOfferStatusCard scene={buildScene(OFFER_ID)} role="provider" />)
    expect(screen.getByText(/wartet auf Kund/)).toBeTruthy()
    expect(screen.getByText(/Festpreis-Angebot/)).toBeTruthy()
    expect(screen.getByText(/500,00/)).toBeTruthy()
  })

  it('shows "Angebot angenommen" on status=accepted', () => {
    setOfferRepository(new InMemoryOfferRepository([buildOffer({ status: 'accepted' })]))
    render(<SpatialOfferStatusCard scene={buildScene(OFFER_ID)} role="provider" />)
    expect(screen.getByText('Angebot angenommen')).toBeTruthy()
  })

  it('shows "Angebot abgelehnt" on status=declined', () => {
    setOfferRepository(new InMemoryOfferRepository([buildOffer({ status: 'declined' })]))
    render(<SpatialOfferStatusCard scene={buildScene(OFFER_ID)} role="provider" />)
    expect(screen.getByText('Angebot abgelehnt')).toBeTruthy()
  })
})

describe('SpatialOfferStatusCard · customer role', () => {
  it('shows "neues Angebot · bitte prüfen" for a pending offer', () => {
    setOfferRepository(new InMemoryOfferRepository([buildOffer()]))
    render(<SpatialOfferStatusCard scene={buildScene(OFFER_ID)} role="customer" />)
    expect(screen.getByText(/neues Angebot/i)).toBeTruthy()
    expect(screen.getByText(/Festpreis-Angebot/)).toBeTruthy()
  })

  it('shows "Angebot von dir angenommen" on status=accepted', () => {
    setOfferRepository(new InMemoryOfferRepository([buildOffer({ status: 'accepted' })]))
    render(<SpatialOfferStatusCard scene={buildScene(OFFER_ID)} role="customer" />)
    expect(screen.getByText('Angebot von dir angenommen')).toBeTruthy()
  })

  it('uses cost_estimate label when documentType=cost_estimate', () => {
    setOfferRepository(new InMemoryOfferRepository([buildOffer({ documentType: 'cost_estimate' })]))
    render(<SpatialOfferStatusCard scene={buildScene(OFFER_ID)} role="customer" />)
    expect(screen.getByText(/Kostenvoranschlag/)).toBeTruthy()
  })
})

describe('SpatialOfferStatusCard · live updates', () => {
  it('re-renders when the offer status changes via the repo', async () => {
    const repo = new InMemoryOfferRepository([buildOffer()])
    setOfferRepository(repo)
    render(<SpatialOfferStatusCard scene={buildScene(OFFER_ID)} role="customer" />)
    expect(screen.getByText(/neues Angebot/i)).toBeTruthy()

    // Simulate a customer accept landing through the repo (C10.7 path).
    await act(async () => {
      await repo.update(OFFER_ID, (o) => ({ ...o, status: 'accepted', acceptedAt: 2 }))
    })
    expect(screen.getByText('Angebot von dir angenommen')).toBeTruthy()
  })
})

describe('SpatialOfferStatusCard · vi mock placeholder', () => {
  // Sanity that vi is wired correctly for this file even when no mock is needed.
  it('mock spy stays inert when unused', () => {
    const spy = vi.fn()
    expect(spy).toHaveBeenCalledTimes(0)
  })
})
