-- 20260612000000-series · SECURITY H2 · chat-thread-migrator caller authentication
-- 20260612030000
-- =============================================================================
-- The Edge Function `chat-thread-migrator` had its shared-secret check disabled
-- (verify_jwt=false + no header check) — anyone could POST it to trigger batch
-- migrations, corrupt migration state (markFailed / exhaust MAX_ATTEMPTS) or
-- force-migrate threads (integrity + DoS). The Edge Function is hardened in the
-- same change to REQUIRE header `x-fixup-trigger-secret` == env
-- `FIXUP_TRIGGER_SHARED_SECRET` (timing-safe, 401 on mismatch).
--
-- This migration re-creates the live internal caller so it keeps working once
-- the gate is on. It does NOT edit the already-applied caller migrations
--   • 20260514000002 §7  (RPC `rpc_enqueue_thread_migration`, lazy path)
-- — per the repo rule "DB is source of truth, write a NEW migration to change a
-- live RPC". CREATE OR REPLACE is idempotent.
--
-- ── RECON: which callers are actually live (2026-06-12) ───────────────────
--   1. Batch cron `chat-thread-migrator-batch` (20260513000003) is RETIRED.
--      Migration 20260517000001 (Slice 7 Legacy Chat Retirement) ran
--      `cron.unschedule('chat-thread-migrator-batch')`; prod `cron.job` confirms
--      NO chat cron exists. All chat_thread_migration_status rows are
--      `migration_verified` (9/9) and the legacy tables are archived read-only.
--      → We deliberately DO NOT re-schedule it: resurrecting retired legacy
--        infra is a regression, not a security fix. The gate on the Edge Fn
--        already blocks any direct attacker POST. If it is ever re-enabled, use
--        the secret-header dispatch pattern sketched at the bottom of this file
--        (mirrors public.spatial_mesh_cleanup_dispatch).
--   2. RPC `rpc_enqueue_thread_migration` IS live — granted to `authenticated`
--      and still called from the app (src/lib/chat/.../SupabaseChatRepository
--      enqueueMigration → supabase.rpc('rpc_enqueue_thread_migration')). Its
--      lazy-mode `net.http_post` had no auth header. Re-created below WITH it.
--
-- ── Shared-secret source ──────────────────────────────────────────────────
-- The caller reads the value from the EXISTING, prod-active vault row
-- `account_cascade_cleanup.shared_secret` — the same row the account-cascade
-- and spatial-parametric-cleanup dispatchers read (see 20260527000001 and
-- 20260531230000). That row holds the value of the Edge env
-- `FIXUP_TRIGGER_SHARED_SECRET` and is confirmed seeded in prod.
--
-- We deliberately do NOT mint a new `chat_thread_migrator.shared_secret` row:
-- a never-seeded dedicated row would make the lazy path silently 401 forever
-- (the `spatial_mesh_cleanup.shared_secret` dormancy lesson — that row was
-- never seeded, leaving mesh-cleanup dead). Reusing the proven row keeps the
-- caller live the moment the migration applies.
--
-- The Edge-Function URL is NOT a secret and is hardcoded exactly as the
-- existing caller migrations hardcode it (no `chat_thread_migrator.url` vault
-- row exists; introducing one would re-open the never-seeded risk).
--
-- ── Dependencies ──────────────────────────────────────────────────────────
--   • pg_net, supabase_vault (installed; see prior migrations).
--   • Vault row `account_cascade_cleanup.shared_secret` seeded (prod ✅).
--   • Edge Function `chat-thread-migrator` redeployed WITH the secret gate.
-- =============================================================================

-- ── RPC lazy path: add the shared-secret header ───────────────────────────
-- Full re-create of rpc_enqueue_thread_migration (20260514000002 §7). The ONLY
-- behavioural change vs the live version is the lazy-mode net.http_post, which
-- now reads the vault secret and sends the x-fixup-trigger-secret header. All
-- auth/RBAC checks (P1-A is_active filters, participant gates) are preserved
-- verbatim. Signature is unchanged so PostgREST exposure is identical.
--
-- Fail-closed: if the vault secret is somehow missing the Edge Fn returns 401
-- and the thread is simply not enqueued this round (no corruption); a user
-- retry recovers it once the vault row is present.

