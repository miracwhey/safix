/**
 * Spatial · Canonical · Workflow · createOfferFromSpatialQuote (C-10 · C10.3)
 *
 * The single orchestrator for turning a BoM-priced Spatial scene into a
 * canonical `offers` row. Closes the C-10 gap: until this workflow shipped,
 * `JobSpatialBomTab.handleQuoteSend` only updated `scene.metadata` — no
 * Offer record was ever created, so the customer's In-App-Offer-list was
 * empty for Spatial-Quotes.
 *
 * Pipeline:
 *   1. Idempotency (local cache) — short-circuit if a pending offer for the
 *      scene already exists in the offer-repo cache. The server-side RPC
 *      `create_spatial_offer` has its own idempotency check (uq_offers_one_
 *      pending_per_spatial_scene + in-RPC step 11); the local check just
 *      saves a round-trip on repeated Quote-Send taps.
 *   2. Scene lookup — `getSpatialSceneRepository().findById(sceneId)`.
 *      Requires `sourceJobId` (Spatial-Quote is job-anchored for push-routing
 *      in C10.5).
 *   3. Job lookup — `getJobById(scene.sourceJobId)` for the conversation-id
 *      fallback. Job is also the truth-source for customer when scene
 *      derivation is incomplete.
 *   4. Conversation resolution: explicit override > `job.sourceConversationId`
 *      > NULL. The DB column is nullable since C-10 migration 20260523120055;
 *      a Spatial-Offer without a thread anchor is valid.
 *   5. BoM → QuoteLineItem mapping + scene-anchor capture into
 *      `spatial_metadata`. Auto-items keep their `nodeId`; manual items
 *      record `source: 'manual'`. This metadata feeds future Edit-Override
 *      and VF-2-Diff paths — without it a later scene change cannot
 *      re-target the affected line items.
 *   6. RPC call via `offerRepo.createViaSpatialQuoteRpc(...)`. The repo
 *      wrapper handles JSON serialisation, row-mapping, local-cache update,
 *      and persistence-failure recording. Auth + RBAC + Pro-Gate live in
 *      the SECURITY DEFINER RPC, not here.
 *
 * Result-typed: every failure surfaces as a typed
 * {@link CreateOfferFromSpatialQuoteResult} with a distinct reason; nothing
 * throws (except programmer-error: missing repository registry binding).
 */

import { getOfferRepository } from '../../../offers/repository/registry'
import type {
  QuoteLineItem,
  Offer,
  SpatialOfferLineItemMeta,
  SpatialOfferMetadata,
  SpatialAufmassSnapshot,
} from '../../../offers/types'
import { getJobById } from '../../../jobs/jobsStore'
import { getSpatialSceneRepository } from '../repository/registry'
import type { SpatialSceneRepository } from '../repository/SpatialSceneRepository'
import type { OfferRepository } from '../../../offers/repository/OfferRepository'
import type { BomItem } from './bomModel'
import { effectiveQuantity } from './bomModel'
import { ensureTimelineEvent } from '../../../timeline'

// ─── Input + Result types ────────────────────────────────────────────────────

export interface CreateOfferFromSpatialQuoteInput {
  /** `spatial_scenes.id` — the BoM source scene. */
  sceneId: string
  /**
   * Commercial document classification. The Provider chooses via the BoM-Tab
   * Channel-Sheet toggle (C10.4) before sending. The DB CHECK constraint
   * already allows both values; the RPC enforces the binary restriction.
   */
  documentType: 'binding_offer' | 'cost_estimate'
  /** Net / VAT / gross totals in integer cents (matches `BomTotals`). */
  totals: { netCents: number; vatCents: number; grossCents: number }
  /**
   * Integer VAT-rate percentage (e.g. `19` for 19 %). Stored on the offer
   * as `vatRate` and used by downstream invoice + payment paths.
   */
  vatRatePct: number
  /** BoM items priced by the Provider in the BoM-Tab. */
  lineItems: BomItem[]
  /**
   * Optional render-ready aufmaß snapshot (floor-plan + measurements). Captured
   * from the hydrated scene at send-time and persisted on
   * `spatial_metadata.aufmass` so the Offer-PDF can render it without re-loading
   * the scene. `undefined` when the BoM tab has no hydrated scene.
   */
  aufmass?: SpatialAufmassSnapshot
  /** Optional free-text scope description for the Offer artifact. */
  description?: string
  /**
   * Optional conversation override. `undefined` falls back to
   * `job.sourceConversationId`; explicit `null` forces no anchor; an
   * explicit string short-circuits the fallback.
   */
  conversationId?: string | null
  /** ISO-4217 currency. Defaults to `EUR`. */
  currency?: string
}

