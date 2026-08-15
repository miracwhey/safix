-- =============================================================================
-- Migration: Block P · Batch 2 — T+80 dispute-default-cut FLIPS to 75/25 PARTIAL
-- Written against LIVE prod schema (project itdntawwuzqfwmcwnwjr, 2026-06-14).
-- DO NOT APPLY without explicit user confirm.
--
-- LOCKSTEP MONEY-CUT (Block P · Batch 2 of 6).
--   20260614040000 made apply_dispute_default_refund stamp resolution_type
--   'refund_full' (the dormant AGB default = 100% refund). This migration kips
--   that default to the 75/25 partial model:
--     - 75% (the still-HELD, NON-released remainder) is refunded to the customer,
--     - 25% (the tranche already paid out) STAYS with the craftsman.
--   The refund amount is the snapshot of the HELD remainder, computed once here
--   and stamped on the dispute so the worker's refund is deterministic across
--   retries (G1: stable amount + stable per-dispute idempotency key).
--
-- WHAT this migration does (additive, idempotent, 0-row-safe):
--   1. ADD COLUMN disputes.default_refund_minor bigint — nullable, no default,
--      no backfill. The held-remainder snapshot in MINOR units (EUR cents). Set
--      by apply_dispute_default_refund when the default fires; read by the worker
--      to drive a deterministic partial refund.
--   2. CREATE OR REPLACE apply_dispute_default_refund(uuid) — body VERBATIM from
--      20260614040000 except:
--        - resolution_type 'refund_full' -> 'refund_partial'
--          (free-text column; 'refund_partial' is already a live value used by
--           operator_resolve_dispute_refund — no CHECK to extend).
--        - computes the HELD remainder (Σ amount of NON-released tranches via the
--          SHARED held predicate below) and stamps it into default_refund_minor.
--        - stamps split_ratio = 0.25 (provider keeps 25%) for audit symmetry with
--          the operator split path (customer share = total × (1 − split_ratio)).
--      service_role-only guard + FOR UPDATE idempotency gate + history + R3.2
--      zombie-acceptance hygiene + jobs projection are ALL unchanged.
--
-- SHARED HELD PREDICATE (G4 — MUST be byte-identical in api/_disputeDefaultCut.ts
--   and any other consumer). A tranche counts as "held" (still in escrow, owed
--   back to the customer on a default) when:
--     status NOT IN ('released','release_pending')
--     AND external_release_ref  IS NULL   -- no tr_* transfer recorded
--     AND external_payout_ref   IS NULL   -- no po_* payout recorded
--     AND transfer_reversal_ref IS NULL   -- not already reversed
--   Column names verified against the live escrow_tranches schema
--   (20260325000001 base + 20260417000002 transfer_reversal_ref +
--    20260613020000 external_payout_ref).
--
-- NOT IN SCOPE (Batch 3): settle_dispute_default is INTENTIONALLY left exactly as
--   20260614040000 defined it — it still settles the FULL escrow plan/tranches +
--   writes a full-amount ledger row. That FULL-refund FSM is expected/ok here
--   because the whole corridor is DORMANT (FUNDING_DESTINATION_CHARGE_ENABLED not
--   set, 0 dispute rows in prod) and the flip happens only after every batch.
--   This migration does NOT re-declare settle_dispute_default.
--
-- POST-RELEASE CLAWBACK (was OPTION A): INVERTED by this batch. The old full
--   refund clawed back deposit + final transfers via reverse_transfer (driving a
--   paid-out connected account negative). The held-snapshot predicate EXCLUDES
--   released/paid-out tranches, so the default now refunds ONLY the in-escrow
--   remainder — the already-released 25% stays with the provider and NO negative
--   Connect balance is triggered by the default path.
--
-- Prod currently has 0 rows in disputes/escrow_payment_plans/escrow_tranches/
--   ledger_entries/acceptances — this migration is 0-row-safe and non-destructive.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add the held-remainder snapshot column to disputes
-- ---------------------------------------------------------------------------
-- Nullable, no default, no backfill. Existing rows stay NULL (byte-identical to
-- current state). MINOR units (EUR cents); the corridor is EUR-only, matching the
-- EUR-anchored MAX_REFUND_AMOUNTS guard in the shared refund service. Stamped only
-- by apply_dispute_default_refund on the T+80 default; read by the worker so the
-- partial refund amount is deterministic across retries.
ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS default_refund_minor bigint;