CREATE OR REPLACE FUNCTION public.rpc_enqueue_thread_migration(
  p_legacy_thread_id text,
  p_legacy_source text,
  p_priority int DEFAULT 100
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid uuid;
  v_thread_id uuid;
  v_status text;
  v_secret text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  IF p_legacy_source NOT IN ('conversations', 'message_threads') THEN
    RAISE EXCEPTION 'invalid_argument: legacy_source must be conversations|message_threads' USING ERRCODE = 'P0001';
  END IF;

  IF p_legacy_source = 'conversations' THEN
    PERFORM 1 FROM public.conversations
      WHERE id::text = p_legacy_thread_id
        AND (customer_user_id = v_uid OR craftsman_user_id = v_uid);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'access_denied: not a participant of conversation' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- P1-A fix: only active team_members may enqueue
    PERFORM 1
      FROM public.message_threads mt
      JOIN public.message_thread_participants mtp ON mtp.thread_id = mt.id
      JOIN public.team_members tm ON tm.id::text = mtp.team_member_id
      WHERE mt.id::text = p_legacy_thread_id
        AND tm.profile_id = v_uid
        AND tm.is_active = true
        AND mtp.is_active = true;  -- mirror live prod def (fail-closed; is_active is NOT NULL)
    IF NOT FOUND THEN
      RAISE EXCEPTION 'access_denied: not an active participant of message_thread' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT thread_id, status INTO v_thread_id, v_status
  FROM public.chat_thread_migration_status
  WHERE legacy_thread_id = p_legacy_thread_id AND legacy_source = p_legacy_source;

  IF v_thread_id IS NOT NULL AND v_status IN ('migration_complete', 'migration_verified') THEN
    RETURN;
  END IF;

  IF v_thread_id IS NULL THEN
    -- SECURITY H2: authenticate the internal Edge call. Read the shared trigger
    -- secret from the prod-active vault row (schema-qualified — SECDEF owner
    -- has access regardless of search_path).
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'account_cascade_cleanup.shared_secret'
    LIMIT 1;

    PERFORM net.http_post(
      url := 'https://itdntawwuzqfwmcwnwjr.supabase.co/functions/v1/chat-thread-migrator',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body := jsonb_build_object(
        'mode', 'lazy',
        'legacyThreadId', p_legacy_thread_id,
        'legacySource', p_legacy_source,
        'priority', p_priority
      )
    );
    RETURN;
  END IF;

  UPDATE public.chat_thread_migration_status
    SET status = 'migration_queued',
        priority = GREATEST(priority, p_priority),
        lock_owner = NULL,
        lock_until = NULL,
        updated_at = public.epoch_ms()
    WHERE thread_id = v_thread_id
      AND status IN ('not_migrated', 'migration_failed', 'migration_queued');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_enqueue_thread_migration(text, text, int) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_enqueue_thread_migration(text, text, int) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ─────────────────────────────────────────────────────
-- Re-create rpc_enqueue_thread_migration from 20260514000002 §7 WITHOUT the
-- v_secret declaration and the x-fixup-trigger-secret header (i.e. the inline
-- '{"Content-Type":"application/json"}'::jsonb header). Only do this if the
-- Edge-Fn gate is also rolled back, else the lazy path 401s.

-- ── Reference: batch-cron dispatch pattern (NOT applied — cron is retired) ─
-- If the `chat-thread-migrator-batch` cron is ever re-enabled, route it through
-- a SECDEF dispatch function so it can authenticate + skip-on-missing-vault,
-- mirroring public.spatial_mesh_cleanup_dispatch:
--
--   CREATE OR REPLACE FUNCTION public.chat_thread_migrator_batch_dispatch()
--   RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
--   SET search_path = public, vault, extensions AS $fn$
--   DECLARE v_secret text; v_request_id bigint;
--   BEGIN
--     SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
--       WHERE name = 'account_cascade_cleanup.shared_secret' LIMIT 1;
--     IF v_secret IS NULL THEN RETURN NULL; END IF;
--     SELECT net.http_post(
--       url := 'https://itdntawwuzqfwmcwnwjr.supabase.co/functions/v1/chat-thread-migrator',
--       headers := jsonb_build_object('content-type','application/json',
--                                     'x-fixup-trigger-secret', v_secret),
--       body := jsonb_build_object('mode','batch','batchSize',20),
--       timeout_milliseconds := 30000) INTO v_request_id;
--     RETURN v_request_id;
--   END $fn$;
--   REVOKE EXECUTE ON FUNCTION public.chat_thread_migrator_batch_dispatch()
--     FROM PUBLIC, anon, authenticated;
--   SELECT cron.schedule('chat-thread-migrator-batch','*/5 * * * *',
--     $j$ SELECT public.chat_thread_migrator_batch_dispatch(); $j$);
