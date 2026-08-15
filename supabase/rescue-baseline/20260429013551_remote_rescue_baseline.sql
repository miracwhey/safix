


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."_assert_caller_is_operator"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT public.is_current_user_operator() THEN
    RAISE EXCEPTION 'operator_required'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;


ALTER FUNCTION "public"."_assert_caller_is_operator"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_attribution_finalized_before_release"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_job_id     UUID;
  v_status     TEXT;
  v_origin     TEXT;
  v_dlq_reason TEXT;
  v_old_status TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM 'released' THEN
    RETURN NEW;
  END IF;

  v_old_status := CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END;

  IF v_old_status IS NOT DISTINCT FROM 'released' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'escrow_tranches' THEN
    IF NEW.plan_id IS NULL THEN
      RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: missing_plan_id'
        USING ERRCODE = 'P0004',
              DETAIL  = 'escrow_tranches.plan_id is required to resolve the owning job.';
    END IF;

    SELECT job_id INTO v_job_id
    FROM public.escrow_payment_plans
    WHERE id = NEW.plan_id;

    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: plan_not_found_or_missing_job'
        USING ERRCODE = 'P0004',
              DETAIL  = format('plan_id=%L has no owning job_id', NEW.plan_id);
    END IF;

  ELSIF TG_TABLE_NAME = 'supplementary_payment_requests' THEN
    v_job_id := NEW.job_id;

    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: missing_job_id'
        USING ERRCODE = 'P0004',
              DETAIL  = 'supplementary_payment_requests.job_id is required.';
    END IF;

  ELSE
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: trigger_misconfigured'
      USING ERRCODE = 'P0004',
            DETAIL  = format('trigger on unknown table %I', TG_TABLE_NAME);
  END IF;

  SELECT attribution_status, commercial_origin, attribution_dlq_reason
  INTO v_status, v_origin, v_dlq_reason
  FROM public.jobs
  WHERE id = v_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: job_not_found'
      USING ERRCODE = 'P0004',
            DETAIL  = format('job_id=%L', v_job_id);
  END IF;

  IF v_status = 'dlq' THEN
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: dlq'
      USING ERRCODE = 'P0004',
            DETAIL  = format('job_id=%L dlq_reason=%L', v_job_id, COALESCE(v_dlq_reason, 'null'));
  END IF;

  IF v_status IS DISTINCT FROM 'finalized' THEN
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: unresolved'
      USING ERRCODE = 'P0004',
            DETAIL  = format('job_id=%L attribution_status=%L', v_job_id, COALESCE(v_status, 'null'));
  END IF;

  IF v_origin IS DISTINCT FROM 'merchant_brought' AND v_origin IS DISTINCT FROM 'platform_acquired' THEN
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: origin_invalid'
      USING ERRCODE = 'P0004',
            DETAIL  = format('job_id=%L commercial_origin=%L', v_job_id, COALESCE(v_origin, 'null'));
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assert_attribution_finalized_before_release"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."assert_attribution_finalized_before_release"() IS 'DB-level defense: blocks any transition into status=released on escrow_tranches or supplementary_payment_requests when the owning jobs row has attribution_status != finalized or an invalid commercial_origin. Raises SQLSTATE P0004 with ATTRIBUTION_NOT_FINALIZED: prefix.';



CREATE OR REPLACE FUNCTION "public"."become_provider"("p_company_name" "text" DEFAULT NULL::"text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
begin
  -- muss eingeloggt sein
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Rolle im Profile setzen
  update public.profiles
  set role = 'provider'
  where id = auth.uid();

  -- Provider-Row anlegen (falls noch nicht existiert)
  insert into public.providers (id, company_name, description)
  values (auth.uid(), p_company_name, p_description)
  on conflict (id) do update
    set company_name = coalesce(excluded.company_name, public.providers.company_name),
        description  = coalesce(excluded.description,  public.providers.description);
end;
$$;


ALTER FUNCTION "public"."become_provider"("p_company_name" "text", "p_description" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_funding_atomic"("p_funding_request_id" "uuid", "p_escrow_plan_id" "uuid" DEFAULT NULL::"uuid", "p_payment_intent_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_now             TIMESTAMPTZ := now();
  v_fr_status       TEXT;
  v_ep_status       TEXT;
  v_fr_updated      BOOLEAN := FALSE;
  v_ep_updated      BOOLEAN := FALSE;
  v_tranches_updated INT := 0;
BEGIN
  -- ── 0. Lock + read funding_request status ──────────────────────────────
  SELECT status INTO v_fr_status
  FROM funding_requests
  WHERE id = p_funding_request_id
  FOR UPDATE;

  IF v_fr_status IS NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'not_found',
      'detail', 'funding_request not found'
    );
  END IF;

  -- Already funded → idempotent success (no changes needed)
  IF v_fr_status = 'funded' THEN
    RETURN jsonb_build_object(
      'outcome', 'already_funded',
      'funding_request_status', v_fr_status
    );
  END IF;

  -- Status guard: only advance from pre-funded states
  IF v_fr_status NOT IN ('created', 'sent', 'funding_started', 'funding_initiated') THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_state',
      'detail', 'funding_request in non-fundable state: ' || v_fr_status,
      'funding_request_status', v_fr_status
    );
  END IF;

  -- ── 1. Update funding_requests → 'funded' ─────────────────────────────
  UPDATE funding_requests
  SET status     = 'funded',
      funded_at  = v_now,
      updated_at = v_now
  WHERE id = p_funding_request_id
    AND status IN ('created', 'sent', 'funding_started', 'funding_initiated');

  v_fr_updated := FOUND;

  -- ── 2. Update escrow_payment_plans → 'funded_in_escrow' ───────────────
  IF p_escrow_plan_id IS NOT NULL THEN
    SELECT status INTO v_ep_status
    FROM escrow_payment_plans
    WHERE id = p_escrow_plan_id
    FOR UPDATE;

    IF v_ep_status IN ('awaiting_customer_funding', 'funding_initiated') THEN
      UPDATE escrow_payment_plans
      SET status              = 'funded_in_escrow',
          funded_at           = v_now,
          external_funding_ref = COALESCE(p_payment_intent_id, external_funding_ref),
          updated_at          = v_now
      WHERE id = p_escrow_plan_id
        AND status IN ('awaiting_customer_funding', 'funding_initiated');

      v_ep_updated := FOUND;
    END IF;
    -- If plan is already funded_in_escrow / partially_released / fully_released → no-op (idempotent)

    -- ── 3. Update pending_funding tranches → 'funded' ────────────────────
    UPDATE escrow_tranches
    SET status     = 'funded',
        updated_at = v_now
    WHERE plan_id = p_escrow_plan_id
      AND status = 'pending_funding';

    GET DIAGNOSTICS v_tranches_updated = ROW_COUNT;
  END IF;

  -- ── Return result ──────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'outcome', 'confirmed',
    'funding_request_updated', v_fr_updated,
    'escrow_plan_updated', v_ep_updated,
    'tranches_updated', v_tranches_updated
  );
END;
$$;


ALTER FUNCTION "public"."confirm_funding_atomic"("p_funding_request_id" "uuid", "p_escrow_plan_id" "uuid", "p_payment_intent_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."disputes_status_change_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.status            IS NOT DISTINCT FROM OLD.status
     AND NEW.decision        IS NOT DISTINCT FROM OLD.decision
     AND NEW.resolution_type IS NOT DISTINCT FROM OLD.resolution_type
     AND NEW.split_ratio     IS NOT DISTINCT FROM OLD.split_ratio
     AND NEW.settlement_status IS NOT DISTINCT FROM OLD.settlement_status
     AND NEW.resolved_at     IS NOT DISTINCT FROM OLD.resolved_at
     AND NEW.closed_at       IS NOT DISTINCT FROM OLD.closed_at
  THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_current_user_operator() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unauthorized: only operators can change dispute lifecycle fields'
    USING ERRCODE = '42501';
END;
$$;


ALTER FUNCTION "public"."disputes_status_change_guard"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."disputes_status_change_guard"() IS 'Block 5.6 — guards status/decision/resolution_type/split_ratio/settlement_status/resolved_at/closed_at against direct mutations by non-operator authenticated callers.';



CREATE OR REPLACE FUNCTION "public"."ensure_subscription_row"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_craftsman_role text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT role, craftsman_role INTO v_role, v_craftsman_role FROM profiles WHERE id = v_caller;
  IF v_role IS DISTINCT FROM 'craftsman' OR v_craftsman_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  INSERT INTO craftsman_subscriptions (profile_id, status) VALUES (v_caller, 'trial_available')
  ON CONFLICT (profile_id) DO NOTHING;
END;
$$;


ALTER FUNCTION "public"."ensure_subscription_row"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text" DEFAULT NULL::"text", "p_actor" "text" DEFAULT 'system'::"text", "p_refunded_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_payment_id     TEXT;
  v_payment_status TEXT;
  v_project_id     TEXT;
  v_now            TIMESTAMPTZ := clock_timestamp();
BEGIN
  -- ── 1. Validate target state parameter ────────────────────────────────────
  IF p_target_state NOT IN ('released', 'refunded') THEN
    RAISE EXCEPTION 'invalid_target_state: % is not a terminal payment state (released | refunded)',
      p_target_state
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 2. Lock payment row ───────────────────────────────────────────────────
  -- Blocking lock — concurrent open_dispute_atomic or a duplicate release call
  -- will wait here rather than racing.  The lock serializes both paths and lets
  -- the state-machine validation (step 3) detect the race and reject.
  SELECT id, status
    INTO v_payment_id, v_payment_status
    FROM public.payments
   WHERE job_id = p_job_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found: no payment record for job %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ── 2b. Authorization check ────────────────────────────────────────────────
  -- Authenticated callers (auth.uid() IS NOT NULL) must be a participant in the job.
  -- Webhooks and crons run as service_role where auth.uid() IS NULL — exempt.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.jobs
       WHERE id = p_job_id
         AND (customer_user_id = auth.uid()::text
              OR craftsman_user_id = auth.uid()::text)
    ) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a participant in job %', p_job_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ── 3. Idempotent guard ───────────────────────────────────────────────────
  IF v_payment_status = p_target_state THEN
    RETURN jsonb_build_object(
      'idempotent', TRUE,
      'state',      p_target_state,
      'paymentId',  v_payment_id
    );
  END IF;

  -- ── 4. State-machine validation ───────────────────────────────────────────
  IF p_target_state = 'released' AND v_payment_status NOT IN (
    'release_pending', 'disputed'
  ) THEN
    RAISE EXCEPTION 'invalid_transition: cannot finalize payment from % to released (job %)',
      v_payment_status, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_target_state = 'refunded' AND v_payment_status NOT IN (
    'deposit_paid', 'in_escrow', 'release_pending', 'disputed'
  ) THEN
    RAISE EXCEPTION 'invalid_transition: cannot finalize payment from % to refunded (job %)',
      v_payment_status, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 5. Dispute guard (release without dispute bypass) ─────────────────────
  -- For non-dispute releases (p_dispute_id IS NULL), refuse to finalize if any
  -- active dispute exists.  The FOR UPDATE lock acquired above ensures no
  -- concurrent open_dispute_atomic can insert a dispute between this check and
  -- the UPDATE below.
  IF p_target_state = 'released' AND p_dispute_id IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM public.disputes
       WHERE job_id = p_job_id
         AND status IN ('open', 'awaiting_evidence', 'under_review')
    ) THEN
      RAISE EXCEPTION 'release_blocked_by_dispute: active dispute exists for job % — resolve before releasing',
        p_job_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 5b. Validate supplied dispute_id ──────────────────────────────────────
  -- When p_dispute_id is supplied (dispute-bypass path), verify it actually
  -- exists and belongs to this job.  Without this check any job participant
  -- could pass an arbitrary UUID to bypass step 5's active-dispute guard.
  IF p_dispute_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.disputes
       WHERE id      = p_dispute_id
         AND job_id  = p_job_id
    ) THEN
      RAISE EXCEPTION 'invalid_dispute_id: dispute % does not exist or does not belong to job %',
        p_dispute_id, p_job_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 6. Update payments ────────────────────────────────────────────────────
  UPDATE public.payments
     SET status          = p_target_state,
         refunded_amount = COALESCE(p_refunded_amount, refunded_amount),
         updated_at      = v_now
   WHERE job_id = p_job_id;

  -- ── 7. Update jobs: payment_state + status (waiting_payment → completed) ──
  UPDATE public.jobs
     SET payment_state = p_target_state,
         status        = CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END,
         updated_at    = v_now
   WHERE id = p_job_id;

  -- ── 8. Update linked project (if any) ─────────────────────────────────────
  SELECT project_id
    INTO v_project_id
    FROM public.jobs
   WHERE id = p_job_id;

  IF v_project_id IS NOT NULL AND v_project_id != '' THEN
    UPDATE public.projects
       SET payment_state = p_target_state,
           updated_at    = v_now
     WHERE id = v_project_id;
  END IF;

  -- ── 9. Return result ──────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'idempotent',   FALSE,
    'state',        p_target_state,
    'paymentId',    v_payment_id,
    'jobId',        p_job_id,
    'projectId',    v_project_id,
    'actor',        p_actor,
    'finalizedAt',  (EXTRACT(EPOCH FROM v_now) * 1000)::BIGINT
  );
END;
$$;


ALTER FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) IS 'v2: Adds dispute_id validation — supplied dispute must exist and belong to the job. Atomically commits released|refunded state across payments, jobs, and projects in a single transaction after a Stripe operation has succeeded. Acquires a row-level lock on the payment to serialize concurrent dispute opens. Called by SupabasePaymentRepository.finalizeStateAtomic() after provider success.';



CREATE OR REPLACE FUNCTION "public"."fn_update_thread_last_message"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.message_threads
  SET    last_message_at   = NEW.created_at,
         last_message_body = LEFT(NEW.body, 200),
         updated_at        = NEW.created_at
  WHERE  id = NEW.thread_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_update_thread_last_message"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_invoice_number"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NEW.status = 'issued'
    AND OLD.status = 'draft'
    AND (OLD.invoice_number IS NULL OR OLD.invoice_number = '')
  THEN
    NEW.invoice_number :=
      'FX-' ||
      EXTRACT(YEAR FROM NOW())::int ||
      '-' ||
      LPAD(nextval('invoice_number_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."generate_invoice_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_thread_id       uuid;
  v_provider_id     uuid;
  v_title           text;
  v_caller_id       text;
  v_assigned_ids    text[];
BEGIN
  SELECT tm.id::text,
         ce.provider_id,
         ce.title,
         ce.assigned_member_ids
  INTO   v_caller_id,
         v_provider_id,
         v_title,
         v_assigned_ids
  FROM   public.calendar_entries ce
  JOIN   public.team_members     tm
    ON   tm.profile_id  = auth.uid()
   AND   tm.provider_id = ce.provider_id
  WHERE  ce.id = p_calendar_entry_id
  LIMIT  1;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller is not a team member of this entry''s company';
  END IF;

  SELECT id INTO v_thread_id
  FROM   public.message_threads
  WHERE  calendar_entry_id = p_calendar_entry_id;

  IF v_thread_id IS NOT NULL THEN
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    VALUES (v_thread_id, v_caller_id)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;

    RETURN v_thread_id;
  END IF;

  INSERT INTO public.message_threads (
    provider_id,
    thread_type,
    calendar_entry_id,
    created_by_team_member_id,
    title
  )
  VALUES (
    v_provider_id,
    'assignment',
    p_calendar_entry_id,
    v_caller_id,
    v_title
  )
  ON CONFLICT (calendar_entry_id) DO NOTHING
  RETURNING id INTO v_thread_id;

  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.message_threads
    WHERE  calendar_entry_id = p_calendar_entry_id;
  END IF;

  IF v_assigned_ids IS NOT NULL AND array_length(v_assigned_ids, 1) > 0 THEN
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    SELECT v_thread_id, unnest(v_assigned_ids)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;
  END IF;

  INSERT INTO public.message_thread_participants (thread_id, team_member_id)
  SELECT v_thread_id, tm.id::text
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
    AND  tm.role IN ('owner', 'admin')
  ON CONFLICT (thread_id, team_member_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_office_thread"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_thread_id   uuid;
  v_provider_id uuid;
  v_caller_id   text;
BEGIN
  SELECT tm.id::text, tm.provider_id
  INTO   v_caller_id, v_provider_id
  FROM   public.team_members tm
  WHERE  tm.profile_id = auth.uid()
  LIMIT  1;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row';
  END IF;

  SELECT id INTO v_thread_id
  FROM   public.message_threads
  WHERE  provider_id = v_provider_id
    AND  thread_type = 'office';

  IF v_thread_id IS NOT NULL THEN
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    VALUES (v_thread_id, v_caller_id)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;
    RETURN v_thread_id;
  END IF;

  INSERT INTO public.message_threads (
    provider_id, thread_type, created_by_team_member_id, title
  )
  VALUES (v_provider_id, 'office', v_caller_id, 'Büro')
  ON CONFLICT (provider_id, thread_type) WHERE thread_type IN ('office', 'team') DO NOTHING
  RETURNING id INTO v_thread_id;

  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.message_threads
    WHERE  provider_id = v_provider_id AND thread_type = 'office';
  END IF;

  INSERT INTO public.message_thread_participants (thread_id, team_member_id)
  SELECT v_thread_id, tm.id::text
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
  ON CONFLICT (thread_id, team_member_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."get_or_create_office_thread"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_team_thread"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_thread_id   uuid;
  v_provider_id uuid;
  v_caller_id   text;
BEGIN
  SELECT tm.id::text, tm.provider_id
  INTO   v_caller_id, v_provider_id
  FROM   public.team_members tm
  WHERE  tm.profile_id = auth.uid()
  LIMIT  1;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row';
  END IF;

  SELECT id INTO v_thread_id
  FROM   public.message_threads
  WHERE  provider_id = v_provider_id
    AND  thread_type = 'team';

  IF v_thread_id IS NOT NULL THEN
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    VALUES (v_thread_id, v_caller_id)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;
    RETURN v_thread_id;
  END IF;

  INSERT INTO public.message_threads (
    provider_id, thread_type, created_by_team_member_id, title
  )
  VALUES (v_provider_id, 'team', v_caller_id, 'Team')
  ON CONFLICT (provider_id, thread_type) WHERE thread_type IN ('office', 'team') DO NOTHING
  RETURNING id INTO v_thread_id;

  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.message_threads
    WHERE  provider_id = v_provider_id AND thread_type = 'team';
  END IF;

  INSERT INTO public.message_thread_participants (thread_id, team_member_id)
  SELECT v_thread_id, tm.id::text
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
  ON CONFLICT (thread_id, team_member_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."get_or_create_team_thread"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE
    AS $$
  select public_url
  from public.provider_media
  where provider_id = p_provider_id
    and kind = 'avatar'
  order by created_at desc
  limit 1;
$$;


ALTER FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") RETURNS TABLE("id" "uuid", "provider_id" "uuid", "kind" "text", "public_url" "text", "caption" "text", "sort_order" integer)
    LANGUAGE "sql" STABLE
    AS $$
  select
    id,
    provider_id,
    kind,
    public_url,
    caption,
    sort_order
  from public.provider_media
  where provider_id = p_provider_id
  order by sort_order asc, created_at asc;
$$;


ALTER FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") RETURNS TABLE("id" "uuid", "public_url" "text", "caption" "text", "sort_order" integer)
    LANGUAGE "sql" STABLE
    AS $$
  select
    id,
    public_url,
    caption,
    sort_order
  from public.provider_media
  where provider_id = p_provider_id
    and kind = 'portfolio'
  order by sort_order asc, created_at asc;
$$;


ALTER FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  select exists (
    select 1 from public.user_blocks
    where (blocker_id = user_a and blocked_id = user_b)
       or (blocker_id = user_b and blocked_id = user_a)
  );
$$;


ALTER FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") IS 'Returns true if either user has blocked the other. Use to filter content visibility.';



CREATE OR REPLACE FUNCTION "public"."is_current_user_operator"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_operator = true
  );
$$;


ALTER FUNCTION "public"."is_current_user_operator"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_code_row  RECORD;
BEGIN
  SELECT "id", "provider_id", "target_role"
  INTO v_code_row
  FROM "company_join_codes"
  WHERE "code"      = UPPER(TRIM(p_code))
    AND "is_active" = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'Code ungültig oder abgelaufen.',
      'code',  'invalid_code'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM "team_members"
    WHERE "provider_id" = v_code_row."provider_id"
      AND "profile_id"  = "auth"."uid"()
  ) THEN
    RETURN jsonb_build_object(
      'ok',          true,
      'provider_id', v_code_row."provider_id"
    );
  END IF;

  INSERT INTO "team_members" (
    "provider_id",
    "profile_id",
    "full_name",
    "role",
    "is_active"
  )
  VALUES (
    v_code_row."provider_id",
    "auth"."uid"(),
    COALESCE(NULLIF(TRIM(p_full_name), ''), 'Mitarbeiter'),
    v_code_row."target_role",
    true
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'ok',          true,
    'provider_id', v_code_row."provider_id"
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'ok',    false,
    'error', 'Beitritt fehlgeschlagen. Bitte versuche es erneut.',
    'code',  'unknown'
  );
END;
$$;


ALTER FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text" DEFAULT NULL::"text", "p_payment_id" "uuid" DEFAULT NULL::"uuid", "p_metadata" "jsonb" DEFAULT '{}'::"jsonb", "p_context_snapshot" "jsonb" DEFAULT NULL::"jsonb", "p_opened_at" timestamp with time zone DEFAULT "now"()) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid                  uuid := auth.uid();
  v_payment_status       text;
  v_payment_id_uuid      uuid;
  v_customer_profile_id  uuid;
  v_provider_id          uuid;
  v_is_operator          boolean := false;
  v_is_customer          boolean := false;
  v_is_provider          boolean := false;
  v_is_party             boolean := false;
  v_now                  timestamptz := COALESCE(p_opened_at, now());
  v_raised_by            text;
  v_dispute_json         jsonb;
BEGIN
  v_raised_by := CASE
    WHEN v_uid IS NOT NULL THEN v_uid::text
    ELSE p_raised_by
  END;

  SELECT j.customer_profile_id,
         j.provider_id
    INTO v_customer_profile_id, v_provider_id
    FROM public.jobs j
   WHERE j.id = p_job_id
   FOR UPDATE;

  IF v_customer_profile_id IS NULL AND v_provider_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id) THEN
      RAISE EXCEPTION 'job_not_found: %', p_job_id
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF v_uid IS NOT NULL THEN
    v_is_operator := public.is_current_user_operator();

    SELECT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = p_job_id
        AND (j.customer_user_id = v_uid OR j.customer_profile_id = v_uid)
    ) INTO v_is_customer;

    SELECT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = p_job_id
        AND (
          j.craftsman_user_id = v_uid::text
          OR j.provider_id IN (
            SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
          )
        )
    ) INTO v_is_provider;

    v_is_party := v_is_operator OR v_is_customer OR v_is_provider;

    IF NOT v_is_party THEN
      RAISE EXCEPTION 'unauthorized: caller is not a participant in job %', p_job_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.disputes
    WHERE job_id = p_job_id
      AND status IN ('open','under_review','customer_waiting','provider_waiting')
  ) THEN
    RAISE EXCEPTION 'active_dispute_exists: job %', p_job_id
      USING ERRCODE = '23505';
  END IF;

  IF p_payment_id IS NOT NULL THEN
    SELECT status::text INTO v_payment_status
      FROM public.payments
     WHERE id = p_payment_id
     FOR UPDATE;
  ELSE
    SELECT status::text, id INTO v_payment_status, v_payment_id_uuid
      FROM public.payments
     WHERE job_id::text = p_job_id::text
     FOR UPDATE;
    IF v_payment_id_uuid IS NOT NULL THEN
      p_payment_id := v_payment_id_uuid;
    END IF;
  END IF;

  IF v_payment_status IS NOT NULL
     AND v_payment_status NOT IN ('in_escrow','work_in_progress','release_pending','disputed')
  THEN
    RAISE EXCEPTION 'payment_invalid_for_dispute: current status is %, cannot transition to disputed',
      v_payment_status
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.disputes (
    id, job_id, payment_id, opened_by_profile_id, customer_profile_id, provider_id,
    status, reason, description, raised_by, metadata, context_snapshot,
    opened_at, created_at, updated_at
  ) VALUES (
    p_dispute_id, p_job_id, p_payment_id, v_uid, v_customer_profile_id, v_provider_id,
    'open', p_reason, p_description, v_raised_by, COALESCE(p_metadata, '{}'::jsonb), p_context_snapshot,
    v_now, v_now, v_now
  );

  IF v_payment_status IS NOT NULL AND v_payment_status <> 'disputed' THEN
    UPDATE public.payments
       SET status     = 'disputed',
           updated_at = now()
     WHERE (p_payment_id IS NOT NULL AND id = p_payment_id)
        OR (p_payment_id IS NULL     AND job_id::text = p_job_id::text);
  END IF;

  UPDATE public.jobs
     SET dispute_status = 'open'
   WHERE id = p_job_id;

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, p_job_id, NULL, 'open', 'system', NULL,
    jsonb_build_object(
      'reason',               p_reason,
      'raised_by',            v_raised_by,
      'payment_id',           p_payment_id,
      'opened_by_profile_id', v_uid,
      'context_snapshot',     p_context_snapshot
    ),
    v_now
  );

  SELECT row_to_json(d)::jsonb INTO v_dispute_json
    FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_dispute_json;