/** Why a {@link createOfferFromSpatialQuote} call did not produce an offer. */
export type CreateOfferFromSpatialQuoteFailure =
  /** Scene id resolves to nothing — caller passed a stale id. */
  | 'scene_not_found'
  /** Scene has no `sourceJobId` — Spatial-Quote requires job context. */
  | 'scene_missing_job'
  /** `job.sourceJobId` resolves to nothing — job was deleted out from under the scene. */
  | 'job_not_found'
  /**
   * The SECURITY DEFINER RPC rejected the insert (auth / RBAC / Pro-Gate /
   * validation). The original error message is carried in `message`.
   */
  | 'rpc_rejected'

export type CreateOfferFromSpatialQuoteResult =
  | { ok: true; offer: Offer; alreadyExisted: boolean }
  | { ok: false; reason: CreateOfferFromSpatialQuoteFailure; message: string }

// ─── BoM → QuoteLineItem mapping ─────────────────────────────────────────────

/**
 * Heuristic mapping from the BoM-Tab's free-form category strings (German UI
 * labels, e.g. `Boden`, `Wand`, `Ausstattung`, `Sonstiges`) onto the offer
 * domain's typed enum. Unknown categories default to `'material'` —
 * Spatial-Quotes are geometry-derived measurements which are materially
 * dominant; labor and other costs require manual classification later.
 */
const BOM_CATEGORY_MAP: Record<string, QuoteLineItem['category']> = {
  Boden: 'material',
  Wand: 'material',
  Decke: 'material',
  Ausstattung: 'material',
  Material: 'material',
  Arbeit: 'labor',
  Labor: 'labor',
  Sonstiges: 'other',
}

function mapBomCategory(category: string): QuoteLineItem['category'] {
  return BOM_CATEGORY_MAP[category] ?? 'material'
}

function bomItemToQuoteLineItem(item: BomItem): QuoteLineItem {
  // Bill the effective quantity (manual override when set, else geometry) so a
  // craftsman's correction is never silently dropped — matches BomTotals' own
  // per-item summation so the offer reconciles bit-for-bit with the BoM display.
  const qty = effectiveQuantity(item)
  return {
    id: item.id,
    label: item.description,
    category: mapBomCategory(item.category),
    netAmount: Math.round(qty * item.unitPriceCents),
    quantity: qty,
    unit: item.unit,
  }
}

function bomItemsToSpatialMetadata(
  items: BomItem[],
  aufmass?: SpatialAufmassSnapshot,
): SpatialOfferMetadata {
  const lineItems: SpatialOfferLineItemMeta[] = items.map((item) => ({
    lineItemId: item.id,
    source: item.source,
    ...(item.nodeId != null && { nodeId: item.nodeId }),
  }))
  return { lineItems, ...(aufmass != null && { aufmass }) }
}

// ─── Workflow ────────────────────────────────────────────────────────────────

/**
 * Create a canonical Offer from a Spatial-Quote.
 *
 * @param input  scene + document-type + BoM items + totals.
 * @param deps   optional repository overrides for testing — defaults to the
 *               registry-resolved active repositories.
 */
