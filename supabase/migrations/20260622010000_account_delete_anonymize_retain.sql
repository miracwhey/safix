-- 20260622010000 · Account-Deletion Block 2 · Anonymize-and-Retain for money/legal records
--
-- PROBLEM (verified against prod itdntawwuzqfwmcwnwjr 2026-06-22):
--   Deleting a user CASCADE-deleted their entire transaction history:
--     auth.users → profiles → jobs (customer_profile_id CASCADE) → escrow_payment_plans
--       → escrow_tranches + funding_requests, → invoices, → disputes, → ratings.
--     offers (CASCADE on either party) → escrow_payment_plans.source_offer_id
--       (NOT NULL CASCADE) → plan + tranches, even when the job survives.
--   Captured Stripe funds were stranded with no DB record; invoices that must be
--   retained 10 years (§147 AO, §257 HGB, §14 UStG) were destroyed.
--
-- DECISION (Leon 2026-06-22): Anonymize-and-Retain. Legal/financial records
-- (jobs, payments, invoices, escrow plans/tranches, funding requests, disputes,
-- ratings) SURVIVE a deletion; the user's PII is scrubbed where it is
-- denormalized and live FKs are nulled. Invoices already snapshot the legally
-- required name+address into `parties` / `customer_snapshot` / `provider_snapshot`
-- jsonb (no live profile FK), so they are self-contained legal documents — they
-- are RETAINED untouched (Verarbeitung gesperrt, not erased). Block 1's money
-- guard blocks deletion while funds are still in flight; this block governs what
-- happens to already-settled records.
--
-- FIX:
--   1. Re-point the three CASCADE FKs that destroyed money/legal records to
--      SET NULL (keeping the record, dropping only the link):
--        • jobs.customer_profile_id           CASCADE → SET NULL  (keystone — keeps
--          the job alive, which keeps invoices/plans/tranches/funding/disputes/
--          ratings/payments alive, all keyed on job_id).
--        • escrow_payment_plans.source_offer_id  NOT NULL CASCADE → nullable SET NULL.
--        • funding_requests.source_offer_id      NOT NULL CASCADE → nullable SET NULL.
--      (Offers themselves remain CASCADE — they are quotes, not retained records,
--       and no retained record depends on them once these two links are nulled.
--       invoices.source_offer_id is a loose uuid with no FK, unaffected.)
--   2. account_anonymize_owned_pii(uuid): scrub the only denormalized name PII on
--      a retained record — jobs.customer (text) — to 'Gelöschter Nutzer' and null
--      the customer id columns. (jobs.city is coarse work-location, not a direct
--      identifier, and the full address lives in the retained invoice snapshot —
--      left intact as a business record.)
--   3. handle_auth_user_before_delete() calls the anonymizer (after the money
--      guard, before row-erasure) so EVERY deletion path anonymizes consistently.
--
-- Repo migration ledger note: jobs/escrow/funding FK definitions live in the
-- baseline snapshot; this is the first migration-file source for the SET NULL form.

-- ── 1. FK re-points ───────────────────────────────────────────────────────
ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_customer_profile_id_fkey;
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_customer_profile_id_fkey
  FOREIGN KEY (customer_profile_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.escrow_payment_plans
  ALTER COLUMN source_offer_id DROP NOT NULL;
ALTER TABLE public.escrow_payment_plans
  DROP CONSTRAINT IF EXISTS escrow_payment_plans_source_offer_id_fkey;
ALTER TABLE public.escrow_payment_plans
  ADD CONSTRAINT escrow_payment_plans_source_offer_id_fkey
  FOREIGN KEY (source_offer_id) REFERENCES public.offers(id) ON DELETE SET NULL;

ALTER TABLE public.funding_requests
  ALTER COLUMN source_offer_id DROP NOT NULL;
ALTER TABLE public.funding_requests
  DROP CONSTRAINT IF EXISTS funding_requests_source_offer_id_fkey;
ALTER TABLE public.funding_requests
  ADD CONSTRAINT funding_requests_source_offer_id_fkey
  FOREIGN KEY (source_offer_id) REFERENCES public.offers(id) ON DELETE SET NULL;

-- ── 2. PII anonymization for retained records ─────────────────────────────
CREATE OR REPLACE FUNCTION public.account_anonymize_owned_pii(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb := '{}'::jsonb;
  n integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'account_anonymize_owned_pii: p_user_id is required' USING errcode = '22023';
  END IF;

  -- jobs.customer is the only denormalized name PII on a retained record. The
  -- jobs_terminal_status_guard only blocks status changes, so scrubbing the
  -- customer field on terminal jobs is allowed. Nulling the id columns here is
  -- belt-and-suspenders; the SET NULL FKs would null them during the cascade too.
  UPDATE public.jobs
    SET customer = 'Gelöschter Nutzer',
        customer_profile_id = NULL,
        customer_user_id = NULL
    WHERE customer_profile_id = p_user_id
       OR customer_user_id = p_user_id;
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('jobs_anonymized', n);

  RETURN v;
END;
$$;

COMMENT ON FUNCTION public.account_anonymize_owned_pii(uuid) IS
  'Block 2 · Scrubs denormalized customer-name PII (jobs.customer) on retained '
  'records when an account is deleted, and nulls the customer id links. Retained '
  'records (jobs/payments/invoices/escrow/disputes/ratings) survive; invoice '
  'snapshots keep the §14 UStG name+address as a locked legal document.';

-- ── 3. Wire anonymization into the all-paths BEFORE DELETE chokepoint ──────
CREATE OR REPLACE FUNCTION public.handle_auth_user_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blockers jsonb;
BEGIN
  v_blockers := public.account_delete_blockers(OLD.id);
  IF v_blockers <> '{}'::jsonb THEN
    RAISE EXCEPTION
      'ACCOUNT_DELETE_BLOCKED: account % has unresolved money/dispute obligations %',
      OLD.id, v_blockers
      USING errcode = 'P0001',
            hint = 'Release or refund escrow, complete payouts, and settle disputes before deletion.';
  END IF;

  -- Retain + anonymize money/legal records BEFORE the cascade runs.
  PERFORM public.account_anonymize_owned_pii(OLD.id);

  -- Erase the rows whose RESTRICT/NO-ACTION FKs would otherwise block the cascade.
  PERFORM public.account_cascade_delete_owned_rows(OLD.id);

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.account_anonymize_owned_pii(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_anonymize_owned_pii(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ─────────────────────────────────────────────────────
-- ALTER TABLE public.jobs DROP CONSTRAINT jobs_customer_profile_id_fkey;
-- ALTER TABLE public.jobs ADD CONSTRAINT jobs_customer_profile_id_fkey
--   FOREIGN KEY (customer_profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
-- (escrow_payment_plans / funding_requests: re-add CASCADE + restore NOT NULL only
--  if every source_offer_id is still populated.)
-- DROP FUNCTION IF EXISTS public.account_anonymize_owned_pii(uuid);
-- -- restore handle_auth_user_before_delete() without the anonymize PERFORM.