END;
$$;


ALTER FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) IS 'Block 5.6 v2: opens a dispute atomically using the gamma schema (uuid + timestamptz + jsonb metadata).';



CREATE OR REPLACE FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status = 'under_review' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  IF v_from_status NOT IN ('open','customer_waiting','provider_waiting') THEN
    RAISE EXCEPTION 'invalid_dispute_status: under_review requires status in (open,customer_waiting,provider_waiting), got %',
      v_from_status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.disputes SET status = 'under_review', updated_at = v_now WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'under_review', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id), v_now);
  UPDATE public.jobs SET dispute_status = 'under_review' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: reject got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.disputes
     SET status            = 'resolved',
         decision           = 'reject',
         resolution_type    = 'rejected',
         settlement_status  = 'settled',
         resolved_at        = COALESCE(resolved_at, v_now),
         updated_at         = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'reject', 'resolution_type', 'rejected'), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status = 'customer_waiting' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  IF v_from_status NOT IN ('open','under_review') THEN
    RAISE EXCEPTION 'invalid_dispute_status: customer_waiting requires status in (open,under_review), got %',
      v_from_status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.disputes SET status = 'customer_waiting', updated_at = v_now WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'customer_waiting', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'requested_party', 'customer'), v_now);
  UPDATE public.jobs SET dispute_status = 'customer_waiting' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status = 'provider_waiting' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  IF v_from_status NOT IN ('open','under_review') THEN
    RAISE EXCEPTION 'invalid_dispute_status: provider_waiting requires status in (open,under_review), got %',
      v_from_status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.disputes SET status = 'provider_waiting', updated_at = v_now WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'provider_waiting', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'requested_party', 'provider'), v_now);
  UPDATE public.jobs SET dispute_status = 'provider_waiting' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_current_status TEXT;
  v_current_origin TEXT;
  v_new_status     TEXT;
  v_new_origin     TEXT;
  v_event_type     TEXT;
  v_is_operator    BOOLEAN;
  v_normalized_reason TEXT;
BEGIN
  v_normalized_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');

  IF p_operator_id IS NULL THEN
    RAISE EXCEPTION 'unauthorized: operator_id required'
      USING ERRCODE = '42501';
  END IF;

  SELECT is_operator
    INTO v_is_operator
    FROM public.profiles
   WHERE id = p_operator_id;

  IF NOT COALESCE(v_is_operator, FALSE) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an operator'
      USING ERRCODE = '42501';
  END IF;

  IF p_mode NOT IN ('resolve', 'reclassify', 'reject') THEN
    RAISE EXCEPTION 'invalid_mode: %', p_mode
      USING ERRCODE = 'P0001';
  END IF;

  IF v_normalized_reason IS NULL THEN
    RAISE EXCEPTION 'reason_required: every operator action must carry a note'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_mode IN ('resolve', 'reclassify') THEN
    IF p_to_origin IS NULL OR p_to_origin NOT IN ('merchant_brought', 'platform_acquired') THEN
      RAISE EXCEPTION 'invalid_to_origin: must be merchant_brought or platform_acquired'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_mode = 'reject' THEN
    IF p_to_origin IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_to_origin: reject must not carry an origin'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT attribution_status, commercial_origin
    INTO v_current_status, v_current_origin
    FROM public.jobs
   WHERE id = p_job_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found: %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;

  IF p_mode = 'resolve' THEN
    IF v_current_status NOT IN ('pending', 'retrying', 'dlq') THEN
      RAISE EXCEPTION 'invalid_transition: resolve requires pending|retrying|dlq, got %',
        v_current_status USING ERRCODE = 'P0001';
    END IF;
    v_new_status := 'finalized';
    v_new_origin := p_to_origin;
    v_event_type := 'operator_resolve';

  ELSIF p_mode = 'reclassify' THEN
    IF v_current_status IS DISTINCT FROM 'finalized' THEN
      RAISE EXCEPTION 'invalid_transition: reclassify requires finalized, got %',
        v_current_status USING ERRCODE = 'P0001';
    END IF;
    v_new_status := 'finalized';
    v_new_origin := p_to_origin;
    v_event_type := 'operator_reclassify';

  ELSIF p_mode = 'reject' THEN
    IF v_current_status NOT IN ('pending', 'retrying', 'dlq') THEN
      RAISE EXCEPTION 'invalid_transition: reject requires pending|retrying|dlq, got %',
        v_current_status USING ERRCODE = 'P0001';
    END IF;
    v_new_status := 'dlq';
    v_new_origin := NULL;
    v_event_type := 'dlq_entered';
  END IF;

  IF p_mode = 'reject' THEN
    UPDATE public.jobs
       SET attribution_status        = v_new_status,
           attribution_dlq_reason    = v_normalized_reason,
           attribution_last_retry_at = clock_timestamp()
     WHERE id = p_job_id;
  ELSE
    UPDATE public.jobs
       SET attribution_status        = v_new_status,
           commercial_origin         = v_new_origin,
           attribution_dlq_reason    = NULL,
           attribution_last_retry_at = clock_timestamp()
     WHERE id = p_job_id;
  END IF;

  INSERT INTO public.attribution_audit_log (
    job_id, event_type, from_status, to_status,
    from_origin, to_origin, operator_id, reason
  ) VALUES (
    p_job_id, v_event_type, v_current_status, v_new_status,
    v_current_origin, v_new_origin, p_operator_id, v_normalized_reason
  );

  RETURN jsonb_build_object(
    'outcome',     'resolved',
    'mode',        p_mode,
    'jobId',       p_job_id,
    'fromStatus',  v_current_status,
    'toStatus',    v_new_status,
    'fromOrigin',  v_current_origin,
    'toOrigin',    v_new_origin
  );
END;
$$;


ALTER FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") IS 'Operator RPC — moves a job out of DLQ, reclassifies a finalized origin, or re-affirms a DLQ row with a new operator note. Validates operator flag, transition matrix, reason presence. Writes attribution_audit_log atomically. SERVICE_ROLE only. Reject on dlq (since 20260420000005) keeps the row frozen but records the operator review.';



CREATE OR REPLACE FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text", "p_refund_amount" numeric DEFAULT NULL::numeric, "p_release_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id      uuid;
  v_from_status      text;
  v_job_id           uuid;
  v_resolution_type  text;
  v_now              timestamptz := now();
  v_result           jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_refund got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  v_resolution_type := CASE WHEN p_release_amount IS NULL OR p_release_amount = 0 THEN 'refund_full' ELSE 'refund_partial' END;
  UPDATE public.disputes
     SET status                 = 'resolved',
         decision               = 'refund',
         resolution_type        = v_resolution_type,
         settlement_status      = 'pending',
         refund_amount          = COALESCE(p_refund_amount,  refund_amount),
         release_amount         = COALESCE(p_release_amount, release_amount),
         customer_refund_amount = COALESCE(p_refund_amount,  customer_refund_amount),
         provider_award_amount  = COALESCE(p_release_amount, provider_award_amount),
         resolved_at            = COALESCE(resolved_at, v_now),
         updated_at             = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'refund', 'resolution_type', v_resolution_type, 'refund_amount', p_refund_amount, 'release_amount', p_release_amount), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text", "p_refund_amount" numeric, "p_release_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text", "p_release_amount" numeric DEFAULT NULL::numeric, "p_refund_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id      uuid;
  v_from_status      text;
  v_job_id           uuid;
  v_resolution_type  text;
  v_now              timestamptz := now();
  v_result           jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_release got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  v_resolution_type := CASE WHEN p_refund_amount IS NULL OR p_refund_amount = 0 THEN 'release_full' ELSE 'release_partial' END;
  UPDATE public.disputes
     SET status                 = 'resolved',
         decision               = 'release',
         resolution_type        = v_resolution_type,
         settlement_status      = 'pending',
         release_amount         = COALESCE(p_release_amount, release_amount),
         refund_amount          = COALESCE(p_refund_amount,  refund_amount),
         provider_award_amount  = COALESCE(p_release_amount, provider_award_amount),
         customer_refund_amount = COALESCE(p_refund_amount,  customer_refund_amount),
         resolved_at            = COALESCE(resolved_at, v_now),
         updated_at             = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'release', 'resolution_type', v_resolution_type, 'release_amount', p_release_amount, 'refund_amount', p_refund_amount), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text", "p_release_amount" numeric, "p_refund_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text" DEFAULT NULL::"text", "p_provider_award_amount" numeric DEFAULT NULL::numeric, "p_customer_refund_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  IF p_split_ratio IS NULL OR p_split_ratio < 0 OR p_split_ratio > 1 THEN
    RAISE EXCEPTION 'invalid_split_ratio: must be in [0,1], got %', p_split_ratio USING ERRCODE = 'P0001';
  END IF;
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_split got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.disputes
     SET status                 = 'resolved',
         decision               = 'split',
         resolution_type        = 'split',
         split_ratio            = p_split_ratio,
         settlement_status      = 'pending',
         provider_award_amount  = COALESCE(p_provider_award_amount,  provider_award_amount),
         customer_refund_amount = COALESCE(p_customer_refund_amount, customer_refund_amount),
         release_amount         = COALESCE(p_provider_award_amount,  release_amount),
         refund_amount          = COALESCE(p_customer_refund_amount, refund_amount),
         resolved_at            = COALESCE(resolved_at, v_now),
         updated_at             = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'split', 'resolution_type', 'split', 'split_ratio', p_split_ratio, 'provider_award_amount', p_provider_award_amount, 'customer_refund_amount', p_customer_refund_amount), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text", "p_provider_award_amount" numeric, "p_customer_refund_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_transfer_reversal_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_reversal_ref" "text", "p_reversed_at" timestamp with time zone DEFAULT "now"()) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_existing_reversal_ref text;
  v_plan_status           text;
  v_tranche_count         int;
  v_released_count        int;
BEGIN
  SELECT transfer_reversal_ref
  INTO v_existing_reversal_ref
  FROM escrow_tranches
  WHERE id = p_tranche_id AND plan_id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_existing_reversal_ref IS NOT DISTINCT FROM p_reversal_ref THEN
    RETURN jsonb_build_object('outcome', 'already_recorded');
  END IF;

  UPDATE escrow_tranches
  SET
    transfer_reversal_ref = p_reversal_ref,
    updated_at            = p_reversed_at
  WHERE id = p_tranche_id
    AND plan_id = p_plan_id;

  -- Recompute plan status: reversed tranches do not count as released.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'released' AND transfer_reversal_ref IS NULL)
  INTO v_tranche_count, v_released_count
  FROM escrow_tranches
  WHERE plan_id = p_plan_id;

  IF v_tranche_count > 0 AND v_tranche_count = v_released_count THEN
    v_plan_status := 'fully_released';
  ELSIF v_released_count > 0 THEN
    v_plan_status := 'partially_released';
  ELSE
    v_plan_status := 'funded_in_escrow';
  END IF;

  UPDATE escrow_payment_plans
  SET
    status     = v_plan_status,
    updated_at = now()
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'outcome',        'reversed',
    'plan_status',    v_plan_status,
    'tranche_count',  v_tranche_count,
    'released_count', v_released_count
  );
END;
$$;


ALTER FUNCTION "public"."reconcile_transfer_reversal_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_reversal_ref" "text", "p_reversed_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_tranche_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone DEFAULT "now"()) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_existing_ref   text;
  v_plan_status    text;
  v_tranche_count  int;
  v_released_count int;
BEGIN
  -- Read the current external_release_ref to detect already-idempotent calls.
  SELECT external_release_ref
  INTO v_existing_ref
  FROM escrow_tranches
  WHERE id = p_tranche_id AND plan_id = p_plan_id
  FOR UPDATE;  -- Row lock: prevents concurrent releases of the same tranche.

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- If this exact transfer ID is already recorded, the write is fully idempotent.
  -- Still recompute and update the plan status in case that write was missed.
  IF v_existing_ref IS DISTINCT FROM p_transfer_id THEN
    UPDATE escrow_tranches
    SET
      status               = 'released',
      released_at          = p_released_at,
      released_by          = p_actor,
      external_release_ref = p_transfer_id,
      updated_at           = now()
    WHERE id = p_tranche_id
      AND plan_id = p_plan_id;
  END IF;

  -- Read all tranches for the plan within the same transaction.
  -- Sees the updated state of the row above.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'released')
  INTO v_tranche_count, v_released_count
  FROM escrow_tranches
  WHERE plan_id = p_plan_id;

  IF v_tranche_count > 0 AND v_tranche_count = v_released_count THEN
    v_plan_status := 'fully_released';
  ELSIF v_released_count > 0 THEN
    v_plan_status := 'partially_released';
  ELSE
    v_plan_status := 'funded_in_escrow';
  END IF;

  UPDATE escrow_payment_plans
  SET
    status     = v_plan_status,
    updated_at = now()
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'outcome',        CASE WHEN v_existing_ref IS NOT DISTINCT FROM p_transfer_id THEN 'already_recorded' ELSE 'released' END,
    'plan_status',    v_plan_status,
    'tranche_count',  v_tranche_count,
    'released_count', v_released_count
  );
END;
$$;


ALTER FUNCTION "public"."release_tranche_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_trial"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_craftsman_role text;
  v_row craftsman_subscriptions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT role, craftsman_role INTO v_role, v_craftsman_role FROM profiles WHERE id = v_caller;
  IF v_role IS DISTINCT FROM 'craftsman' OR v_craftsman_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  SELECT * INTO v_row FROM craftsman_subscriptions WHERE profile_id = v_caller FOR UPDATE;
  IF v_row IS NULL THEN RAISE EXCEPTION 'no_subscription_row'; END IF;
  IF v_row.status != 'trial_available' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state', 'current', v_row.status);
  END IF;
  IF v_row.trial_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'trial_already_used');
  END IF;
  UPDATE craftsman_subscriptions
  SET status = 'trial_active', trial_started_at = v_now, trial_ends_at = v_now + interval '14 days', updated_at = v_now
  WHERE id = v_row.id;
  RETURN jsonb_build_object('ok', true, 'trial_ends_at', (v_now + interval '14 days')::text);
END;
$$;


ALTER FUNCTION "public"."start_trial"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_provider_search_vector"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.search_vector :=
    to_tsvector(
      'german',
      coalesce(NEW.company_name, '') || ' ' ||
      coalesce(NEW.description, '') || ' ' ||
      coalesce(NEW.city, '') || ' ' ||
      coalesce(NEW.trade_categories, '')
    );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_provider_search_vector"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."acceptances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "payment_id" "uuid",
    "source_offer_id" "uuid",
    "customer_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "accepted_at" bigint,
    "notes" "text",
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    "expires_at" bigint,
    CONSTRAINT "acceptances_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'disputed'::"text"])))
);


ALTER TABLE "public"."acceptances" OWNER TO "postgres";


COMMENT ON TABLE "public"."acceptances" IS 'Canonical Abnahme record. Opened (pending) when craftsman marks work complete. Transitions to accepted when customer explicitly confirms. One per job in terminal state.';



COMMENT ON COLUMN "public"."acceptances"."status" IS 'pending | accepted | disputed';



COMMENT ON COLUMN "public"."acceptances"."expires_at" IS 'Unix timestamp (ms) when the acceptance deadline expires. Set to created_at + 72h at work completion. After expiry, cron auto-releases the final payment tranche.';



