-- DB-level defense: block any transition into status='released' on
-- escrow_tranches or supplementary_payment_requests when the owning job's
-- commercial attribution is not finalized.
--
-- Context:
--   Application-layer gate lives in api/_attributionGuard.ts (Stage 1) and is
--   invoked by create-escrow, initiate-supplementary-funding, release-tranche,
--   and _releaseSupplementaryPayout.  This migration adds the final line of
--   defense at the database layer — any bypass of the app guard (direct SQL,
--   worker bug, future code path, operator mistake) is caught here.
--
-- Error contract:
--   Raises SQLSTATE 'P0004' with MESSAGE prefix 'ATTRIBUTION_NOT_FINALIZED:'.
--   Callers at the app layer (release-tranche.ts, _releaseSupplementaryPayout.ts)
--   detect this prefix/code and emit the structured Sentry event
--   `api.<module>.attribution_drift_split_brain` when the trigger fires after a
--   successful Stripe Transfer (TOCTOU between guard and DB write).
--
-- Scope:
--   Only transitions INTO 'released' are gated.  Transitions between
--   intermediate states (funded → eligible_for_release, release_pending → funded,
--   etc.) are unaffected.
--
--   INSERTs with status='released' are explicitly gated — prevents back-filling
--   or direct inserts from bypassing the check.
--
--   Rows that are already 'released' (idempotent re-writes, healing of missing
--   external_release_ref) do NOT re-fire the trigger because
--   OLD.status IS NOT DISTINCT FROM 'released' short-circuits the guard.
--
-- Fail-closed:
--   Missing plan_id, missing job row, attribution in pending/retrying/dlq/null,
--   or finalized+invalid-origin all raise.  The DB refuses to record the
--   'released' transition under any unresolved attribution state.

CREATE OR REPLACE FUNCTION public.assert_attribution_finalized_before_release()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id     UUID;
  v_status     TEXT;
  v_origin     TEXT;
  v_dlq_reason TEXT;
  v_old_status TEXT;
BEGIN
  -- Short-circuit: only gate transitions INTO 'released'.
  -- COALESCE handles INSERT (OLD is NULL) and UPDATE.
  IF NEW.status IS DISTINCT FROM 'released' THEN
    RETURN NEW;
  END IF;

  v_old_status := CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END;

  -- If the row was already released, this is an idempotent rewrite
  -- (healing of external_release_ref, updated_at bump, etc.) — do NOT re-gate.
  IF v_old_status IS NOT DISTINCT FROM 'released' THEN
    RETURN NEW;
  END IF;

  -- Resolve job_id depending on which table the trigger fired on.
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
    -- Trigger attached to an unexpected table — fail loud.
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: trigger_misconfigured'
      USING ERRCODE = 'P0004',
            DETAIL  = format('trigger on unknown table %I', TG_TABLE_NAME);
  END IF;

  -- Fetch attribution snapshot.  Fail-closed on job row absence.
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

-- ── Attach triggers ──────────────────────────────────────────────────────────
-- BEFORE INSERT OR UPDATE so the raise aborts the write before any row lands.
-- FOR EACH ROW so NEW.* is available and SECURITY DEFINER runs per row.

DROP TRIGGER IF EXISTS assert_attribution_finalized_before_release_tranche
  ON public.escrow_tranches;

CREATE TRIGGER assert_attribution_finalized_before_release_tranche
  BEFORE INSERT OR UPDATE ON public.escrow_tranches
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_attribution_finalized_before_release();

DROP TRIGGER IF EXISTS assert_attribution_finalized_before_release_supplementary
  ON public.supplementary_payment_requests;

CREATE TRIGGER assert_attribution_finalized_before_release_supplementary
  BEFORE INSERT OR UPDATE ON public.supplementary_payment_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_attribution_finalized_before_release();

-- ── Permissions ──────────────────────────────────────────────────────────────
-- Trigger function is invoked implicitly; no GRANTs needed on it, but we
-- revoke from PUBLIC to prevent accidental direct calls.
REVOKE EXECUTE ON FUNCTION public.assert_attribution_finalized_before_release() FROM PUBLIC;

COMMENT ON FUNCTION public.assert_attribution_finalized_before_release() IS
  'DB-level defense: blocks any transition into status=released on escrow_tranches or supplementary_payment_requests when the owning jobs row has attribution_status != finalized or an invalid commercial_origin. Raises SQLSTATE P0004 with ATTRIBUTION_NOT_FINALIZED: prefix.';
