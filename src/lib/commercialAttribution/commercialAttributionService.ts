/**
 * Commercial Attribution Service
 *
 * Resolves and persists the durable commercial origin for customer↔craftsman
 * relationships. This is the canonical source of truth for fee/commission logic.
 *
 * ── Resolution priority ──────────────────────────────────────────────────────
 *
 *   1. Session cache (platform_acquired only — merchant_brought always re-verified)
 *   2. Existing relationship in Supabase        (one read — preferred path)
 *   3. Local inference from available context   (fallback, creates new record
 *      via persistAndReadCanonical — atomic L2 write + read-back)
 *
 * Inference rules (applied only when no record exists yet):
 *   - inquiryOrigin = 'reel'                  → platform_acquired, context 'reel'
 *   - inquiryOrigin = 'profile' | 'category'  → platform_acquired, context 'search'
 *   - inquiryOrigin = 'project' (builder)     → platform_acquired, context 'search'
 *     ⚠️  Builder-path invited customers will be mis-classified as platform_acquired
 *         until the guided-entry selectProvider hook is wired (see below).
 *   - inquiryOrigin absent / 'direct'         → platform_acquired, context 'unknown'
 *   - Explicit recordInviteRelationship call   → merchant_brought, context 'invite'
 *
 * ── L2 ↔ L3 atomicity guarantee (Stage 5 — 2026-04-20) ───────────────────────
 *
 *   Every inference path that creates a new relationship goes through
 *   `persistAndReadCanonical`, which:
 *     1. Issues INSERT … ON CONFLICT DO NOTHING (awaited).
 *     2. Re-reads the canonical row from Supabase.
 *     3. Returns the canonical commercial_origin — the value actually stored.
 *
 *   This closes the previous fire-and-forget race: concurrent calls with
 *   different inferred origins can no longer diverge from the Layer-2 row.
 *   Callers always receive the DB-winning origin (first-write-wins) and can
 *   safely stamp Layer 3 with it.
 *
 *   Transient insert failures that are NOT a unique-violation return
 *   'unknown_pending_resolution' so the caller stamps the job for later
 *   finalisation by the Attribution Finalizer worker.  No silent fallback.
 *
 * ── Guided-entry invite hook (pending UI wiring) ─────────────────────────────
 *
 *   When a customer completes the invited guided-entry path:
 *     1. selectProvider(providerId) is called           [guidedEntryState.ts]
 *     2. UI must additionally call:
 *        recordInviteRelationship(customerUserId, craftsmanUserId)
 *
 *   This pre-creates the merchant_brought record during the customer's session.
 *   At job creation (craftsman's session), resolveAndEnsureRelationship then
 *   finds the existing record and correctly returns merchant_brought — including
 *   for builder-path inquiries where inquiryOrigin alone would infer incorrectly.
 *
 *   Until this hook is wired, invited customers who use the builder project
 *   flow will be classified as platform_acquired (conservative / platform-safe).
 *
 * ── Immutability guarantee ───────────────────────────────────────────────────
 *
 *   Supabase inserts use ON CONFLICT DO NOTHING. The first-written
 *   commercial_origin for a given pair is permanent and cannot be overridden
 *   by later calls to this service. Only the operator resolve RPC
 *   (supabase/migrations/20260420000004) may change a jobs.commercial_origin
 *   after finalisation, and it records every change in attribution_audit_log.
 */

import { supabase } from '../supabase'
import { logInfo, logWarning } from '../observability'
import type { CommercialOrigin, JobCommercialOrigin, OriginContext, CustomerProviderRelationship } from './types'

// ────────────────────────────────────────────────────────────────────────────
// Session cache
// Cleared on sign-out. Protects against redundant Supabase reads within
// the same session when the same pair appears on multiple job creations.
// ────────────────────────────────────────────────────────────────────────────

const _cache = new Map<string, CustomerProviderRelationship>()

function cacheKey(customerUserId: string, craftsmanUserId: string): string {
  return `${customerUserId}:${craftsmanUserId}`
}