CREATE TABLE IF NOT EXISTS "public"."analytics_events" (
    "event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text" NOT NULL,
    "actor_user_id" "uuid",
    "metadata" "jsonb",
    "created_at" bigint NOT NULL
);


ALTER TABLE "public"."analytics_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attribution_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "from_status" "text",
    "to_status" "text",
    "from_origin" "text",
    "to_origin" "text",
    "retry_count" integer,
    "reason" "text",
    "operator_id" "uuid",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "attribution_audit_log_dlq_reason_required" CHECK ((("event_type" <> 'dlq_entered'::"text") OR ("reason" IS NOT NULL))),
    CONSTRAINT "attribution_audit_log_event_type_check" CHECK (("event_type" = ANY (ARRAY['finalize_auto'::"text", 'finalize_absent'::"text", 'retry_incremented'::"text", 'dlq_entered'::"text", 'operator_resolve'::"text", 'operator_reclassify'::"text"]))),
    CONSTRAINT "attribution_audit_log_operator_id_required" CHECK ((("event_type" <> ALL (ARRAY['operator_resolve'::"text", 'operator_reclassify'::"text"])) OR ("operator_id" IS NOT NULL)))
);


ALTER TABLE "public"."attribution_audit_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."attribution_audit_log" IS 'Operator-visible forensic history of attribution lifecycle transitions. Written by finalize-attribution cron and operator RPCs only.';



CREATE TABLE IF NOT EXISTS "public"."calendar_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid",
    "title" "text" DEFAULT ''::"text" NOT NULL,
    "customer_name" "text" DEFAULT ''::"text" NOT NULL,
    "location" "text" DEFAULT ''::"text" NOT NULL,
    "date_label" "text" DEFAULT ''::"text" NOT NULL,
    "date_key" "text" DEFAULT ''::"text" NOT NULL,
    "starts_at_label" "text" DEFAULT ''::"text" NOT NULL,
    "ends_at_label" "text" DEFAULT ''::"text" NOT NULL,
    "assigned_member_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "created_at" bigint DEFAULT 0 NOT NULL,
    "updated_at" bigint DEFAULT 0 NOT NULL,
    "provider_id" "uuid",
    "description" "text" DEFAULT ''::"text" NOT NULL,
    CONSTRAINT "calendar_entries_requires_scope" CHECK ((("job_id" IS NOT NULL) OR ("provider_id" IS NOT NULL)))
);


ALTER TABLE "public"."calendar_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."change_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "source_offer_id" "uuid",
    "craftsman_user_id" "uuid" NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "description" "text" NOT NULL,
    "price" "text" NOT NULL,
    "currency" "text",
    "gross_total" bigint,
    "net_total" bigint,
    "vat_rate" numeric(5,2),
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "sent_at" bigint,
    "accepted_at" bigint,
    "declined_at" bigint,
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    CONSTRAINT "change_orders_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending'::"text", 'accepted'::"text", 'declined'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."change_orders" OWNER TO "postgres";


COMMENT ON TABLE "public"."change_orders" IS 'Canonical Nachtrag record. Commercial change proposal for a Job that has already been accepted. Only accepted ChangeOrders update the canonical payment amount.';



COMMENT ON COLUMN "public"."change_orders"."gross_total" IS 'Gross delta in minor units (cents). Positive = additional cost. Negative = credit.';



COMMENT ON COLUMN "public"."change_orders"."status" IS 'draft | pending | accepted | declined | cancelled';



CREATE TABLE IF NOT EXISTS "public"."company_join_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "target_role" "text" DEFAULT 'worker'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "company_join_codes_target_role_check" CHECK (("target_role" = 'worker'::"text"))
);


