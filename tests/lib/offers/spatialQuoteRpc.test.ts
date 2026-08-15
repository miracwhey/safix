/**
 * Spatial C-10 · Repository tests for `createViaSpatialQuoteRpc` + `findBySpatialScene`.
 *
 * Covers both the Supabase wrapper (mocked `supabase.rpc`) and the InMemory
 * mirror so workflow assertions stay runtime-agnostic. The Supabase test path
 * verifies the exact RPC param shape, the row → Offer mapping, the local
 * cache update, and persistence-failure recording on error. The InMemory test
 * path verifies idempotency (same scene + pending → returns existing) and
 * shape compatibility with the Supabase path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { SupabaseOfferRepository } from '../../../src/lib/offers/repository/SupabaseOfferRepository'
import { InMemoryOfferRepository } from '../../../src/lib/offers/repository/InMemoryOfferRepository'
import type { CreateSpatialOfferRpcInput } from '../../../src/lib/offers/repository/OfferRepository'
import type { Offer, QuoteLineItem } from '../../../src/lib/offers/types'
import { supabase } from '../../../src/lib/supabase'

vi.mock('../../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(), onAuthStateChange: vi.fn() },
    from: vi.fn(),
    rpc: vi.fn(),
  },
}))
vi.mock('../../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))
const recordPersistenceFailure = vi.fn()
vi.mock('../../../src/lib/persistence', () => ({
  recordPersistenceFailure: (...args: unknown[]) => recordPersistenceFailure(...args),
}))

const SCENE_ID = '11111111-1111-4111-8111-111111111111'
const OFFER_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER = 'a1000000-0000-4000-8000-000000000001'
const CRAFTSMAN = 'a1000000-0000-4000-8000-000000000002'

function buildLineItems(): QuoteLineItem[] {
  return [
    { id: 'li-1', label: 'Fliesen', category: 'material', netAmount: 5000, quantity: 4, unit: 'm2' },
    { id: 'li-2', label: 'Verlegung', category: 'labor', netAmount: 8000, quantity: 8, unit: 'h' },
  ]
}

function buildInput(overrides: Partial<CreateSpatialOfferRpcInput> = {}): CreateSpatialOfferRpcInput {
  return {
    id: OFFER_ID,
    sceneId: SCENE_ID,
    documentType: 'binding_offer',
    price: 130_00,
    netTotal: 130_00,
    grossTotal: 154_70,
    vatAmount: 24_70,
    vatRate: 19,
    currency: 'EUR',
    lineItems: buildLineItems(),
    spatialMetadata: {
      lineItems: [
        { lineItemId: 'li-1', nodeId: 'wall-1', source: 'auto' },
        { lineItemId: 'li-2', source: 'manual' },
      ],
    },
    description: 'Fliesenarbeiten Bad',
    conversationId: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(supabase.auth.onAuthStateChange).mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  } as never)
  recordPersistenceFailure.mockClear()
})
afterEach(() => vi.clearAllMocks())

describe('SupabaseOfferRepository · createViaSpatialQuoteRpc (C-10)', () => {
  it('sends every RPC param in snake_case and maps the returned row into an Offer', async () => {
    const repo = new SupabaseOfferRepository()
    const rpcMock = vi.fn().mockResolvedValue({
      data: {
        id: OFFER_ID,
        conversation_id: null,
        customer_user_id: CUSTOMER,
        craftsman_user_id: CRAFTSMAN,
        price: '130',
        description: 'Fliesenarbeiten Bad',
        timing_note: null,
        status: 'pending',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        accepted_at: null,
        declined_at: null,
        created_job_id: null,
        sent_at: 1_700_000_000_000,
        currency: 'EUR',
        gross_total: 154_70,
        net_total: 130_00,
        vat_amount: 24_70,
        vat_rate: 19,
        line_items: buildLineItems(),
        document_type: 'binding_offer',
        context_type: 'project',
        source_spatial_scene_id: SCENE_ID,
        spatial_metadata: {
          lineItems: [
            { lineItemId: 'li-1', nodeId: 'wall-1', source: 'auto' },
            { lineItemId: 'li-2', source: 'manual' },
          ],
        },
        pdf_url: null,
        is_stale: false,
      },
      error: null,
    })
    vi.mocked(supabase.rpc).mockImplementation(rpcMock as never)

    const offer = await repo.createViaSpatialQuoteRpc(buildInput())

    // Exact RPC param shape — must match the migration signature.
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith('create_spatial_offer', {
      p_id: OFFER_ID,
      p_scene_id: SCENE_ID,
      p_document_type: 'binding_offer',
      p_price: 130_00,
      p_net_total: 130_00,
      p_gross_total: 154_70,
      p_vat_amount: 24_70,
      p_vat_rate: 19,
      p_currency: 'EUR',
      p_line_items: buildLineItems(),
      p_spatial_metadata: {
        lineItems: [
          { lineItemId: 'li-1', nodeId: 'wall-1', source: 'auto' },
          { lineItemId: 'li-2', source: 'manual' },
        ],
      },
      p_description: 'Fliesenarbeiten Bad',
      p_conversation_id: null,
    })

    // Returned row → domain Offer.
    expect(offer.id).toBe(OFFER_ID)
    expect(offer.sourceSpatialSceneId).toBe(SCENE_ID)
    expect(offer.conversationId).toBeNull()
    expect(offer.contextType).toBe('project')
    expect(offer.documentType).toBe('binding_offer')
    expect(offer.spatialMetadata?.lineItems).toHaveLength(2)

    // Local cache update — subscribers see the new offer immediately.
    expect(repo.getAll().find((o) => o.id === OFFER_ID)).toBe(offer)
    expect(repo.findBySpatialScene(SCENE_ID)?.id).toBe(OFFER_ID)
  })

  it('defaults currency to EUR and serialises empty optional collections', async () => {
    const repo = new SupabaseOfferRepository()
    const rpcMock = vi.fn().mockResolvedValue({
      data: {
        id: OFFER_ID,
        conversation_id: null,
        customer_user_id: CUSTOMER,
        craftsman_user_id: CRAFTSMAN,
        price: '50',
        status: 'pending',
        created_at: 1,
        updated_at: 1,
        sent_at: 1,
        document_type: 'cost_estimate',
        context_type: 'project',
        source_spatial_scene_id: SCENE_ID,
        is_stale: false,
        accepted_at: null,
        declined_at: null,
        created_job_id: null,
        description: null,
        timing_note: null,
      },
      error: null,
    })
    vi.mocked(supabase.rpc).mockImplementation(rpcMock as never)

    await repo.createViaSpatialQuoteRpc({
      id: OFFER_ID,
      sceneId: SCENE_ID,
      documentType: 'cost_estimate',
      price: 50_00,
      netTotal: 50_00,
      grossTotal: 50_00,
      vatAmount: 0,
      vatRate: 0,
    })

    expect(rpcMock).toHaveBeenCalledWith(
      'create_spatial_offer',
      expect.objectContaining({
        p_currency: 'EUR',
        p_line_items: [],
        p_spatial_metadata: {},
        p_description: null,
        p_conversation_id: null,
      }),
    )
  })

  it('records persistence failure and re-throws on RPC error', async () => {
    const repo = new SupabaseOfferRepository()
    const rpcMock = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message: 'create_spatial_offer: caller X not authorized for provider_org Y',
      },
    })
    vi.mocked(supabase.rpc).mockImplementation(rpcMock as never)

    await expect(repo.createViaSpatialQuoteRpc(buildInput())).rejects.toMatchObject({
      code: '42501',
    })

    expect(recordPersistenceFailure).toHaveBeenCalledTimes(1)
    expect(recordPersistenceFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'offers',
        operation: 'create_spatial_offer',
        entityId: OFFER_ID,
      }),
    )
    // Cache untouched.
    expect(repo.getAll()).toHaveLength(0)
  })

  it('throws on empty RPC response (contract violation)', async () => {
    const repo = new SupabaseOfferRepository()
    vi.mocked(supabase.rpc).mockImplementation(
      vi.fn().mockResolvedValue({ data: null, error: null }) as never,
    )

    await expect(repo.createViaSpatialQuoteRpc(buildInput())).rejects.toThrow(
      /create_spatial_offer returned empty row/,
    )
  })
})

describe('InMemoryOfferRepository · createViaSpatialQuoteRpc (C-10)', () => {
  it('returns the existing pending offer on a second call with the same scene (idempotency)', async () => {
    const repo = new InMemoryOfferRepository()
    const first = await repo.createViaSpatialQuoteRpc(buildInput())
    const second = await repo.createViaSpatialQuoteRpc(
      buildInput({ id: 'different-attempt-uuid' }),
    )
    expect(second.id).toBe(first.id)
    expect(repo.getAll()).toHaveLength(1)
  })

  it('creates a new spatial offer with the same shape the Supabase path emits', async () => {
    const repo = new InMemoryOfferRepository()
    const offer = await repo.createViaSpatialQuoteRpc(buildInput())
    expect(offer.sourceSpatialSceneId).toBe(SCENE_ID)
    expect(offer.documentType).toBe('binding_offer')
    expect(offer.contextType).toBe('project')
    expect(offer.conversationId).toBeNull()
    expect(offer.status).toBe('pending')
    expect(offer.spatialMetadata?.lineItems).toHaveLength(2)
  })

  it('findBySpatialScene round-trips with createViaSpatialQuoteRpc', async () => {
    const repo = new InMemoryOfferRepository()
    await repo.createViaSpatialQuoteRpc(buildInput())
    expect(repo.findBySpatialScene(SCENE_ID)?.id).toBe(OFFER_ID)
    expect(repo.findBySpatialScene('does-not-exist')).toBeUndefined()
  })
})

describe('InMemoryOfferRepository · add() null-conversation safety (C-10)', () => {
  it('does NOT spuriously collide two Spatial-Offers with NULL conversationId', async () => {
    const repo = new InMemoryOfferRepository()
    const offer1: Offer = {
      id: 'sp-1',
      conversationId: null,
      customerUserId: CUSTOMER,
      craftsmanUserId: CRAFTSMAN,
      price: '100',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      sentAt: 1,
      sourceSpatialSceneId: 'scene-a',
      isStale: false,
    } as Offer
    const offer2: Offer = { ...offer1, id: 'sp-2', sourceSpatialSceneId: 'scene-b' }

    await repo.add(offer1)
    // Different scene → should NOT throw despite both having NULL conversationId.
    await expect(repo.add(offer2)).resolves.toBeUndefined()
    expect(repo.getAll()).toHaveLength(2)
  })

  it('rejects a second pending Spatial-Offer for the SAME scene', async () => {
    const repo = new InMemoryOfferRepository()
    const offer1: Offer = {
      id: 'sp-1',
      conversationId: null,
      customerUserId: CUSTOMER,
      craftsmanUserId: CRAFTSMAN,
      price: '100',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      sentAt: 1,
      sourceSpatialSceneId: 'scene-a',
      isStale: false,
    } as Offer
    const offer2: Offer = { ...offer1, id: 'sp-2' }

    await repo.add(offer1)
    await expect(repo.add(offer2)).rejects.toThrow(/Active spatial offer already exists/)
  })
})