/** Call on sign-out to prevent stale entries leaking across sessions. */
export function clearCommercialAttributionCache(): void {
  _cache.clear()
}

// ────────────────────────────────────────────────────────────────────────────
// Inference
// ────────────────────────────────────────────────────────────────────────────

export type InferOriginInput = {
  /**
   * The inquiry origin from the originating conversation.
   * Maps UI surface → commercial classification when no relationship exists yet.
   */
  inquiryOrigin?: 'reel' | 'profile' | 'project' | 'category' | null
}

/**
 * Infer commercial origin from available context signals.
 * Used ONLY when no existing relationship record is found.
 *
 * 'merchant_brought' requires an explicit prior call to recordInviteRelationship.
 * All surfaces reachable through SaFix's own discovery classify as
 * 'platform_acquired'.
 */
export function inferCommercialOrigin(input: InferOriginInput): {
  origin: CommercialOrigin
  context: OriginContext
} {
  switch (input.inquiryOrigin) {
    case 'reel':
      return { origin: 'platform_acquired', context: 'reel' }
    case 'profile':
    case 'category':
    case 'project':
      return { origin: 'platform_acquired', context: 'search' }
    default:
      return { origin: 'platform_acquired', context: 'unknown' }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Persistence (atomic — L2 write before any L3 stamp)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Persist a customer↔craftsman commercial relationship to Supabase and
 * return the canonical `commercial_origin` that is actually stored afterwards.
 *
 * Flow:
 *   1. INSERT with ON CONFLICT DO NOTHING (awaited).
 *   2. Re-read the row by (customer_user_id, craftsman_user_id).
 *   3. Return the stored origin.  If a concurrent write won the race, the
 *      caller receives the winning origin — NOT the locally inferred one.
 *
 * Failure modes:
 *   - insert error other than 23505 (unique_violation): transient DB failure.
 *     Returns 'unknown_pending_resolution'.  Caller must stamp that value on
 *     the Job; the Attribution Finalizer resolves asynchronously.
 *   - post-insert read error or empty row: returns 'unknown_pending_resolution'.
 *
 * NEVER returns an inferred value that did not round-trip through the DB.
 * NEVER stamps cache on failure.
 */
async function persistAndReadCanonical(
  customerUserId: string,
  craftsmanUserId: string,
  inferredOrigin: CommercialOrigin,
  context: OriginContext,
): Promise<JobCommercialOrigin> {
  // Step 1: INSERT.  ON CONFLICT DO NOTHING is enforced by the unique
  // index on (customer_user_id, craftsman_user_id) in
  // supabase/migrations/20260409000004_commercial_attribution.sql.
  const { error: insertError } = await supabase
    .from('customer_provider_relationships')
    .insert({
      customer_user_id: customerUserId,
      craftsman_user_id: craftsmanUserId,
      commercial_origin: inferredOrigin,
      origin_context: context,
    })

  if (insertError) {
    const code = (insertError as { code?: string }).code
    if (code !== '23505') {
      // Real transient error — NOT a conflict.  Do not stamp L3 definitively.
      logWarning('commercial_attribution.persist_failed', {
        customerUserId,
        craftsmanUserId,
        inferredOrigin,
        reason: insertError.message,
      })
      return 'unknown_pending_resolution'
    }
    // 23505 = conflict → row already exists (our write lost the race OR the
    // row was pre-existing under a different resolution path).  Fall through
    // to the read-back to discover the canonical winner.
  }

  // Step 2: read-back.  This is the authoritative source of the canonical
  // commercial_origin for the pair.
  const { data, error: readError } = await supabase
    .from('customer_provider_relationships')
    .select('id, commercial_origin, origin_context, created_at')
    .eq('customer_user_id', customerUserId)
    .eq('craftsman_user_id', craftsmanUserId)
    .maybeSingle()

  if (readError || !data) {
    logWarning('commercial_attribution.post_insert_read_failed', {
      customerUserId,
      craftsmanUserId,
      reason: readError?.message ?? 'row_not_visible_after_insert',
    })
    return 'unknown_pending_resolution'
  }

  const canonicalOrigin = data.commercial_origin as CommercialOrigin

  // Step 3: cache the canonical (not inferred) value.  Guarantees that any
  // subsequent intra-session read returns the same origin the DB would return.
  const rel: CustomerProviderRelationship = {
    id: data.id as string,
    customerUserId,
    craftsmanUserId,
    commercialOrigin: canonicalOrigin,
    originContext: data.origin_context as OriginContext | undefined,
    createdAt: new Date(data.created_at as string).getTime(),
  }
  _cache.set(cacheKey(customerUserId, craftsmanUserId), rel)

  if (canonicalOrigin !== inferredOrigin) {
    // Diagnostic breadcrumb: our inference lost to a prior/concurrent write.
    // Not an error — the system behaves correctly — but it is useful to
    // surface for attribution-analytics triangulation.
    logInfo('commercial_attribution.race_resolved_to_canonical', {
      customerUserId,
      craftsmanUserId,
      inferred: inferredOrigin,
      canonical: canonicalOrigin,
    })
  } else {
    logInfo('commercial_attribution.relationship_created', {
      customerUserId,
      craftsmanUserId,
      origin: canonicalOrigin,
      context,
    })
  }

  return canonicalOrigin
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Record a merchant_brought relationship for a customer who completed the
 * invited guided-entry path.
 *
 * Call this from the UI immediately after selectProvider() succeeds, during
 * the customer's own session (auth.uid() = customerUserId).
 *
 * Since Stage 5 (2026-04-20) this function awaits the underlying
 * persistAndReadCanonical call and logs a warning on transient failures.
 * The return type stays `Promise<void>` to preserve call-sites, but the
 * operation is no longer fire-and-forget: callers awaiting completion can
 * trust that the Layer-2 record either exists OR the failure has been logged.
 *
 * If a record already exists for this pair (ON CONFLICT DO NOTHING), the
 * existing classification is preserved — merchant_brought cannot override a
 * pre-existing platform_acquired row (immutability guarantee).
 *
 * @param customerUserId   Supabase auth.users UUID of the customer
 * @param craftsmanUserId  Supabase auth.users UUID of the invited craftsman
 */
export async function recordInviteRelationship(
  customerUserId: string,
  craftsmanUserId: string,
): Promise<void> {
  // Cache short-circuit only when a merchant_brought entry is already cached.
  // A cached platform_acquired still forces a DB round-trip through
  // persistAndReadCanonical so the invite attempt is surfaced (and logged if
  // the conflict preserves the existing non-invite classification).
  const cached = _cache.get(cacheKey(customerUserId, craftsmanUserId))
  if (cached?.commercialOrigin === 'merchant_brought') return

  // In-memory mode: populate the cache directly.  The Supabase client is a
  // placeholder in this build; a real network call would hang.  This keeps the
  // semantic (an invite establishes merchant_brought for the current session)
  // without committing a spurious write.
  if ((import.meta.env.VITE_DATA_SOURCE as string | undefined) !== 'supabase') {
    _cache.set(cacheKey(customerUserId, craftsmanUserId), {
      id: '',
      customerUserId,
      craftsmanUserId,
      commercialOrigin: 'merchant_brought',
      originContext: 'invite',
      createdAt: Date.now(),
    })
    return
  }

  // Atomic persist + read-back.  Return value intentionally discarded — the
  // caller (UI invite flow) does not consume it.  Any failure is already
  // logged inside persistAndReadCanonical.
  await persistAndReadCanonical(customerUserId, craftsmanUserId, 'merchant_brought', 'invite')
}

/**
 * Resolve the commercial origin for a (customerUserId, craftsmanUserId) pair.
 *
 * Resolution steps:
 *   1. Session cache hit — platform_acquired returned immediately.
 *      merchant_brought cache entries are NOT served from cache: the DB is always
 *      re-verified to guard against stale entries after relationship deletion.
 *   2. Supabase lookup — returns existing record.
 *   3. No record found — infers from context AND atomically persists + reads
 *      back the canonical origin via persistAndReadCanonical.
 *
 * Security guardrail: merchant_brought is only returned when confirmed by the DB.
 * If the DB row is absent (deleted, lookup error), the safe default (platform_acquired
 * → 9%) is applied.  merchant_brought can never propagate without a live DB row.
 *
 * Safe to call from either the customer's or the craftsman's session.
 * Supabase RLS allows reads by both parties (craftsman_user_id = auth.uid() OR
 * customer_user_id = auth.uid()).
 *
 * @param customerUserId   Supabase auth.users UUID of the customer
 * @param craftsmanUserId  Supabase auth.users UUID of the craftsman
 * @param inferInput       Context for inference when no record exists
 * @returns JobCommercialOrigin to stamp on the job/project.
 *   Returns 'unknown_pending_resolution' when the Supabase lookup fails
 *   transiently OR when the INSERT + read-back round-trip cannot complete.
 *   The caller must stamp this value on the job; the Attribution Finalizer
 *   worker resolves it asynchronously.  Payment endpoints gate on
 *   attribution_status = 'finalized' and block until the worker resolves.
 */
export async function resolveAndEnsureRelationship(
  customerUserId: string,
  craftsmanUserId: string,
  inferInput: InferOriginInput,
): Promise<JobCommercialOrigin> {
  // 1. Session cache — platform_acquired only.
  //    merchant_brought is always re-verified from DB; see security-guardrail note.
  const cached = _cache.get(cacheKey(customerUserId, craftsmanUserId))
  if (cached && cached.commercialOrigin !== 'merchant_brought') {
    return cached.commercialOrigin
  }

  // 2. In-memory mode: no network.  Infer, populate cache, return.
  if ((import.meta.env.VITE_DATA_SOURCE as string | undefined) !== 'supabase') {
    const { origin, context } = inferCommercialOrigin(inferInput)
    _cache.set(cacheKey(customerUserId, craftsmanUserId), {
      id: '',
      customerUserId,
      craftsmanUserId,
      commercialOrigin: origin,
      originContext: context,
      createdAt: Date.now(),
    })
    return origin
  }

  // 3. Supabase lookup.
  const { data, error } = await supabase
    .from('customer_provider_relationships')
    .select('id, commercial_origin, origin_context, created_at')
    .eq('customer_user_id', customerUserId)
    .eq('craftsman_user_id', craftsmanUserId)
    .maybeSingle()

  if (error) {
    logWarning('commercial_attribution.lookup_failed', {
      customerUserId,
      craftsmanUserId,
      reason: error.message,
    })
    // Do NOT fall through to inference on a DB error.
    // Return the blocked state so the caller stamps 'unknown_pending_resolution'
    // on the job. All payment initiation is then blocked until the Finalizer
    // resolves the row (or an operator acts).
    return 'unknown_pending_resolution'
  }

  if (data) {
    const rel: CustomerProviderRelationship = {
      id: data.id as string,
      customerUserId,
      craftsmanUserId,
      commercialOrigin: data.commercial_origin as CommercialOrigin,
      originContext: data.origin_context as OriginContext | undefined,
      createdAt: new Date(data.created_at as string).getTime(),
    }
    _cache.set(cacheKey(customerUserId, craftsmanUserId), rel)
    return rel.commercialOrigin
  }

  // 4. No record and no error — definitively no relationship exists yet.
  //    Infer AND atomically persist + read-back.  If any step of the
  //    persistence round-trip fails, the caller receives
  //    'unknown_pending_resolution' so the Finalizer takes over.
  const { origin: inferredOrigin, context } = inferCommercialOrigin(inferInput)
  return await persistAndReadCanonical(
    customerUserId,
    craftsmanUserId,
    inferredOrigin,
    context,
  )
}
