-- Serialize provider-share allocation for dispute split releases before any
-- Stripe movement. A durable per-tranche reservation is the handoff between
-- Postgres quota truth and Stripe's idempotent transfer/payout call.

ALTER TABLE public.escrow_tranches
  ADD COLUMN IF NOT EXISTS split_reserved_gross numeric(12,2),
  ADD COLUMN IF NOT EXISTS split_reserved_ratio numeric(7,6),
  ADD COLUMN IF NOT EXISTS split_reserved_at timestamptz;

ALTER TABLE public.escrow_tranches
  DROP CONSTRAINT IF EXISTS escrow_tranches_split_reservation_shape_check;

ALTER TABLE public.escrow_tranches
  ADD CONSTRAINT escrow_tranches_split_reservation_shape_check CHECK (
    (split_reserved_gross IS NULL AND split_reserved_ratio IS NULL AND split_reserved_at IS NULL)
    OR (
      split_reserved_gross > 0
      AND split_reserved_ratio > 0
      AND split_reserved_ratio < 1
      AND split_reserved_at IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION public.guard_split_release_reservation_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF (
    NEW.split_reserved_gross IS DISTINCT FROM OLD.split_reserved_gross
    OR NEW.split_reserved_ratio IS DISTINCT FROM OLD.split_reserved_ratio
    OR NEW.split_reserved_at IS DISTINCT FROM OLD.split_reserved_at
  ) AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'split_release_reservation_server_only'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_split_release_reservation_fields()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_split_release_reservation_fields_tg ON public.escrow_tranches;
CREATE TRIGGER guard_split_release_reservation_fields_tg
  BEFORE UPDATE OF split_reserved_gross, split_reserved_ratio, split_reserved_at
  ON public.escrow_tranches
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_split_release_reservation_fields();

CREATE OR REPLACE FUNCTION public.reserve_split_release_quota(
  p_tranche_id  text,
  p_plan_id     text,
  p_split_ratio numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plan_total       numeric;
  v_tranche          record;
  v_provider_target  numeric;
  v_committed_gross  numeric := 0;
  v_remaining_gross  numeric;
  v_reserved_gross   numeric;
BEGIN
  IF p_split_ratio IS NULL OR p_split_ratio <= 0 OR p_split_ratio >= 1 THEN
    RETURN jsonb_build_object('outcome', 'invalid_ratio');
  END IF;

  -- The plan lock serializes sibling reservations. Every concurrent caller for
  -- the same escrow plan must pass this row before reading committed quota.
  SELECT total_amount
    INTO v_plan_total
    FROM public.escrow_payment_plans
   WHERE id = p_plan_id::uuid
   FOR UPDATE;

  IF v_plan_total IS NULL OR v_plan_total <= 0 THEN
    RETURN jsonb_build_object('outcome', 'plan_total_missing');
  END IF;

  SELECT id, plan_id, amount, status, external_release_ref,
         external_payout_ref, transfer_reversal_ref,
         split_reserved_gross, split_reserved_ratio
    INTO v_tranche
    FROM public.escrow_tranches
   WHERE id = p_tranche_id::uuid
   FOR UPDATE;

  IF NOT FOUND OR v_tranche.plan_id <> p_plan_id::uuid THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_tranche.split_reserved_gross IS NOT NULL THEN
    IF v_tranche.split_reserved_ratio IS DISTINCT FROM p_split_ratio THEN
      RETURN jsonb_build_object('outcome', 'ratio_conflict');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'reserved',
      'reserved_gross', v_tranche.split_reserved_gross,
      'idempotent', true
    );
  END IF;

  IF v_tranche.status <> 'eligible_for_release'
     AND NOT (
       v_tranche.status = 'released'
       AND v_tranche.external_release_ref IS NULL
       AND v_tranche.external_payout_ref IS NULL
     ) THEN
    RETURN jsonb_build_object('outcome', 'invalid_tranche_state', 'status', v_tranche.status);
  END IF;

  SELECT COALESCE(sum(
    CASE
      WHEN et.id = p_tranche_id::uuid THEN 0
      WHEN et.transfer_reversal_ref IS NOT NULL THEN 0
      WHEN et.external_release_ref IS NOT NULL
        OR et.external_payout_ref IS NOT NULL
        OR et.status IN ('released', 'release_pending')
        THEN COALESCE(et.split_reserved_gross, et.amount)
      WHEN et.split_reserved_gross IS NOT NULL
        THEN et.split_reserved_gross
      ELSE 0
    END
  ), 0)
    INTO v_committed_gross
    FROM public.escrow_tranches et
   WHERE et.plan_id = p_plan_id::uuid;

  v_provider_target := round(v_plan_total * p_split_ratio, 2);
  v_remaining_gross := greatest(0, v_provider_target - v_committed_gross);

  IF v_remaining_gross <= 0 THEN
    RETURN jsonb_build_object(
      'outcome', 'quota_exhausted',
      'provider_target_gross', v_provider_target,
      'committed_gross', v_committed_gross
    );
  END IF;

  v_reserved_gross := least(v_tranche.amount, v_remaining_gross);

  UPDATE public.escrow_tranches
     SET split_reserved_gross = v_reserved_gross,
         split_reserved_ratio = p_split_ratio,
         split_reserved_at = now(),
         updated_at = now()
   WHERE id = p_tranche_id::uuid;

  RETURN jsonb_build_object(
    'outcome', 'reserved',
    'reserved_gross', v_reserved_gross,
    'provider_target_gross', v_provider_target,
    'committed_gross', v_committed_gross,
    'idempotent', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_split_release_quota(text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_split_release_quota(text, text, numeric)
  TO service_role;

CREATE OR REPLACE FUNCTION public.release_split_release_reservation(
  p_tranche_id  text,
  p_plan_id     text,
  p_split_ratio numeric
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_released boolean := false;
BEGIN
  PERFORM 1
    FROM public.escrow_payment_plans
   WHERE id = p_plan_id::uuid
   FOR UPDATE;

  UPDATE public.escrow_tranches
     SET split_reserved_gross = NULL,
         split_reserved_ratio = NULL,
         split_reserved_at = NULL,
         updated_at = now()
   WHERE id = p_tranche_id::uuid
     AND plan_id = p_plan_id::uuid
     AND split_reserved_ratio = p_split_ratio
     AND status = 'eligible_for_release'
     AND external_release_ref IS NULL
     AND external_payout_ref IS NULL;
  v_released := FOUND;

  RETURN v_released;
END;
$function$;

REVOKE ALL ON FUNCTION public.release_split_release_reservation(text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_split_release_reservation(text, text, numeric)
  TO service_role;

NOTIFY pgrst, 'reload schema';
