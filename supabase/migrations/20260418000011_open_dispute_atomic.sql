-- =============================================================================
-- Migration: open_dispute_atomic RPC
-- =============================================================================
-- Atomically opens a dispute for a job in a single database transaction:
--   1. Acquires a row-level lock on the payment record (if one exists).
--   2. Validates that the payment state allows the 'disputed' transition.
--   3. Inserts the dispute row (unique partial index prevents duplicate
--      active disputes for the same job — error code 23505 on conflict).
--   4. Transitions the payment status to 'disputed'.
--   5. Sets the job's dispute_status to 'open'.
--
-- All five steps are executed inside a single implicit PL/pgSQL transaction.
-- If any step fails the entire operation is rolled back — no partial state.
--
-- Returns the inserted dispute row as JSONB so the caller can populate its
-- local in-memory cache without a second round-trip.
--
-- Error codes the caller must handle:
--   23505 (unique_violation) — an active dispute already exists for this job.
--   P0001 (raise_exception)  — payment is in a state that cannot be disputed
--                              (e.g. released, refunded, deposit_required).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.open_dispute_atomic(
  p_job_id            TEXT,
  p_dispute_id        TEXT,
  p_reason            TEXT,
  p_title             TEXT,
  p_description       TEXT,
  p_raised_by         TEXT    DEFAULT NULL,
  p_payment_id        TEXT    DEFAULT NULL,
  p_context_snapshot  JSONB   DEFAULT NULL,
  p_created_at        BIGINT  DEFAULT NULL,
  p_updated_at        BIGINT  DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment_status TEXT;
  v_now_ms         BIGINT;
  v_dispute_json   JSONB;
  v_raised_by      TEXT;
BEGIN
  -- Resolve timestamp — caller may pass its own value for consistency
  v_now_ms := COALESCE(p_created_at, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT);

  -- For authenticated callers, always derive raised_by from the JWT — callers must
  -- not be able to spoof another user's identity.  Webhooks/crons (service_role)
  -- pass auth.uid() = NULL and supply raised_by themselves.
  v_raised_by := CASE
    WHEN auth.uid() IS NOT NULL THEN auth.uid()::text
    ELSE p_raised_by
  END;

  -- ── 1. Lock the payment row for this job (if it exists) ───────────────────
  -- Blocking lock: if a concurrent release or refund is mid-flight on the same
  -- payment we wait here rather than racing.  The SKIP LOCKED alternative would
  -- let us proceed without a payment — not safe for the money-lock invariant.
  SELECT status
    INTO v_payment_status
    FROM public.payments
   WHERE job_id = p_job_id
   FOR UPDATE;

  -- ── 1b. Authorization check ───────────────────────────────────────────────
  -- Authenticated callers must be a participant in the job.
  -- service_role callers (auth.uid() IS NULL) are exempt.
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

  -- ── 2. Validate payment state allows the 'disputed' transition ────────────
  -- Valid predecessors (mirrors payments/stateMachine.ts allowedTransitions):
  --   in_escrow, work_in_progress, release_pending
  -- 'disputed' is also accepted here so that a concurrent open where the first
  -- thread already committed triggers the unique-constraint path (23505) rather
  -- than an opaque state error.
  -- Payments in terminal states (released, refunded) or pre-escrow states
  -- (deposit_required, deposit_paid) cannot be disputed.
  IF v_payment_status IS NOT NULL
     AND v_payment_status NOT IN (
           'in_escrow', 'work_in_progress', 'release_pending', 'disputed'
         )
  THEN
    RAISE EXCEPTION 'payment_invalid_for_dispute: current status is %, cannot transition to disputed',
      v_payment_status
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 3. Insert the dispute ─────────────────────────────────────────────────
  -- idx_disputes_job_active_unique prevents two active disputes for the same
  -- job.  Concurrent callers will get SQLSTATE 23505 on the second INSERT.
  INSERT INTO public.disputes (
    id,
    job_id,
    payment_id,
    raised_by,
    status,
    reason,
    title,
    description,
    created_at,
    updated_at,
    context_snapshot
  ) VALUES (
    p_dispute_id,
    p_job_id,
    p_payment_id,
    v_raised_by,
    'open',
    p_reason,
    p_title,
    p_description,
    v_now_ms,
    v_now_ms,
    p_context_snapshot
  );

  -- ── 4. Transition payment to 'disputed' (if payment exists and not already) ──
  IF v_payment_status IS NOT NULL AND v_payment_status != 'disputed' THEN
    UPDATE public.payments
       SET status     = 'disputed',
           updated_at = NOW()
     WHERE job_id = p_job_id;
  END IF;

  -- ── 5. Set job dispute status ─────────────────────────────────────────────
  UPDATE public.jobs
     SET dispute_status = 'open'
   WHERE id = p_job_id;

  -- ── 6. Return the created dispute row ─────────────────────────────────────
  SELECT row_to_json(d)::JSONB
    INTO v_dispute_json
    FROM public.disputes d
   WHERE d.id = p_dispute_id;

  RETURN v_dispute_json;
END;
$$;

-- Callable by authenticated users (browser client) and service_role (webhooks).
-- SECURITY DEFINER ensures the function runs with the definer's privileges,
-- bypassing RLS — intentional for the atomic multi-table write.
GRANT EXECUTE ON FUNCTION public.open_dispute_atomic TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_dispute_atomic TO service_role;