ALTER TABLE "public"."company_join_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "craftsman_user_id" "uuid",
    "customer_user_id" "uuid",
    "created_at" bigint DEFAULT (EXTRACT(epoch FROM "now"()) * (1000)::numeric),
    "customer_name" "text" DEFAULT ''::"text" NOT NULL,
    "customer_avatar_url" "text" DEFAULT ''::"text" NOT NULL,
    "craftsman_name" "text" DEFAULT ''::"text" NOT NULL,
    "craftsman_handle" "text" DEFAULT ''::"text" NOT NULL,
    "craftsman_avatar_url" "text" DEFAULT ''::"text" NOT NULL,
    "project_title" "text" DEFAULT ''::"text" NOT NULL,
    "project_subtitle" "text" DEFAULT ''::"text" NOT NULL,
    "project_location" "text",
    "project_cost_range" "text",
    "project_duration" "text",
    "project_status_label" "text",
    "time_label" "text",
    "unread_count" integer,
    "inquiry_origin" "text",
    "source_project_id" "text",
    "reviewed_at" bigint,
    "declined_at" bigint,
    "inquiry_criteria" "jsonb",
    "project_description" "text"
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."correction_requests" (
    "id" "text" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "worker_team_member_id" "text" NOT NULL,
    "worker_profile_id" "uuid" NOT NULL,
    "calendar_entry_id" "text",
    "requested_date" "text",
    "kind" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "owner_note" "text",
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    CONSTRAINT "correction_requests_kind_check" CHECK (("kind" = ANY (ARRAY['missing_time'::"text", 'wrong_time'::"text", 'wrong_assignment'::"text", 'other'::"text"]))),
    CONSTRAINT "correction_requests_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_review'::"text", 'resolved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."correction_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."craftsman_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'trial_available'::"text" NOT NULL,
    "trial_started_at" timestamp with time zone,
    "trial_ends_at" timestamp with time zone,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "canceled_at" timestamp with time zone,
    "grace_started_at" timestamp with time zone,
    "billing_provider" "text",
    "billing_provider_subscription_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "craftsman_subscriptions_billing_provider_check" CHECK ((("billing_provider" = ANY (ARRAY['apple'::"text", 'stripe'::"text"])) OR ("billing_provider" IS NULL))),
    CONSTRAINT "craftsman_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['trial_available'::"text", 'trial_active'::"text", 'active'::"text", 'grace'::"text", 'canceled'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."craftsman_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_provider_relationships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "craftsman_user_id" "uuid" NOT NULL,
    "commercial_origin" "text" NOT NULL,
    "origin_context" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "customer_provider_relationships_commercial_origin_check" CHECK (("commercial_origin" = ANY (ARRAY['merchant_brought'::"text", 'platform_acquired'::"text"]))),
    CONSTRAINT "customer_provider_relationships_origin_context_check" CHECK (("origin_context" = ANY (ARRAY['invite'::"text", 'reel'::"text", 'search'::"text", 'referral'::"text", 'manual_import'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."customer_provider_relationships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_request_sends" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "sent_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customer_request_sends" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "role" "text" DEFAULT '''customer'''::"text",
    "display_name" "text",
    "phone" "text",
    "onboarding_done" boolean DEFAULT false,
    "craftsman_role" "text",
    "is_operator" boolean DEFAULT false NOT NULL,
    "guided_entry_state" "jsonb",
    "tos_accepted_at" timestamp with time zone
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."providers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "company_name" "text",
    "description" "text",
    "rating" numeric DEFAULT '0'::numeric,
    "verified" boolean DEFAULT false,
    "profile_id" "uuid",
    "city" "text",
    "trade_categories" "text",
    "avatar_url" "text",
    "is_public" boolean DEFAULT true,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "search_vector" "tsvector",
    "slug" "text",
    "handle" "text",
    "business_address" "text",
    CONSTRAINT "providers_company_name_not_blank_check" CHECK ((("company_name" IS NULL) OR ("length"(TRIM(BOTH FROM "company_name")) > 0))),
    CONSTRAINT "providers_handle_not_blank_check" CHECK ((("handle" IS NULL) OR ("length"(TRIM(BOTH FROM "handle")) > 0))),
    CONSTRAINT "providers_rating_range_check" CHECK ((("rating" IS NULL) OR (("rating" >= (0)::numeric) AND ("rating" <= (5)::numeric)))),
    CONSTRAINT "providers_slug_not_blank_check" CHECK ((("slug" IS NULL) OR ("length"(TRIM(BOTH FROM "slug")) > 0)))
);


ALTER TABLE "public"."providers" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."discovery_providers" AS
 SELECT "p"."id" AS "provider_id",
    "p"."profile_id",
    "p"."company_name",
    "p"."description",
    "p"."city",
    "p"."trade_categories",
    "p"."avatar_url",
    "p"."rating",
    "p"."verified",
    "p"."is_public",
    "p"."created_at" AS "provider_created_at",
    "p"."updated_at" AS "provider_updated_at",
    "pr"."display_name",
    "pr"."phone",
    "pr"."role",
    "pr"."craftsman_role",
    "pr"."onboarding_done"
   FROM ("public"."providers" "p"
     JOIN "public"."profiles" "pr" ON (("p"."profile_id" = "pr"."id")));


ALTER VIEW "public"."discovery_providers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."disputes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "payment_id" "uuid",
    "project_id" "uuid",
    "opened_by_profile_id" "uuid",
    "provider_id" "uuid",
    "customer_profile_id" "uuid",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "reason" "text",
    "description" "text",
    "resolution_type" "text",
    "resolution_note" "text",
    "refund_amount" numeric DEFAULT 0 NOT NULL,
    "release_amount" numeric DEFAULT 0 NOT NULL,
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "split_ratio" numeric,
    "provider_award_amount" numeric DEFAULT 0 NOT NULL,
    "customer_refund_amount" numeric DEFAULT 0 NOT NULL,
    "settlement_status" "text",
    "raised_by" "text",
    "decision" "text",
    "context_snapshot" "jsonb",
    CONSTRAINT "disputes_decision_check" CHECK ((("decision" IS NULL) OR ("decision" = ANY (ARRAY['release'::"text", 'refund'::"text", 'split'::"text", 'reject'::"text"])))),
    CONSTRAINT "disputes_resolution_type_check" CHECK ((("resolution_type" IS NULL) OR ("resolution_type" = ANY (ARRAY['refund_full'::"text", 'refund_partial'::"text", 'release_full'::"text", 'release_partial'::"text", 'split'::"text", 'rejected'::"text"])))),
    CONSTRAINT "disputes_settlement_status_check" CHECK ((("settlement_status" IS NULL) OR ("settlement_status" = ANY (ARRAY['pending'::"text", 'settled'::"text"])))),
    CONSTRAINT "disputes_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'under_review'::"text", 'customer_waiting'::"text", 'provider_waiting'::"text", 'resolved'::"text", 'closed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."disputes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."disputes"."settlement_status" IS 'Financial settlement state for terminal disputes. pending = decision made, money action not yet completed. settled = money action confirmed. NULL for non-terminal disputes.';



COMMENT ON COLUMN "public"."disputes"."context_snapshot" IS 'JSONB snapshot of job/payment state captured at dispute-open time. Used to reconstruct the dispute context for review and resolution. Null for disputes opened before this column was added.';



CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_profile_id" "uuid",
    "provider_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "city" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "budget_amount" numeric,
    "scheduled_for" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dispute_id" "uuid",
    "dispute_status" "text",
    "assigned_team_member_id" "uuid",
    "assignment_status" "text",
    "assigned_provider_id" "uuid",
    "customer_user_id" "uuid",
    "work_started_at" bigint,
    "funding_requested_at" bigint,
    "source_offer_id" "uuid",
    "work_completed_at" bigint,
    "project_id" "text" DEFAULT ''::"text" NOT NULL,
    "customer" "text" DEFAULT ''::"text" NOT NULL,
    "location" "text" DEFAULT ''::"text" NOT NULL,
    "date_label" "text" DEFAULT 'Termin offen'::"text" NOT NULL,
    "amount" "text" DEFAULT ''::"text" NOT NULL,
    "payment_state" "text" DEFAULT 'deposit_required'::"text" NOT NULL,
    "documentation_status" "text" DEFAULT 'Noch keine Dokumentation'::"text" NOT NULL,
    "assigned_member_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "notes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "photo_count" integer DEFAULT 0 NOT NULL,
    "intake_context" "jsonb",
    "proposal_timing_note" "text",
    "proposal_sent_at" bigint,
    "proposal_accepted_at" bigint,
    "payment_released_at" bigint,
    "craftsman_user_id" "text",
    "source_conversation_id" "uuid",
    "commercial_origin" "text",
    "attribution_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attribution_retry_count" integer DEFAULT 0 NOT NULL,
    "attribution_last_retry_at" timestamp with time zone,
    "job_kind" "text",
    "attribution_dlq_reason" "text",
    CONSTRAINT "jobs_assignment_status_check" CHECK ((("assignment_status" IS NULL) OR ("assignment_status" = ANY (ARRAY['unassigned'::"text", 'assigned'::"text", 'accepted'::"text", 'declined'::"text", 'in_progress'::"text", 'completed'::"text"])))),
    CONSTRAINT "jobs_attribution_dlq_reason_required" CHECK ((("attribution_status" <> 'dlq'::"text") OR ("attribution_dlq_reason" IS NOT NULL))),
    CONSTRAINT "jobs_attribution_finalized_origin_check" CHECK ((("attribution_status" <> 'finalized'::"text") OR ("commercial_origin" = ANY (ARRAY['merchant_brought'::"text", 'platform_acquired'::"text"])))),
    CONSTRAINT "jobs_attribution_status_check" CHECK (("attribution_status" = ANY (ARRAY['pending'::"text", 'finalized'::"text", 'retrying'::"text", 'dlq'::"text"]))),
    CONSTRAINT "jobs_commercial_origin_check" CHECK (("commercial_origin" = ANY (ARRAY['merchant_brought'::"text", 'platform_acquired'::"text", 'unknown_pending_resolution'::"text"]))),
    CONSTRAINT "jobs_job_kind_check" CHECK ((("job_kind" IS NULL) OR ("job_kind" = ANY (ARRAY['standard'::"text", 'estimate_tracking'::"text", 'cost_estimate_tracking'::"text", 'diagnosis'::"text"])))),
    CONSTRAINT "jobs_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'booked'::"text", 'scheduled'::"text", 'in_progress'::"text", 'waiting_payment'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."jobs"."dispute_status" IS 'Current dispute lifecycle status for this job. Allowed: open | under_review | resolved_refund | resolved_release | resolved_split | rejected. NULL when no dispute has been opened.';



COMMENT ON COLUMN "public"."jobs"."job_kind" IS 'Commercial kind of this job — derived from the documentType of the Offer that created it (Paket 2+). ''standard'' (binding_offer origin, full execution + escrow) | ''estimate_tracking'' (estimate origin, tracking only) | ''cost_estimate_tracking'' (cost_estimate origin, tracking only, no payment) | ''diagnosis'' (diagnosis origin, own diagnosis instant-payment path). NULL = legacy pre-Paket-2 job, treated as ''standard''.';



COMMENT ON COLUMN "public"."jobs"."attribution_dlq_reason" IS 'Documented reason when attribution_status = ''dlq''. See finalize-attribution.ts for taxonomy.';



CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid",
    "project_id" "uuid",
    "provider_id" "uuid",
    "customer_profile_id" "uuid",
    "provider_stripe_account_id" "text",
    "stripe_payment_intent_id" "text",
    "stripe_checkout_session_id" "text",
    "stripe_refund_id" "text",
    "stripe_transfer_id" "text",
    "currency" "text" DEFAULT 'eur'::"text" NOT NULL,
    "amount_total" numeric DEFAULT 0 NOT NULL,
    "amount_captured" numeric DEFAULT 0 NOT NULL,
    "amount_refunded" numeric DEFAULT 0 NOT NULL,
    "platform_fee_amount" numeric DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payment_method_type" "text",
    "payment_provider" "text" DEFAULT 'stripe'::"text" NOT NULL,
    "escrow_created_at" timestamp with time zone,
    "captured_at" timestamp with time zone,
    "refunded_at" timestamp with time zone,
    "failed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "failure_reason" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_stripe_event_id" "text",
    "last_stripe_event_type" "text",
    "stripe_status" "text",
    "reconciled_at" timestamp with time zone,
    "dispute_id" "uuid",
    "dispute_status" "text",
    "release_blocked" boolean DEFAULT false NOT NULL,
    "amount_released" numeric DEFAULT 0 NOT NULL,
    "amount_held" numeric DEFAULT 0 NOT NULL,
    "amount_disputed" numeric DEFAULT 0 NOT NULL,
    "split_resolution_ratio" numeric,
    "split_resolution_note" "text",
    "client_secret" "text",
    "craftsman_user_id" "uuid",
    "customer_user_id" "uuid",
    "deposit_amount" numeric,
    "final_amount" numeric,
    "offer_id" "uuid",
    "provider_ref" "text",
    "total_amount" numeric,
    "refunded_amount" numeric(12,2),
    CONSTRAINT "payments_job_or_project_check" CHECK ((("job_id" IS NOT NULL) OR ("project_id" IS NOT NULL))),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['none'::"text", 'deposit_required'::"text", 'deposit_paid'::"text", 'in_escrow'::"text", 'work_in_progress'::"text", 'release_pending'::"text", 'released'::"text", 'disputed'::"text", 'refunded'::"text", 'pending'::"text", 'requires_payment_method'::"text", 'requires_confirmation'::"text", 'processing'::"text", 'authorized'::"text", 'escrowed'::"text", 'captured'::"text", 'partially_refunded'::"text", 'failed'::"text", 'cancelled'::"text", 'diagnosis_payment_pending'::"text", 'diagnosis_payment_completed'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."dispute_details" AS
 SELECT "d"."id",
    "d"."job_id",
    "d"."payment_id",
    "d"."project_id",
    "d"."opened_by_profile_id",
    "d"."provider_id",
    "d"."customer_profile_id",
    "d"."status",
    "d"."reason",
    "d"."description",
    "d"."resolution_type",
    "d"."resolution_note",
    "d"."refund_amount",
    "d"."release_amount",
    "d"."opened_at",
    "d"."resolved_at",
    "d"."closed_at",
    "d"."metadata",
    "d"."created_at",
    "d"."updated_at",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "p"."status" AS "payment_status",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_refunded",
    "pr"."company_name" AS "provider_company_name",
    "cp"."display_name" AS "customer_display_name"
   FROM (((("public"."disputes" "d"
     LEFT JOIN "public"."jobs" "j" ON (("d"."job_id" = "j"."id")))
     LEFT JOIN "public"."payments" "p" ON (("d"."payment_id" = "p"."id")))
     LEFT JOIN "public"."providers" "pr" ON (("d"."provider_id" = "pr"."id")))
     LEFT JOIN "public"."profiles" "cp" ON (("d"."customer_profile_id" = "cp"."id")));


ALTER VIEW "public"."dispute_details" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dispute_evidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dispute_id" "uuid" NOT NULL,
    "uploaded_by_profile_id" "uuid",
    "kind" "text" DEFAULT 'image'::"text" NOT NULL,
    "storage_path" "text",
    "public_url" "text",
    "caption" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dispute_evidence_kind_check" CHECK (("kind" = ANY (ARRAY['image'::"text", 'document'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."dispute_evidence" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."dispute_ops_overview" AS
 SELECT "id" AS "dispute_id",
    "job_id",
    "payment_id",
    "status",
    "reason",
    "resolution_type",
    "refund_amount",
    "release_amount",
    "opened_at",
    "resolved_at",
    (EXTRACT(day FROM ("now"() - "opened_at")))::integer AS "age_days",
        CASE
            WHEN (EXTRACT(day FROM ("now"() - "opened_at")) >= (7)::numeric) THEN 'critical'::"text"
            WHEN (EXTRACT(day FROM ("now"() - "opened_at")) >= (3)::numeric) THEN 'elevated'::"text"
            ELSE 'normal'::"text"
        END AS "urgency_level"
   FROM "public"."disputes" "d"
  WHERE ("status" = ANY (ARRAY['open'::"text", 'under_review'::"text", 'customer_waiting'::"text", 'provider_waiting'::"text"]));


ALTER VIEW "public"."dispute_ops_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dispute_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dispute_id" "uuid" NOT NULL,
    "previous_status" "text",
    "next_status" "text" NOT NULL,
    "source" "text" NOT NULL,
    "note" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_id" "uuid",
    CONSTRAINT "dispute_status_history_source_check" CHECK (("source" = ANY (ARRAY['client'::"text", 'server'::"text", 'webhook'::"text", 'system'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."dispute_status_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_delivery_log" (
    "id" bigint NOT NULL,
    "job_id" "text" NOT NULL,
    "notification_type" "text" NOT NULL,
    "recipient_user_id" "text" NOT NULL,
    "recipient_role" "text" NOT NULL,
    "recipient_email" "text",
    "success" boolean NOT NULL,
    "error_message" "text",
    "provider_message_id" "text",
    "sent_at" bigint NOT NULL,
    CONSTRAINT "email_delivery_log_recipient_role_check" CHECK (("recipient_role" = ANY (ARRAY['customer'::"text", 'craftsman'::"text"])))
);


ALTER TABLE "public"."email_delivery_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."email_delivery_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."email_delivery_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."email_delivery_log_id_seq" OWNED BY "public"."email_delivery_log"."id";



CREATE TABLE IF NOT EXISTS "public"."escrow_payment_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_offer_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "currency" "text" DEFAULT 'EUR'::"text" NOT NULL,
    "total_amount" numeric(12,2) NOT NULL,
    "funding_mode" "text" DEFAULT 'full_upfront_escrow'::"text" NOT NULL,
    "release_model" "text" DEFAULT 'start_25_completion_75'::"text" NOT NULL,
    "status" "text" DEFAULT 'awaiting_customer_funding'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "funding_initiated_at" timestamp with time zone,
    "funded_at" timestamp with time zone,
    "external_funding_ref" "text",
    "funding_idempotency_key" "text",
    "platform_fee_rate" numeric(5,4),
    "platform_fee_amount" numeric(12,2),
    "commercial_origin" "text",
    CONSTRAINT "escrow_plans_funding_mode_check" CHECK (("funding_mode" = 'full_upfront_escrow'::"text")),
    CONSTRAINT "escrow_plans_release_model_check" CHECK (("release_model" = 'start_25_completion_75'::"text")),
    CONSTRAINT "escrow_plans_status_check" CHECK (("status" = ANY (ARRAY['awaiting_customer_funding'::"text", 'funding_initiated'::"text", 'funded_in_escrow'::"text", 'partially_released'::"text", 'fully_released'::"text", 'funding_failed'::"text", 'disputed'::"text", 'refunded'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."escrow_payment_plans" OWNER TO "postgres";


COMMENT ON COLUMN "public"."escrow_payment_plans"."platform_fee_rate" IS 'Platform commission rate applied at PI creation: 0.05 (merchant_brought) or 0.09 (platform_acquired). Null for plans created before fee-model wiring.';



COMMENT ON COLUMN "public"."escrow_payment_plans"."platform_fee_amount" IS 'Absolute platform fee in the plan currency, computed as total_amount * platform_fee_rate. Mirrors application_fee_amount sent to Stripe.';



COMMENT ON COLUMN "public"."escrow_payment_plans"."commercial_origin" IS 'Snapshot of jobs.commercial_origin at the moment the PaymentIntent was created. Immutable after first write.';



CREATE TABLE IF NOT EXISTS "public"."escrow_tranches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "percentage" numeric(5,2) NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "release_trigger" "text" NOT NULL,
    "status" "text" DEFAULT 'pending_funding'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "eligible_at" timestamp with time zone,
    "released_at" timestamp with time zone,
    "external_release_ref" "text",
    "triggered_by" "text",
    "released_by" "text",
    "transfer_reversal_ref" "text",
    CONSTRAINT "escrow_tranches_kind_check" CHECK (("kind" = ANY (ARRAY['deposit_release'::"text", 'final_release'::"text"]))),
    CONSTRAINT "escrow_tranches_released_by_check" CHECK ((("released_by" IS NULL) OR ("released_by" = ANY (ARRAY['customer'::"text", 'provider'::"text", 'system'::"text"])))),
    CONSTRAINT "escrow_tranches_status_check" CHECK (("status" = ANY (ARRAY['pending_funding'::"text", 'funded'::"text", 'locked'::"text", 'eligible_for_release'::"text", 'release_pending'::"text", 'released'::"text", 'blocked'::"text", 'disputed'::"text", 'refunded'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "escrow_tranches_trigger_check" CHECK (("release_trigger" = ANY (ARRAY['work_started'::"text", 'work_completed'::"text"]))),
    CONSTRAINT "escrow_tranches_triggered_by_check" CHECK ((("triggered_by" IS NULL) OR ("triggered_by" = ANY (ARRAY['customer'::"text", 'provider'::"text", 'system'::"text"]))))
);


ALTER TABLE "public"."escrow_tranches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."funding_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_offer_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "escrow_plan_id" "uuid" NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "provider_user_id" "uuid" NOT NULL,
    "type" "text" DEFAULT 'full_escrow'::"text" NOT NULL,
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'EUR'::"text" NOT NULL,
    "created_by" "text" DEFAULT 'provider'::"text" NOT NULL,
    "conversation_id" "uuid",
    "message_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone,
    "funded_at" timestamp with time zone,
    "external_funding_ref" "text",
    "funding_idempotency_key" "text",
    "failure_reason" "text",
    "expires_at" bigint DEFAULT ((EXTRACT(epoch FROM ("now"() + '14 days'::interval)) * (1000)::numeric))::bigint,
    CONSTRAINT "funding_requests_created_by_check" CHECK (("created_by" = ANY (ARRAY['provider'::"text", 'system'::"text"]))),
    CONSTRAINT "funding_requests_status_check" CHECK (("status" = ANY (ARRAY['created'::"text", 'sent'::"text", 'funding_started'::"text", 'funding_initiated'::"text", 'funded'::"text", 'funding_failed'::"text", 'expired'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "funding_requests_type_check" CHECK (("type" = 'full_escrow'::"text"))
);


ALTER TABLE "public"."funding_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."internal_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "sender_team_member_id" "text" NOT NULL,
    "body" "text" NOT NULL,
    "message_kind" "text" DEFAULT 'text'::"text" NOT NULL,
    "created_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "updated_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    CONSTRAINT "internal_messages_message_kind_check" CHECK (("message_kind" = 'text'::"text"))
);


ALTER TABLE "public"."internal_messages" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."invoice_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."invoice_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "invoice_number" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "parties" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "line_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "amounts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "issued_at_label" "text" DEFAULT ''::"text" NOT NULL,
    "due_at_label" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" bigint DEFAULT 0 NOT NULL,
    "updated_at" bigint DEFAULT 0 NOT NULL,
    "issued_at" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "team_member_id" "uuid",
    "assignment_role" "text" DEFAULT 'primary'::"text" NOT NULL,
    "status" "text" DEFAULT 'assigned'::"text" NOT NULL,
    "note" "text",
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "accepted_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "job_assignments_assignment_role_check" CHECK (("assignment_role" = ANY (ARRAY['primary'::"text", 'support'::"text", 'viewer'::"text"]))),
    CONSTRAINT "job_assignments_status_check" CHECK (("status" = ANY (ARRAY['assigned'::"text", 'accepted'::"text", 'declined'::"text", 'removed'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."job_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."team_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "profile_id" "uuid",
    "full_name" "text" NOT NULL,
    "role" "text" DEFAULT 'worker'::"text" NOT NULL,
    "phone" "text",
    "email" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    CONSTRAINT "team_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'worker'::"text", 'subcontractor'::"text"])))
);


ALTER TABLE "public"."team_members" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."job_assignment_details" AS
 SELECT "ja"."id",
    "ja"."job_id",
    "ja"."provider_id",
    "ja"."team_member_id",
    "ja"."assignment_role",
    "ja"."status",
    "ja"."note",
    "ja"."assigned_at",
    "ja"."accepted_at",
    "ja"."completed_at",
    "ja"."created_at",
    "ja"."updated_at",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "j"."city" AS "job_city",
    "tm"."full_name" AS "team_member_name",
    "tm"."role" AS "team_member_role",
    "tm"."phone" AS "team_member_phone",
    "p"."company_name" AS "provider_company_name"
   FROM ((("public"."job_assignments" "ja"
     LEFT JOIN "public"."jobs" "j" ON (("ja"."job_id" = "j"."id")))
     LEFT JOIN "public"."team_members" "tm" ON (("ja"."team_member_id" = "tm"."id")))
     LEFT JOIN "public"."providers" "p" ON (("ja"."provider_id" = "p"."id")));


ALTER VIEW "public"."job_assignment_details" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."job_details" AS
 SELECT "j"."id",
    "j"."customer_profile_id",
    "j"."provider_id",
    "j"."title",
    "j"."description",
    "j"."city",
    "j"."status",
    "j"."budget_amount",
    "j"."scheduled_for",
    "j"."created_at",
    "j"."updated_at",
    "customer"."display_name" AS "customer_display_name",
    "customer"."phone" AS "customer_phone",
    "p"."company_name" AS "provider_company_name",
    "p"."city" AS "provider_city",
    "p"."verified" AS "provider_verified",
    "p"."avatar_url" AS "provider_avatar_url",
    "provider_profile"."display_name" AS "provider_display_name",
    "provider_profile"."phone" AS "provider_phone",
    "provider_profile"."craftsman_role" AS "provider_craftsman_role"
   FROM ((("public"."jobs" "j"
     LEFT JOIN "public"."profiles" "customer" ON (("j"."customer_profile_id" = "customer"."id")))
     LEFT JOIN "public"."providers" "p" ON (("j"."provider_id" = "p"."id")))
     LEFT JOIN "public"."profiles" "provider_profile" ON (("p"."profile_id" = "provider_profile"."id")));


ALTER VIEW "public"."job_details" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "craftsman_user_id" "text" DEFAULT ''::"text" NOT NULL,
    "would_hire_again" boolean DEFAULT false NOT NULL,
    "note" "text",
    "created_at" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."job_feedback" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."job_integrity_overview" AS
 SELECT "j"."id" AS "job_id",
    "j"."title",
    "j"."status",
    "j"."city",
    "j"."provider_id",
    "j"."assigned_provider_id",
    "j"."assigned_team_member_id",
    "j"."assignment_status",
    "j"."dispute_id",
    "j"."dispute_status",
    "p"."id" AS "payment_id",
    "p"."status" AS "payment_status",
        CASE
            WHEN (("j"."status" = ANY (ARRAY['in_progress'::"text", 'completed'::"text"])) AND ("j"."assigned_provider_id" IS NULL)) THEN 'execution_without_provider'::"text"
            WHEN (("j"."assignment_status" = 'assigned'::"text") AND ("j"."assigned_team_member_id" IS NULL)) THEN 'assigned_without_team_member'::"text"
            WHEN (("j"."dispute_status" IS NOT NULL) AND ("j"."dispute_id" IS NULL)) THEN 'dispute_status_without_dispute'::"text"
            WHEN (("j"."status" = 'completed'::"text") AND ("p"."id" IS NULL)) THEN 'completed_without_payment'::"text"
            ELSE NULL::"text"
        END AS "integrity_flag"
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."payments" "p" ON (("p"."job_id" = "j"."id")));


ALTER VIEW "public"."job_integrity_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ledger_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid",
    "job_id" "uuid",
    "dispute_id" "uuid",
    "entry_type" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "currency" "text" DEFAULT 'EUR'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "type" "text",
    CONSTRAINT "ledger_entries_amount_positive" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "ledger_entries_entry_type_check" CHECK (("entry_type" = ANY (ARRAY['escrow_deposit'::"text", 'platform_fee'::"text", 'payout'::"text", 'refund'::"text", 'dispute_hold'::"text", 'refund_partial'::"text", 'payout_adjustment'::"text", 'escrow_release'::"text", 'escrow_refund'::"text"])))
);


ALTER TABLE "public"."ledger_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_artifacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "kind" "text" DEFAULT ''::"text" NOT NULL,
    "label" "text" DEFAULT ''::"text" NOT NULL,
    "filename" "text" DEFAULT ''::"text" NOT NULL,
    "mime_type" "text" DEFAULT ''::"text" NOT NULL,
    "uploaded_at" bigint DEFAULT 0 NOT NULL,
    "uploaded_by" "text" DEFAULT ''::"text" NOT NULL,
    "notes" "text",
    "dispute_id" "uuid",
    "timeline_event_id" "uuid"
);


ALTER TABLE "public"."media_artifacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_uploads" (
    "id" "text" NOT NULL,
    "owner_user_id" "text" NOT NULL,
    "entity_type" "text" DEFAULT ''::"text" NOT NULL,
    "entity_id" "text" DEFAULT ''::"text" NOT NULL,
    "file_path" "text" DEFAULT ''::"text" NOT NULL,
    "public_url" "text" DEFAULT ''::"text" NOT NULL,
    "mime_type" "text" DEFAULT ''::"text" NOT NULL,
    "media_type" "text" DEFAULT 'image'::"text" NOT NULL,
    "created_at" bigint DEFAULT 0 NOT NULL,
    "media_role" "text" DEFAULT ''::"text" NOT NULL
);


ALTER TABLE "public"."media_uploads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_thread_participants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "team_member_id" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_read_at" bigint,
    "created_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL
);


ALTER TABLE "public"."message_thread_participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "thread_type" "text" NOT NULL,
    "calendar_entry_id" "uuid",
    "created_by_team_member_id" "text" NOT NULL,
    "title" "text",
    "last_message_at" bigint,
    "last_message_body" "text",
    "created_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "updated_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    CONSTRAINT "message_threads_thread_type_check" CHECK (("thread_type" = ANY (ARRAY['assignment'::"text", 'office'::"text", 'team'::"text"])))
);


ALTER TABLE "public"."message_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "text" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "sender_user_id" "uuid" NOT NULL,
    "content" "text",
    "created_at" bigint NOT NULL,
    "media_url" "text"
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "type" "text" DEFAULT ''::"text" NOT NULL,
    "priority" "text" DEFAULT 'low'::"text" NOT NULL,
    "read" boolean DEFAULT false NOT NULL,
    "occurred_at" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."notification_signals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offers" (
    "id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "craftsman_user_id" "uuid" NOT NULL,
    "price" numeric(12,2) NOT NULL,
    "description" "text",
    "timing_note" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "updated_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "accepted_at" bigint,
    "declined_at" bigint,
    "created_job_id" "uuid",
    "sent_at" bigint,
    "currency" "text",
    "gross_total" numeric,
    "net_total" numeric,
    "vat_amount" numeric,
    "vat_rate" integer,
    "labor_cost" numeric,
    "material_cost" numeric,
    "other_cost" numeric,
    "scope_summary" "text",
    "scope_included" "text",
    "scope_excluded" "text",
    "assumptions" "text",
    "payment_terms" "text",
    "valid_until" "text",
    "cancellation_terms" "text",
    "escrow_required" boolean,
    "project_title_snapshot" "text",
    "customer_description_snapshot" "text",
    "location_snapshot" "text",
    "version" integer DEFAULT 1,
    "notes" "text",
    "locked_at" bigint,
    "project_id" "uuid",
    "line_items" "jsonb",
    "offer_mode" "text",
    "craftsman_name_snapshot" "text",
    "vat_included" boolean,
    "evidence_media_ids" "text",
    "offer_ref" "text",
    "document_type" "text",
    "context_type" "text",
    "source_diagnosis_id" "text",
    CONSTRAINT "offers_context_type_check" CHECK ((("context_type" IS NULL) OR ("context_type" = ANY (ARRAY['conversation'::"text", 'inquiry'::"text", 'project'::"text"])))),
    CONSTRAINT "offers_document_type_check" CHECK ((("document_type" IS NULL) OR ("document_type" = ANY (ARRAY['estimate'::"text", 'cost_estimate'::"text", 'binding_offer'::"text", 'diagnosis'::"text"])))),
    CONSTRAINT "offers_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending'::"text", 'accepted'::"text", 'declined'::"text", 'expired'::"text", 'superseded'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."offers" OWNER TO "postgres";


COMMENT ON COLUMN "public"."offers"."offer_mode" IS '''binding'' (default, verbindliches Angebot) | ''estimate'' (unverbindliche Schätzung). NULL is treated as ''binding'' for backward compatibility. Only binding offers unlock the payment corridor on acceptance.';



COMMENT ON COLUMN "public"."offers"."document_type" IS 'Leading commercial document type (Paket 1+). ''binding_offer'' (verbindliches Angebot, standard escrow) | ''estimate'' (unverbindliche Schätzung, no payment) | ''cost_estimate'' (Kostenvoranschlag, no payment) | ''diagnosis'' (Diagnose-Einsatz, own instant-payment path). NULL rows are resolved to ''binding_offer'' by the domain layer for backward compatibility.';



COMMENT ON COLUMN "public"."offers"."context_type" IS 'Context classification for this commercial document (Paket 1). ''conversation'' (default) | ''inquiry'' | ''project''. The actual context anchor is conversation_id. context_type classifies it.';



COMMENT ON COLUMN "public"."offers"."source_diagnosis_id" IS 'ID of the diagnosis offer this binding_offer was created from (Paket 4d). NULL for all offers not created as a follow-up to a diagnosis. Soft reference — no FK constraint. Provides audit trail: diagnosis → follow-up binding_offer.';



CREATE TABLE IF NOT EXISTS "public"."operator_action_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "operator_id" "uuid" NOT NULL,
    "action_type" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "metadata" "jsonb",
    "created_at" bigint DEFAULT (EXTRACT(epoch FROM "now"()) * (1000)::numeric) NOT NULL
);


ALTER TABLE "public"."operator_action_audit" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_details" AS
 SELECT "p"."id",
    "p"."job_id",
    "p"."project_id",
    "p"."provider_id",
    "p"."customer_profile_id",
    "p"."provider_stripe_account_id",
    "p"."stripe_payment_intent_id",
    "p"."stripe_checkout_session_id",
    "p"."stripe_refund_id",
    "p"."stripe_transfer_id",
    "p"."currency",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_refunded",
    "p"."platform_fee_amount",
    "p"."status",
    "p"."payment_method_type",
    "p"."payment_provider",
    "p"."escrow_created_at",
    "p"."captured_at",
    "p"."refunded_at",
    "p"."failed_at",
    "p"."cancelled_at",
    "p"."failure_reason",
    "p"."metadata",
    "p"."created_at",
    "p"."updated_at",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "pr"."company_name" AS "provider_company_name",
    "cp"."display_name" AS "customer_display_name"
   FROM ((("public"."payments" "p"
     LEFT JOIN "public"."jobs" "j" ON (("p"."job_id" = "j"."id")))
     LEFT JOIN "public"."providers" "pr" ON (("p"."provider_id" = "pr"."id")))
     LEFT JOIN "public"."profiles" "cp" ON (("p"."customer_profile_id" = "cp"."id")));


ALTER VIEW "public"."payment_details" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_lifecycle_overview" AS
 SELECT "p"."id" AS "payment_id",
    "p"."job_id",
    "p"."project_id",
    "p"."provider_id",
    "p"."customer_profile_id",
    "p"."status",
    "p"."payment_provider",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_released",
    "p"."amount_refunded",
    "p"."amount_disputed",
    "p"."amount_held",
    "p"."platform_fee_amount",
    "p"."split_resolution_ratio",
    "p"."last_stripe_event_id",
    "p"."last_stripe_event_type",
    "p"."reconciled_at",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "d"."id" AS "dispute_id",
    "d"."status" AS "dispute_status"
   FROM (("public"."payments" "p"
     LEFT JOIN "public"."jobs" "j" ON (("p"."job_id" = "j"."id")))
     LEFT JOIN "public"."disputes" "d" ON (("p"."dispute_id" = "d"."id")));


ALTER VIEW "public"."payment_lifecycle_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stripe_event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "livemode" boolean,
    "api_version" "text",
    "object_id" "text",
    "payment_intent_id" "text",
    "checkout_session_id" "text",
    "refund_id" "text",
    "event_created_at" timestamp with time zone,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "processing_status" "text" DEFAULT 'received'::"text" NOT NULL,
    "processing_error" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "stripe_events_processing_status_check" CHECK (("processing_status" = ANY (ARRAY['received'::"text", 'processing'::"text", 'processed'::"text", 'ignored'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."stripe_events" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_reconciliation_details" AS
 SELECT "p"."id" AS "payment_id",
    "p"."job_id",
    "p"."project_id",
    "p"."status" AS "payment_status",
    "p"."stripe_status",
    "p"."stripe_payment_intent_id",
    "p"."stripe_checkout_session_id",
    "p"."last_stripe_event_id",
    "p"."last_stripe_event_type",
    "p"."reconciled_at",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_refunded",
    "p"."created_at",
    "p"."updated_at",
    "se"."event_type" AS "latest_event_type",
    "se"."processing_status" AS "latest_event_processing_status",
    "se"."received_at" AS "latest_event_received_at",
    "se"."processed_at" AS "latest_event_processed_at"
   FROM ("public"."payments" "p"
     LEFT JOIN "public"."stripe_events" "se" ON (("se"."stripe_event_id" = "p"."last_stripe_event_id")));


ALTER VIEW "public"."payment_reconciliation_details" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_risk_overview" AS
 SELECT "p"."id" AS "payment_id",
    "p"."job_id",
    "p"."project_id",
    "p"."provider_id",
    "p"."customer_profile_id",
    "p"."status" AS "payment_status",
    "p"."stripe_status",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_refunded",
    "p"."dispute_id",
    "p"."dispute_status",
    "p"."release_blocked",
    "p"."reconciled_at",
    "p"."last_stripe_event_type",
    "p"."last_stripe_event_id",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "d"."status" AS "dispute_status_live",
        CASE
            WHEN (("p"."release_blocked" = true) AND ("d"."id" IS NULL)) THEN 'blocked_without_dispute'::"text"
            WHEN (("p"."status" = 'released'::"text") AND ("d"."status" = ANY (ARRAY['open'::"text", 'under_review'::"text", 'customer_waiting'::"text", 'provider_waiting'::"text"]))) THEN 'released_while_disputed'::"text"
            WHEN (("p"."status" = 'disputed'::"text") AND ("d"."id" IS NULL)) THEN 'disputed_without_dispute_record'::"text"
            WHEN (("p"."status" = ANY (ARRAY['escrowed'::"text", 'authorized'::"text"])) AND ("p"."reconciled_at" IS NULL)) THEN 'unreconciled_escrow'::"text"
            ELSE NULL::"text"
        END AS "risk_flag"
   FROM (("public"."payments" "p"
     LEFT JOIN "public"."jobs" "j" ON (("p"."job_id" = "j"."id")))
     LEFT JOIN "public"."disputes" "d" ON (("p"."dispute_id" = "d"."id")));


ALTER VIEW "public"."payment_risk_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "previous_status" "text",
    "next_status" "text" NOT NULL,
    "source" "text" NOT NULL,
    "stripe_event_id" "text",
    "note" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payment_status_history_source_check" CHECK (("source" = ANY (ARRAY['client'::"text", 'server'::"text", 'webhook'::"text", 'system'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."payment_status_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_job_id" "uuid",
    "title" "text",
    "customer_profile_id" "uuid",
    "craftsman_user_id" "uuid",
    "location" "text",
    "status" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "customer_user_id" "uuid",
    "payment_state" "text" DEFAULT 'none'::"text" NOT NULL,
    "commercial_origin" "text",
    "source" "text",
    "category" "text",
    "description" "text",
    "requested_budget" "text",
    "requested_timing" "text",
    CONSTRAINT "projects_commercial_origin_check" CHECK (("commercial_origin" = ANY (ARRAY['merchant_brought'::"text", 'platform_acquired'::"text", 'unknown_pending_resolution'::"text"])))
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


COMMENT ON COLUMN "public"."projects"."source" IS '''builder'' | ''inquiry'' | ''direct''';



COMMENT ON COLUMN "public"."projects"."category" IS 'Trade category, e.g. ''Elektrik'', ''Bad''';



COMMENT ON COLUMN "public"."projects"."description" IS 'Free-text description of the required work';



COMMENT ON COLUMN "public"."projects"."requested_budget" IS 'Customer budget expectation, e.g. ''unter 2.000 €''';



COMMENT ON COLUMN "public"."projects"."requested_timing" IS 'Customer timing preference, e.g. ''Innerhalb 4 Wochen''';



CREATE TABLE IF NOT EXISTS "public"."provider_media" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "storage_path" "text",
    "public_url" "text",
    "caption" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "media_type" "text" DEFAULT 'image'::"text" NOT NULL,
    "title" "text",
    "description" "text",
    "trade_tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "published" boolean DEFAULT true NOT NULL,
    "show_price" boolean DEFAULT false NOT NULL,
    "show_duration" boolean DEFAULT false NOT NULL,
    "source_job_id" "text",
    "project_title_snapshot" "text",
    "location_snapshot" "text",
    "duration_snapshot" "text",
    "amount_snapshot" "text",
    "trade_tags_snapshot" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "provider_media_kind_check" CHECK (("kind" = ANY (ARRAY['avatar'::"text", 'portfolio'::"text", 'cover'::"text"])))
);


ALTER TABLE "public"."provider_media" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_media_likes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "media_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."provider_media_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_payout_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_user_id" "uuid" NOT NULL,
    "stripe_connect_account_id" "text",
    "onboarding_status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "charges_enabled" boolean DEFAULT false NOT NULL,
    "payouts_enabled" boolean DEFAULT false NOT NULL,
    "onboarding_completed_at" timestamp with time zone,
    "requirements_due" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "provider_payout_accounts_onboarding_status_check" CHECK (("onboarding_status" = ANY (ARRAY['not_started'::"text", 'onboarding_in_progress'::"text", 'onboarding_complete'::"text", 'payout_blocked'::"text"])))
);


ALTER TABLE "public"."provider_payout_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ratings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "craftsman_user_id" "uuid" NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "rating" numeric DEFAULT 0 NOT NULL,
    "comment" "text",
    "created_at" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."ratings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "scheduled_start" bigint DEFAULT 0 NOT NULL,
    "scheduled_end" bigint DEFAULT 0 NOT NULL,
    "execution_window" bigint DEFAULT 0 NOT NULL,
    "scheduling_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" bigint DEFAULT 0 NOT NULL,
    "updated_at" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_webhook_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stripe_event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "livemode" boolean,
    "object_id" "text",
    "payment_intent_id" "text",
    "checkout_session_id" "text",
    "refund_id" "text",
    "event_created_at" timestamp with time zone,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "processing_status" "text" DEFAULT 'received'::"text" NOT NULL,
    "processing_error" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "failure_reason" "text",
    "event_id" "text",
    "outcome" "text",
    "payment_id" "text",
    "job_id" "text",
    "previous_state" "text",
    "new_state" "text"
);


ALTER TABLE "public"."stripe_webhook_events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."stripe_webhook_events"."failure_reason" IS 'Machine-readable failure reason when outcome is failed/invalid_transition. NULL for successful events. Used for operator recovery diagnostics.';



CREATE TABLE IF NOT EXISTS "public"."supplementary_payment_requests" (
    "id" "uuid" NOT NULL,
    "change_order_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "original_payment_id" "uuid" NOT NULL,
    "customer_user_id" "text" NOT NULL,
    "craftsman_user_id" "text" NOT NULL,
    "amount_cents" integer NOT NULL,
    "currency" "text" DEFAULT 'EUR'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "acknowledged_at" bigint,
    "paid_at" bigint,
    "waived_at" bigint,
    "external_ref" "text",
    "funding_initiated_at" bigint,
    "funded_at" bigint,
    "released_at" bigint,
    "external_payout_ref" "text",
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    CONSTRAINT "supplementary_payment_requests_amount_cents_check" CHECK (("amount_cents" > 0)),
    CONSTRAINT "supplementary_payment_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'acknowledged'::"text", 'funding_initiated'::"text", 'funded'::"text", 'released'::"text", 'paid'::"text", 'waived'::"text"])))
);


ALTER TABLE "public"."supplementary_payment_requests" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."team_member_details" AS
 SELECT "tm"."id",
    "tm"."provider_id",
    "tm"."profile_id",
    "tm"."full_name",
    "tm"."role",
    "tm"."phone",
    "tm"."email",
    "tm"."is_active",
    "tm"."created_at",
    "tm"."updated_at",
    "p"."company_name" AS "provider_company_name",
    "pr"."display_name" AS "linked_profile_display_name",
    "pr"."phone" AS "linked_profile_phone"
   FROM (("public"."team_members" "tm"
     LEFT JOIN "public"."providers" "p" ON (("tm"."provider_id" = "p"."id")))
     LEFT JOIN "public"."profiles" "pr" ON (("tm"."profile_id" = "pr"."id")));


ALTER VIEW "public"."team_member_details" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."thread_artifacts" (
    "id" "text" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "artifact_type" "text" NOT NULL,
    "project_id" "text",
    "offer_id" "text",
    "job_id" "text",
    "phase" "text",
    "customer_user_id" "uuid",
    "craftsman_user_id" "uuid",
    "created_at" bigint DEFAULT 0 NOT NULL,
    "updated_at" bigint DEFAULT 0 NOT NULL,
    "snapshot_title" "text",
    "snapshot_status" "text",
    "snapshot_price" "text",
    "snapshot_summary" "text",
    "snapshot_phase_label" "text",
    "snapshot_category" "text",
    "snapshot_location" "text",
    "snapshot_budget" "text",
    "snapshot_timing" "text",
    "funding_request_id" "uuid",
    "escrow_plan_id" "uuid",
    "snapshot_document_type" "text",
    "snapshot_version" integer,
    "snapshot_valid_until" "text",
    "change_order_id" "uuid",
    CONSTRAINT "thread_artifacts_artifact_type_check" CHECK (("artifact_type" = ANY (ARRAY['project'::"text", 'offer'::"text", 'payment_phase'::"text", 'funding_step'::"text", 'change_order'::"text"])))
);


ALTER TABLE "public"."thread_artifacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."timeline_signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "type" "text" DEFAULT ''::"text" NOT NULL,
    "occurred_at" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."timeline_signals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_blocks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "blocker_id" "uuid" NOT NULL,
    "blocked_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "blocks_no_self_block" CHECK (("blocker_id" <> "blocked_id"))
);


ALTER TABLE "public"."user_blocks" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_blocks" IS 'Bidirectional block relationships between users.';



CREATE TABLE IF NOT EXISTS "public"."user_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reporter_id" "uuid" NOT NULL,
    "reported_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "details" "text",
    "context_type" "text",
    "context_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "operator_notes" "text",
    CONSTRAINT "reports_no_self_report" CHECK (("reporter_id" <> "reported_id"))
);


ALTER TABLE "public"."user_reports" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_reports" IS 'User-submitted reports against other users for safety review.';



CREATE OR REPLACE VIEW "public"."visible_discovery_providers" AS
 SELECT "provider_id",
    "profile_id",
    "company_name",
    "description",
    "city",
    "trade_categories",
    "avatar_url",
    "rating",
    "verified",
    "is_public",
    "provider_created_at",
    "provider_updated_at",
    "display_name",
    "phone",
    "role",
    "craftsman_role",
    "onboarding_done"
   FROM "public"."discovery_providers"
  WHERE (("is_public" = true) AND ("onboarding_done" = true));


ALTER VIEW "public"."visible_discovery_providers" OWNER TO "postgres";


ALTER TABLE ONLY "public"."email_delivery_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."email_delivery_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."acceptances"
    ADD CONSTRAINT "acceptances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."analytics_events"
    ADD CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."attribution_audit_log"
    ADD CONSTRAINT "attribution_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "blocks_unique_pair" UNIQUE ("blocker_id", "blocked_id");



ALTER TABLE ONLY "public"."calendar_entries"
    ADD CONSTRAINT "calendar_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_join_codes"
    ADD CONSTRAINT "company_join_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."correction_requests"
    ADD CONSTRAINT "correction_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."craftsman_subscriptions"
    ADD CONSTRAINT "craftsman_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."craftsman_subscriptions"
    ADD CONSTRAINT "craftsman_subscriptions_profile_id_key" UNIQUE ("profile_id");



ALTER TABLE ONLY "public"."customer_provider_relationships"
    ADD CONSTRAINT "customer_provider_relationships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_provider_relationships"
    ADD CONSTRAINT "customer_provider_relationships_unique" UNIQUE ("customer_user_id", "craftsman_user_id");



ALTER TABLE ONLY "public"."customer_request_sends"
    ADD CONSTRAINT "customer_request_sends_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dispute_evidence"
    ADD CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dispute_status_history"
    ADD CONSTRAINT "dispute_status_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_delivery_log"
    ADD CONSTRAINT "email_delivery_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_payment_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_plans_source_offer_unique" UNIQUE ("source_offer_id");



ALTER TABLE ONLY "public"."escrow_tranches"
    ADD CONSTRAINT "escrow_tranches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."escrow_tranches"
    ADD CONSTRAINT "escrow_tranches_plan_kind_unique" UNIQUE ("plan_id", "kind");



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_escrow_plan_unique" UNIQUE ("escrow_plan_id");



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."internal_messages"
    ADD CONSTRAINT "internal_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_assignments"
    ADD CONSTRAINT "job_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_feedback"
    ADD CONSTRAINT "job_feedback_job_id_key" UNIQUE ("job_id");



ALTER TABLE ONLY "public"."job_feedback"
    ADD CONSTRAINT "job_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_payment_entrytype_unique" UNIQUE ("payment_id", "entry_type");



ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_artifacts"
    ADD CONSTRAINT "media_artifacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_uploads"
    ADD CONSTRAINT "media_uploads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_thread_participants"
    ADD CONSTRAINT "message_thread_participants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_thread_participants"
    ADD CONSTRAINT "message_thread_participants_thread_id_team_member_id_key" UNIQUE ("thread_id", "team_member_id");



ALTER TABLE ONLY "public"."message_threads"
    ADD CONSTRAINT "message_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_signals"
    ADD CONSTRAINT "notification_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operator_action_audit"
    ADD CONSTRAINT "operator_action_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_status_history"
    ADD CONSTRAINT "payment_status_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_media_likes"
    ADD CONSTRAINT "provider_media_likes_media_id_user_id_key" UNIQUE ("media_id", "user_id");



ALTER TABLE ONLY "public"."provider_media_likes"
    ADD CONSTRAINT "provider_media_likes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_media"
    ADD CONSTRAINT "provider_media_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_payout_accounts"
    ADD CONSTRAINT "provider_payout_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_handle_unique" UNIQUE ("handle");



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_profile_id_unique" UNIQUE ("profile_id");



ALTER TABLE ONLY "public"."ratings"
    ADD CONSTRAINT "ratings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_events"
    ADD CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_webhook_events"
    ADD CONSTRAINT "stripe_webhook_events_event_id_key" UNIQUE ("event_id");



ALTER TABLE ONLY "public"."stripe_webhook_events"
    ADD CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplementary_payment_requests"
    ADD CONSTRAINT "supplementary_payment_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."thread_artifacts"
    ADD CONSTRAINT "thread_artifacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."timeline_signals"
    ADD CONSTRAINT "timeline_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_threads"
    ADD CONSTRAINT "uq_assignment_thread" UNIQUE ("calendar_entry_id");



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_pkey" PRIMARY KEY ("id");



CREATE INDEX "customer_request_sends_user_date_idx" ON "public"."customer_request_sends" USING "btree" ("user_id", "sent_date");



CREATE INDEX "dispute_evidence_dispute_id_idx" ON "public"."dispute_evidence" USING "btree" ("dispute_id");



CREATE INDEX "dispute_evidence_uploaded_by_profile_id_idx" ON "public"."dispute_evidence" USING "btree" ("uploaded_by_profile_id");



CREATE INDEX "dispute_status_history_created_at_idx" ON "public"."dispute_status_history" USING "btree" ("created_at");



CREATE INDEX "dispute_status_history_dispute_id_idx" ON "public"."dispute_status_history" USING "btree" ("dispute_id");



CREATE INDEX "disputes_created_at_idx" ON "public"."disputes" USING "btree" ("created_at");



CREATE INDEX "disputes_customer_profile_id_idx" ON "public"."disputes" USING "btree" ("customer_profile_id");



CREATE INDEX "disputes_job_id_idx" ON "public"."disputes" USING "btree" ("job_id");



CREATE UNIQUE INDEX "disputes_one_active_per_job_idx" ON "public"."disputes" USING "btree" ("job_id") WHERE ("status" = ANY (ARRAY['open'::"text", 'under_review'::"text", 'customer_waiting'::"text", 'provider_waiting'::"text"]));



CREATE INDEX "disputes_opened_by_profile_id_idx" ON "public"."disputes" USING "btree" ("opened_by_profile_id");



CREATE INDEX "disputes_payment_id_idx" ON "public"."disputes" USING "btree" ("payment_id");



CREATE INDEX "disputes_project_id_idx" ON "public"."disputes" USING "btree" ("project_id");



CREATE INDEX "disputes_provider_id_idx" ON "public"."disputes" USING "btree" ("provider_id");



CREATE INDEX "disputes_status_idx" ON "public"."disputes" USING "btree" ("status");



CREATE INDEX "idx_acceptances_customer_user_id" ON "public"."acceptances" USING "btree" ("customer_user_id");



CREATE INDEX "idx_acceptances_job_id" ON "public"."acceptances" USING "btree" ("job_id");



CREATE INDEX "idx_acceptances_pending_expires" ON "public"."acceptances" USING "btree" ("expires_at") WHERE (("status" = 'pending'::"text") AND ("expires_at" IS NOT NULL));



CREATE INDEX "idx_analytics_events_created_at" ON "public"."analytics_events" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_analytics_events_event_type" ON "public"."analytics_events" USING "btree" ("event_type");



CREATE INDEX "idx_attribution_audit_log_event_type_created_at" ON "public"."attribution_audit_log" USING "btree" ("event_type", "created_at" DESC);



CREATE INDEX "idx_attribution_audit_log_job_id" ON "public"."attribution_audit_log" USING "btree" ("job_id", "created_at" DESC);



CREATE INDEX "idx_change_orders_craftsman_user_id" ON "public"."change_orders" USING "btree" ("craftsman_user_id");



CREATE INDEX "idx_change_orders_customer_user_id" ON "public"."change_orders" USING "btree" ("customer_user_id");



CREATE INDEX "idx_change_orders_job_id" ON "public"."change_orders" USING "btree" ("job_id");



CREATE UNIQUE INDEX "idx_company_join_codes_code_active" ON "public"."company_join_codes" USING "btree" ("code") WHERE ("is_active" = true);



CREATE UNIQUE INDEX "idx_company_join_codes_provider_active" ON "public"."company_join_codes" USING "btree" ("provider_id") WHERE ("is_active" = true);



CREATE INDEX "idx_company_join_codes_provider_id" ON "public"."company_join_codes" USING "btree" ("provider_id");



CREATE INDEX "idx_conversations_craftsman_user_id" ON "public"."conversations" USING "btree" ("craftsman_user_id") WHERE ("craftsman_user_id" IS NOT NULL);



CREATE INDEX "idx_conversations_created_at" ON "public"."conversations" USING "btree" ("created_at");



CREATE INDEX "idx_conversations_customer_user_id" ON "public"."conversations" USING "btree" ("customer_user_id") WHERE ("customer_user_id" IS NOT NULL);



CREATE INDEX "idx_correction_requests_provider_id" ON "public"."correction_requests" USING "btree" ("provider_id");



CREATE INDEX "idx_correction_requests_status" ON "public"."correction_requests" USING "btree" ("status");



CREATE INDEX "idx_correction_requests_worker_profile_id" ON "public"."correction_requests" USING "btree" ("worker_profile_id");



CREATE INDEX "idx_cpr_craftsman" ON "public"."customer_provider_relationships" USING "btree" ("craftsman_user_id");



CREATE INDEX "idx_cpr_customer" ON "public"."customer_provider_relationships" USING "btree" ("customer_user_id");



CREATE INDEX "idx_craftsman_subscriptions_profile_id" ON "public"."craftsman_subscriptions" USING "btree" ("profile_id");



CREATE INDEX "idx_craftsman_subscriptions_status" ON "public"."craftsman_subscriptions" USING "btree" ("status");



CREATE INDEX "idx_dispute_status_history_dispute_id" ON "public"."dispute_status_history" USING "btree" ("dispute_id");



CREATE INDEX "idx_dispute_status_history_job_id" ON "public"."dispute_status_history" USING "btree" ("job_id");



CREATE INDEX "idx_email_delivery_log_job_id" ON "public"."email_delivery_log" USING "btree" ("job_id");



CREATE INDEX "idx_email_delivery_log_success" ON "public"."email_delivery_log" USING "btree" ("success") WHERE ("success" = false);



CREATE INDEX "idx_escrow_plans_customer" ON "public"."escrow_payment_plans" USING "btree" ("customer_user_id");



CREATE UNIQUE INDEX "idx_escrow_plans_idempotency_key" ON "public"."escrow_payment_plans" USING "btree" ("funding_idempotency_key") WHERE ("funding_idempotency_key" IS NOT NULL);



CREATE INDEX "idx_escrow_plans_job_id" ON "public"."escrow_payment_plans" USING "btree" ("job_id");



CREATE INDEX "idx_escrow_plans_provider" ON "public"."escrow_payment_plans" USING "btree" ("provider_id");



CREATE INDEX "idx_escrow_tranches_plan_id" ON "public"."escrow_tranches" USING "btree" ("plan_id");



CREATE INDEX "idx_funding_requests_active_expires" ON "public"."funding_requests" USING "btree" ("expires_at") WHERE ("status" <> ALL (ARRAY['funded'::"text", 'cancelled'::"text", 'expired'::"text"]));



CREATE INDEX "idx_funding_requests_customer" ON "public"."funding_requests" USING "btree" ("customer_user_id");



CREATE INDEX "idx_funding_requests_external_ref" ON "public"."funding_requests" USING "btree" ("external_funding_ref") WHERE ("external_funding_ref" IS NOT NULL);



CREATE UNIQUE INDEX "idx_funding_requests_idempotency_key" ON "public"."funding_requests" USING "btree" ("funding_idempotency_key") WHERE ("funding_idempotency_key" IS NOT NULL);



CREATE INDEX "idx_funding_requests_job_id" ON "public"."funding_requests" USING "btree" ("job_id");



CREATE INDEX "idx_funding_requests_provider" ON "public"."funding_requests" USING "btree" ("provider_id");



CREATE INDEX "idx_funding_requests_provider_id" ON "public"."funding_requests" USING "btree" ("provider_id") WHERE ("provider_id" IS NOT NULL);



CREATE INDEX "idx_funding_requests_source_offer_id" ON "public"."funding_requests" USING "btree" ("source_offer_id");



CREATE INDEX "idx_imsg_thread_time" ON "public"."internal_messages" USING "btree" ("thread_id", "created_at");



CREATE INDEX "idx_jobs_attribution_status" ON "public"."jobs" USING "btree" ("attribution_status") WHERE ("attribution_status" = ANY (ARRAY['pending'::"text", 'retrying'::"text", 'dlq'::"text"]));



CREATE INDEX "idx_jobs_commercial_origin" ON "public"."jobs" USING "btree" ("commercial_origin") WHERE ("commercial_origin" IS NOT NULL);



CREATE INDEX "idx_jobs_craftsman_user_id" ON "public"."jobs" USING "btree" ("craftsman_user_id");



CREATE INDEX "idx_jobs_funding_requested_at" ON "public"."jobs" USING "btree" ("funding_requested_at") WHERE ("funding_requested_at" IS NOT NULL);



CREATE INDEX "idx_jobs_project_id" ON "public"."jobs" USING "btree" ("project_id");



CREATE INDEX "idx_jobs_source_conversation_id" ON "public"."jobs" USING "btree" ("source_conversation_id");



CREATE INDEX "idx_jobs_source_offer_id" ON "public"."jobs" USING "btree" ("source_offer_id") WHERE ("source_offer_id" IS NOT NULL);



CREATE INDEX "idx_jobs_status" ON "public"."jobs" USING "btree" ("status");



CREATE INDEX "idx_jobs_work_completed_at" ON "public"."jobs" USING "btree" ("work_completed_at") WHERE ("work_completed_at" IS NOT NULL);



CREATE INDEX "idx_jobs_work_started_at" ON "public"."jobs" USING "btree" ("work_started_at") WHERE ("work_started_at" IS NOT NULL);



CREATE INDEX "idx_ledger_entries_dispute_id" ON "public"."ledger_entries" USING "btree" ("dispute_id") WHERE ("dispute_id" IS NOT NULL);



CREATE INDEX "idx_ledger_entries_job_id" ON "public"."ledger_entries" USING "btree" ("job_id");



CREATE INDEX "idx_ledger_entries_payment_id" ON "public"."ledger_entries" USING "btree" ("payment_id");



CREATE INDEX "idx_ledger_entries_type" ON "public"."ledger_entries" USING "btree" ("entry_type");



CREATE INDEX "idx_message_threads_calendar_entry" ON "public"."message_threads" USING "btree" ("calendar_entry_id") WHERE ("calendar_entry_id" IS NOT NULL);



CREATE INDEX "idx_message_threads_provider" ON "public"."message_threads" USING "btree" ("provider_id");



CREATE INDEX "idx_messages_conversation_id" ON "public"."messages" USING "btree" ("conversation_id");



CREATE INDEX "idx_messages_order" ON "public"."messages" USING "btree" ("conversation_id", "created_at");



CREATE INDEX "idx_mtp_member" ON "public"."message_thread_participants" USING "btree" ("team_member_id");



CREATE INDEX "idx_mtp_thread" ON "public"."message_thread_participants" USING "btree" ("thread_id");



CREATE INDEX "idx_offers_conversation_id" ON "public"."offers" USING "btree" ("conversation_id");



CREATE INDEX "idx_offers_craftsman_user_id" ON "public"."offers" USING "btree" ("craftsman_user_id");



CREATE INDEX "idx_offers_customer_user_id" ON "public"."offers" USING "btree" ("customer_user_id");



CREATE INDEX "idx_payments_job_id" ON "public"."payments" USING "btree" ("job_id");



CREATE INDEX "idx_payments_provider_ref" ON "public"."payments" USING "btree" ("provider_ref") WHERE ("provider_ref" IS NOT NULL);



CREATE INDEX "idx_payments_provider_stripe_account" ON "public"."payments" USING "btree" ("provider_stripe_account_id") WHERE ("provider_stripe_account_id" IS NOT NULL);



CREATE INDEX "idx_payments_status" ON "public"."payments" USING "btree" ("status");



CREATE INDEX "idx_projects_commercial_origin" ON "public"."projects" USING "btree" ("commercial_origin") WHERE ("commercial_origin" IS NOT NULL);



CREATE INDEX "idx_projects_source_job_id" ON "public"."projects" USING "btree" ("source_job_id");



CREATE INDEX "idx_projects_status" ON "public"."projects" USING "btree" ("status");



CREATE INDEX "idx_provider_media_likes_media_id" ON "public"."provider_media_likes" USING "btree" ("media_id");



CREATE INDEX "idx_provider_media_likes_user_id" ON "public"."provider_media_likes" USING "btree" ("user_id");



CREATE INDEX "idx_provider_media_portfolio" ON "public"."provider_media" USING "btree" ("provider_id", "kind", "sort_order") WHERE ("kind" = 'portfolio'::"text");



CREATE UNIQUE INDEX "idx_provider_media_provider_kind_singular" ON "public"."provider_media" USING "btree" ("provider_id", "kind") WHERE ("kind" <> 'portfolio'::"text");



CREATE INDEX "idx_stripe_webhook_events_payment_intent_id" ON "public"."stripe_webhook_events" USING "btree" ("payment_intent_id") WHERE ("payment_intent_id" IS NOT NULL);



CREATE INDEX "idx_stripe_webhook_events_processed_at" ON "public"."stripe_webhook_events" USING "btree" ("processed_at" DESC);



CREATE UNIQUE INDEX "idx_team_members_provider_profile_unique" ON "public"."team_members" USING "btree" ("provider_id", "profile_id") WHERE ("profile_id" IS NOT NULL);



CREATE INDEX "idx_thread_artifacts_change_order" ON "public"."thread_artifacts" USING "btree" ("change_order_id") WHERE ("change_order_id" IS NOT NULL);



CREATE INDEX "idx_thread_artifacts_conversation" ON "public"."thread_artifacts" USING "btree" ("conversation_id");



CREATE INDEX "idx_thread_artifacts_escrow_plan" ON "public"."thread_artifacts" USING "btree" ("escrow_plan_id") WHERE ("escrow_plan_id" IS NOT NULL);



CREATE INDEX "idx_thread_artifacts_funding_request" ON "public"."thread_artifacts" USING "btree" ("funding_request_id") WHERE ("funding_request_id" IS NOT NULL);



CREATE INDEX "idx_thread_artifacts_offer" ON "public"."thread_artifacts" USING "btree" ("offer_id") WHERE ("offer_id" IS NOT NULL);



CREATE UNIQUE INDEX "idx_thread_artifacts_offer_single" ON "public"."thread_artifacts" USING "btree" ("conversation_id", "artifact_type") WHERE ("artifact_type" = 'offer'::"text");



CREATE UNIQUE INDEX "idx_thread_artifacts_payment_phase_single" ON "public"."thread_artifacts" USING "btree" ("conversation_id", "artifact_type") WHERE ("artifact_type" = 'payment_phase'::"text");



CREATE INDEX "idx_thread_artifacts_project" ON "public"."thread_artifacts" USING "btree" ("project_id") WHERE ("project_id" IS NOT NULL);



CREATE INDEX "idx_user_blocks_blocked" ON "public"."user_blocks" USING "btree" ("blocked_id");



CREATE INDEX "idx_user_blocks_blocker" ON "public"."user_blocks" USING "btree" ("blocker_id");



CREATE INDEX "idx_user_reports_reported" ON "public"."user_reports" USING "btree" ("reported_id");



CREATE INDEX "idx_user_reports_reporter" ON "public"."user_reports" USING "btree" ("reporter_id");



CREATE INDEX "idx_user_reports_status" ON "public"."user_reports" USING "btree" ("status");



CREATE INDEX "index_operator_action_audit_created" ON "public"."operator_action_audit" USING "btree" ("created_at");



CREATE INDEX "index_operator_action_audit_operator" ON "public"."operator_action_audit" USING "btree" ("operator_id");



CREATE INDEX "job_assignments_job_id_idx" ON "public"."job_assignments" USING "btree" ("job_id");



CREATE UNIQUE INDEX "job_assignments_one_primary_per_job_idx" ON "public"."job_assignments" USING "btree" ("job_id") WHERE (("assignment_role" = 'primary'::"text") AND ("status" = ANY (ARRAY['assigned'::"text", 'accepted'::"text"])));



CREATE INDEX "job_assignments_provider_id_idx" ON "public"."job_assignments" USING "btree" ("provider_id");



CREATE INDEX "job_assignments_status_idx" ON "public"."job_assignments" USING "btree" ("status");



CREATE INDEX "job_assignments_team_member_id_idx" ON "public"."job_assignments" USING "btree" ("team_member_id");



CREATE INDEX "jobs_assigned_provider_id_idx" ON "public"."jobs" USING "btree" ("assigned_provider_id");



CREATE INDEX "jobs_assigned_team_member_id_idx" ON "public"."jobs" USING "btree" ("assigned_team_member_id");



CREATE INDEX "jobs_assignment_status_idx" ON "public"."jobs" USING "btree" ("assignment_status");



CREATE INDEX "jobs_city_idx" ON "public"."jobs" USING "btree" ("city");



CREATE INDEX "jobs_created_at_idx" ON "public"."jobs" USING "btree" ("created_at");



CREATE INDEX "jobs_customer_profile_id_idx" ON "public"."jobs" USING "btree" ("customer_profile_id");



CREATE INDEX "jobs_customer_user_id_idx" ON "public"."jobs" USING "btree" ("customer_user_id");



CREATE INDEX "jobs_dispute_id_idx" ON "public"."jobs" USING "btree" ("dispute_id");



CREATE INDEX "jobs_dispute_status_idx" ON "public"."jobs" USING "btree" ("dispute_status");



CREATE INDEX "jobs_provider_id_idx" ON "public"."jobs" USING "btree" ("provider_id");



CREATE INDEX "jobs_scheduled_for_idx" ON "public"."jobs" USING "btree" ("scheduled_for");



CREATE INDEX "jobs_status_idx" ON "public"."jobs" USING "btree" ("status");



CREATE INDEX "ledger_entries_dispute_idx" ON "public"."ledger_entries" USING "btree" ("dispute_id");



CREATE INDEX "ledger_entries_job_idx" ON "public"."ledger_entries" USING "btree" ("job_id");



CREATE INDEX "ledger_entries_payment_idx" ON "public"."ledger_entries" USING "btree" ("payment_id");



CREATE INDEX "ledger_entries_type_idx" ON "public"."ledger_entries" USING "btree" ("entry_type");



CREATE INDEX "offers_source_diagnosis_id_idx" ON "public"."offers" USING "btree" ("source_diagnosis_id") WHERE ("source_diagnosis_id" IS NOT NULL);



CREATE INDEX "payment_status_history_created_at_idx" ON "public"."payment_status_history" USING "btree" ("created_at");



CREATE INDEX "payment_status_history_payment_id_idx" ON "public"."payment_status_history" USING "btree" ("payment_id");



CREATE INDEX "payment_status_history_stripe_event_id_idx" ON "public"."payment_status_history" USING "btree" ("stripe_event_id");



CREATE INDEX "payments_amount_disputed_idx" ON "public"."payments" USING "btree" ("amount_disputed");



CREATE INDEX "payments_amount_released_idx" ON "public"."payments" USING "btree" ("amount_released");



CREATE INDEX "payments_created_at_idx" ON "public"."payments" USING "btree" ("created_at");



CREATE INDEX "payments_customer_profile_id_idx" ON "public"."payments" USING "btree" ("customer_profile_id");



CREATE INDEX "payments_dispute_id_idx" ON "public"."payments" USING "btree" ("dispute_id");



CREATE INDEX "payments_dispute_status_idx" ON "public"."payments" USING "btree" ("dispute_status");



CREATE INDEX "payments_job_id_idx" ON "public"."payments" USING "btree" ("job_id");



CREATE INDEX "payments_last_stripe_event_id_idx" ON "public"."payments" USING "btree" ("last_stripe_event_id");



CREATE INDEX "payments_project_id_idx" ON "public"."payments" USING "btree" ("project_id");



CREATE INDEX "payments_provider_id_idx" ON "public"."payments" USING "btree" ("provider_id");



CREATE INDEX "payments_provider_idx" ON "public"."payments" USING "btree" ("payment_provider");



CREATE INDEX "payments_reconciled_at_idx" ON "public"."payments" USING "btree" ("reconciled_at");



CREATE INDEX "payments_release_blocked_idx" ON "public"."payments" USING "btree" ("release_blocked");



CREATE INDEX "payments_status_idx" ON "public"."payments" USING "btree" ("status");



CREATE UNIQUE INDEX "payments_stripe_checkout_session_id_unique_idx" ON "public"."payments" USING "btree" ("stripe_checkout_session_id") WHERE ("stripe_checkout_session_id" IS NOT NULL);



CREATE INDEX "payments_stripe_payment_intent_id_idx" ON "public"."payments" USING "btree" ("stripe_payment_intent_id");



CREATE UNIQUE INDEX "payments_stripe_payment_intent_id_unique_idx" ON "public"."payments" USING "btree" ("stripe_payment_intent_id") WHERE ("stripe_payment_intent_id" IS NOT NULL);



CREATE INDEX "payments_stripe_status_idx" ON "public"."payments" USING "btree" ("stripe_status");



CREATE INDEX "profiles_craftsman_role_idx" ON "public"."profiles" USING "btree" ("craftsman_role");



CREATE INDEX "profiles_onboarding_done_idx" ON "public"."profiles" USING "btree" ("onboarding_done");



CREATE INDEX "profiles_role_idx" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "projects_craftsman_user_id_idx" ON "public"."projects" USING "btree" ("craftsman_user_id");



CREATE INDEX "projects_customer_profile_id_idx" ON "public"."projects" USING "btree" ("customer_profile_id");



CREATE INDEX "provider_media_kind_idx" ON "public"."provider_media" USING "btree" ("kind");



CREATE INDEX "provider_media_provider_id_idx" ON "public"."provider_media" USING "btree" ("provider_id");



CREATE INDEX "provider_media_sort_order_idx" ON "public"."provider_media" USING "btree" ("provider_id", "sort_order");



CREATE UNIQUE INDEX "provider_payout_accounts_provider_user_id_idx" ON "public"."provider_payout_accounts" USING "btree" ("provider_user_id");



CREATE INDEX "providers_city_idx" ON "public"."providers" USING "btree" ("city");



CREATE INDEX "providers_company_name_idx" ON "public"."providers" USING "btree" ("company_name");



CREATE UNIQUE INDEX "providers_handle_unique_idx" ON "public"."providers" USING "btree" ("handle") WHERE ("handle" IS NOT NULL);



CREATE INDEX "providers_is_public_idx" ON "public"."providers" USING "btree" ("is_public");



CREATE INDEX "providers_profile_id_idx" ON "public"."providers" USING "btree" ("profile_id");



CREATE INDEX "providers_search_idx" ON "public"."providers" USING "gin" ("search_vector");



CREATE INDEX "providers_search_vector_idx" ON "public"."providers" USING "gin" ("search_vector");



CREATE UNIQUE INDEX "providers_slug_unique_idx" ON "public"."providers" USING "btree" ("slug") WHERE ("slug" IS NOT NULL);



CREATE INDEX "stripe_events_checkout_session_id_idx" ON "public"."stripe_events" USING "btree" ("checkout_session_id");



CREATE INDEX "stripe_events_event_type_idx" ON "public"."stripe_events" USING "btree" ("event_type");



CREATE INDEX "stripe_events_payment_intent_id_idx" ON "public"."stripe_events" USING "btree" ("payment_intent_id");



CREATE INDEX "stripe_events_processing_status_idx" ON "public"."stripe_events" USING "btree" ("processing_status");



CREATE INDEX "stripe_events_received_at_idx" ON "public"."stripe_events" USING "btree" ("received_at");



CREATE UNIQUE INDEX "stripe_events_stripe_event_id_unique_idx" ON "public"."stripe_events" USING "btree" ("stripe_event_id");



CREATE UNIQUE INDEX "stripe_webhook_events_event_id_unique_idx" ON "public"."stripe_webhook_events" USING "btree" ("stripe_event_id");



CREATE INDEX "stripe_webhook_events_payment_intent_idx" ON "public"."stripe_webhook_events" USING "btree" ("payment_intent_id");



CREATE INDEX "stripe_webhook_events_status_idx" ON "public"."stripe_webhook_events" USING "btree" ("processing_status");



CREATE UNIQUE INDEX "supplementary_payment_requests_change_order_id_key" ON "public"."supplementary_payment_requests" USING "btree" ("change_order_id");



CREATE INDEX "supplementary_payment_requests_craftsman_idx" ON "public"."supplementary_payment_requests" USING "btree" ("craftsman_user_id");



CREATE INDEX "supplementary_payment_requests_customer_idx" ON "public"."supplementary_payment_requests" USING "btree" ("customer_user_id");



CREATE INDEX "supplementary_payment_requests_external_ref_idx" ON "public"."supplementary_payment_requests" USING "btree" ("external_ref") WHERE ("external_ref" IS NOT NULL);



CREATE INDEX "supplementary_payment_requests_job_id_idx" ON "public"."supplementary_payment_requests" USING "btree" ("job_id");



CREATE INDEX "supplementary_payment_requests_payout_ref_idx" ON "public"."supplementary_payment_requests" USING "btree" ("external_payout_ref") WHERE ("external_payout_ref" IS NOT NULL);



CREATE INDEX "team_members_is_active_idx" ON "public"."team_members" USING "btree" ("is_active");



CREATE INDEX "team_members_profile_id_idx" ON "public"."team_members" USING "btree" ("profile_id");



CREATE INDEX "team_members_provider_id_idx" ON "public"."team_members" USING "btree" ("provider_id");



CREATE UNIQUE INDEX "team_members_unique_provider_profile_idx" ON "public"."team_members" USING "btree" ("provider_id", "profile_id") WHERE ("profile_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_acceptances_job_accepted" ON "public"."acceptances" USING "btree" ("job_id") WHERE ("status" = 'accepted'::"text");



CREATE UNIQUE INDEX "uq_acceptances_job_pending" ON "public"."acceptances" USING "btree" ("job_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "uq_offers_one_pending_per_conversation" ON "public"."offers" USING "btree" ("conversation_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "uq_office_team_threads" ON "public"."message_threads" USING "btree" ("provider_id", "thread_type") WHERE ("thread_type" = ANY (ARRAY['office'::"text", 'team'::"text"]));



CREATE OR REPLACE TRIGGER "assert_attribution_finalized_before_release_supplementary" BEFORE INSERT OR UPDATE ON "public"."supplementary_payment_requests" FOR EACH ROW EXECUTE FUNCTION "public"."assert_attribution_finalized_before_release"();



CREATE OR REPLACE TRIGGER "assert_attribution_finalized_before_release_tranche" BEFORE INSERT OR UPDATE ON "public"."escrow_tranches" FOR EACH ROW EXECUTE FUNCTION "public"."assert_attribution_finalized_before_release"();



CREATE OR REPLACE TRIGGER "assign_invoice_number" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."generate_invoice_number"();



CREATE OR REPLACE TRIGGER "disputes_status_change_guard_tg" BEFORE UPDATE ON "public"."disputes" FOR EACH ROW EXECUTE FUNCTION "public"."disputes_status_change_guard"();



CREATE OR REPLACE TRIGGER "providers_search_vector_trigger" BEFORE INSERT OR UPDATE ON "public"."providers" FOR EACH ROW EXECUTE FUNCTION "public"."update_provider_search_vector"();



CREATE OR REPLACE TRIGGER "set_disputes_updated_at" BEFORE UPDATE ON "public"."disputes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_job_assignments_updated_at" BEFORE UPDATE ON "public"."job_assignments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_jobs_updated_at" BEFORE UPDATE ON "public"."jobs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_payments_updated_at" BEFORE UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_provider_media_updated_at" BEFORE UPDATE ON "public"."provider_media" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_providers_updated_at" BEFORE UPDATE ON "public"."providers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_team_members_updated_at" BEFORE UPDATE ON "public"."team_members" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_internal_message_last_message" AFTER INSERT ON "public"."internal_messages" FOR EACH ROW EXECUTE FUNCTION "public"."fn_update_thread_last_message"();



ALTER TABLE ONLY "public"."acceptances"
    ADD CONSTRAINT "acceptances_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."acceptances"
    ADD CONSTRAINT "acceptances_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."acceptances"
    ADD CONSTRAINT "acceptances_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."attribution_audit_log"
    ADD CONSTRAINT "attribution_audit_log_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_entries"
    ADD CONSTRAINT "calendar_entries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."company_join_codes"
    ADD CONSTRAINT "company_join_codes_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."correction_requests"
    ADD CONSTRAINT "correction_requests_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."craftsman_subscriptions"
    ADD CONSTRAINT "craftsman_subscriptions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_provider_relationships"
    ADD CONSTRAINT "customer_provider_relationships_craftsman_user_id_fkey" FOREIGN KEY ("craftsman_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_provider_relationships"
    ADD CONSTRAINT "customer_provider_relationships_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_request_sends"
    ADD CONSTRAINT "customer_request_sends_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dispute_evidence"
    ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dispute_evidence"
    ADD CONSTRAINT "dispute_evidence_uploaded_by_profile_id_fkey" FOREIGN KEY ("uploaded_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dispute_status_history"
    ADD CONSTRAINT "dispute_status_history_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_customer_profile_id_fkey" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_opened_by_profile_id_fkey" FOREIGN KEY ("opened_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_payment_plans_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_payment_plans_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_payment_plans_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."escrow_tranches"
    ADD CONSTRAINT "escrow_tranches_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."escrow_payment_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "fk_conversation" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_escrow_plan_id_fkey" FOREIGN KEY ("escrow_plan_id") REFERENCES "public"."escrow_payment_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."internal_messages"
    ADD CONSTRAINT "internal_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_assignments"
    ADD CONSTRAINT "job_assignments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_assignments"
    ADD CONSTRAINT "job_assignments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_assignments"
    ADD CONSTRAINT "job_assignments_team_member_id_fkey" FOREIGN KEY ("team_member_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_feedback"
    ADD CONSTRAINT "job_feedback_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_assigned_provider_id_fkey" FOREIGN KEY ("assigned_provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_assigned_team_member_id_fkey" FOREIGN KEY ("assigned_team_member_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_customer_profile_id_fkey" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."media_artifacts"
    ADD CONSTRAINT "media_artifacts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_thread_participants"
    ADD CONSTRAINT "message_thread_participants_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_threads"
    ADD CONSTRAINT "message_threads_calendar_entry_id_fkey" FOREIGN KEY ("calendar_entry_id") REFERENCES "public"."calendar_entries"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_threads"
    ADD CONSTRAINT "message_threads_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_signals"
    ADD CONSTRAINT "notification_signals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_craftsman_user_id_fkey" FOREIGN KEY ("craftsman_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_created_job_id_fkey" FOREIGN KEY ("created_job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "public"."payment_status_history"
    ADD CONSTRAINT "payment_status_history_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_customer_profile_id_fkey" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_likes"
    ADD CONSTRAINT "provider_media_likes_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."provider_media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_likes"
    ADD CONSTRAINT "provider_media_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media"
    ADD CONSTRAINT "provider_media_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_payout_accounts"
    ADD CONSTRAINT "provider_payout_accounts_provider_user_id_fkey" FOREIGN KEY ("provider_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ratings"
    ADD CONSTRAINT "ratings_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplementary_payment_requests"
    ADD CONSTRAINT "supplementary_payment_requests_change_order_id_fkey" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_artifacts"
    ADD CONSTRAINT "thread_artifacts_change_order_id_fkey" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_artifacts"
    ADD CONSTRAINT "thread_artifacts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_artifacts"
    ADD CONSTRAINT "thread_artifacts_escrow_plan_id_fkey" FOREIGN KEY ("escrow_plan_id") REFERENCES "public"."escrow_payment_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."thread_artifacts"
    ADD CONSTRAINT "thread_artifacts_funding_request_id_fkey" FOREIGN KEY ("funding_request_id") REFERENCES "public"."funding_requests"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."timeline_signals"
    ADD CONSTRAINT "timeline_signals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



CREATE POLICY "Authenticated users can insert analytics events" ON "public"."analytics_events" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Authenticated users can insert dispute evidence" ON "public"."dispute_evidence" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Authenticated users can insert payment status history" ON "public"."payment_status_history" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Authenticated users can read dispute evidence" ON "public"."dispute_evidence" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read payment status history" ON "public"."payment_status_history" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read stripe events" ON "public"."stripe_events" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Job assignments: insert own provider" ON "public"."job_assignments" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "job_assignments"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Job assignments: read own provider" ON "public"."job_assignments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "job_assignments"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Job assignments: update own provider" ON "public"."job_assignments" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "job_assignments"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "job_assignments"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Jobs: insert own customer" ON "public"."jobs" FOR INSERT TO "authenticated" WITH CHECK (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "Jobs: read own customer or provider" ON "public"."jobs" FOR SELECT TO "authenticated" USING ((("customer_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."assigned_provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Jobs: read own team member" ON "public"."jobs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE (("tm"."provider_id" = "jobs"."provider_id") AND ("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true)))));



CREATE POLICY "Jobs: update own customer or provider" ON "public"."jobs" FOR UPDATE TO "authenticated" USING ((("customer_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."assigned_provider_id") AND ("p"."profile_id" = "auth"."uid"())))))) WITH CHECK ((("customer_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."assigned_provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Ledger: read own payment/job/dispute" ON "public"."ledger_entries" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."payments" "p"
  WHERE (("p"."id" = "ledger_entries"."payment_id") AND (("p"."customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pr"
          WHERE (("pr"."id" = "p"."provider_id") AND ("pr"."profile_id" = "auth"."uid"())))))))) OR (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "ledger_entries"."job_id") AND (("j"."customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pr"
          WHERE (("pr"."id" = "j"."provider_id") AND ("pr"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pr"
          WHERE (("pr"."id" = "j"."assigned_provider_id") AND ("pr"."profile_id" = "auth"."uid"())))))))) OR (EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE (("d"."id" = "ledger_entries"."dispute_id") AND (("d"."opened_by_profile_id" = "auth"."uid"()) OR ("d"."customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pr"
          WHERE (("pr"."id" = "d"."provider_id") AND ("pr"."profile_id" = "auth"."uid"()))))))))));



CREATE POLICY "Operators can insert own audit entries" ON "public"."operator_action_audit" FOR INSERT WITH CHECK (("operator_id" = "auth"."uid"()));



CREATE POLICY "Operators can read analytics events" ON "public"."analytics_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_operator" = true)))));



CREATE POLICY "Payments: insert own customer or provider" ON "public"."payments" FOR INSERT TO "authenticated" WITH CHECK ((("customer_profile_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"()) OR ("craftsman_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "payments"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Payments: read own customer or provider" ON "public"."payments" FOR SELECT TO "authenticated" USING ((("customer_profile_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"()) OR ("craftsman_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "payments"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Payments: update own customer or provider" ON "public"."payments" FOR UPDATE TO "authenticated" USING ((("customer_profile_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"()) OR ("craftsman_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "payments"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))))) WITH CHECK ((("customer_profile_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"()) OR ("craftsman_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "payments"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Profiles: read own" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "Profiles: update own" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "Projects: insert own" ON "public"."projects" FOR INSERT WITH CHECK ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"())));



CREATE POLICY "Projects: read own" ON "public"."projects" FOR SELECT USING ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "pr" ON (("pr"."id" = "j"."provider_id")))
  WHERE (("j"."id" = "projects"."source_job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("pr"."profile_id" = "auth"."uid"())))))));



CREATE POLICY "Projects: update own" ON "public"."projects" FOR UPDATE USING ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()))) WITH CHECK ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"())));



CREATE POLICY "Provider media: insert own provider" ON "public"."provider_media" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Provider media: update own provider" ON "public"."provider_media" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Providers: insert own" ON "public"."providers" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "Providers: read own" ON "public"."providers" FOR SELECT TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "Providers: update own" ON "public"."providers" FOR UPDATE TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "Public can read onboarded profiles" ON "public"."profiles" FOR SELECT USING (("onboarding_done" = true));



CREATE POLICY "Public can read provider media" ON "public"."provider_media" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media"."provider_id") AND ("p"."is_public" = true)))));



CREATE POLICY "Public can read visible providers" ON "public"."providers" FOR SELECT USING (("is_public" = true));



CREATE POLICY "Team members: insert own provider" ON "public"."team_members" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "team_members"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Team members: read own profile_id" ON "public"."team_members" FOR SELECT TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "Team members: read own provider" ON "public"."team_members" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "team_members"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Team members: update own provider" ON "public"."team_members" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "team_members"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "team_members"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can read own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."acceptances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "acceptances_craftsman_read" ON "public"."acceptances" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "acceptances"."job_id") AND (("j"."craftsman_user_id")::"uuid" = "auth"."uid"())))));



CREATE POLICY "acceptances_customer_insert" ON "public"."acceptances" FOR INSERT WITH CHECK (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "acceptances_customer_read" ON "public"."acceptances" FOR SELECT USING (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "acceptances_customer_update" ON "public"."acceptances" FOR UPDATE USING (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "acceptances_service_all" ON "public"."acceptances" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."analytics_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attribution_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attribution_audit_log_operator_read" ON "public"."attribution_audit_log" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" IS TRUE)))));



CREATE POLICY "authenticated_insert_relationships" ON "public"."customer_provider_relationships" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "blocked_users_read_block_record" ON "public"."user_blocks" FOR SELECT USING (("auth"."uid"() = "blocked_id"));



ALTER TABLE "public"."calendar_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "calendar_entries_owner_insert" ON "public"."calendar_entries" FOR INSERT WITH CHECK (((("provider_id" IS NOT NULL) AND ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) OR (("provider_id" IS NULL) AND ("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE ("jobs"."craftsman_user_id" = ("auth"."uid"())::"text"))))));



CREATE POLICY "calendar_entries_owner_select" ON "public"."calendar_entries" FOR SELECT USING (((("provider_id" IS NOT NULL) AND ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) OR (("provider_id" IS NULL) AND ("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE ("jobs"."craftsman_user_id" = ("auth"."uid"())::"text"))))));



CREATE POLICY "calendar_entries_owner_update" ON "public"."calendar_entries" FOR UPDATE USING (((("provider_id" IS NOT NULL) AND ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) OR (("provider_id" IS NULL) AND ("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE ("jobs"."craftsman_user_id" = ("auth"."uid"())::"text")))))) WITH CHECK (((("provider_id" IS NOT NULL) AND ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) OR (("provider_id" IS NULL) AND ("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE ("jobs"."craftsman_user_id" = ("auth"."uid"())::"text"))))));



CREATE POLICY "calendar_entries_worker_select" ON "public"."calendar_entries" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."provider_id" = "calendar_entries"."provider_id") AND ("calendar_entries"."assigned_member_ids" @> ARRAY[("tm"."id")::"text"])))));



CREATE POLICY "calendar_entries_worker_update" ON "public"."calendar_entries" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."provider_id" = "calendar_entries"."provider_id") AND ("calendar_entries"."assigned_member_ids" @> ARRAY[("tm"."id")::"text"])))));



ALTER TABLE "public"."change_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "change_orders_craftsman_insert" ON "public"."change_orders" FOR INSERT WITH CHECK (("craftsman_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_craftsman_read" ON "public"."change_orders" FOR SELECT USING (("craftsman_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_craftsman_update" ON "public"."change_orders" FOR UPDATE USING (("craftsman_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_customer_read" ON "public"."change_orders" FOR SELECT USING (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_customer_update" ON "public"."change_orders" FOR UPDATE USING (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_service_all" ON "public"."change_orders" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."company_join_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."correction_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "correction_requests_owner_select" ON "public"."correction_requests" FOR SELECT TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "correction_requests_owner_update" ON "public"."correction_requests" FOR UPDATE TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) WITH CHECK (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "correction_requests_worker_insert" ON "public"."correction_requests" FOR INSERT TO "authenticated" WITH CHECK (("worker_profile_id" = "auth"."uid"()));



CREATE POLICY "correction_requests_worker_select" ON "public"."correction_requests" FOR SELECT TO "authenticated" USING (("worker_profile_id" = "auth"."uid"()));



CREATE POLICY "craftsman_read_own_relationships" ON "public"."customer_provider_relationships" FOR SELECT USING (("craftsman_user_id" = "auth"."uid"()));



ALTER TABLE "public"."craftsman_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "craftsman_subscriptions_select_own" ON "public"."craftsman_subscriptions" FOR SELECT USING (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."customer_provider_relationships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_read_own_relationships" ON "public"."customer_provider_relationships" FOR SELECT USING (("customer_user_id" = "auth"."uid"()));



ALTER TABLE "public"."customer_request_sends" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_request_sends_insert_own" ON "public"."customer_request_sends" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "customer_request_sends_select_own" ON "public"."customer_request_sends" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."dispute_evidence" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dispute_history_insert_client_own_side" ON "public"."dispute_status_history" FOR INSERT TO "authenticated" WITH CHECK ((("source" = 'client'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE (("d"."id" = "dispute_status_history"."dispute_id") AND (("d"."opened_by_profile_id" = "auth"."uid"()) OR ("d"."customer_profile_id" = "auth"."uid"()) OR ("d"."provider_id" IN ( SELECT "providers"."id"
           FROM "public"."providers"
          WHERE ("providers"."profile_id" = "auth"."uid"())))))))));



CREATE POLICY "dispute_history_select_own_side" ON "public"."dispute_status_history" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE (("d"."id" = "dispute_status_history"."dispute_id") AND (("d"."opened_by_profile_id" = "auth"."uid"()) OR ("d"."customer_profile_id" = "auth"."uid"()) OR ("d"."provider_id" IN ( SELECT "providers"."id"
           FROM "public"."providers"
          WHERE ("providers"."profile_id" = "auth"."uid"()))))))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true))))));



ALTER TABLE "public"."dispute_status_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."disputes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "disputes_insert_own_side" ON "public"."disputes" FOR INSERT TO "authenticated" WITH CHECK ((("opened_by_profile_id" = "auth"."uid"()) AND ("job_id" IN ( SELECT "j"."id"
   FROM "public"."jobs" "j"
  WHERE (("j"."customer_user_id" = "auth"."uid"()) OR ("j"."customer_profile_id" = "auth"."uid"()) OR ("j"."craftsman_user_id" = ("auth"."uid"())::"text") OR ("j"."provider_id" IN ( SELECT "pr"."id"
           FROM "public"."providers" "pr"
          WHERE ("pr"."profile_id" = "auth"."uid"()))))))));



CREATE POLICY "disputes_select_own_side" ON "public"."disputes" FOR SELECT TO "authenticated" USING ((("opened_by_profile_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()) OR ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true))))));



CREATE POLICY "disputes_update_own_side" ON "public"."disputes" FOR UPDATE TO "authenticated" USING ((("opened_by_profile_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()) OR ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true)))))) WITH CHECK ((("opened_by_profile_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()) OR ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true))))));



ALTER TABLE "public"."email_delivery_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."escrow_payment_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "escrow_plans_customer_insert" ON "public"."escrow_payment_plans" FOR INSERT WITH CHECK (("auth"."uid"() = "customer_user_id"));



CREATE POLICY "escrow_plans_customer_read" ON "public"."escrow_payment_plans" FOR SELECT USING (("auth"."uid"() = "customer_user_id"));



CREATE POLICY "escrow_plans_customer_update" ON "public"."escrow_payment_plans" FOR UPDATE USING (("auth"."uid"() = "customer_user_id")) WITH CHECK (("auth"."uid"() = "customer_user_id"));



CREATE POLICY "escrow_plans_provider_read" ON "public"."escrow_payment_plans" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."providers"
  WHERE (("providers"."id" = "escrow_payment_plans"."provider_id") AND ("providers"."profile_id" = "auth"."uid"())))));



CREATE POLICY "escrow_plans_service_all" ON "public"."escrow_payment_plans" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."escrow_tranches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "escrow_tranches_customer_insert" ON "public"."escrow_tranches" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."escrow_payment_plans"
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("escrow_payment_plans"."customer_user_id" = "auth"."uid"())))));



