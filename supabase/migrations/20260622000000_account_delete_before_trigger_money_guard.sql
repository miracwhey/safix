-- 20260622000000 · Account-Deletion Block 1 · BEFORE-DELETE chokepoint + money guard
--
-- PROBLEM (verified against prod itdntawwuzqfwmcwnwjr 2026-06-22):
--   1. "Cannot delete user" — six NOT NULL + RESTRICT/NO-ACTION FKs block every
--      DELETE FROM auth.users unless the referencing rows are erased first. That
--      erasure (account_cascade_delete_owned_rows) ran ONLY inside the Vercel
--      route (api/delete-account.ts). Admin-console deletes, direct SQL, and any
--      future RPC never call it, so deleting any user who captured a scan / acted
--      as a provider / touched spatial fails with SQLSTATE 23503. The existing
--      AFTER-DELETE safety-net trigger cannot help: the DELETE aborts before it
--      ever fires.
--        Blockers: scans.captured_by (RESTRICT, →profiles),
--                  provider_presales_projects.created_by_user_id (RESTRICT, →profiles),
--                  spatial_share_audit.actor_user_id (RESTRICT, →auth.users),
--                  spatial_change_orders.proposer_id (NO ACTION, →auth.users),
--                  spatial_pin_reviews.reviewed_by_user_id (NO ACTION, →auth.users),
--                  spatial_rescan_requests.requested_by_user_id (NO ACTION, →auth.users).
--      Plus two org-scoped NO-ACTION blockers that the user-actor-only erasure
--      missed for multi-member orgs (rows authored by an employee but pointing at
--      the deleted owner's providers row):
--                  spatial_pin_reviews.provider_org_id (NO ACTION, →providers),
--                  spatial_rescan_requests.provider_org_id (NO ACTION, →providers).
--   2. "App breaks / money strands" — deleting a user with funds in escrow,
--      pending payouts, or open disputes silently CASCADE-deletes the job, escrow
--      plan and tranches (jobs.customer_profile_id CASCADE; offers→plan CASCADE),
--      stranding captured Stripe funds with no DB record. There was NO pre-delete
--      money guard anywhere.
--
-- FIX (this migration — the durable single chokepoint):
--   • account_delete_blockers(uuid) → jsonb: read-only money/dispute precheck.
--   • account_cascade_delete_owned_rows(uuid): extended with the two org-scoped
--     spatial deletes so multi-member-org owner deletion no longer blocks.
--   • handle_auth_user_before_delete(): BEFORE DELETE ON auth.users — (a) RAISEs
--     if account_delete_blockers is non-empty (money/dispute in flight), so EVERY
--     deletion path is guarded; (b) runs the row-erasure so EVERY path succeeds.
--   The Vercel route keeps its own synchronous precheck + erasure (defense in
--   depth, and a clean 409 for the in-app user before deleteUser is attempted).
--
-- Block 2 (separate) re-points jobs/payments/invoices FKs CASCADE→SET NULL and
-- adds anonymize-and-retain for legally retained records (§147 AO / §14 UStG).

-- ── 1. Read-only money / dispute precheck ────────────────────────────────
-- Returns {} when the account is deletable; otherwise a jsonb object whose keys
-- name the unresolved obligation classes and whose values are counts. Both the
-- BEFORE-DELETE trigger and the Vercel route call this — one source of truth.
CREATE OR REPLACE FUNCTION public.account_delete_blockers(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb := '{}'::jsonb;
  v_provider_ids uuid[];
  n_escrow   integer;
  n_payout   integer;
  n_funding  integer;
  n_funding2 integer;
  n_dispute  integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'account_delete_blockers: p_user_id is required' USING errcode = '22023';
  END IF;

  SELECT coalesce(array_agg(id), '{}'::uuid[])
    INTO v_provider_ids
    FROM public.providers
    WHERE profile_id = p_user_id;

  -- Escrow funds held and not yet finalized (as customer OR provider org).
  SELECT count(*) INTO n_escrow
    FROM public.escrow_tranches t
    JOIN public.escrow_payment_plans p ON p.id = t.plan_id
    WHERE (p.customer_user_id = p_user_id OR p.provider_id = ANY (v_provider_ids))
      AND t.status IN ('funded', 'locked', 'eligible_for_release', 'blocked', 'disputed');
  IF n_escrow > 0 THEN v := v || jsonb_build_object('active_escrow', n_escrow); END IF;

  -- Payout in flight (transfer/payout to provider not yet settled).
  SELECT count(*) INTO n_payout
    FROM public.escrow_tranches t
    JOIN public.escrow_payment_plans p ON p.id = t.plan_id
    WHERE (p.customer_user_id = p_user_id OR p.provider_id = ANY (v_provider_ids))
      AND t.status = 'release_pending';
  IF n_payout > 0 THEN v := v || jsonb_build_object('pending_payout', n_payout); END IF;

  -- Funding in flight (PaymentIntent may be capturing).
  SELECT count(*) INTO n_funding
    FROM public.escrow_payment_plans p
    WHERE (p.customer_user_id = p_user_id OR p.provider_id = ANY (v_provider_ids))
      AND p.status = 'funding_initiated';
  SELECT count(*) INTO n_funding2
    FROM public.funding_requests fr
    WHERE (fr.customer_user_id = p_user_id OR fr.provider_user_id = p_user_id)
      AND fr.status IN ('funding_started', 'funding_initiated');
  IF (n_funding + n_funding2) > 0 THEN
    v := v || jsonb_build_object('funding_in_flight', n_funding + n_funding2);
  END IF;

  -- Open or resolved-but-unsettled disputes the user is party to.
  SELECT count(*) INTO n_dispute
    FROM public.disputes d
    WHERE (d.customer_profile_id = p_user_id
           OR d.opened_by_profile_id = p_user_id
           OR d.provider_id = ANY (v_provider_ids))
      AND (d.status IN ('open', 'under_review', 'customer_waiting', 'provider_waiting')
           OR (d.status = 'resolved' AND d.settlement_status IS DISTINCT FROM 'settled'));
  IF n_dispute > 0 THEN v := v || jsonb_build_object('open_dispute', n_dispute); END IF;

  RETURN v;
END;
$$;

COMMENT ON FUNCTION public.account_delete_blockers(uuid) IS
  'Read-only precheck. Returns {} when the account can be deleted, else a jsonb '
  'map of unresolved money/dispute obligations -> counts. Called by the BEFORE '
  'DELETE trigger (hard enforcement) and api/delete-account.ts (clean 409 UX).';

-- ── 2. Row-erasure (extended with org-scoped spatial blockers) ────────────
-- Deletes exactly the rows whose FKs would otherwise block the auth.users /
-- profiles / providers cascade. Idempotent (re-running deletes 0 rows). The
-- delete order is unchanged from the prod baseline; the only change is the
-- added `OR provider_org_id = ANY(...)` clauses for the two spatial tables.
CREATE OR REPLACE FUNCTION public.account_cascade_delete_owned_rows(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb := '{}'::jsonb;
  n integer;
  v_provider_ids uuid[];
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'account_cascade_delete_owned_rows: p_user_id is required'
      USING errcode = '22023';
  END IF;

  SELECT coalesce(array_agg(id), '{}'::uuid[])
    INTO v_provider_ids
    FROM public.providers
    WHERE profile_id = p_user_id;

  DELETE FROM public.spatial_pin_reviews
    WHERE reviewed_by_user_id = p_user_id
       OR provider_org_id = ANY (v_provider_ids);
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('spatial_pin_reviews', n);

  DELETE FROM public.spatial_change_orders WHERE proposer_id = p_user_id;
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('spatial_change_orders', n);

  DELETE FROM public.spatial_rescan_requests
    WHERE requested_by_user_id = p_user_id
       OR provider_org_id = ANY (v_provider_ids);
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('spatial_rescan_requests', n);

  DELETE FROM public.spatial_share_audit WHERE actor_user_id = p_user_id;
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('spatial_share_audit', n);

  DELETE FROM public.provider_presales_projects WHERE created_by_user_id = p_user_id;
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('provider_presales_projects', n);

  -- Neutralize the roomplan-anchor CHECK before deleting the scans. Deleting a
  -- scan fires `spatial_scenes.source_scan_id → scans ON DELETE SET NULL`; for a
  -- roomplan scene with no surviving job anchor that NULL would violate
  -- `spatial_scenes_anchor_chk` (origin='roomplan' requires a scan or job
  -- anchor) and abort the whole deletion with SQLSTATE 23514. The scene itself
  -- is often shared with a provider, so we retain it and reclassify it as
  -- 'manual' rather than delete it. (Job-anchored scenes are unaffected here;
  -- the job→scene SET NULL path is handled when jobs FKs move to SET NULL.)
  UPDATE public.spatial_scenes
    SET origin = 'manual'
    WHERE origin = 'roomplan'
      AND COALESCE(source_job_id::text, '') = ''
      AND source_scan_id IN (SELECT id FROM public.scans WHERE captured_by = p_user_id);
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('spatial_scenes_reanchored', n);

  DELETE FROM public.scans WHERE captured_by = p_user_id;
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('scans', n);

  RETURN v;
END;
$$;

-- ── 3. BEFORE DELETE chokepoint on auth.users ─────────────────────────────
-- Runs for EVERY deletion path (Vercel route, admin console, direct SQL, Apple
-- support console, future RPC). The money guard RAISE aborts the delete; the
-- erasure clears the blocking FKs so the subsequent cascade succeeds.
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

  PERFORM public.account_cascade_delete_owned_rows(OLD.id);

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.handle_auth_user_before_delete() IS
  'Block 1 · BEFORE DELETE ON auth.users single chokepoint. (a) RAISEs '
  '(ACCOUNT_DELETE_BLOCKED) when account_delete_blockers is non-empty so no path '
  'can strand escrow/payouts/disputes; (b) erases the six (+two org-scoped) '
  'RESTRICT/NO-ACTION FK rows so the auth.users/profiles/providers cascade '
  'succeeds on every path. Complements the AFTER DELETE storage-cleanup trigger.';

DROP TRIGGER IF EXISTS auth_users_before_delete_guard ON auth.users;

CREATE TRIGGER auth_users_before_delete_guard
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_auth_user_before_delete();

-- ── 4. Grants ─────────────────────────────────────────────────────────────
-- CREATE FUNCTION grants EXECUTE to PUBLIC (incl. anon) by default — revoke it.
-- Only service_role (the Vercel admin client) needs to call the precheck RPC.
-- Trigger/erasure functions run as SECURITY DEFINER from the trigger; no role
-- needs a direct grant.
REVOKE ALL ON FUNCTION public.account_delete_blockers(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_delete_blockers(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.account_cascade_delete_owned_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_cascade_delete_owned_rows(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.handle_auth_user_before_delete() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ─────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS auth_users_before_delete_guard ON auth.users;
-- DROP FUNCTION IF EXISTS public.handle_auth_user_before_delete();
-- DROP FUNCTION IF EXISTS public.account_delete_blockers(uuid);
-- -- account_cascade_delete_owned_rows: restore the pre-org-scope baseline body
-- --   (drop the two `OR provider_org_id = ANY(...)` clauses) if reverting fully.
