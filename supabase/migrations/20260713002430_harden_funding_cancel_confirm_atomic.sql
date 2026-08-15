-- Close the remaining cancel-vs-confirm race and repair the canonical funding
-- transition without allowing request / plan / tranche truth to diverge.
--
-- Lock order for every money-sensitive path is:
--   jobs -> funding_requests -> escrow_payment_plans -> escrow_tranches
-- A cancellation that wins the job lock makes confirmation return
-- `job_terminal`; a confirmation that wins first makes cancellation fail.

CREATE OR REPLACE FUNCTION public.guard_job_cancellation_against_funding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_has_live_funds boolean;
  v_has_live_intent boolean;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- The job row is already locked by the triggering UPDATE. Lock every linked
  -- request in deterministic order before deciding whether cancellation wins.
  PERFORM 1
    FROM public.funding_requests
   WHERE job_id = OLD.id
   ORDER BY id
   FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
      FROM public.funding_requests fr
      LEFT JOIN public.escrow_payment_plans ep ON ep.id = fr.escrow_plan_id
     WHERE fr.job_id = OLD.id
       AND (
         fr.status = 'funded'
         OR ep.status IN (
           'funded_in_escrow', 'partially_released', 'fully_released',
           'disputed', 'refunded'
         )
       )
  ) INTO v_has_live_funds;

  IF v_has_live_funds THEN
    RAISE EXCEPTION 'job_cancel_blocked_by_funding: job % has secured or settled funds', OLD.id
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.funding_requests
     WHERE job_id = OLD.id
       AND status = 'funding_initiated'
  ) INTO v_has_live_intent;

  -- A live PaymentIntent is deliberately left intact. Once the job commits as
  -- cancelled, confirm_funding_atomic returns job_terminal and the API/webhook
  -- refunds or cancels that Stripe intent. Pre-intent requests are closed here
  -- in the same transaction as the job.
  UPDATE public.funding_requests
     SET status = 'cancelled', updated_at = now()
   WHERE job_id = OLD.id
     AND status IN ('created', 'sent', 'funding_started', 'funding_failed');

  IF NOT v_has_live_intent THEN
    UPDATE public.escrow_payment_plans
       SET status = 'cancelled', updated_at = now()
     WHERE job_id = OLD.id
       AND status IN ('awaiting_customer_funding', 'funding_failed');

    UPDATE public.escrow_tranches et
       SET status = 'cancelled', updated_at = now()
     WHERE et.plan_id IN (
       SELECT ep.id
         FROM public.escrow_payment_plans ep
        WHERE ep.job_id = OLD.id
          AND ep.status = 'cancelled'
     )
       AND et.status IN ('pending_funding', 'funded', 'locked');
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_job_cancellation_against_funding()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_job_cancellation_against_funding_tg ON public.jobs;
CREATE TRIGGER guard_job_cancellation_against_funding_tg
  BEFORE UPDATE OF status ON public.jobs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'cancelled')
  EXECUTE FUNCTION public.guard_job_cancellation_against_funding();

CREATE OR REPLACE FUNCTION public.cascade_project_cancellation_to_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_job_status text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'cancelled'
     OR NEW.source_job_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status
    INTO v_job_status
    FROM public.jobs
   WHERE id = NEW.source_job_id
   FOR UPDATE;

  IF v_job_status IS NULL OR v_job_status = 'new' OR v_job_status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF v_job_status = 'completed' THEN
    RAISE EXCEPTION 'project_cancel_blocked_by_terminal_job: job % is completed', NEW.source_job_id
      USING ERRCODE = '23514';
  END IF;

  -- The job trigger above performs the funding guard/cascade while this project
  -- update is still inside the same database transaction.
  UPDATE public.jobs
     SET status = 'cancelled', updated_at = now()
   WHERE id = NEW.source_job_id
     AND status NOT IN ('completed', 'cancelled');

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.cascade_project_cancellation_to_job()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cascade_project_cancellation_to_job_tg ON public.projects;
CREATE TRIGGER cascade_project_cancellation_to_job_tg
  BEFORE UPDATE OF status ON public.projects
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'cancelled')
  EXECUTE FUNCTION public.cascade_project_cancellation_to_job();

