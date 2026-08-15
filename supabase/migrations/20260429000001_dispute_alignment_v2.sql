-- =============================================================================
-- Block 5.6 — Dispute Alignment v2
-- =============================================================================
-- Aligns the production dispute DB layer with the App-side γ contract finalised
-- in Blocks 5.5a / 5.5b / 5.5c (UUID identifiers, ISO-8601 timestamptz columns,
-- jsonb metadata, γ status vocabulary).
--
-- Replaces the un-applied attempt 20260428000001_dispute_operator_rpc.sql and
-- the legacy open_dispute_atomic from 20260418000011_open_dispute_atomic.sql.
--
-- Scope:
--   1. Precondition: refuses to run if disputes/history hold any rows.
--   2. Decision CHECK constraint (defensive).
--   3. Index cleanup (drop legacy active-unique that references deprecated
--      'awaiting_evidence'; drop duplicate non-unique indexes).
--   4. RLS cleanup on disputes + dispute_status_history (drop wide policies,
--      install ownership-aware narrow policies).
--   5. Operator helper public.is_current_user_operator().
--   6. open_dispute_atomic v2 (uuid + timestamptz + jsonb).
--   7. Seven operator RPCs matching the App contract (p_dispute_id uuid).
--   8. BEFORE UPDATE trigger blocking direct status / decision / resolution
--      mutations from non-operator authenticated callers.
--   9. Grants for authenticated.
--
-- All steps are idempotent at the DDL level (DROP IF EXISTS / CREATE OR
-- REPLACE) so the migration can be re-applied safely against the empty
-- production state. The PRECONDITION block hard-aborts if data is present.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. PRECONDITION — refuse to run if dispute data exists
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_disputes_count       bigint;
  v_history_count        bigint;
BEGIN
  SELECT count(*) INTO v_disputes_count FROM public.disputes;
  SELECT count(*) INTO v_history_count  FROM public.dispute_status_history;

  IF v_disputes_count <> 0 OR v_history_count <> 0 THEN
    RAISE EXCEPTION
      'dispute_alignment_v2_precondition_failed: disputes=% history=% (v2 migration is built for the empty production window only)',
      v_disputes_count, v_history_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. CONSTRAINTS
-- ---------------------------------------------------------------------------
-- Decision CHECK — production currently lacks one. App emits release | refund
-- | split | reject (or NULL while the dispute is still active).
ALTER TABLE public.disputes
  DROP CONSTRAINT IF EXISTS disputes_decision_check;

ALTER TABLE public.disputes
  ADD CONSTRAINT disputes_decision_check
  CHECK (decision IS NULL OR decision IN ('release','refund','split','reject'));

-- ---------------------------------------------------------------------------
-- 3. INDEX CLEANUP
-- ---------------------------------------------------------------------------
-- Drop the legacy partial-unique index that references 'awaiting_evidence'.
-- The CHECK constraint no longer permits that status, and the γ-aware index
-- disputes_one_active_per_job_idx is the canonical guard.
DROP INDEX IF EXISTS public.idx_disputes_job_active_unique;

-- Re-assert the γ active-unique index in case the production copy was
-- re-created with a different status set somewhere along the line.
DROP INDEX IF EXISTS public.disputes_one_active_per_job_idx;
CREATE UNIQUE INDEX disputes_one_active_per_job_idx
  ON public.disputes (job_id)
  WHERE status IN ('open','under_review','customer_waiting','provider_waiting');

-- Drop duplicate non-unique indexes (production tree carries both names).
DROP INDEX IF EXISTS public.idx_disputes_job_id;
DROP INDEX IF EXISTS public.idx_disputes_status;
DROP INDEX IF EXISTS public.idx_disputes_payment_id;

-- ---------------------------------------------------------------------------
-- 4. RLS — drop existing dispute / history policies (both name variants)
-- ---------------------------------------------------------------------------
ALTER TABLE public.disputes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispute_status_history ENABLE ROW LEVEL SECURITY;

-- Wide / duplicate dispute policies
DROP POLICY IF EXISTS disputes_select_own           ON public.disputes;
DROP POLICY IF EXISTS disputes_insert_own           ON public.disputes;
DROP POLICY IF EXISTS disputes_update_own           ON public.disputes;
DROP POLICY IF EXISTS "Disputes: read own side"     ON public.disputes;
DROP POLICY IF EXISTS "Disputes: insert own side"   ON public.disputes;
DROP POLICY IF EXISTS "Disputes: update own side"   ON public.disputes;

