-- =============================================================================
-- Migration: finalize_payment_state_atomic RPC
-- =============================================================================
-- Atomically commits terminal payment state across three tables in a single
-- PostgreSQL transaction after a Stripe operation has succeeded.
--
-- Covers:
--   payments  — status (released | refunded)
--   jobs      — payment_state + status (waiting_payment → completed)
--   projects  — payment_state (if a project is linked via jobs.project_id)
--
-- Row-level locking:
--   Acquires FOR UPDATE on the payment row before any writes.
--   This serializes concurrent open_dispute_atomic and finalize_payment_state_atomic
--   calls — preventing release + concurrent dispute from both "winning".
--
-- State-machine validation:
--   Mirrors allowedTransitions in src/lib/payments/stateMachine.ts.
--   An invalid transition raises P0001 so callers can distinguish it from
--   network errors and skip the recordPersistenceFailure path.
--
-- Dispute guard (release only):
--   When p_dispute_id IS NULL (non-dispute release), the function checks for
--   any active dispute (open / awaiting_evidence / under_review) and raises
--   P0001 if one exists.  Dispute-bypass releases pass a real dispute.id.
--
-- Idempotent:
--   If the payment is already in the target state, returns immediately without
--   writes and sets idempotent=true in the result.
--
-- Usage:
--   SELECT public.finalize_payment_state_atomic(
--     'job-abc123',          -- p_job_id
--     'released',            -- p_target_state
--     NULL,                  -- p_dispute_id  (non-dispute release)
--     'provider'             -- p_actor
--   );
--
-- Error codes callers must handle:
--   P0001 — invalid_transition | release_blocked_by_dispute | invalid_target_state
--   P0002 — payment_not_found
-- =============================================================================

CREATE OR REPLACE FUNCTION public.finalize_payment_state_atomic(
  p_job_id          TEXT,
  p_target_state    TEXT,
  p_dispute_id      TEXT    DEFAULT NULL,
  p_actor           TEXT    DEFAULT 'system',
  p_refunded_amount NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- Return immediately if the payment is already in the target state.
  -- This makes retries safe after a partial failure where the RPC succeeded
  -- but the caller did not receive the response (e.g. network timeout).
  IF v_payment_status = p_target_state THEN
    RETURN jsonb_build_object(
      'idempotent', TRUE,
      'state',      p_target_state,
      'paymentId',  v_payment_id
    );
  END IF;

  -- ── 4. State-machine validation ───────────────────────────────────────────
  -- Mirrors allowedTransitions in src/lib/payments/stateMachine.ts exactly:
  --   released: release_pending | disputed
  --   refunded: deposit_paid | in_escrow | release_pending | disputed
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
  -- active dispute exists.  The unique partial index ensures at most one active
  -- dispute per job, so EXISTS is cheap and correct.
  -- The FOR UPDATE lock acquired above ensures no concurrent open_dispute_atomic
  -- can insert a dispute between this check and the UPDATE below.
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

  -- ── 6. Update payments ────────────────────────────────────────────────────
  -- Sets refunded_amount only for refund paths where the caller supplies it.
  -- This tracks partial refunds (split resolutions) for the ledger.
  UPDATE public.payments
     SET status          = p_target_state,
         refunded_amount = COALESCE(p_refunded_amount, refunded_amount),
         updated_at      = v_now
   WHERE job_id = p_job_id;

  -- ── 7. Update jobs: payment_state + status (waiting_payment → completed) ──
  -- Only advances job.status to 'completed' when the job is in 'waiting_payment'.
  -- Jobs in 'in_progress' (dispute edge case) are left alone here — the workflow
  -- layer handles the intermediate 'waiting_payment' step before calling this RPC.
  UPDATE public.jobs
     SET payment_state = p_target_state,
         status        = CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END,
         updated_at    = v_now
   WHERE id = p_job_id;

  -- ── 8. Update linked project (if any) ─────────────────────────────────────
  -- project_id may be empty string ('') when no project is linked (schema default).
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

-- Callable by authenticated users (browser client) and service_role (webhooks/crons).
-- SECURITY DEFINER: runs as definer, bypasses RLS for the atomic multi-table commit.
GRANT EXECUTE ON FUNCTION public.finalize_payment_state_atomic TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_payment_state_atomic TO service_role;

COMMENT ON FUNCTION public.finalize_payment_state_atomic IS
  'Atomically commits released|refunded state across payments, jobs, and projects '
  'in a single transaction after a Stripe operation has succeeded. '
  'Acquires a row-level lock on the payment to serialize concurrent dispute opens. '
  'Called by SupabasePaymentRepository.finalizeStateAtomic() after provider success.';
