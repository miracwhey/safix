/**
 * Commercial Attribution Types
 *
 * Defines the three-layer commercial attribution model:
 *
 *   Layer 1  customer acquisition source — how the customer found SaFix
 *            (lives on profiles.guided_entry_state.path — not here)
 *
 *   Layer 2  customer↔craftsman commercial relationship — the durable origin
 *            of the business relationship between a specific customer and a
 *            specific craftsman/provider. Drives commission logic.
 *            (table: customer_provider_relationships)
 *
 *   Layer 3  job/project commercial origin — explicit copy on each revenue
 *            event, inherited from layer 2 at creation time.
 *            (jobs.commercial_origin, projects.commercial_origin)
 *
 * Critical distinction:
 *   - The same customer may have different commercial origins with different
 *     craftsmen. Never collapse all providers into one global customer flag.
 *   - commercial_origin is immutable after first write. Use origin_context
 *     for audit detail; it does not override the commercial classification.
 */

/**
 * The commercial origin of a customer↔craftsman relationship.
 *
 * merchant_brought  — the craftsman/company brought this customer into SaFix
 *                     themselves (invite link, personal import, etc.).
 *                     Platform commission: 5%.
 *
 * platform_acquired — SaFix acquired the customer through its own surfaces
 *                     (reels, search, profile browse, category discovery).
 *                     Platform commission: 9%.
 */
export type CommercialOrigin = 'merchant_brought' | 'platform_acquired'

/**
 * The commercial origin as stamped on a job or project (Layer 3).
 *
 * Extends CommercialOrigin with the transient blocked state
 * 'unknown_pending_resolution', which is set when the Supabase lookup for
 * customer_provider_relationships fails at job-creation time (timeout, 503,
 * or other transient error).
 *
 * INVARIANT: 'unknown_pending_resolution' BLOCKS all payment initiation.
 * Payment endpoints (create-escrow, initiate-funding) gate on
 * attribution_status = 'finalized' and return 402 when not finalized.
 * Resolution is handled exclusively by the Attribution Finalizer worker.
 *
 * 'unknown_pending_resolution' is NEVER stored in customer_provider_relationships.
 * It is a job/project-level transient marker only.
 */
export type JobCommercialOrigin = CommercialOrigin | 'unknown_pending_resolution'

/**
 * Contextual detail about how the commercial relationship was first established.
 * Stored for audit purposes only — does not override CommercialOrigin.
 *
 * invite        — craftsman sent an invite link (guided_entry path='invited')
 * reel          — customer discovered craftsman via an Explore reel
 * search        — customer found craftsman via category/text search or profile browse
 * referral      — customer was referred by another user
 * manual_import — craftsman imported an existing customer manually
 * unknown       — origin not determinable at relationship creation time
 */
export type OriginContext =
  | 'invite'
  | 'reel'
  | 'search'
  | 'referral'
  | 'manual_import'
  | 'unknown'

/**
 * Layer 2: the durable commercial attribution record for a specific
 * customer↔craftsman pair.
 *
 * One record exists per unique (customerUserId, craftsmanUserId) combination.
 * This is the system of record for commission logic.
 * Jobs and projects inherit commercialOrigin from this record at creation time.
 *
 * commercialOrigin is set once and never changed. If business rules require
 * reclassification, a new record must be explicitly written with operator
 * authorization (not supported in v1 — prohibited by design).
 */
/**
 * Lifecycle state of the attribution resolution for a job.
 *
 * pending   — resolution is in-flight or pending first attempt.
 *             Set at job creation when the DB lookup failed transiently.
 *             BLOCKS all payment initiation.
 *
 * retrying  — Attribution Finalizer worker attempted resolution but the DB
 *             was still unreachable. Worker retries with exponential backoff.
 *             BLOCKS payment initiation.
 *
 * finalized — commercial_origin has been confirmed from
 *             customer_provider_relationships (or definitively absent →
 *             platform_acquired). Payment initiation is permitted.
 */
export type AttributionStatus = 'pending' | 'finalized' | 'retrying'

export type CustomerProviderRelationship = {
  id: string
  /** Supabase auth.users UUID of the customer. */
  customerUserId: string
  /** Supabase auth.users UUID of the craftsman/company owner (= profiles.id). */
  craftsmanUserId: string
  /** The durable commercial origin — drives fee logic. */
  commercialOrigin: CommercialOrigin
  /** Audit context for how the relationship was established. */
  originContext?: OriginContext
  /** Unix timestamp (ms) when the relationship was first established. */
  createdAt: number
}