CREATE OR REPLACE FUNCTION public.confirm_funding_atomic(
  p_funding_request_id uuid,
  p_escrow_plan_id     uuid DEFAULT NULL::uuid,
  p_payment_intent_id  text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now                timestamptz := now();
  v_hint_plan_id       uuid;
  v_hint_job_id        uuid;
  v_canonical_plan_id  uuid;
  v_job_id             uuid;
  v_plan_job_id        uuid;
  v_fr_status          text;
  v_ep_status          text;
  v_job_status         text;
  v_was_already_funded boolean := false;
  v_reconcile_funding  boolean := false;
  v_fr_updated         boolean := false;
  v_ep_updated         boolean := false;
  v_tranches_updated   integer := 0;
  v_pay_id             uuid;
  v_gross              numeric;
  v_fee                numeric;
  v_rate               numeric;
  v_cur                 text;
BEGIN
  -- Read relationship hints without locking, then acquire the canonical lock
  -- order. The relationship is re-read under lock before any write.
  SELECT escrow_plan_id, job_id
    INTO v_hint_plan_id, v_hint_job_id
    FROM public.funding_requests
   WHERE id = p_funding_request_id;

  IF v_hint_plan_id IS NULL OR v_hint_job_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'detail', 'funding_request not found or unlinked');
  END IF;

  SELECT status
    INTO v_job_status
    FROM public.jobs
   WHERE id = v_hint_job_id
   FOR UPDATE;

  IF v_job_status IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_state', 'detail', 'linked job not found');
  END IF;

  SELECT status, escrow_plan_id, job_id
    INTO v_fr_status, v_canonical_plan_id, v_job_id
    FROM public.funding_requests
   WHERE id = p_funding_request_id
   FOR UPDATE;

  IF v_fr_status IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'detail', 'funding_request not found');
  END IF;

  IF v_canonical_plan_id IS DISTINCT FROM v_hint_plan_id
     OR v_job_id IS DISTINCT FROM v_hint_job_id THEN
    RETURN jsonb_build_object('outcome', 'invalid_state', 'detail', 'funding relationship changed while locking');
  END IF;

  IF p_escrow_plan_id IS NOT NULL AND p_escrow_plan_id <> v_canonical_plan_id THEN
    RETURN jsonb_build_object('outcome', 'invalid_state', 'detail', 'provided escrow plan does not match funding_request');
  END IF;

  SELECT status, job_id
    INTO v_ep_status, v_plan_job_id
    FROM public.escrow_payment_plans
   WHERE id = v_canonical_plan_id
   FOR UPDATE;

  IF v_ep_status IS NULL OR v_plan_job_id IS DISTINCT FROM v_job_id THEN
    RETURN jsonb_build_object('outcome', 'invalid_state', 'detail', 'canonical escrow plan missing or linked to another job');
  END IF;

  v_was_already_funded := v_fr_status = 'funded';

  IF NOT v_was_already_funded THEN
    IF v_job_status IN ('cancelled', 'completed') THEN
      RETURN jsonb_build_object(
        'outcome', 'job_terminal',
        'detail', 'job is ' || v_job_status || ' — funding refused',
        'job_status', v_job_status
      );
    END IF;

    IF v_fr_status NOT IN ('created', 'sent', 'funding_started', 'funding_initiated') THEN
      RETURN jsonb_build_object(
        'outcome', 'invalid_state',
        'detail', 'funding_request in non-fundable state: ' || v_fr_status,
        'funding_request_status', v_fr_status
      );
    END IF;

    IF v_ep_status NOT IN ('awaiting_customer_funding', 'funding_initiated') THEN
      RETURN jsonb_build_object(
        'outcome', 'invalid_state',
        'detail', 'escrow plan in non-fundable state: ' || v_ep_status,
        'escrow_plan_status', v_ep_status
      );
    END IF;

    UPDATE public.funding_requests
       SET status = 'funded', funded_at = v_now, updated_at = v_now
     WHERE id = p_funding_request_id
       AND status IN ('created', 'sent', 'funding_started', 'funding_initiated');
    v_fr_updated := FOUND;
    v_reconcile_funding := true;
  ELSE
    IF v_job_status = 'cancelled' THEN
      RETURN jsonb_build_object(
        'outcome', 'invalid_state',
        'detail', 'funded request is linked to a cancelled job; operator reconciliation required'
      );
    END IF;

    IF v_ep_status IN ('cancelled', 'funding_failed') THEN
      RETURN jsonb_build_object(
        'outcome', 'invalid_state',
        'detail', 'funded request conflicts with escrow plan state: ' || v_ep_status,
        'escrow_plan_status', v_ep_status
      );
    END IF;

    -- Heal only the historical partial-confirm states. Later lifecycle states
    -- are already beyond funding and must never be rewound.
    v_reconcile_funding := v_ep_status IN (
      'awaiting_customer_funding', 'funding_initiated', 'funded_in_escrow'
    );
  END IF;

  IF v_reconcile_funding THEN
    IF v_ep_status IN ('awaiting_customer_funding', 'funding_initiated') THEN
      UPDATE public.escrow_payment_plans
         SET status = 'funded_in_escrow',
             funded_at = COALESCE(funded_at, v_now),
             external_funding_ref = COALESCE(p_payment_intent_id, external_funding_ref),
             updated_at = v_now
       WHERE id = v_canonical_plan_id
         AND status IN ('awaiting_customer_funding', 'funding_initiated');
      v_ep_updated := FOUND;
    END IF;

    UPDATE public.escrow_tranches
       SET status = 'funded', updated_at = v_now
     WHERE plan_id = v_canonical_plan_id
       AND status = 'pending_funding';
    GET DIAGNOSTICS v_tranches_updated = ROW_COUNT;

    SELECT total_amount, platform_fee_amount, platform_fee_rate,
           upper(COALESCE(currency, 'EUR'))
      INTO v_gross, v_fee, v_rate, v_cur
      FROM public.escrow_payment_plans
     WHERE id = v_canonical_plan_id;

    SELECT id INTO v_pay_id
      FROM public.payments
     WHERE job_id = v_job_id
     ORDER BY created_at ASC
     LIMIT 1;

    IF v_pay_id IS NOT NULL AND v_gross IS NOT NULL THEN
      v_fee := COALESCE(v_fee, round(v_gross * COALESCE(v_rate, 0), 2));
      INSERT INTO public.ledger_entries (
        payment_id, job_id, entry_type, amount, currency, metadata, movement_ref
      )
      VALUES
        (v_pay_id, v_job_id, 'escrow_deposit', v_gross, v_cur,
         jsonb_build_object('note', 'Treuhand-Einzahlung eingegangen', 'escrow_plan_id', v_canonical_plan_id::text),
         v_canonical_plan_id::text),
        (v_pay_id, v_job_id, 'platform_fee', v_fee, v_cur,
         jsonb_build_object('note', 'SaFix Plattformprovision', 'escrow_plan_id', v_canonical_plan_id::text, 'rate', v_rate),
         v_canonical_plan_id::text)
      ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'outcome', CASE WHEN v_was_already_funded THEN 'already_funded' ELSE 'confirmed' END,
    'funding_request_updated', v_fr_updated,
    'escrow_plan_updated', v_ep_updated,
    'tranches_updated', v_tranches_updated,
    'escrow_plan_id', v_canonical_plan_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
