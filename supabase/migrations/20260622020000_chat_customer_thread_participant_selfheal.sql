-- Batch 4 (chat send hardening): make rpc_get_or_create_chat_customer_thread
-- self-healing so a reused / migrated / orphaned customer thread can never be
-- handed back without a LIVE participant row for the caller.
--
-- Root cause (prod audit 2026-06-22): the two reuse branches (inquiry-origin
-- and 60s-cooldown) RETURN v_thread_id BEFORE the only chat_participants INSERT,
-- which ran solely on the fresh-create branch. Both the chat_threads SELECT
-- policy and the chat_messages INSERT WITH CHECK require
--   EXISTS(chat_participants WHERE user_id = auth.uid() AND left_at IS NULL).
-- So any thread that enters the reuse set without a live participant row
-- (migrator non-atomic backfill, a future left_at writer, legacy data) is
-- returned idempotently but is then either RLS-invisible or 42501-locked on
-- every send — permanently, on every retry. Client cache-seeding (Batch 1/2)
-- CANNOT fix this: the thread resolves but the INSERT still rejects.
--
-- Fix: resolve v_thread_id on every path, then upsert BOTH participant rows
-- unconditionally with ON CONFLICT (thread_id, user_id) DO UPDATE SET
-- left_at = NULL — collapsing the orphan / reuse / left classes into one
-- self-healing guarantee. left_at restore is safe here: customer + craftsman
-- never legitimately "leave" a 1:1 customer thread (blocking uses user_blocks +
-- RLS, not left_at).
--
-- Scope: ONLY the participant self-heal. The provider_id RAISE is kept as-is —
-- chat_threads_customer_channel_check enforces provider_id IS NOT NULL for
-- customer threads, so relaxing it (#7) belongs in a separate migration that
-- first alters that constraint.
--
-- Idempotent (CREATE OR REPLACE). No data backfill: the only current orphans
-- are degenerate self-threads (customer_user_id = craftsman_user_id, test data)
-- that the self-thread guard already rejects creating — they are left as-is.

CREATE OR REPLACE FUNCTION public.rpc_get_or_create_chat_customer_thread(
  p_craftsman_user_id uuid,
  p_title text DEFAULT NULL::text,
  p_inquiry_origin text DEFAULT NULL::text,
  p_source_project_id text DEFAULT NULL::text,
  p_inquiry_criteria jsonb DEFAULT NULL::jsonb,
  p_display_metadata jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
  v_provider_id uuid;
  v_thread_id uuid;
  v_cooldown_window_ms bigint := 60000;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  IF p_craftsman_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: craftsman_user_id required' USING ERRCODE = 'P0001';
  END IF;
  IF p_craftsman_user_id = v_uid THEN
    RAISE EXCEPTION 'invalid_argument: cannot start customer-thread with self' USING ERRCODE = 'P0001';
  END IF;
  IF p_inquiry_origin IS NOT NULL
     AND p_inquiry_origin NOT IN ('reel','profile','category','project') THEN
    RAISE EXCEPTION 'invalid_argument: unknown inquiry_origin %', p_inquiry_origin USING ERRCODE = 'P0001';
  END IF;

  -- ── Resolve an existing thread to reuse ──────────────────────────────────
  IF p_inquiry_origin IS NOT NULL THEN
    SELECT id INTO v_thread_id
    FROM public.chat_threads
    WHERE channel_type = 'customer'
      AND customer_user_id = v_uid
      AND craftsman_user_id = p_craftsman_user_id
      AND closed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_thread_id IS NOT NULL THEN
      UPDATE public.chat_threads
      SET inquiry_origin    = p_inquiry_origin,
          source_project_id = COALESCE(source_project_id, p_source_project_id),
          inquiry_criteria  = COALESCE(inquiry_criteria, p_inquiry_criteria),
          display_metadata  = COALESCE(display_metadata, p_display_metadata),
          updated_at        = public.epoch_ms()
      WHERE id = v_thread_id
        AND inquiry_origin IS NULL;
      -- NOTE: fall through to the participant upsert (no early RETURN).
    END IF;
  ELSE
    SELECT id INTO v_thread_id
    FROM public.chat_threads
    WHERE channel_type = 'customer'
      AND customer_user_id = v_uid
      AND craftsman_user_id = p_craftsman_user_id
      AND created_at > (public.epoch_ms() - v_cooldown_window_ms)
    ORDER BY created_at DESC
    LIMIT 1;
    -- NOTE: fall through to the participant upsert (no early RETURN).
  END IF;

  -- ── Create when no reusable thread was found ─────────────────────────────
  IF v_thread_id IS NULL THEN
    SELECT id INTO v_provider_id
    FROM public.providers
    WHERE profile_id = p_craftsman_user_id;
    -- provider_id stays REQUIRED: chat_threads_customer_channel_check enforces
    -- provider_id IS NOT NULL for customer threads, so a NULL would only swap the
    -- P0001 RAISE for a 23514 constraint violation. Relaxing #7 (provider-less
    -- craftsman contactable) needs a separate migration that first alters that
    -- CHECK constraint; out of scope here.
    IF v_provider_id IS NULL THEN
      RAISE EXCEPTION 'invalid_argument: craftsman has no provider profile' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.chat_threads (
      channel_type, customer_user_id, craftsman_user_id, provider_id, title,
      inquiry_origin, source_project_id, inquiry_criteria, display_metadata
    )
    VALUES (
      'customer', v_uid, p_craftsman_user_id, v_provider_id, p_title,
      p_inquiry_origin, p_source_project_id, p_inquiry_criteria, p_display_metadata
    )
    RETURNING id INTO v_thread_id;
  END IF;

  -- ── Self-healing participant guarantee (runs on EVERY path) ───────────────
  -- Both participant rows must always be live (left_at IS NULL) or the caller is
  -- permanently RLS-invisible / 42501-locked out of a thread they own.
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES
    (v_thread_id, v_uid, 'customer', public.epoch_ms()),
    (v_thread_id, p_craftsman_user_id, 'craftsman', public.epoch_ms())
  ON CONFLICT (thread_id, user_id) DO UPDATE SET left_at = NULL;

  RETURN v_thread_id;
END;
$function$;

-- Re-assert least-privilege EXECUTE on every replacement (CREATE OR REPLACE
-- preserves grants, but a future drop+recreate would silently re-open the
-- default PUBLIC/anon EXECUTE — see feedback_supabase_function_anon_default_execute).
REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_chat_customer_thread(uuid, text, text, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_get_or_create_chat_customer_thread(uuid, text, text, text, jsonb, jsonb) TO authenticated, service_role;

-- PostgREST schema cache: a recreated SECURITY DEFINER RPC must be re-read or
-- the next call can 404 with "schema is invalid or incompatible".
NOTIFY pgrst, 'reload schema';

-- Rollback: re-apply the pre-2026-06-22 definition (early RETURNs in both reuse
-- branches + `ON CONFLICT … DO NOTHING` + the `craftsman has no provider profile`
-- RAISE). Kept in git history at migration 20260611000000_chat_inquiry_metadata.sql.
