-- Operator-driven attribution resolution / reclassification RPC.
--
-- Companion to the Finalizer: when the worker cannot self-resolve a job
-- (missing IDs, max-retry exceeded, data anomaly), it transitions the row to
-- attribution_status='dlq'.  This RPC is the ONLY server-approved path that
-- moves a DLQ row back into a finalized state.  It also supports post-hoc
-- reclassification when a previously-finalized job was classified wrong.
--
-- Authorization model:
--   - Granted to SERVICE_ROLE only.  The API handler at
--     api/operator/resolve-attribution.ts verifies the caller is an operator
--     (profiles.is_operator = true) before invoking the RPC via the admin
--     client.  The RPC re-verifies the operator flag in the DB as
--     belt-and-suspenders.
--
-- Transition matrix:
--   mode='resolve'
--     from attribution_status ∈ ('pending','retrying','dlq')  → 'finalized'
--     requires p_to_origin ∈ ('merchant_brought','platform_acquired')
--     clears attribution_dlq_reason
--
--   mode='reclassify'
--     from attribution_status = 'finalized'  → 'finalized' (origin change only)
--     requires p_to_origin ∈ ('merchant_brought','platform_acquired')
--     does not alter attribution_dlq_reason (always NULL for finalized rows)
--
--   mode='reject'
--     from attribution_status ∈ ('pending','retrying')  → 'dlq'
--     requires p_reason (persisted into attribution_dlq_reason)
--     p_to_origin MUST be NULL (rejection is not a classification decision)
--
-- Audit trail:
--   Every successful transition inserts exactly one row into
--   attribution_audit_log with event_type:
--     resolve     → 'operator_resolve'
--     reclassify  → 'operator_reclassify'
--     reject      → 'dlq_entered'   (operator-initiated DLQ; operator_id set)
--
-- Error contract:
--   SQLSTATE 42501 — caller is not an operator
--   SQLSTATE P0001 — invalid argument (mode, origin, reason) OR invalid transition
--   SQLSTATE P0002 — job not found
--
-- Return JSONB on success:
--   { outcome: 'resolved', mode, jobId, fromStatus, toStatus, fromOrigin, toOrigin }

CREATE OR REPLACE FUNCTION public.operator_resolve_attribution(
  p_job_id      UUID,
  p_mode        TEXT,
  p_to_origin   TEXT,
  p_reason      TEXT,
  p_operator_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- ── 0. Input normalisation ────────────────────────────────────────────────
  v_normalized_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');

  -- ── 1. Authorization: operator flag on profiles ───────────────────────────
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

  -- ── 2. Static argument validation ─────────────────────────────────────────
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

  -- ── 3. Row lock + current snapshot ────────────────────────────────────────
  SELECT attribution_status, commercial_origin
    INTO v_current_status, v_current_origin
    FROM public.jobs
   WHERE id = p_job_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found: %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ── 4. Transition-matrix validation ───────────────────────────────────────
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
    IF v_current_status NOT IN ('pending', 'retrying') THEN
      RAISE EXCEPTION 'invalid_transition: reject requires pending|retrying, got %',
        v_current_status USING ERRCODE = 'P0001';
    END IF;
    v_new_status := 'dlq';
    v_new_origin := NULL;
    v_event_type := 'dlq_entered';
  END IF;

  -- ── 5. Apply state transition ─────────────────────────────────────────────
  IF p_mode = 'reject' THEN
    UPDATE public.jobs
       SET attribution_status        = v_new_status,
           attribution_dlq_reason    = v_normalized_reason,
           attribution_last_retry_at = clock_timestamp()
     WHERE id = p_job_id;
  ELSE
    -- resolve / reclassify: set origin, clear DLQ reason (finalized rows never carry one).
    UPDATE public.jobs
       SET attribution_status        = v_new_status,
           commercial_origin         = v_new_origin,
           attribution_dlq_reason    = NULL,
           attribution_last_retry_at = clock_timestamp()
     WHERE id = p_job_id;
  END IF;

  -- ── 6. Audit-log row (atomic with the state transition) ───────────────────
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

-- ── Permissions ──────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.operator_resolve_attribution(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.operator_resolve_attribution(UUID, TEXT, TEXT, TEXT, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.operator_resolve_attribution(UUID, TEXT, TEXT, TEXT, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.operator_resolve_attribution(UUID, TEXT, TEXT, TEXT, UUID) TO service_role;

COMMENT ON FUNCTION public.operator_resolve_attribution(UUID, TEXT, TEXT, TEXT, UUID) IS
  'Operator RPC — moves a job out of DLQ (or reclassifies origin on a finalized job). Validates operator flag, transition matrix, reason presence. Writes attribution_audit_log atomically. SERVICE_ROLE only — invoked by api/operator/resolve-attribution.';