CREATE POLICY "escrow_tranches_customer_read" ON "public"."escrow_tranches" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."escrow_payment_plans"
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("escrow_payment_plans"."customer_user_id" = "auth"."uid"())))));



CREATE POLICY "escrow_tranches_customer_update" ON "public"."escrow_tranches" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."escrow_payment_plans"
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("escrow_payment_plans"."customer_user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."escrow_payment_plans"
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("escrow_payment_plans"."customer_user_id" = "auth"."uid"())))));



CREATE POLICY "escrow_tranches_provider_read" ON "public"."escrow_tranches" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."escrow_payment_plans"
     JOIN "public"."providers" ON (("providers"."id" = "escrow_payment_plans"."provider_id")))
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("providers"."profile_id" = "auth"."uid"())))));



CREATE POLICY "escrow_tranches_service_all" ON "public"."escrow_tranches" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."funding_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "funding_requests_customer_read" ON "public"."funding_requests" FOR SELECT USING (("auth"."uid"() = "customer_user_id"));



CREATE POLICY "funding_requests_provider_insert" ON "public"."funding_requests" FOR INSERT WITH CHECK (("auth"."uid"() = "provider_user_id"));



CREATE POLICY "funding_requests_provider_read" ON "public"."funding_requests" FOR SELECT USING (("auth"."uid"() = "provider_user_id"));