-- Wide / duplicate history policies
DROP POLICY IF EXISTS dispute_history_select                                  ON public.dispute_status_history;
DROP POLICY IF EXISTS dispute_history_insert                                  ON public.dispute_status_history;
DROP POLICY IF EXISTS "Authenticated users can read dispute history"          ON public.dispute_status_history;
DROP POLICY IF EXISTS "Authenticated users can insert dispute history"        ON public.dispute_status_history;

-- ---------------------------------------------------------------------------
-- 5. RLS — narrow ownership-aware policies on disputes
-- ---------------------------------------------------------------------------
-- SELECT: parties to the dispute + operators.
--   Party = opener (opened_by_profile_id), customer (customer_profile_id),
--   craftsman (provider linked via providers.profile_id).
CREATE POLICY disputes_select_own_side
  ON public.disputes
  FOR SELECT
  TO authenticated
  USING (
    opened_by_profile_id = auth.uid()
    OR customer_profile_id = auth.uid()
    OR provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_operator = true
    )
  );

-- INSERT: any authenticated party of the underlying job. The expected client
-- path is open_dispute_atomic (SECURITY DEFINER) which bypasses RLS, but we
-- keep a narrow direct-insert window so the existing add() repository path
-- (used by tests + offline retry) does not silently fail. Spoofing is
-- prevented by binding opened_by_profile_id to auth.uid() and by requiring
-- participation in the underlying job.
CREATE POLICY disputes_insert_own_side
  ON public.disputes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    opened_by_profile_id = auth.uid()
    AND job_id IN (
      SELECT j.id FROM public.jobs j
      WHERE j.customer_user_id    = auth.uid()
         OR j.customer_profile_id = auth.uid()
         OR j.craftsman_user_id   = auth.uid()::text
         OR j.provider_id IN (
              SELECT pr.id FROM public.providers pr WHERE pr.profile_id = auth.uid()
            )
    )
  );

-- UPDATE: parties may patch metadata/evidence/settlement_status/etc on their
-- own row. Status / decision / resolution_type / split_ratio mutations are
-- gated by the BEFORE UPDATE trigger (step 8) regardless of RLS — only the
-- operator helper RPCs (SECURITY DEFINER) and service_role can change them.
CREATE POLICY disputes_update_own_side
  ON public.disputes
  FOR UPDATE
  TO authenticated
  USING (
    opened_by_profile_id = auth.uid()
    OR customer_profile_id = auth.uid()
    OR provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_operator = true
    )
  )
  WITH CHECK (
    opened_by_profile_id = auth.uid()
    OR customer_profile_id = auth.uid()
    OR provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_operator = true
    )
  );

-- ---------------------------------------------------------------------------
-- 6. RLS — narrow ownership-aware policies on dispute_status_history
-- ---------------------------------------------------------------------------
-- SELECT: any party of the parent dispute, plus operators.
CREATE POLICY dispute_history_select_own_side
  ON public.dispute_status_history
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.disputes d
      WHERE d.id = dispute_status_history.dispute_id
        AND (
          d.opened_by_profile_id = auth.uid()
          OR d.customer_profile_id = auth.uid()
          OR d.provider_id IN (
            SELECT id FROM public.providers WHERE profile_id = auth.uid()
          )
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_operator = true
    )
  );

