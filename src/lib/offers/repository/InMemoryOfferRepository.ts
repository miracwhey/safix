import type { Offer, QuoteLineItem } from '../types'
import type {
  CreateSpatialOfferRpcInput,
  OfferRepository,
} from './OfferRepository'

type Listener = () => void

export class InMemoryOfferRepository implements OfferRepository {
  private offers: Offer[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: Offer[] = []) {
    this.offers = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded at construction time
  }

  isHydrated(): boolean {
    // In-memory repos are always hydrated — data is available at construction
    return true
  }

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Offer[] {
    return [...this.offers]
  }

  getById(id: string): Offer | undefined {
    return this.offers.find((o) => o.id === id)
  }

  getByConversationId(conversationId: string): Offer[] {
    return this.offers.filter((o) => o.conversationId === conversationId)
  }

  findBySpatialScene(sceneId: string): Offer | undefined {
    return this.offers.find((o) => o.sourceSpatialSceneId === sceneId)
  }

  async add(offer: Offer): Promise<void> {
    // Enforce: no duplicate active (pending) offers per conversation. The
    // null === null comparison would otherwise spuriously collide all
    // Spatial-Offers (which carry NULL conversationId); skip the check for
    // those — their server-side idempotency is enforced by the partial
    // unique index `uq_offers_one_pending_per_spatial_scene` (C-10 migration
    // 20260523120055) and by `createViaSpatialQuoteRpc`'s in-RPC pre-check.
    if (offer.conversationId != null) {
      const existing = this.offers.find(
        (o) => o.conversationId === offer.conversationId && o.status === 'pending'
      )
      if (existing) {
        throw new Error(
          `Active offer already exists for conversation ${offer.conversationId}`
        )
      }
    } else if (offer.sourceSpatialSceneId) {
      // Spatial-Offer path: enforce one-pending-per-scene locally too so
      // InMemoryOfferRepository tests catch double-create bugs without
      // needing the DB constraint.
      const existing = this.offers.find(
        (o) =>
          o.sourceSpatialSceneId === offer.sourceSpatialSceneId &&
          o.status === 'pending'
      )
      if (existing) {
        throw new Error(
          `Active spatial offer already exists for scene ${offer.sourceSpatialSceneId}`
        )
      }
    }

    this.offers = [...this.offers, offer]
    this.notify()
  }

  async update(offerId: string, updater: (offer: Offer) => Offer): Promise<void> {
    this.offers = this.offers.map((o) => (o.id === offerId ? updater(o) : o))
    this.notify()
  }

  async createViaSpatialQuoteRpc(input: CreateSpatialOfferRpcInput): Promise<Offer> {
    // In-memory mirror of the SECURITY DEFINER RPC. Replicates the server-
    // side idempotency check (pending offer for the same scene → return it),
    // then synthesises a domain Offer with the same shape rowToOffer would
    // produce on the Supabase path. Tests rely on the same shape both paths
    // emit so workflow assertions are runtime-agnostic.
    const existing = this.offers.find(
      (o) => o.sourceSpatialSceneId === input.sceneId && o.status === 'pending'
    )
    if (existing) return existing

    const now = Date.now()
    const lineItems: QuoteLineItem[] | undefined = input.lineItems
    const created: Offer = {
      id: input.id,
      conversationId: input.conversationId ?? null,
      customerUserId: 'inmemory-customer',
      craftsmanUserId: 'inmemory-owner',
      // Domain `price` is a human-readable string. The RPC carries it as
      // numeric; mirror by stringifying so consumers stay shape-compatible.
      price: String(input.price),
      status: 'pending',
      documentType: input.documentType,
      contextType: input.conversationId ? 'conversation' : 'project',
      offerMode: input.documentType === 'binding_offer' ? 'binding' : 'estimate',
      currency: (input.currency ?? 'EUR') as Offer['currency'],
      grossTotal: input.grossTotal,
      netTotal: input.netTotal,
      vatAmount: input.vatAmount,
      vatRate: input.vatRate,
      ...(lineItems && { lineItems }),
      ...(input.description != null && { description: input.description }),
      ...(input.spatialMetadata && { spatialMetadata: input.spatialMetadata }),
      sourceSpatialSceneId: input.sceneId,
      isStale: false,
      createdAt: now,
      updatedAt: now,
      sentAt: now,
    }

    this.offers = [created, ...this.offers]
    this.notify()
    return created
  }

  reset(): void {
    this.offers = []
    this.notify()
  }
}