CREATE POLICY "funding_requests_provider_update" ON "public"."funding_requests" FOR UPDATE USING (("auth"."uid"() = "provider_user_id")) WITH CHECK (("auth"."uid"() = "provider_user_id"));



CREATE POLICY "funding_requests_service_all" ON "public"."funding_requests" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "imsg_owner_select" ON "public"."internal_messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."message_threads" "mt"
  WHERE (("mt"."id" = "internal_messages"."thread_id") AND ("mt"."provider_id" IN ( SELECT "providers"."id"
           FROM "public"."providers"
          WHERE ("providers"."profile_id" = "auth"."uid"())))))));



CREATE POLICY "imsg_participant_insert" ON "public"."internal_messages" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."message_thread_participants" "mtp"
     JOIN "public"."team_members" "tm" ON ((("tm"."id")::"text" = "mtp"."team_member_id")))
  WHERE (("mtp"."thread_id" = "internal_messages"."thread_id") AND ("mtp"."team_member_id" = "internal_messages"."sender_team_member_id") AND ("mtp"."is_active" = true) AND ("tm"."profile_id" = "auth"."uid"())))));



CREATE POLICY "imsg_participant_select" ON "public"."internal_messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."message_thread_participants" "mtp"
     JOIN "public"."team_members" "tm" ON ((("tm"."id")::"text" = "mtp"."team_member_id")))
  WHERE (("mtp"."thread_id" = "internal_messages"."thread_id") AND ("mtp"."is_active" = true) AND ("tm"."profile_id" = "auth"."uid"())))));



