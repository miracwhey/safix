-- =============================================================================
-- Block P5b — payments FSM terminal client-lockdown (MED#1 + MED#4)
-- Project: SaFix backend (ref itdntawwuzqfwmcwnwjr), Postgres 17.
-- Sequenced AFTER 20260617000000_p5_payments_fsm_authority_trigger.sql
-- (CREATE OR REPLACE on enforce_payment_fsm — the trigger itself is unchanged).
--
-- ⚠️  DEPLOY ORDER (HARD): apply ONLY WITH or AFTER the TS change that routes every
--     client released/refunded write through finalize_payment_state_atomic
--     (src/lib/payments/service.ts updatePaymentState + the already-RPC-routed
--     releaseEscrowPayment). Applying this BEFORE that TS ships would make step 4a
--     reject ANY surviving authenticated client-direct terminal UPDATE with an
--     uncaught 42501. Passive migration; prod-apply is a separate, explicitly-
--     confirmed step. NOT applied to prod by this file.
--
-- ⚠️  CHARACTER OF THIS CHANGE: this is DEFENSE-IN-DEPTH hardening, not a live-bug
--     fix. The LIVE destination-charge corridor (FUNDING_DESTINATION_CHARGE_ENABLED
--     = true) does NOT client-direct-write a money terminal: a release returns
--     release_pending/release_deferred (releaseClient.ts / release-tranche.ts) and
--     the payout.paid webhook settles payments→released + jobs→completed as
--     service_role (auth.uid() NULL → step 1 bypass). The client terminal-write
--     path (applyLocalSideEffectsAfterServerRelease → updatePaymentState('released'),
--     releaseOperations.ts:577/424) is reached ONLY in the LEGACY flag-OFF transfer
--     model (being retired), where the provider release was ALREADY P5-payee-blocked
--     (42501). So no WORKING path is regressed; this migration makes the DB the
--     enforcement point so a buggy/compromised/future client can never move a money
--     terminal client-direct, regardless of app code.
--
-- ⚠️  KNOWN LATENT DEFECT (legacy flag-OFF only, NOT live): in the flag-OFF path the
--     RPC moves the DB job→completed first, then the subsequent client-side
--     job/project syncs in releaseOperations.ts (updateJobPaymentReleased /
--     syncPaymentStateToJobAndProject / updateJobStatus) run against a STALE local
--     job cache (the RPC refreshes only the payment cache) and would write
--     status='waiting_payment' backwards → jobs_terminal_status_guard 23514. This is
--     unreachable in PAYOUT_MODE (the live corridor never enters this path) and the
--     flag-OFF provider release was already P5-blocked, so it is confined to dying
--     legacy code. FIX (only if the transfer model is ever revived): reload the
--     local job cache from the DB after the RPC-routed release, before the redundant
--     client syncs (which then become no-ops), or skip them in supabase mode.
--
-- WHAT THIS CLOSES (the two non-blocking MEDs deferred from the P5 run)
--   The P5 trigger (20260617000000) only blocked the PAYEE (craftsman / provider)
--   from driving 'released'/'refunded', and only validated the FSM when BOTH the
--   old and new status were canonical. That deliberately left two gaps open
--   because the client still wrote terminals directly:
--
--   MED#1 — the NON-payee customer could client-direct UPDATE payments to
--     'released'/'refunded', bypassing the active-dispute guard + the atomic
--     job/project sync + the timeline audit row that ONLY finalize_payment_state_
--     atomic enforces. (No money theft — Stripe is server-gated — but a payment
--     could diverge from an open dispute and skip the audit trail.)
--
--   MED#4 — the legacy-hop FSM escape: because legacy CHECK-only states
--     (authorized/captured/escrowed/partially_refunded/...) are non-canonical,
--     the canonical-only FSM guard was SKIPPED whenever one side was legacy. A
--     client could hop a canonical terminal out via a legacy NEW status
--     (e.g. released -> captured -> ...) to escape terminality.
--
--   Now that the client routes EVERY released/refunded write through the RPC
--   (sentinel bypass) and the webhook/cron run as service_role (auth.uid() NULL),
--   the ONLY authenticated, non-bypass writes left are the forward escrow steps +
--   dispute-open. So we can hard-block all authenticated terminal writes:
--     (4a) v_new IN (released,refunded)  -> blocked for ALL authenticated callers
--          (subsumes the old payee-only authority guard; closes MED#1; also blocks
--           any legacy-hop INTO a terminal since only v_new matters).
--     (4b) v_old IN (released,refunded)  -> terminal is immutable from the client,
--          incl. a legacy/non-canonical NEW (closes the MED#4 escape direction).
--     (4c) canonical->canonical          -> must be FSM-legal (unchanged).
--
--   The trigger no longer needs to read public.providers (the payee lookup is
--   gone), but stays SECURITY DEFINER / owner postgres for parity and zero
--   behavioral change to the bypass/NULL-uid fast paths.
--
-- CHOKEPOINT COMPLETENESS (verified before authoring): grep of src/ shows NO
--   direct .from('payments') writes; the only client paths that set payments.status
--   to a terminal are updatePaymentState + releaseEscrowPayment, both now via
--   getPaymentRepository().finalizeStateAtomic. All other client repo.update()
--   calls touch non-status fields (linkage / amounts / providerRef / clientSecret)
--   → trigger step (3) passes them untouched. Webhook + crons = service_role.
--
-- RECONCILED AGAINST LIVE PROD 2026-06-21 (read-only): enforce_payment_fsm_tg is
--   LIVE + enabled on public.payments; finalize_payment_state_atomic(text,text,
--   text,text,numeric) + payment_fsm_is_canonical/allowed live; disputes = 0.
--
-- Idempotent + transaction-safe (CREATE OR REPLACE only; no schema/column/index/
-- grant changes). Safe to behaviorally repro inside an aborted tx.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_payment_fsm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_uid uuid  := auth.uid();
  v_old text  := OLD.status;
  v_new text  := NEW.status;
BEGIN
  -- (1) service_role / system: webhooks, crons, migrations, seeds.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- (2) trusted SECDEF RPC sentinel — set ONLY by finalize_payment_state_atomic
  --     (it does its OWN authz + dispute-guard + atomic job/project sync + audit
  --     before flipping the row). A BEFORE trigger still fires under SECURITY
  --     DEFINER with auth.uid() = the CALLER, which is why the sentinel exists.
  --     NOTE: settle_dispute_resolution / settle_dispute_default do NOT set this
  --     sentinel — they are service_role-only (called by the payout.paid webhook)
  --     and REVOKEd from authenticated, so they bypass via step (1) NULL-uid, not
  --     here. If either is ever GRANTed to authenticated, step 4a would start
  --     rejecting their terminal writes (they would then need the sentinel too).
  IF current_setting('app.payment_fsm_bypass', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- (3) non-status update (linkage / refunded_amount / updated_at / stripe ids).
  IF v_new IS NOT DISTINCT FROM v_old THEN
    RETURN NEW;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────────
  -- From here: an AUTHENTICATED, non-bypass, status-CHANGING write. The forward
  -- escrow steps + dispute-open stay client-writable; money terminals do not.
  -- ───────────────────────────────────────────────────────────────────────────

  -- (4a) MED#1 — money-terminal lockdown. No authenticated client may drive a
  --      payment to 'released'/'refunded' directly; the legitimate terminal path
  --      is finalize_payment_state_atomic (step 2 sentinel) or a service_role
  --      webhook/cron (step 1). Subsumes the old payee-only authority guard
  --      (same 42501) and additionally blocks the non-payee customer + any
  --      legacy-hop INTO a terminal (only v_new matters here).
  IF v_new IN ('released', 'refunded') THEN
    RAISE EXCEPTION
      'payment_terminal_requires_rpc: payment % may not be driven to ''%'' by a direct client write — use finalize_payment_state_atomic / the release-refund RPC',
      OLD.id, v_new
      -- 42501 (insufficient_privilege): authority denial, mirrors the P5 payee
      -- guard's errcode. Not P0001, so no classifyFailure 'unknown' retry-loop.
      USING ERRCODE = '42501';
  END IF;

  -- (4b) MED#4 — canonical-terminal immutability. No authenticated client may move
  --      a payment OUT of a canonical terminal ('released'/'refunded'), including
  --      via a legacy / non-canonical NEW status (the legacy-hop ESCAPE direction).
  --      Step 4a already blocks re-entry INTO a terminal, so this closes the loop.
  IF public.payment_fsm_is_canonical(v_old)
     AND v_old IN ('released', 'refunded') THEN
    RAISE EXCEPTION
      'payment_terminal_immutable: payment % is terminal (''%'') and may not be moved by a client write (attempted -> ''%'')',
      OLD.id, v_old, v_new
      -- 23514 (check_violation) → classifyFailure class 23 'business-rejected' →
      -- flushPendingMutations DROPS the queue entry (no permanent retry-loop).
      USING ERRCODE = '23514';
  END IF;

  -- (4c) Canonical FSM guard for the remaining authenticated forward transitions
  --      (deposit_paid / in_escrow / work_in_progress / release_pending / disputed
  --      and the dispute re-routes). Enforced ONLY when BOTH sides are canonical so
  --      legacy Stripe-ish writes (non-terminal) stay working. released/refunded
  --      are fully handled by 4a/4b above and never reach this branch.
  IF public.payment_fsm_is_canonical(v_old)
     AND public.payment_fsm_is_canonical(v_new)
     AND NOT public.payment_fsm_is_allowed(v_old, v_new) THEN
    RAISE EXCEPTION
      'payment_fsm_illegal_transition: % -> % is not an allowed payment transition (payment %)',
      v_old, v_new, OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Owner/grants are unchanged from 20260617000000 (idempotent re-assert for safety).
ALTER FUNCTION public.enforce_payment_fsm() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_payment_fsm() FROM PUBLIC, anon;

-- The enforce_payment_fsm_tg trigger already exists on public.payments and points
-- at this function name — CREATE OR REPLACE updates the body in place, no trigger
-- recreation needed.

-- ---------------------------------------------------------------------------
-- Refresh PostgREST schema cache (feedback_postgrest_schema_cache_reload).
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK (run manually — NOT via apply_migration)
--   Re-apply 20260617000000_p5_payments_fsm_authority_trigger.sql's
--   enforce_payment_fsm() body verbatim (restores the payee-only authority guard
--   + canonical-both FSM check; re-opens MED#1/MED#4). Then:
--     NOTIFY pgrst, 'reload schema';
--   No column/schema/index/grant changes were made by this migration.
-- =============================================================================