export async function createOfferFromSpatialQuote(
  input: CreateOfferFromSpatialQuoteInput,
  deps: {
    offerRepo?: OfferRepository
    sceneRepo?: SpatialSceneRepository
  } = {},
): Promise<CreateOfferFromSpatialQuoteResult> {
  const offerRepo = deps.offerRepo ?? getOfferRepository()
  const sceneRepo = deps.sceneRepo ?? getSpatialSceneRepository()

  // 1. Idempotency pre-check via the indexed reverse-lookup. Saves a network
  //    round-trip on rapid Quote-Send retaps. The server-side RPC has its
  //    own check (in-RPC step 11 + `uq_offers_one_pending_per_spatial_scene`
  //    partial unique index) as the safety net — if the cache happens to
  //    surface a non-pending historical offer for the scene, we fall through
  //    to the RPC which returns the existing pending row (if any).
  const cached = offerRepo.findBySpatialScene(input.sceneId)
  if (cached && cached.status === 'pending') {
    return { ok: true, offer: cached, alreadyExisted: true }
  }

  // 2. Scene lookup + job-anchor guard.
  const scene = await sceneRepo.findById(input.sceneId)
  if (!scene) {
    return {
      ok: false,
      reason: 'scene_not_found',
      message: `Szene ${input.sceneId} nicht gefunden.`,
    }
  }
  if (scene.sourceJobId == null) {
    return {
      ok: false,
      reason: 'scene_missing_job',
      message:
        'Diese Szene ist keinem Auftrag zugeordnet — ein Spatial-Angebot braucht einen Auftrag als Kontext.',
    }
  }

  // 3. Job lookup for conversation-id fallback. Returns undefined if the
  //    job was deleted out from under the scene (rare — investigated as
  //    'job_not_found' so the caller can surface the inconsistency).
  const job = getJobById(scene.sourceJobId)
  if (!job) {
    return {
      ok: false,
      reason: 'job_not_found',
      message: `Auftrag ${scene.sourceJobId} nicht gefunden — Datenkonsistenz prüfen.`,
    }
  }

  // 4. Conversation resolution. The DB column is nullable since C-10;
  //    NULL means "this offer is anchored to scene + job, not a thread".
  const resolvedConvId: string | null =
    input.conversationId !== undefined
      ? input.conversationId
      : (job.sourceConversationId ?? null)

  // 5. BoM → QuoteLineItem mapping + scene-anchor capture (+ aufmaß snapshot).
  const lineItems = input.lineItems.map(bomItemToQuoteLineItem)
  const spatialMetadata = bomItemsToSpatialMetadata(input.lineItems, input.aufmass)

  // 6. RPC call via offer repository.
  const offerId = crypto.randomUUID()
  try {
    const offer = await offerRepo.createViaSpatialQuoteRpc({
      id: offerId,
      sceneId: input.sceneId,
      documentType: input.documentType,
      // `price` is the gross total in cents — the RPC carries it through as
      // numeric. The Offer domain stringifies it on read so UI consumers see
      // the human-readable form.
      price: input.totals.grossCents,
      netTotal: input.totals.netCents,
      grossTotal: input.totals.grossCents,
      vatAmount: input.totals.vatCents,
      vatRate: input.vatRatePct,
      currency: input.currency ?? 'EUR',
      lineItems,
      spatialMetadata,
      ...(input.description != null && { description: input.description }),
      conversationId: resolvedConvId,
    })
    // When the RPC short-circuited on its own idempotency pre-check (step 11),
    // the returned offer id will differ from the p_id we generated above —
    // surface that as `alreadyExisted` so the caller does not double-record
    // analytics / timeline events for the same Quote-Send.
    const alreadyExisted = offer.id !== offerId

    // 7. Notification-Bridge (C10.5) — fire `offer_sent` timeline event
    //    anchored to scene.sourceJobId. The notification-bridge subscribes to
    //    timeline events, maps via notificationConfig (`offer_sent` → 'action'
    //    priority, 'customer' role), and feeds notify-push. `ensureTimelineEvent`
    //    is idempotent (checks `hasEventOfType(jobId, type)`) — a retry after
    //    server-side idempotency does NOT spawn a second push.
    if (!alreadyExisted) {
      ensureTimelineEvent({
        jobId: scene.sourceJobId,
        type: 'offer_sent',
        entityId: offer.id,
      })
    }

    return { ok: true, offer, alreadyExisted }
  } catch (e) {
    return {
      ok: false,
      reason: 'rpc_rejected',
      message:
        e instanceof Error
          ? e.message
          : 'Angebot konnte nicht erstellt werden.',
    }
  }
}