ALTER TABLE "public"."internal_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoices_insert_own" ON "public"."invoices" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "invoices"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "invoices_select_own" ON "public"."invoices" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "invoices"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "invoices_update_own" ON "public"."invoices" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "invoices"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



ALTER TABLE "public"."job_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_feedback" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "job_feedback_insert_authenticated" ON "public"."job_feedback" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "job_feedback_select_public" ON "public"."job_feedback" FOR SELECT USING (true);



CREATE POLICY "job_feedback_update_authenticated" ON "public"."job_feedback" FOR UPDATE USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "join_codes_owner_all" ON "public"."company_join_codes" TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) WITH CHECK (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



ALTER TABLE "public"."ledger_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_artifacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "media_artifacts_insert_own" ON "public"."media_artifacts" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "media_artifacts"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "media_artifacts_select_own" ON "public"."media_artifacts" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "media_artifacts"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("p"."profile_id" = "auth"."uid"()))))));



ALTER TABLE "public"."media_uploads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "media_uploads_delete_own" ON "public"."media_uploads" FOR DELETE TO "authenticated" USING (("owner_user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "media_uploads_insert_own" ON "public"."media_uploads" FOR INSERT TO "authenticated" WITH CHECK (("owner_user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "media_uploads_select_own_or_public" ON "public"."media_uploads" FOR SELECT USING (true);



CREATE POLICY "media_uploads_update_own" ON "public"."media_uploads" FOR UPDATE TO "authenticated" USING (("owner_user_id" = ("auth"."uid"())::"text")) WITH CHECK (("owner_user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."message_thread_participants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_threads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mthread_owner_insert" ON "public"."message_threads" FOR INSERT WITH CHECK (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "mthread_owner_select" ON "public"."message_threads" FOR SELECT USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "mthread_owner_update" ON "public"."message_threads" FOR UPDATE USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "mthread_worker_select" ON "public"."message_threads" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."message_thread_participants" "mtp"
     JOIN "public"."team_members" "tm" ON ((("tm"."id")::"text" = "mtp"."team_member_id")))
  WHERE (("mtp"."thread_id" = "message_threads"."id") AND ("mtp"."is_active" = true) AND ("tm"."profile_id" = "auth"."uid"()) AND ("tm"."provider_id" = "message_threads"."provider_id")))));



CREATE POLICY "mtp_own_update" ON "public"."message_thread_participants" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE ((("tm"."id")::"text" = "message_thread_participants"."team_member_id") AND ("tm"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE ((("tm"."id")::"text" = "message_thread_participants"."team_member_id") AND ("tm"."profile_id" = "auth"."uid"())))));