COMMENT ON COLUMN public.disputes.default_refund_minor IS
  'P4 Batch 2 (75/25): held-remainder snapshot in MINOR units (EUR cents), set by '
  'apply_dispute_default_refund when the AGB T+80 default fires. Σ amount of the '
  'NON-released tranches (the shared held predicate) × 100. NULL = no auto-default '
  'applied. Makes the worker''s partial refund amount deterministic across retries '
  '(stable amount + stable per-dispute idempotency key).';

-- ---------------------------------------------------------------------------
-- 2. apply_dispute_default_refund(p_dispute_id uuid) — now 75/25 PARTIAL
-- ---------------------------------------------------------------------------
-- Called by the daily cron for disputes that have reached T+80 with no consensus
-- and no operator action. Applies the AGB default = 75/25 PARTIAL refund: the
-- still-HELD remainder is refunded to the customer (provisional + right-of-
-- recourse); the already-released tranche stays with the provider.
--
-- Called by service_role only (cron / Edge Function orchestration).
-- auth.uid() IS NULL in this context → disputes_status_change_guard branch (b)
-- admits the UPDATE unconditionally — no sentinel needed.
--
-- Idempotency gate (FOR UPDATE lock → no race):
--   Proceeds ONLY when ALL conditions hold:
--     - status IN ('open','under_review','customer_waiting','provider_waiting')
--     - decision IS NULL        (operator/consensus has not already decided)
--     - default_applied_at IS NULL  (not already applied)
--   If any condition is false, returns the current dispute row unchanged (no RAISE).
--   This means operator/consensus decisions always win; concurrent cron calls are safe.
CREATE OR REPLACE FUNCTION public.apply_dispute_default_refund(
  p_dispute_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status             text;
  v_decision           text;
  v_settlement_status  text;
  v_default_applied_at timestamptz;
  v_job_id             uuid;
  v_held_minor         bigint;
  v_result             jsonb;
BEGIN
  -- Lock the dispute row for the duration of this transaction.
  -- Prevents concurrent cron calls from double-applying the default.
  SELECT d.status, d.decision, d.settlement_status, d.default_applied_at, d.job_id
    INTO v_status, v_decision, v_settlement_status, v_default_applied_at, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  -- Row not found (job_id IS NULL is the sentinel — job_id is NOT NULL on disputes).
  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  -- RACE / IDEMPOTENCY GATE.
  -- Return the current row unchanged whenever:
  --   • status is already terminal (resolved/closed/cancelled)
  --   • a decision has already been recorded by operator or consensus
  --   • the default has already been applied (default_applied_at IS NOT NULL)
  -- This makes the call safe to retry and ensures operator/consensus always wins.
  -- On a 1b in-progress retry this returns the SAME already-stamped row (including
  -- default_refund_minor), so the worker re-reads the identical snapshot (G1).
  IF NOT (
    v_status IN ('open', 'under_review', 'customer_waiting', 'provider_waiting')
    AND v_decision IS NULL
    AND v_default_applied_at IS NULL
  ) THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d
     WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;

  -- ── Held-remainder snapshot (75% side of the 75/25 cut) ───────────────────
  -- Σ amount of the NON-released tranches for this job's plan, converted to MINOR
  -- units (EUR cents). SHARED held predicate (G4 — byte-identical in the worker):
  --   status NOT IN ('released','release_pending')
  --   AND external_release_ref IS NULL AND external_payout_ref IS NULL
  --   AND transfer_reversal_ref IS NULL
  -- COALESCE → 0 when no held tranche exists (e.g. everything already released);
  -- the worker's anchor check skips plan-less disputes before ever calling this.
  SELECT COALESCE(round(SUM(t.amount) * 100), 0)::bigint
    INTO v_held_minor
    FROM public.escrow_tranches t
    JOIN public.escrow_payment_plans epp ON epp.id = t.plan_id
   WHERE epp.job_id = v_job_id
     AND t.status NOT IN ('released', 'release_pending')
     AND t.external_release_ref  IS NULL
     AND t.external_payout_ref   IS NULL
     AND t.transfer_reversal_ref IS NULL;

  -- Apply the AGB T+80 default: 75/25 PARTIAL refund, provisional.
  -- resolved_at = COALESCE preserves it if already set (unlikely given gate above,
  -- but defensive). resolution_type flips full -> partial; split_ratio=0.25 records
  -- the provider's retained share for audit; default_refund_minor is the snapshot.
  UPDATE public.disputes
     SET status               = 'resolved',
         decision             = 'refund',
         resolution_type      = 'refund_partial',
         split_ratio          = 0.25,
         default_refund_minor = v_held_minor,
         settlement_status    = 'pending',
         default_applied_at   = now(),
         resolved_at          = COALESCE(resolved_at, now()),
         updated_at           = now()
   WHERE id = p_dispute_id;

  -- Audit trail.
  -- source = 'system' (valid per dispute_status_history.source CHECK).
  INSERT INTO public.dispute_status_history
    (dispute_id, previous_status, next_status, source, note, metadata, job_id)
  VALUES (
    p_dispute_id,
    v_status,
    'resolved',
    'system',
    'AGB T+80 default refund (75/25 partial)',
    jsonb_build_object(
      'auto_default',         true,
      'rule',                 'AGB_T80_default',
      'resolution_type',      'refund_partial',
      'split_ratio',          0.25,
      'default_refund_minor', v_held_minor
    ),
    v_job_id
  );

  -- R3.2 zombie-acceptance hygiene (verbatim pattern from operator_resolve_dispute_refund).
  -- Drives the related pending acceptance terminal so the auto-release sweep can never
  -- release a now-refunded final tranche to the provider.
  -- acceptances.updated_at is bigint epoch-ms (NOT timestamptz).
  UPDATE public.acceptances
     SET status     = 'disputed',
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE job_id = v_job_id
     AND status = 'pending';

  -- Sync jobs projection.
  UPDATE public.jobs
     SET dispute_status = 'resolved'
   WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d
   WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_dispute_default_refund(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_dispute_default_refund(uuid) TO service_role;

COMMENT ON FUNCTION public.apply_dispute_default_refund(uuid) IS
  'P4 Batch 2 · T+80 default cut (75/25): applies AGB default = PARTIAL refund of '
  'the still-HELD remainder for a dispute that reached T+80 with no consensus and '
  'no operator action. Stamps resolution_type=refund_partial, split_ratio=0.25 and '
  'the held-remainder snapshot (default_refund_minor). SECURITY DEFINER. '
  'service_role ONLY (cron + Edge Function orchestration). Idempotent: gate returns '
  'the current row unchanged if operator/consensus already acted or the default was '
  'already applied (the snapshot is then re-read identically on retry). '
  'Gated behind FUNDING_DESTINATION_CHARGE_ENABLED=true at the cron caller level; '
  'dormant when the flag is not set.';

-- ---------------------------------------------------------------------------
-- NOTE: settle_dispute_default is NOT touched by this migration (Batch 3 scope).
-- It remains exactly as 20260614040000 defined it (full-plan settlement). That is
-- expected while the corridor is dormant.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3. Schema cache reload
-- ---------------------------------------------------------------------------
-- Required after every MCP-apply migration (feedback_postgrest_schema_cache_reload).
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK
-- (run manually to undo — NOT via apply_migration)
-- =============================================================================
--
-- -- Step 1: Restore the full-refund apply body (re-apply 20260614040000's
-- --         apply_dispute_default_refund definition verbatim).
--
-- -- Step 2: Drop the snapshot column (only safe because prod has 0 dispute rows):
-- ALTER TABLE public.disputes DROP COLUMN IF EXISTS default_refund_minor;
--
-- -- Step 3: Schema cache reload:
-- NOTIFY pgrst, 'reload schema';
-- =============================================================================
