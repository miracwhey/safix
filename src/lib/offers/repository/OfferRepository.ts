import type { Offer, QuoteLineItem, SpatialOfferMetadata } from '../types'

/**
 * Input contract for the SECURITY DEFINER RPC `create_spatial_offer`
 * (migration 20260523120055). Mirrors the RPC's named parameters.
 *
 * The repository wrapper is responsible for:
 *   - Serialising `lineItems` and `spatialMetadata` to JSON.
 *   - Mapping the returned `offers` row back into a domain `Offer`.
 *   - Updating the local in-memory cache (so subscribers see the new offer
 *     without waiting for the next `initialize()` resync).
 *
 * Ownership / Pro-Gate enforcement happens server-side inside the RPC; this
 * input carries no auth context.
 */
export interface CreateSpatialOfferRpcInput {
  /** Client-generated offer uuid. The RPC enforces ON CONFLICT (id) DO NOTHING. */
  id: string
  /** `spatial_scenes.id` the offer is derived from. Must be job-anchored. */
  sceneId: string
  /** Commercial document type — Spatial-Quote restricts to two values. */
  documentType: 'binding_offer' | 'cost_estimate'
  /** Gross price as numeric (minor-unit cents — DB column is numeric). */
  price: number
  /** Net total in cents. */
  netTotal: number
  /** Gross total in cents (= price for Spatial-Quote). */
  grossTotal: number
  /** VAT amount in cents. */
  vatAmount: number
  /** VAT rate as integer percentage (e.g. 19). */
  vatRate: number
  /** ISO-4217 currency. Defaults to `EUR` server-side. */
  currency?: string
  /** Structured line items from the BoM (already in QuoteLineItem shape). */
  lineItems?: QuoteLineItem[]
  /** Per-line-item richness (nodeId, source). Persisted as `spatial_metadata` jsonb. */
  spatialMetadata?: SpatialOfferMetadata
  /** Optional free-text scope description. */
  description?: string
  /**
   * Optional explicit conversation override. When omitted the RPC falls
   * back to `job.source_conversation_id`; when that is also NULL the
   * offer is created without a conversation anchor.
   */
  conversationId?: string | null
}

export interface OfferRepository {
  /**
   * Loads initial offer data from the underlying store.
   * Must be called once during application bootstrap.
   * For in-memory implementations this is a no-op.
   */
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load
   * (i.e. `initialize()` has resolved at least once).
   *
   * Used by screens that need to distinguish between "entity not loaded yet"
   * and "entity genuinely does not exist" without resorting to a timeout.
   *
   * For InMemoryOfferRepository this is always `true` (data is available at
   * construction time).
   * For SupabaseOfferRepository this becomes `true` after the first
   * `initialize()` call completes.
   */
  isHydrated(): boolean

  getAll(): Offer[]
  getById(id: string): Offer | undefined
  getByConversationId(conversationId: string): Offer[]

  /**
   * Spatial C-10: reverse-lookup an offer by its source spatial scene.
   * Returns the most recent pending offer if multiple exist (the DB
   * `uq_offers_one_pending_per_spatial_scene` index enforces at most one
   * pending; this method also surfaces accepted/declined/superseded
   * offers for scene-detail history views — caller filters by status if
   * needed).
   *
   * NOTE: a pure in-memory lookup against the cache (no network round-trip).
   */
  findBySpatialScene(sceneId: string): Offer | undefined

  /**
   * Adds a new offer. Throws if an active (pending) offer already exists
   * for the same conversation.
   *
   * NOT a valid path for Spatial-Offers — they must go through
   * `createViaSpatialQuoteRpc` so the SECURITY DEFINER RPC enforces the
   * Pro-Gate + RBAC server-side. Calling `add()` with `sourceSpatialSceneId`
   * set bypasses those guards and is rejected by RLS for non-Owner callers.
   */
  add(offer: Offer): Promise<void>

  /**
   * Atomically updates an offer by ID. The updater function receives the
   * current offer and must return the new state.
   */
  update(offerId: string, updater: (offer: Offer) => Offer): Promise<void>

  /**
   * Spatial C-10: canonical Spatial-Quote-Send path. Calls the SECURITY
   * DEFINER RPC `create_spatial_offer` which performs server-side RBAC
   * (Owner OR active team_member of the scene's provider Org) + Pro-Gate
   * (Org-Owner has active Pro plan) + idempotency (returns existing pending
   * offer for the same scene).
   *
   * On success the new offer is appended to the local cache and subscribers
   * are notified. Throws on RPC error (28000 auth, 22023 input, 42501
   * authorization).
   */
  createViaSpatialQuoteRpc(input: CreateSpatialOfferRpcInput): Promise<Offer>

  subscribe(listener: () => void): () => void
  notify(): void
  reset(): void
}