CREATE POLICY "mtp_select" ON "public"."message_thread_participants" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE ((("tm"."id")::"text" = "message_thread_participants"."team_member_id") AND ("tm"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."message_threads" "mt"
     JOIN "public"."providers" "p" ON (("p"."id" = "mt"."provider_id")))
  WHERE (("mt"."id" = "message_thread_participants"."thread_id") AND ("p"."profile_id" = "auth"."uid"()))))));



ALTER TABLE "public"."notification_signals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_signals_insert_own" ON "public"."notification_signals" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "notification_signals"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "notification_signals_select_own" ON "public"."notification_signals" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "notification_signals"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "notification_signals_update_own" ON "public"."notification_signals" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "notification_signals"."job_id") AND (("p"."profile_id" = "auth"."uid"()) OR ("j"."customer_user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."offers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "offers_insert_craftsman" ON "public"."offers" FOR INSERT WITH CHECK (("auth"."uid"() = "craftsman_user_id"));



CREATE POLICY "offers_select_own" ON "public"."offers" FOR SELECT USING ((("auth"."uid"() = "craftsman_user_id") OR ("auth"."uid"() = "customer_user_id")));



CREATE POLICY "offers_update_own" ON "public"."offers" FOR UPDATE USING ((("auth"."uid"() = "craftsman_user_id") OR ("auth"."uid"() = "customer_user_id"))) WITH CHECK ((("auth"."uid"() = "craftsman_user_id") OR ("auth"."uid"() = "customer_user_id")));



ALTER TABLE "public"."operator_action_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "operators_read_all_reports" ON "public"."user_reports" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_operator" = true)))));



CREATE POLICY "operators_update_reports" ON "public"."user_reports" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_operator" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_operator" = true)))));



ALTER TABLE "public"."payment_status_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_media" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_media_likes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_media_likes_delete" ON "public"."provider_media_likes" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_media_likes_insert" ON "public"."provider_media_likes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_media_likes_select" ON "public"."provider_media_likes" FOR SELECT USING (true);



ALTER TABLE "public"."provider_payout_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_payout_own_row" ON "public"."provider_payout_accounts" USING (("auth"."uid"() = "provider_user_id")) WITH CHECK (("auth"."uid"() = "provider_user_id"));



ALTER TABLE "public"."providers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ratings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ratings_insert_customer" ON "public"."ratings" FOR INSERT WITH CHECK (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "ratings_select_own" ON "public"."ratings" FOR SELECT USING ((("customer_user_id" = "auth"."uid"()) OR ("craftsman_user_id" = "auth"."uid"())));



CREATE POLICY "ratings_update_customer" ON "public"."ratings" FOR UPDATE USING (("customer_user_id" = "auth"."uid"()));



ALTER TABLE "public"."schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schedules_insert_own" ON "public"."schedules" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "schedules"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "schedules_select_own" ON "public"."schedules" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "schedules"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "schedules_update_own" ON "public"."schedules" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "schedules"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



ALTER TABLE "public"."stripe_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stripe_webhook_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplementary_payment_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "supplementary_payment_requests_craftsman_read" ON "public"."supplementary_payment_requests" FOR SELECT USING ((("auth"."uid"())::"text" = "craftsman_user_id"));



CREATE POLICY "supplementary_payment_requests_craftsman_update" ON "public"."supplementary_payment_requests" FOR UPDATE USING ((("auth"."uid"())::"text" = "craftsman_user_id"));



CREATE POLICY "supplementary_payment_requests_customer_read" ON "public"."supplementary_payment_requests" FOR SELECT USING ((("auth"."uid"())::"text" = "customer_user_id"));



CREATE POLICY "supplementary_payment_requests_customer_update" ON "public"."supplementary_payment_requests" FOR UPDATE USING ((("auth"."uid"())::"text" = "customer_user_id"));



CREATE POLICY "supplementary_payment_requests_insert" ON "public"."supplementary_payment_requests" FOR INSERT WITH CHECK (((("auth"."uid"())::"text" = "craftsman_user_id") OR (("auth"."uid"())::"text" = "customer_user_id")));



ALTER TABLE "public"."team_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."thread_artifacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "thread_artifacts_insert_own" ON "public"."thread_artifacts" FOR INSERT WITH CHECK ((("auth"."uid"() = "customer_user_id") OR ("auth"."uid"() = "craftsman_user_id")));



CREATE POLICY "thread_artifacts_select_own" ON "public"."thread_artifacts" FOR SELECT USING ((("auth"."uid"() = "customer_user_id") OR ("auth"."uid"() = "craftsman_user_id")));



CREATE POLICY "thread_artifacts_update_own" ON "public"."thread_artifacts" FOR UPDATE USING ((("auth"."uid"() = "customer_user_id") OR ("auth"."uid"() = "craftsman_user_id"))) WITH CHECK ((("auth"."uid"() = "customer_user_id") OR ("auth"."uid"() = "craftsman_user_id")));



ALTER TABLE "public"."timeline_signals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "timeline_signals_insert_own" ON "public"."timeline_signals" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "timeline_signals"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "timeline_signals_select_own" ON "public"."timeline_signals" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "timeline_signals"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("p"."profile_id" = "auth"."uid"()))))));



ALTER TABLE "public"."user_blocks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_delete_own_blocks" ON "public"."user_blocks" FOR DELETE USING (("auth"."uid"() = "blocker_id"));



CREATE POLICY "users_insert_own_blocks" ON "public"."user_blocks" FOR INSERT WITH CHECK (("auth"."uid"() = "blocker_id"));



CREATE POLICY "users_insert_own_reports" ON "public"."user_reports" FOR INSERT WITH CHECK (("auth"."uid"() = "reporter_id"));



CREATE POLICY "users_read_own_blocks" ON "public"."user_blocks" FOR SELECT USING (("auth"."uid"() = "blocker_id"));



CREATE POLICY "users_read_own_reports" ON "public"."user_reports" FOR SELECT USING (("auth"."uid"() = "reporter_id"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."disputes";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."escrow_payment_plans";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."escrow_tranches";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."funding_requests";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."jobs";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."messages";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."notification_signals";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."payments";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."supplementary_payment_requests";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."timeline_signals";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































REVOKE ALL ON FUNCTION "public"."_assert_caller_is_operator"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_assert_caller_is_operator"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."assert_attribution_finalized_before_release"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assert_attribution_finalized_before_release"() TO "anon";
GRANT ALL ON FUNCTION "public"."assert_attribution_finalized_before_release"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assert_attribution_finalized_before_release"() TO "service_role";



GRANT ALL ON FUNCTION "public"."become_provider"("p_company_name" "text", "p_description" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."become_provider"("p_company_name" "text", "p_description" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."become_provider"("p_company_name" "text", "p_description" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."confirm_funding_atomic"("p_funding_request_id" "uuid", "p_escrow_plan_id" "uuid", "p_payment_intent_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."confirm_funding_atomic"("p_funding_request_id" "uuid", "p_escrow_plan_id" "uuid", "p_payment_intent_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."confirm_funding_atomic"("p_funding_request_id" "uuid", "p_escrow_plan_id" "uuid", "p_payment_intent_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."disputes_status_change_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."disputes_status_change_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."disputes_status_change_guard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."ensure_subscription_row"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_subscription_row"() TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_subscription_row"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_subscription_row"() TO "service_role";



GRANT ALL ON FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_update_thread_last_message"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_update_thread_last_message"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_update_thread_last_message"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_invoice_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_invoice_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_invoice_number"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_or_create_office_thread"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_or_create_office_thread"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_or_create_office_thread"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_or_create_team_thread"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_or_create_team_thread"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_or_create_team_thread"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_current_user_operator"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_current_user_operator"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_current_user_operator"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_current_user_operator"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text", "p_refund_amount" numeric, "p_release_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text", "p_refund_amount" numeric, "p_release_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text", "p_refund_amount" numeric, "p_release_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text", "p_release_amount" numeric, "p_refund_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text", "p_release_amount" numeric, "p_refund_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text", "p_release_amount" numeric, "p_refund_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text", "p_provider_award_amount" numeric, "p_customer_refund_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text", "p_provider_award_amount" numeric, "p_customer_refund_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text", "p_provider_award_amount" numeric, "p_customer_refund_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_transfer_reversal_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_reversal_ref" "text", "p_reversed_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_transfer_reversal_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_reversal_ref" "text", "p_reversed_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_tranche_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_tranche_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."start_trial"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."start_trial"() TO "anon";
GRANT ALL ON FUNCTION "public"."start_trial"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."start_trial"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_provider_search_vector"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_provider_search_vector"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_provider_search_vector"() TO "service_role";


















GRANT ALL ON TABLE "public"."acceptances" TO "anon";
GRANT ALL ON TABLE "public"."acceptances" TO "authenticated";
GRANT ALL ON TABLE "public"."acceptances" TO "service_role";



GRANT ALL ON TABLE "public"."analytics_events" TO "anon";
GRANT ALL ON TABLE "public"."analytics_events" TO "authenticated";
GRANT ALL ON TABLE "public"."analytics_events" TO "service_role";



GRANT ALL ON TABLE "public"."attribution_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."attribution_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."attribution_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_entries" TO "anon";
GRANT ALL ON TABLE "public"."calendar_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_entries" TO "service_role";



GRANT ALL ON TABLE "public"."change_orders" TO "anon";
GRANT ALL ON TABLE "public"."change_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."change_orders" TO "service_role";



GRANT ALL ON TABLE "public"."company_join_codes" TO "anon";
GRANT ALL ON TABLE "public"."company_join_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."company_join_codes" TO "service_role";



GRANT ALL ON TABLE "public"."conversations" TO "anon";
GRANT ALL ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT ALL ON TABLE "public"."correction_requests" TO "anon";
GRANT ALL ON TABLE "public"."correction_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."correction_requests" TO "service_role";



GRANT ALL ON TABLE "public"."craftsman_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."craftsman_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."craftsman_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."customer_provider_relationships" TO "anon";
GRANT ALL ON TABLE "public"."customer_provider_relationships" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_provider_relationships" TO "service_role";



GRANT ALL ON TABLE "public"."customer_request_sends" TO "anon";
GRANT ALL ON TABLE "public"."customer_request_sends" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_request_sends" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."providers" TO "anon";
GRANT ALL ON TABLE "public"."providers" TO "authenticated";
GRANT ALL ON TABLE "public"."providers" TO "service_role";



GRANT ALL ON TABLE "public"."discovery_providers" TO "anon";
GRANT ALL ON TABLE "public"."discovery_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."discovery_providers" TO "service_role";



GRANT ALL ON TABLE "public"."disputes" TO "anon";
GRANT ALL ON TABLE "public"."disputes" TO "authenticated";
GRANT ALL ON TABLE "public"."disputes" TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "anon";
GRANT ALL ON TABLE "public"."jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."jobs" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."dispute_details" TO "anon";
GRANT ALL ON TABLE "public"."dispute_details" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_details" TO "service_role";



GRANT ALL ON TABLE "public"."dispute_evidence" TO "anon";
GRANT ALL ON TABLE "public"."dispute_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_evidence" TO "service_role";



GRANT ALL ON TABLE "public"."dispute_ops_overview" TO "anon";
GRANT ALL ON TABLE "public"."dispute_ops_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_ops_overview" TO "service_role";



GRANT ALL ON TABLE "public"."dispute_status_history" TO "anon";
GRANT ALL ON TABLE "public"."dispute_status_history" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_status_history" TO "service_role";



GRANT ALL ON TABLE "public"."email_delivery_log" TO "anon";
GRANT ALL ON TABLE "public"."email_delivery_log" TO "authenticated";
GRANT ALL ON TABLE "public"."email_delivery_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."email_delivery_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."email_delivery_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."email_delivery_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."escrow_payment_plans" TO "anon";
GRANT ALL ON TABLE "public"."escrow_payment_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."escrow_payment_plans" TO "service_role";



GRANT ALL ON TABLE "public"."escrow_tranches" TO "anon";
GRANT ALL ON TABLE "public"."escrow_tranches" TO "authenticated";
GRANT ALL ON TABLE "public"."escrow_tranches" TO "service_role";



GRANT ALL ON TABLE "public"."funding_requests" TO "anon";
GRANT ALL ON TABLE "public"."funding_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."funding_requests" TO "service_role";



GRANT ALL ON TABLE "public"."internal_messages" TO "anon";
GRANT ALL ON TABLE "public"."internal_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."internal_messages" TO "service_role";



GRANT ALL ON SEQUENCE "public"."invoice_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."invoice_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."invoice_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."job_assignments" TO "anon";
GRANT ALL ON TABLE "public"."job_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."job_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."team_members" TO "anon";
GRANT ALL ON TABLE "public"."team_members" TO "authenticated";
GRANT ALL ON TABLE "public"."team_members" TO "service_role";



GRANT ALL ON TABLE "public"."job_assignment_details" TO "anon";
GRANT ALL ON TABLE "public"."job_assignment_details" TO "authenticated";
GRANT ALL ON TABLE "public"."job_assignment_details" TO "service_role";



GRANT ALL ON TABLE "public"."job_details" TO "anon";
GRANT ALL ON TABLE "public"."job_details" TO "authenticated";
GRANT ALL ON TABLE "public"."job_details" TO "service_role";



GRANT ALL ON TABLE "public"."job_feedback" TO "anon";
GRANT ALL ON TABLE "public"."job_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."job_feedback" TO "service_role";



GRANT ALL ON TABLE "public"."job_integrity_overview" TO "anon";
GRANT ALL ON TABLE "public"."job_integrity_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."job_integrity_overview" TO "service_role";



GRANT ALL ON TABLE "public"."ledger_entries" TO "anon";
GRANT ALL ON TABLE "public"."ledger_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."ledger_entries" TO "service_role";



GRANT ALL ON TABLE "public"."media_artifacts" TO "anon";
GRANT ALL ON TABLE "public"."media_artifacts" TO "authenticated";
GRANT ALL ON TABLE "public"."media_artifacts" TO "service_role";



GRANT ALL ON TABLE "public"."media_uploads" TO "anon";
GRANT ALL ON TABLE "public"."media_uploads" TO "authenticated";
GRANT ALL ON TABLE "public"."media_uploads" TO "service_role";



GRANT ALL ON TABLE "public"."message_thread_participants" TO "anon";
GRANT ALL ON TABLE "public"."message_thread_participants" TO "authenticated";
GRANT ALL ON TABLE "public"."message_thread_participants" TO "service_role";



GRANT ALL ON TABLE "public"."message_threads" TO "anon";
GRANT ALL ON TABLE "public"."message_threads" TO "authenticated";
GRANT ALL ON TABLE "public"."message_threads" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."notification_signals" TO "anon";
GRANT ALL ON TABLE "public"."notification_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_signals" TO "service_role";



GRANT ALL ON TABLE "public"."offers" TO "anon";
GRANT ALL ON TABLE "public"."offers" TO "authenticated";
GRANT ALL ON TABLE "public"."offers" TO "service_role";



GRANT ALL ON TABLE "public"."operator_action_audit" TO "anon";
GRANT ALL ON TABLE "public"."operator_action_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."operator_action_audit" TO "service_role";



GRANT ALL ON TABLE "public"."payment_details" TO "anon";
GRANT ALL ON TABLE "public"."payment_details" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_details" TO "service_role";



GRANT ALL ON TABLE "public"."payment_lifecycle_overview" TO "anon";
GRANT ALL ON TABLE "public"."payment_lifecycle_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_lifecycle_overview" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_events" TO "anon";
GRANT ALL ON TABLE "public"."stripe_events" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_events" TO "service_role";



GRANT ALL ON TABLE "public"."payment_reconciliation_details" TO "anon";
GRANT ALL ON TABLE "public"."payment_reconciliation_details" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_reconciliation_details" TO "service_role";



GRANT ALL ON TABLE "public"."payment_risk_overview" TO "anon";
GRANT ALL ON TABLE "public"."payment_risk_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_risk_overview" TO "service_role";



GRANT ALL ON TABLE "public"."payment_status_history" TO "anon";
GRANT ALL ON TABLE "public"."payment_status_history" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_status_history" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."provider_media" TO "anon";
GRANT ALL ON TABLE "public"."provider_media" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_media" TO "service_role";



GRANT ALL ON TABLE "public"."provider_media_likes" TO "anon";
GRANT ALL ON TABLE "public"."provider_media_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_media_likes" TO "service_role";



GRANT ALL ON TABLE "public"."provider_payout_accounts" TO "anon";
GRANT ALL ON TABLE "public"."provider_payout_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_payout_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."ratings" TO "anon";
GRANT ALL ON TABLE "public"."ratings" TO "authenticated";
GRANT ALL ON TABLE "public"."ratings" TO "service_role";



GRANT ALL ON TABLE "public"."schedules" TO "anon";
GRANT ALL ON TABLE "public"."schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."schedules" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "anon";
GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "service_role";



GRANT ALL ON TABLE "public"."supplementary_payment_requests" TO "anon";
GRANT ALL ON TABLE "public"."supplementary_payment_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."supplementary_payment_requests" TO "service_role";



GRANT ALL ON TABLE "public"."team_member_details" TO "anon";
GRANT ALL ON TABLE "public"."team_member_details" TO "authenticated";
GRANT ALL ON TABLE "public"."team_member_details" TO "service_role";



GRANT ALL ON TABLE "public"."thread_artifacts" TO "anon";
GRANT ALL ON TABLE "public"."thread_artifacts" TO "authenticated";
GRANT ALL ON TABLE "public"."thread_artifacts" TO "service_role";



GRANT ALL ON TABLE "public"."timeline_signals" TO "anon";
GRANT ALL ON TABLE "public"."timeline_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."timeline_signals" TO "service_role";



GRANT ALL ON TABLE "public"."user_blocks" TO "anon";
GRANT ALL ON TABLE "public"."user_blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."user_blocks" TO "service_role";



GRANT ALL ON TABLE "public"."user_reports" TO "anon";
GRANT ALL ON TABLE "public"."user_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."user_reports" TO "service_role";



GRANT ALL ON TABLE "public"."visible_discovery_providers" TO "anon";
GRANT ALL ON TABLE "public"."visible_discovery_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."visible_discovery_providers" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































