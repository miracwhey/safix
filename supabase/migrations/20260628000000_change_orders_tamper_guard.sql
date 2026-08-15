-- 20260628000000_change_orders_tamper_guard.sql
--
-- HARDENING (Authz Batch 1a) — close the change_orders price/identity tampering vector.
--
-- PROBLEM (verified on prod 2026-06-28 via pg_policies):
--   change_orders_customer_update AND change_orders_craftsman_update both have
--   with_check = NULL and no column constraints. A party that owns the row
--   (customer_user_id = auth.uid()) can PATCH ANY column via direct PostgREST —
--   including gross_total / net_total / price — before accepting a Nachtrag.
--   acceptChangeOrderWorkflow then derives the supplementary payment amount from
--   the (possibly tampered) value (src/lib/workflow/changeOrderWorkflow.ts:329-332)
--   → customer underpayment / money corruption.
--
-- FIX:
--   1. BEFORE UPDATE trigger change_orders_tamper_guard_tg:
--        - identity/anchor columns (id, job_id, source_offer_id, craftsman_user_id,
--          customer_user_id, created_at) immutable for every client writer.
--        - financial/content columns (description, price, currency, gross_total,
--          net_total, vat_rate) mutable ONLY by the craftsman while OLD.status='draft'.
--        - service_role / server (auth.uid() IS NULL) and operators bypass.
--      Per-column IS DISTINCT FROM comparison is safe with the repository's
--      full-row write pattern (SupabaseChangeOrderRepository.update writes the whole
--      row): unchanged financials pass, the legit status-only accept/decline passes,
--      the craftsman draft edit passes; only a real tamper of a frozen column raises.
--   2. Mirror the ownership predicate into WITH CHECK on both UPDATE policies so the
--      NEW row is re-validated (closes the with_check = NULL gap as defense-in-depth).
--
-- ERRCODE 23514 (check_violation) — client-facing business reject. classifyFailure
-- maps class 23 to business-rejected → dropped from any offline replay queue instead
-- of retry-looping (P0001 would map to unknown → retry storm).
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS change_orders_tamper_guard_tg ON public.change_orders;
--   DROP FUNCTION IF EXISTS public.change_orders_tamper_guard();
--   DROP POLICY IF EXISTS change_orders_customer_update ON public.change_orders;
--   DROP POLICY IF EXISTS change_orders_craftsman_update ON public.change_orders;
--   CREATE POLICY change_orders_customer_update  ON public.change_orders FOR UPDATE USING (customer_user_id = auth.uid());
--   CREATE POLICY change_orders_craftsman_update ON public.change_orders FOR UPDATE USING (craftsman_user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.change_orders_tamper_guard()
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

  -- Operators are trusted (mirrors disputes_status_change_guard).
  IF public.is_current_user_operator() THEN
    RETURN NEW;
  END IF;

  -- Identity / anchor columns: immutable for all client writers.
  IF NEW.id                IS DISTINCT FROM OLD.id
     OR NEW.job_id            IS DISTINCT FROM OLD.job_id
     OR NEW.source_offer_id   IS DISTINCT FROM OLD.source_offer_id
     OR NEW.craftsman_user_id IS DISTINCT FROM OLD.craftsman_user_id
     OR NEW.customer_user_id  IS DISTINCT FROM OLD.customer_user_id
     OR NEW.created_at         IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'change_orders: identity/anchor columns are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- Financial / content columns: mutable only by the craftsman while still draft.
  IF ( NEW.description IS DISTINCT FROM OLD.description
       OR NEW.price       IS DISTINCT FROM OLD.price
       OR NEW.currency    IS DISTINCT FROM OLD.currency
       OR NEW.gross_total IS DISTINCT FROM OLD.gross_total
       OR NEW.net_total   IS DISTINCT FROM OLD.net_total
       OR NEW.vat_rate    IS DISTINCT FROM OLD.vat_rate )
     AND NOT ( auth.uid() = OLD.craftsman_user_id AND OLD.status = 'draft' )
  THEN
    RAISE EXCEPTION 'change_orders: financial fields are immutable after send and for the customer'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS change_orders_tamper_guard_tg ON public.change_orders;
CREATE TRIGGER change_orders_tamper_guard_tg
  BEFORE UPDATE ON public.change_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.change_orders_tamper_guard();

-- Defense-in-depth: re-validate ownership on the NEW row (close with_check = NULL).
DROP POLICY IF EXISTS change_orders_customer_update ON public.change_orders;
CREATE POLICY change_orders_customer_update
  ON public.change_orders FOR UPDATE
  USING (customer_user_id = auth.uid())
  WITH CHECK (customer_user_id = auth.uid());

DROP POLICY IF EXISTS change_orders_craftsman_update ON public.change_orders;
CREATE POLICY change_orders_craftsman_update
  ON public.change_orders FOR UPDATE
  USING (craftsman_user_id = auth.uid())
  WITH CHECK (craftsman_user_id = auth.uid());

NOTIFY pgrst, 'reload schema';
