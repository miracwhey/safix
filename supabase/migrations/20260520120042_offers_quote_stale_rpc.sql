-- Spatial Canonical · Phase 3 · Block 3.9 · QUOTE-STALE SECURITY DEFINER RPC
--
-- Purpose:
--   The QUOTE-STALE data model (20260520120041) added the four `offers.is_stale*`
--   columns but deliberately did NOT create the write path: marking a provider's
--   offer stale is a customer-verify action, and a customer must never hold a
--   direct UPDATE grant on a provider's `offers` row (Verify-Flow-Spec §4).
--
--   This migration creates that write path — `public.offers_mark_quote_stale` —
--   a SECURITY DEFINER RPC. It runs as the function owner, bypassing `offers`
--   RLS, and performs the four-column stale write only after proving the caller
--   is the offer's own customer and a scene-actor of the triggering scene.
--
-- Why a separate migration (not folded into 20260520120041):
--   120041 is the passive data-model step (additive columns, no confirm needed).
--   The RPC is the ACTIVE step (a new callable that grants authenticated EXECUTE)
--   — CLAUDE.md keeps passive schema and active grants in distinct migrations.
--   120041's own header flags this RPC as the deferred follow-on; this is it.
--
-- Pairs with the pure decision layer src/lib/spatial/workflow/verifyReQuote.ts
--   (evaluateReQuoteTrigger → planMarkQuotesStale → StaleOfferPlan). That layer
--   DECIDES which offers go stale; this RPC is the persistence the Supabase-mode
--   caller invokes per planned offer.
--
-- Verified against PROD schema 2026-05-20 (itdntawwuzqfwmcwnwjr):
--   offers.id               uuid
--   offers.customer_user_id uuid   (the customer party — the legitimate caller)
--   offers.status           text   (only 'pending' offers are ever marked stale)
--
-- Plan reference: spatial-v1-verify-flow-implementation-spec.md §4 / §3.9.

-- ── RPC: offers_mark_quote_stale ─────────────────────────────────────────────
--
-- Marks ONE pending offer stale on behalf of the customer whose scan basis
-- changed. Returns true when the flag was newly set, false on an idempotent
-- no-op (offer already stale, or no longer pending). Hard violations
-- (unauthenticated / not the offer's customer / not a scene-actor / unknown
-- offer or scene / illegal reason) raise — they signal a caller bug or an
-- attempted cross-customer write, never a benign race.
--
-- now() is stamped server-side — the client-supplied markedAt of the pure
-- layer is for InMemory determinism only and is intentionally NOT trusted here.

CREATE OR REPLACE FUNCTION public.offers_mark_quote_stale(
  p_offer_id        uuid,
  p_reason          text,
  p_source_scene_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid;
  v_customer_user_id uuid;
  v_status           text;
  v_is_stale         boolean;
BEGIN
  -- 1. Must be authenticated.
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'offers_mark_quote_stale: authentication required'
      USING ERRCODE = '28000';
  END IF;

  -- 2. Reason must be one of the three VF-2 trigger reasons (mirrors
  --    offers_stale_reason_chk so the error is an RPC-level rejection).
  IF p_reason NOT IN ('measurement_changed','high_severity_pin_added','layout_changed') THEN
    RAISE EXCEPTION
      'offers_mark_quote_stale: invalid reason %; must be measurement_changed|high_severity_pin_added|layout_changed',
      p_reason
      USING ERRCODE = '22023';
  END IF;

  -- 3. Offer must exist; lock the row so a concurrent mark is serialised.
  SELECT customer_user_id, status, is_stale
    INTO v_customer_user_id, v_status, v_is_stale
    FROM public.offers
    WHERE id = p_offer_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offers_mark_quote_stale: offer % not found', p_offer_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 4. The caller must be THIS offer's customer. A customer may flag only their
  --    own pending quotes stale — never another party's offer.
  IF v_customer_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION
      'offers_mark_quote_stale: caller is not the customer of offer %', p_offer_id
      USING ERRCODE = '42501';
  END IF;

  -- 5. The triggering scene must exist and the caller must be a scene-actor of
  --    it — the stale flag is only legitimate when raised from a scene the
  --    customer genuinely owns / can see (spatial_can_view_scene, 20260520120010).
  IF NOT public.spatial_can_view_scene(p_source_scene_id, v_uid) THEN
    RAISE EXCEPTION
      'offers_mark_quote_stale: caller is not a scene-actor of source scene %',
      p_source_scene_id
      USING ERRCODE = '42501';
  END IF;

  -- 6. Idempotent no-ops — never churn the timestamp, never raise:
  --    - already stale  → the flag stands (the pure layer also skips these),
  --    - not pending    → a closed/superseded/expired offer has no live basis
  --                       to flag; the customer's edit simply has no target.
  IF v_is_stale = true THEN
    RETURN false;
  END IF;
  IF v_status <> 'pending' THEN
    RETURN false;
  END IF;

  -- 7. Apply the four-column stale write. now() is the server-authoritative
  --    mark timestamp; the offers_stale_consistency_chk constraint holds
  --    because is_stale, stale_reason and stale_marked_at are all set together.
  UPDATE public.offers
     SET is_stale              = true,
         stale_reason          = p_reason,
         stale_marked_at       = now(),
         stale_source_scene_id = p_source_scene_id
   WHERE id = p_offer_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.offers_mark_quote_stale(uuid, text, uuid) IS
  'Spatial Canonical Block 3.9 (Verify-Flow §4): SECURITY DEFINER RPC that marks '
  'one pending offer stale on behalf of its customer after a scan-basis change. '
  'Validates auth.uid() = offers.customer_user_id and scene-actor membership of '
  'the source scene; bypasses offers RLS so the customer never needs a direct '
  'UPDATE grant on a provider offer column. now() is stamped server-side. '
  'Returns true when newly flagged, false on idempotent no-op (already stale / '
  'not pending). Pairs with verifyReQuote.ts planMarkQuotesStale.';

-- Grant: authenticated (the customer-verify caller) + service_role. anon / PUBLIC
-- excluded — an unauthenticated caller has no offer to flag.
REVOKE EXECUTE ON FUNCTION public.offers_mark_quote_stale(uuid, text, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.offers_mark_quote_stale(uuid, text, uuid) TO authenticated, service_role;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- REVOKE EXECUTE ON FUNCTION public.offers_mark_quote_stale(uuid, text, uuid) FROM authenticated, service_role;
-- DROP FUNCTION IF EXISTS public.offers_mark_quote_stale(uuid, text, uuid);