-- INSERT: client-driven entries only. Operator/admin/system rows are written
-- by SECURITY DEFINER RPCs which bypass RLS. The narrow client policy:
--   • requires source = 'client' (server sources stay server-only)
--   • requires the dispute to belong to the authenticated user.
CREATE POLICY dispute_history_insert_client_own_side
  ON public.dispute_status_history
  FOR INSERT
  TO authenticated
  WITH CHECK (
    source = 'client'
    AND EXISTS (
      SELECT 1 FROM public.disputes d
      WHERE d.id = dispute_status_history.dispute_id
        AND (
          d.opened_by_profile_id = auth.uid()
          OR d.customer_profile_id = auth.uid()
          OR d.provider_id IN (
            SELECT id FROM public.providers WHERE profile_id = auth.uid()
          )
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 7. Operator helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_operator()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_operator = true
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_current_user_operator() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_current_user_operator() TO authenticated;

CREATE OR REPLACE FUNCTION public._assert_caller_is_operator()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    -- service_role / RPC-internal write without a JWT: trusted.
    RETURN NULL;
  END IF;

  IF NOT public.is_current_user_operator() THEN
    RAISE EXCEPTION 'operator_required'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._assert_caller_is_operator() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._assert_caller_is_operator() FROM anon;
REVOKE EXECUTE ON FUNCTION public._assert_caller_is_operator() FROM authenticated;

-- ---------------------------------------------------------------------------
-- 8. open_dispute_atomic v2
-- ---------------------------------------------------------------------------
-- Drop the legacy text/bigint signature explicitly — CREATE OR REPLACE alone
-- cannot change argument types.
DROP FUNCTION IF EXISTS public.open_dispute_atomic(
  text, text, text, text, text, text, text, jsonb, bigint, bigint
);
DROP FUNCTION IF EXISTS public.open_dispute_atomic(
  uuid, uuid, text, text, text, uuid, jsonb, jsonb, timestamptz
);

CREATE FUNCTION public.open_dispute_atomic(
  p_job_id            uuid,
  p_dispute_id        uuid,
  p_reason            text,
  p_description       text,
  p_raised_by         text         DEFAULT NULL,
  p_payment_id        uuid         DEFAULT NULL,
  p_metadata          jsonb        DEFAULT '{}'::jsonb,
  p_context_snapshot  jsonb        DEFAULT NULL,
  p_opened_at         timestamptz  DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- ── Resolve effective raiser identity ────────────────────────────────────
  -- Authenticated callers must not be able to spoof someone else.
  v_raised_by := CASE
    WHEN v_uid IS NOT NULL THEN v_uid::text
    ELSE p_raised_by
  END;

  -- ── Load + lock the job ──────────────────────────────────────────────────
  SELECT j.customer_profile_id,
         j.provider_id
    INTO v_customer_profile_id, v_provider_id
    FROM public.jobs j
   WHERE j.id = p_job_id
   FOR UPDATE;

  IF v_customer_profile_id IS NULL AND v_provider_id IS NULL THEN
    -- Allow either NULL individually, but if the job itself does not exist the
    -- SELECT above returns no row — guard against that.
    IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id) THEN
      RAISE EXCEPTION 'job_not_found: %', p_job_id
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- ── Authorization ────────────────────────────────────────────────────────
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

  -- ── Reject pre-existing active dispute (defensive — covers ages where the
  --   partial-unique index might be missing) ─────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.disputes
    WHERE job_id = p_job_id
      AND status IN ('open','under_review','customer_waiting','provider_waiting')
  ) THEN
    RAISE EXCEPTION 'active_dispute_exists: job %', p_job_id
      USING ERRCODE = '23505';
  END IF;

  -- ── Lock the payment row ────────────────────────────────────────────────
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
      -- Backfill the parameter for the dispute insert below.
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

  -- ── Insert the dispute row ──────────────────────────────────────────────
  INSERT INTO public.disputes (
    id,
    job_id,
    payment_id,
    opened_by_profile_id,
    customer_profile_id,
    provider_id,
    status,
    reason,
    description,
    raised_by,
    metadata,
    context_snapshot,
    opened_at,
    created_at,
    updated_at
  ) VALUES (
    p_dispute_id,
    p_job_id,
    p_payment_id,
    v_uid,
    v_customer_profile_id,
    v_provider_id,
    'open',
    p_reason,
    p_description,
    v_raised_by,
    COALESCE(p_metadata, '{}'::jsonb),
    p_context_snapshot,
    v_now,
    v_now,
    v_now
  );

  -- ── Mirror onto payment + job ───────────────────────────────────────────
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

  -- ── Initial history entry (server-owned) ────────────────────────────────
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

  -- ── Return the freshly created dispute ──────────────────────────────────
  SELECT row_to_json(d)::jsonb INTO v_dispute_json
    FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_dispute_json;
END;
$$;

GRANT EXECUTE ON FUNCTION public.open_dispute_atomic(
  uuid, uuid, text, text, text, uuid, jsonb, jsonb, timestamptz
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_dispute_atomic(
  uuid, uuid, text, text, text, uuid, jsonb, jsonb, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.open_dispute_atomic(
  uuid, uuid, text, text, text, uuid, jsonb, jsonb, timestamptz
) IS
  'Block 5.6 v2: opens a dispute atomically using the γ schema (uuid + '
  'timestamptz + jsonb metadata). Authorises the caller against the parent '
  'job, prevents concurrent active disputes, mirrors the dispute status onto '
  'payments + jobs, writes the initial dispute_status_history entry.';

-- ---------------------------------------------------------------------------
-- 9. Drop the legacy operator-RPC names (block 5.3 attempt) before installing
--    the γ-aligned set. Argument types are different, so DROP IF EXISTS with
--    the legacy signature is required.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.operator_mark_dispute_awaiting_evidence(text);
DROP FUNCTION IF EXISTS public.operator_mark_dispute_under_review(text);
DROP FUNCTION IF EXISTS public.operator_resolve_dispute_release(text);
DROP FUNCTION IF EXISTS public.operator_resolve_dispute_refund(text);
DROP FUNCTION IF EXISTS public.operator_resolve_dispute_split(text, numeric);
DROP FUNCTION IF EXISTS public.operator_reject_dispute(text);

-- ---------------------------------------------------------------------------
-- 10. Operator RPCs — γ contract, p_dispute_id uuid
-- ---------------------------------------------------------------------------

-- 10a. operator_request_customer_evidence_dispute -------------------------------
CREATE OR REPLACE FUNCTION public.operator_request_customer_evidence_dispute(
  p_dispute_id uuid,
  p_note       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();

  SELECT status, job_id INTO v_from_status, v_job_id
    FROM public.disputes
   WHERE id = p_dispute_id
   FOR UPDATE;

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

  UPDATE public.disputes
     SET status = 'customer_waiting', updated_at = v_now
   WHERE id = p_dispute_id;

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, v_job_id, v_from_status, 'customer_waiting', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'requested_party', 'customer'),
    v_now
  );

  UPDATE public.jobs SET dispute_status = 'customer_waiting' WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

-- 10b. operator_request_provider_evidence_dispute -------------------------------
CREATE OR REPLACE FUNCTION public.operator_request_provider_evidence_dispute(
  p_dispute_id uuid,
  p_note       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();

  SELECT status, job_id INTO v_from_status, v_job_id
    FROM public.disputes
   WHERE id = p_dispute_id
   FOR UPDATE;

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

  UPDATE public.disputes
     SET status = 'provider_waiting', updated_at = v_now
   WHERE id = p_dispute_id;

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, v_job_id, v_from_status, 'provider_waiting', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'requested_party', 'provider'),
    v_now
  );

  UPDATE public.jobs SET dispute_status = 'provider_waiting' WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

-- 10c. operator_mark_dispute_under_review ---------------------------------------
CREATE OR REPLACE FUNCTION public.operator_mark_dispute_under_review(
  p_dispute_id uuid,
  p_note       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();

  SELECT status, job_id INTO v_from_status, v_job_id
    FROM public.disputes
   WHERE id = p_dispute_id
   FOR UPDATE;

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

  UPDATE public.disputes
     SET status = 'under_review', updated_at = v_now
   WHERE id = p_dispute_id;

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, v_job_id, v_from_status, 'under_review', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id),
    v_now
  );

  UPDATE public.jobs SET dispute_status = 'under_review' WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

-- 10d. operator_resolve_dispute_release -----------------------------------------
CREATE OR REPLACE FUNCTION public.operator_resolve_dispute_release(
  p_dispute_id     uuid,
  p_note           text     DEFAULT NULL,
  p_release_amount numeric  DEFAULT NULL,
  p_refund_amount  numeric  DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  SELECT status, job_id INTO v_from_status, v_job_id
    FROM public.disputes
   WHERE id = p_dispute_id
   FOR UPDATE;

  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;

  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_release got %', v_from_status
      USING ERRCODE = 'P0001';
  END IF;

  v_resolution_type := CASE
    WHEN p_refund_amount IS NULL OR p_refund_amount = 0 THEN 'release_full'
    ELSE 'release_partial'
  END;

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

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object(
      'operator_id',      v_operator_id,
      'decision',         'release',
      'resolution_type',  v_resolution_type,
      'release_amount',   p_release_amount,
      'refund_amount',    p_refund_amount
    ),
    v_now
  );

  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

-- 10e. operator_resolve_dispute_refund ------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_resolve_dispute_refund(
  p_dispute_id     uuid,
  p_note           text     DEFAULT NULL,
  p_refund_amount  numeric  DEFAULT NULL,
  p_release_amount numeric  DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  SELECT status, job_id INTO v_from_status, v_job_id
    FROM public.disputes
   WHERE id = p_dispute_id
   FOR UPDATE;

  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;

  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_refund got %', v_from_status
      USING ERRCODE = 'P0001';
  END IF;

  v_resolution_type := CASE
    WHEN p_release_amount IS NULL OR p_release_amount = 0 THEN 'refund_full'
    ELSE 'refund_partial'
  END;

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

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object(
      'operator_id',     v_operator_id,
      'decision',        'refund',
      'resolution_type', v_resolution_type,
      'refund_amount',   p_refund_amount,
      'release_amount',  p_release_amount
    ),
    v_now
  );

  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

-- 10f. operator_resolve_dispute_split -------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_resolve_dispute_split(
  p_dispute_id            uuid,
  p_split_ratio           numeric,
  p_note                  text     DEFAULT NULL,
  p_provider_award_amount numeric  DEFAULT NULL,
  p_customer_refund_amount numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    RAISE EXCEPTION 'invalid_split_ratio: must be in [0,1], got %', p_split_ratio
      USING ERRCODE = 'P0001';
  END IF;

  SELECT status, job_id INTO v_from_status, v_job_id
    FROM public.disputes
   WHERE id = p_dispute_id
   FOR UPDATE;

  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;

  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_split got %', v_from_status
      USING ERRCODE = 'P0001';
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

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object(
      'operator_id',             v_operator_id,
      'decision',                'split',
      'resolution_type',         'split',
      'split_ratio',             p_split_ratio,
      'provider_award_amount',   p_provider_award_amount,
      'customer_refund_amount',  p_customer_refund_amount
    ),
    v_now
  );

  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

-- 10g. operator_reject_dispute --------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_reject_dispute(
  p_dispute_id uuid,
  p_note       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();

  SELECT status, job_id INTO v_from_status, v_job_id
    FROM public.disputes
   WHERE id = p_dispute_id
   FOR UPDATE;

  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;

  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: reject got %', v_from_status
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.disputes
     SET status            = 'resolved',
         decision           = 'reject',
         resolution_type    = 'rejected',
         settlement_status  = 'settled',
         resolved_at        = COALESCE(resolved_at, v_now),
         updated_at         = v_now
   WHERE id = p_dispute_id;

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object(
      'operator_id',     v_operator_id,
      'decision',        'reject',
      'resolution_type', 'rejected'
    ),
    v_now
  );

  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. Status-change guard trigger
-- ---------------------------------------------------------------------------
-- Belt-and-suspenders: even if RLS update is permitted, only operators (and
-- service_role / SECURITY DEFINER RPCs that run with auth.uid() = NULL via
-- internal calls — service_role only) may flip status / decision /
-- resolution_type / split_ratio / settlement_status. SECURITY DEFINER RPCs
-- preserve the calling user's auth.uid(); for those we additionally accept
-- is_current_user_operator() = true. This blocks raw .from('disputes').
-- update({status: ...}) calls from a non-operator client.

CREATE OR REPLACE FUNCTION public.disputes_status_change_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Fast path: nothing protected changed.
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

  -- service_role / RPC-internal write without a JWT.
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

DROP TRIGGER IF EXISTS disputes_status_change_guard_tg ON public.disputes;
CREATE TRIGGER disputes_status_change_guard_tg
  BEFORE UPDATE ON public.disputes
  FOR EACH ROW
  EXECUTE FUNCTION public.disputes_status_change_guard();

COMMENT ON FUNCTION public.disputes_status_change_guard() IS
  'Block 5.6 — guards status/decision/resolution_type/split_ratio/settlement_status/'
  'resolved_at/closed_at against direct mutations by non-operator authenticated callers.';

-- ---------------------------------------------------------------------------
-- 12. Grants — every operator RPC executable by authenticated; helper RPC
--    enforces is_operator internally.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'operator_request_customer_evidence_dispute(uuid, text)',
    'operator_request_provider_evidence_dispute(uuid, text)',
    'operator_mark_dispute_under_review(uuid, text)',
    'operator_resolve_dispute_release(uuid, text, numeric, numeric)',
    'operator_resolve_dispute_refund(uuid, text, numeric, numeric)',
    'operator_resolve_dispute_split(uuid, numeric, text, numeric, numeric)',
    'operator_reject_dispute(uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC',       v_fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM anon',         v_fn);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION public.%s TO authenticated',  v_fn);
  END LOOP;
END $$;

-- =============================================================================
-- End of Block 5.6 — Dispute Alignment v2
-- =============================================================================
