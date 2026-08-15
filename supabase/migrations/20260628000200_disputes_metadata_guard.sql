-- 20260628000200_disputes_metadata_guard.sql
--
-- HARDENING (Authz Batch 1c) — close the disputes.metadata operator-key forgery vector.
--
-- PROBLEM (verified on prod 2026-06-28 via pg_policies / pg_proc):
--   The RLS UPDATE policy `disputes_update_own_side` admits any party (opener /
--   customer / provider / active team-member) as well as operators. The existing
--   `disputes_status_change_guard_tg` (BEFORE UPDATE) guards lifecycle columns
--   (status, decision, resolution_type, split_ratio, settlement_status,
--   resolved_at, closed_at) but does NOT guard the `metadata` jsonb column.
--
--   Two metadata keys are operator-only (N13.OPS — operatorWriteWorkflow.ts):
--     • operator_comments    — free-text operator voice, rendered verbatim to
--       both parties by selectReconciliationView. A party forging this key can
--       impersonate the official operator voice.
--     • shared_evidence_ids  — controls which dispute-media rows a party sees
--       as "shared by counterparty". A party forging this can expose or hide
--       evidence visibility.
--
--   Both keys are written by direct PostgREST UPDATE (not a SECDEF RPC), which
--   means the operator's JWT must pass is_current_user_operator() at DB level
--   — the TS-layer `assertOperator()` guard is the first line, the new trigger
--   is the second.  A party who crafts a direct PostgREST PATCH can bypass the
--   TS guard and write arbitrary values to these keys because the status-change
--   trigger does not inspect `metadata`.
--
-- TAXONOMY of disputes.metadata keys (verified 2026-06-28):
--   OPERATOR-ONLY (frozen for non-operator callers):
--     • operator_comments    src/lib/disputes/operatorWriteWorkflow.ts:7-10,146-176
--     • shared_evidence_ids  src/lib/disputes/operatorWriteWorkflow.ts:12-14,185-215
--   PARTY-WRITABLE (not frozen):
--     • evidence   — written by party_submit_dispute_statement SECDEF RPC
--                    (migrations/20260610120000_h24_party_submit_dispute_statement.sql:184-192)
--                    and by SupabaseDisputeRepository.update() read-merge-write
--                    (src/lib/disputes/repository/SupabaseDisputeRepository.ts:119-128)
--     • title      — written by SupabaseDisputeRepository.update() metadataFromDispute()
--                    (src/lib/disputes/repository/SupabaseDisputeRepository.ts:125)
--   SERVER/CRON-ONLY (already bypassed by auth.uid() IS NULL):
--     • sla_reminders_sent — written by SLA cron (service_role; auth.uid() IS NULL)
--
-- FIX:
--   A new BEFORE UPDATE trigger `disputes_metadata_guard_tg` that:
--     1. Bypasses for service_role / cron / webhook (auth.uid() IS NULL).
--     2. Bypasses for operators (is_current_user_operator()).
--     3. For all other callers: raises 23514 if operator_comments or
--        shared_evidence_ids changed (NEW.metadata->key IS DISTINCT FROM
--        OLD.metadata->key).
--     4. Allows all other metadata mutations (evidence, title, etc.) through.
--
--   IS DISTINCT FROM is safe because the party write paths never touch
--   operator-only keys:
--     • party_submit_dispute_statement uses jsonb_set(metadata, '{evidence}', …)
--       → operator_comments / shared_evidence_ids unchanged.
--     • SupabaseDisputeRepository.update() read-merge-writes { ...serverMeta,
--       title, evidence } where serverMeta carries the preserved server-side keys.
--
--   COMPOSE, DON'T MODIFY: This trigger is separate from the existing
--   `disputes_status_change_guard_tg` to avoid risk of regression on the
--   battle-tested lifecycle guard. Both triggers fire BEFORE UPDATE; trigger
--   alphabetical order puts disputes_metadata_guard_tg before
--   disputes_status_change_guard_tg.
--
-- ERRCODE 23514 (check_violation): client-facing business reject. classifyFailure
-- maps class 23 → business-rejected → offline queue drop (not P0001 retry storm).
--
-- SELF-PROOF: executed against prod temp table 2026-06-28. All 5 cases PASS:
--   PASS case1: party->operator_comments blocked (23514)
--   PASS case2: party->shared_evidence_ids blocked (23514)
--   PASS case3: party->evidence allowed
--   PASS case4: service_role->operator_comments allowed
--   PASS case5: operator->operator_comments allowed
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS disputes_metadata_guard_tg ON public.disputes;
--   DROP FUNCTION IF EXISTS public.disputes_metadata_guard();

CREATE OR REPLACE FUNCTION public.disputes_metadata_guard()
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

  -- Operators are trusted.
  IF public.is_current_user_operator() THEN
    RETURN NEW;
  END IF;

  -- Fast path: metadata column unchanged — nothing to check.
  IF NEW.metadata IS NOT DISTINCT FROM OLD.metadata THEN
    RETURN NEW;
  END IF;

  -- operator_comments is operator-only. A party must never be able to write
  -- this key; it is rendered as the official "operator voice" to both parties.
  IF (NEW.metadata -> 'operator_comments') IS DISTINCT FROM (OLD.metadata -> 'operator_comments') THEN
    RAISE EXCEPTION 'disputes.metadata: operator_comments is operator-only'
      USING ERRCODE = '23514';
  END IF;

  -- shared_evidence_ids is operator-only. It controls counterparty evidence
  -- visibility; a party forging it could expose or hide evidence.
  IF (NEW.metadata -> 'shared_evidence_ids') IS DISTINCT FROM (OLD.metadata -> 'shared_evidence_ids') THEN
    RAISE EXCEPTION 'disputes.metadata: shared_evidence_ids is operator-only'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS disputes_metadata_guard_tg ON public.disputes;
CREATE TRIGGER disputes_metadata_guard_tg
  BEFORE UPDATE ON public.disputes
  FOR EACH ROW
  EXECUTE FUNCTION public.disputes_metadata_guard();

NOTIFY pgrst, 'reload schema';
