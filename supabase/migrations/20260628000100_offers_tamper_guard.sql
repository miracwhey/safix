-- 20260628000100_offers_tamper_guard.sql
--
-- HARDENING (Authz Batch 1b) — close the offers status-FSM + financial tamper vector.
--
-- PROBLEM (verified on prod 2026-06-28 via pg_policies / information_schema.triggers):
--   The single offers_update_own policy already has qual AND with_check both scoped
--   to the parties ( (auth.uid()=craftsman_user_id) OR (auth.uid()=customer_user_id) )
--   — ownership IS validated.  However there is NO column lock and NO FSM guard, and
--   there is currently NO trigger on public.offers.
--
--   A customer can therefore issue direct PostgREST UPDATEs to:
--     (a) Rewrite financial columns (price, gross_total, net_total, vat_amount …) on
--         a pending offer then call acceptOfferWorkflow — the workflow derives the
--         escrow/payment amount directly from offer.price / offer.grossTotal
--         (offerWorkflow.ts:789-800) → customer underpayment / money corruption.
--     (b) Revert status from 'accepted' or 'declined' back to 'pending', reopening a
--         completed transaction.
--     (c) Drive status to an arbitrary value, bypassing per-party authority.
--
-- FIX: BEFORE UPDATE trigger public.offers_tamper_guard():
--   1. Identity / anchor columns (id, conversation_id, customer_user_id,
--      craftsman_user_id, created_at, source_spatial_scene_id) immutable for ALL
--      client writers at ALL times.
--   2. Financial / price columns (price, currency, gross_total, net_total, vat_amount,
--      vat_rate, labor_cost, material_cost, other_cost, line_items) mutable ONLY by
--      the craftsman while OLD.status = 'draft'.  Immutable for the customer at all
--      times and for the craftsman once the offer has been sent (status != 'draft').
--   3. FSM guard:
--        - Terminal statuses (accepted, declined, superseded, expired, cancelled):
--          no client writer may change status.
--        - From 'pending': customer authority → accepted | declined only;
--                          craftsman authority → superseded | cancelled only.
--        - From 'draft':   craftsman authority → pending | cancelled only.
--
-- NOTE: offers_update_own WITH CHECK is already `(auth.uid()=craftsman_user_id) OR
--   (auth.uid()=customer_user_id)` — no policy recreation needed here (unlike
--   change_orders where WITH CHECK was NULL).
--
-- WRITE PATTERN CONFIRMED: SupabaseOfferRepository.update() sends the full row via
--   offerToRow(updated) on every update (SupabaseOfferRepository.ts:473-478).
--   IS DISTINCT FROM column checks are therefore safe: unchanged columns compare
--   equal and pass through; only a real change to a frozen column raises.
--
-- ERRCODE 23514 (check_violation): classifyFailure maps class-23 →
--   business-rejected → offline-queue drop (not a retry storm as P0001 would cause).
--
-- SELF-PROOF: temp-table abort-tx verified on prod 2026-06-28, all 9 cases PASS:
--   PASS T1 customer-tamper-price-pending BLOCKED 23514
--   PASS T2 customer-revert-accepted-to-pending BLOCKED 23514
--   PASS T3 customer-pending-to-draft BLOCKED 23514
--   PASS T4 customer-pending-to-superseded BLOCKED 23514
--   PASS T5 legit-customer-accept ALLOWED
--   PASS T6 legit-customer-decline ALLOWED
--   PASS T7 craftsman-edit-financials-while-draft ALLOWED
--   PASS T8 craftsman-supersede-pending ALLOWED
--   PASS T9 craftsman-update-notes-pending ALLOWED
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS offers_tamper_guard_tg ON public.offers;
--   DROP FUNCTION IF EXISTS public.offers_tamper_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- Guard function
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.offers_tamper_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Trusted server writers (service_role / cron / webhook run without a JWT).
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Operators are trusted (mirrors change_orders_tamper_guard).
  IF public.is_current_user_operator() THEN
    RETURN NEW;
  END IF;

  -- ── Identity / anchor columns: immutable for all client writers ───────────
  --
  -- source_spatial_scene_id is included: Spatial-Offers anchor to a scene and
  -- that anchor must not be silently re-pointed by a client.
  IF NEW.id                       IS DISTINCT FROM OLD.id
     OR NEW.conversation_id       IS DISTINCT FROM OLD.conversation_id
     OR NEW.customer_user_id      IS DISTINCT FROM OLD.customer_user_id
     OR NEW.craftsman_user_id     IS DISTINCT FROM OLD.craftsman_user_id
     OR NEW.created_at            IS DISTINCT FROM OLD.created_at
     OR NEW.source_spatial_scene_id IS DISTINCT FROM OLD.source_spatial_scene_id
  THEN
    RAISE EXCEPTION 'offers: identity/anchor columns are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- ── Financial / price columns: mutable only by craftsman while draft ──────
  --
  -- Once the offer is sent (status leaves 'draft'), financial columns are the
  -- commercial snapshot the customer accepted.  acceptOfferWorkflow derives the
  -- escrow/payment amount directly from offer.price / offer.grossTotal —
  -- tampering these after send corrupts the money corridor.
  IF ( NEW.price          IS DISTINCT FROM OLD.price
       OR NEW.currency    IS DISTINCT FROM OLD.currency
       OR NEW.gross_total IS DISTINCT FROM OLD.gross_total
       OR NEW.net_total   IS DISTINCT FROM OLD.net_total
       OR NEW.vat_amount  IS DISTINCT FROM OLD.vat_amount
       OR NEW.vat_rate    IS DISTINCT FROM OLD.vat_rate
       OR NEW.labor_cost  IS DISTINCT FROM OLD.labor_cost
       OR NEW.material_cost IS DISTINCT FROM OLD.material_cost
       OR NEW.other_cost  IS DISTINCT FROM OLD.other_cost
       OR NEW.line_items  IS DISTINCT FROM OLD.line_items )
     AND NOT ( auth.uid() = OLD.craftsman_user_id AND OLD.status = 'draft' )
  THEN
    RAISE EXCEPTION 'offers: financial/price fields are immutable after send and for the customer'
      USING ERRCODE = '23514';
  END IF;

  -- ── FSM: terminal statuses block any client status change ─────────────────
  IF OLD.status IN ('accepted', 'declined', 'superseded', 'expired', 'cancelled')
     AND NEW.status IS DISTINCT FROM OLD.status
  THEN
    RAISE EXCEPTION 'offers: status ''%'' is terminal and cannot be changed by a client writer', OLD.status
      USING ERRCODE = '23514';
  END IF;

  -- ── FSM: per-party authority from 'pending' ───────────────────────────────
  --
  -- Customer drives the acceptance decision.
  -- Craftsman supersedes (supersedeOfferWorkflow marks old offer 'superseded'
  -- and creates a fresh one) or cancels.
  IF OLD.status = 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF auth.uid() = OLD.customer_user_id THEN
      IF NEW.status NOT IN ('accepted', 'declined') THEN
        RAISE EXCEPTION 'offers: customer may only transition pending → accepted or declined (got ''%'')', NEW.status
          USING ERRCODE = '23514';
      END IF;
    ELSIF auth.uid() = OLD.craftsman_user_id THEN
      IF NEW.status NOT IN ('superseded', 'cancelled') THEN
        RAISE EXCEPTION 'offers: craftsman may only transition pending → superseded or cancelled (got ''%'')', NEW.status
          USING ERRCODE = '23514';
      END IF;
    ELSE
      -- Belt-and-suspenders: RLS already blocks non-parties via offers_update_own.
      RAISE EXCEPTION 'offers: caller is not a party to this offer'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- ── FSM: per-party authority from 'draft' ────────────────────────────────
  --
  -- Only the craftsman can send (draft → pending) or cancel from draft.
  IF OLD.status = 'draft' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF auth.uid() = OLD.craftsman_user_id THEN
      IF NEW.status NOT IN ('pending', 'cancelled') THEN
        RAISE EXCEPTION 'offers: craftsman may only transition draft → pending or cancelled (got ''%'')', NEW.status
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'offers: only the craftsman can advance an offer from draft'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Attach trigger
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS offers_tamper_guard_tg ON public.offers;
CREATE TRIGGER offers_tamper_guard_tg
  BEFORE UPDATE ON public.offers
  FOR EACH ROW
  EXECUTE FUNCTION public.offers_tamper_guard();

NOTIFY pgrst, 'reload schema';
