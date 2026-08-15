-- =============================================================================
-- Block D Slice 1 — P0 Hardening Patch (post-audit 2026-05-10)
-- =============================================================================
-- Fixes 6 P0 findings from session-audit on PR #898 foundation:
--
--   P0-A — fn_seed_chat_participants_for_provider seeded ehemalige MA
--          (kein is_active=true Filter)
--   P0-B — rpc_get_or_create_chat_customer_thread spam/DoS (kein Dedup)
--   P0-4 — fn_chat_set_message_type_on_attachment kein 'mixed' bei mixed
--          Asset-Types
--   P1-A — rpc_enqueue_thread_migration kein is_active=true Filter
--   P1-C — rpc_get_or_create_chat_assignment_thread: Worker ohne
--          assigned_member_ids-Membership kann Thread öffnen
--   P2-A — fn_resolve_provider_for_caller LIMIT 1 ohne ORDER BY
--          (nicht-deterministisch bei Doppel-Membership)
--
-- Plus: NEW RPC `rpc_send_chat_message_with_attachments` für atomare
--       chat_messages + chat_attachments Inserts (Fix für P0-3 atomic
--       attachment-send aus chatWorkflow).
--
-- Atomar in Transaction. Idempotent (CREATE OR REPLACE / IF NOT EXISTS).
-- Reversal-Plan in Section R.
--
-- Pre-verified gegen Prod 2026-05-10:
--   - team_members.is_active existiert (boolean)
--   - chat_messages.message_type CHECK akzeptiert nicht 'mixed' (wird erweitert)
--   - fn_chat_set_message_type_on_attachment existiert (wird ersetzt)
--   - team_members.created_at existiert (für ORDER BY)
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1 — chat_messages.message_type CHECK: add 'mixed'
-- =============================================================================

ALTER TABLE public.chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_message_type_check;

ALTER TABLE public.chat_messages
  ADD CONSTRAINT chat_messages_message_type_check
  CHECK (message_type = ANY (ARRAY[
    'text'::text,
    'image'::text,
    'document'::text,
    'voice'::text,
    'video'::text,
    'mixed'::text,
    'artifact_card'::text,
    'system'::text
  ]));

-- =============================================================================
-- SECTION 2 — Replace fn_chat_set_message_type_on_attachment (P0-4)
-- =============================================================================
-- New behavior:
--   text → NEW.asset_type (first attachment)
--   <single asset-type> + different asset-type → 'mixed'
--   <same asset-type> → no change
--   'mixed' → no change

CREATE OR REPLACE FUNCTION public.fn_chat_set_message_type_on_attachment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current text;
BEGIN
  SELECT message_type INTO v_current
  FROM public.chat_messages
  WHERE id = NEW.message_id;

  IF v_current IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_current = 'text' THEN
    UPDATE public.chat_messages
    SET message_type = NEW.asset_type
    WHERE id = NEW.message_id;
  ELSIF v_current IN ('image', 'document', 'voice', 'video')
    AND v_current <> NEW.asset_type THEN
    UPDATE public.chat_messages
    SET message_type = 'mixed'
    WHERE id = NEW.message_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_chat_set_message_type_on_attachment() FROM public, anon, authenticated;

-- =============================================================================
-- SECTION 3 — fn_resolve_provider_for_caller: deterministic ORDER BY (P2-A)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_resolve_provider_for_caller()
RETURNS TABLE(team_member_id uuid, profile_id uuid, provider_id uuid, member_role text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = 'public'
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
    SELECT tm.id, tm.profile_id, tm.provider_id, tm.role
    FROM public.team_members tm
    WHERE tm.profile_id = v_uid
      AND tm.is_active = true
    ORDER BY tm.created_at DESC, tm.id DESC
    LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_resolve_provider_for_caller() FROM public, anon, authenticated;

-- =============================================================================
-- SECTION 4 — fn_seed_chat_participants_for_provider: is_active filter (P0-A)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_seed_chat_participants_for_provider(
  p_thread_id uuid,
  p_provider_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT
    p_thread_id,
    tm.profile_id,
    CASE WHEN tm.role = 'owner' THEN 'owner' ELSE 'worker' END,
    public.epoch_ms()
  FROM public.team_members tm
  WHERE tm.provider_id = p_provider_id
    AND tm.profile_id IS NOT NULL
    AND tm.is_active = true   -- P0-A fix: skip ehemalige Mitarbeiter
  ON CONFLICT (thread_id, user_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_seed_chat_participants_for_provider(uuid, uuid) FROM public, anon, authenticated;

-- =============================================================================
-- SECTION 5 — rpc_get_or_create_chat_assignment_thread: Membership-Check (P1-C)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_get_or_create_chat_assignment_thread(p_calendar_entry_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_caller record;
  v_thread_id uuid;
  v_calendar_provider_id uuid;
  v_assigned_member_ids text[];
BEGIN
  SELECT * INTO v_caller FROM public.fn_resolve_provider_for_caller();
  IF v_caller.team_member_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row' USING ERRCODE = 'P0001';
  END IF;

  SELECT provider_id, assigned_member_ids
    INTO v_calendar_provider_id, v_assigned_member_ids
  FROM public.calendar_entries
  WHERE id = p_calendar_entry_id;

  IF v_calendar_provider_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: calendar_entry % not found', p_calendar_entry_id USING ERRCODE = 'P0001';
  END IF;
  IF v_calendar_provider_id <> v_caller.provider_id THEN
    RAISE EXCEPTION 'access_denied: calendar_entry belongs to different provider' USING ERRCODE = 'P0001';
  END IF;

  -- P1-C: Caller must be either an owner OR explicitly assigned to this entry.
  IF v_caller.member_role <> 'owner'
     AND NOT (v_caller.team_member_id::text = ANY(COALESCE(v_assigned_member_ids, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'access_denied: caller not assigned to this calendar_entry' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_thread_id
  FROM public.chat_threads
  WHERE provider_id = v_caller.provider_id
    AND channel_type = 'assignment'
    AND assignment_calendar_entry_id = p_calendar_entry_id;

  IF v_thread_id IS NULL THEN
    INSERT INTO public.chat_threads (
      channel_type, provider_id, assignment_calendar_entry_id, title
    )
    VALUES (
      'assignment', v_caller.provider_id, p_calendar_entry_id, 'Einsatz'
    )
    ON CONFLICT (provider_id, assignment_calendar_entry_id)
      WHERE channel_type = 'assignment' AND assignment_calendar_entry_id IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_thread_id;

    IF v_thread_id IS NULL THEN
      SELECT id INTO v_thread_id
      FROM public.chat_threads
      WHERE provider_id = v_caller.provider_id
        AND channel_type = 'assignment'
        AND assignment_calendar_entry_id = p_calendar_entry_id;
    END IF;
  END IF;

  -- Seed assigned worker(s) — only active team_members
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT
    v_thread_id,
    tm.profile_id,
    CASE WHEN tm.role = 'owner' THEN 'owner' ELSE 'worker' END,
    public.epoch_ms()
  FROM public.calendar_entries ce
  JOIN public.team_members tm ON tm.id::text = ANY(ce.assigned_member_ids)
  WHERE ce.id = p_calendar_entry_id
    AND tm.profile_id IS NOT NULL
    AND tm.is_active = true   -- P0-A fix
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  -- Always include the caller
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES (
    v_thread_id,
    v_caller.profile_id,
    CASE WHEN v_caller.member_role = 'owner' THEN 'owner' ELSE 'worker' END,
    public.epoch_ms()
  )
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  -- Include all active owners of the provider so they can monitor assignment threads
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT
    v_thread_id,
    tm.profile_id,
    'owner',
    public.epoch_ms()
  FROM public.team_members tm
  WHERE tm.provider_id = v_caller.provider_id
    AND tm.role = 'owner'
    AND tm.profile_id IS NOT NULL
    AND tm.is_active = true   -- P0-A fix
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_chat_assignment_thread(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_or_create_chat_assignment_thread(uuid) TO authenticated;

-- =============================================================================
-- SECTION 6 — rpc_get_or_create_chat_customer_thread: 60s cooldown (P0-B)
-- =============================================================================
-- Returns existing thread if customer has an active customer-thread with same
-- craftsman within last 60s. Prevents accidental double-create + DoS spam.

CREATE OR REPLACE FUNCTION public.rpc_get_or_create_chat_customer_thread(
  p_craftsman_user_id uuid,
  p_title text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
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

  -- P0-B fix: Reuse a recent thread between same customer and craftsman within
  -- the cooldown window. Defangs accidental double-clicks AND deliberate spam.
  SELECT id INTO v_thread_id
  FROM public.chat_threads
  WHERE channel_type = 'customer'
    AND customer_user_id = v_uid
    AND craftsman_user_id = p_craftsman_user_id
    AND created_at > (public.epoch_ms() - v_cooldown_window_ms)
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_thread_id IS NOT NULL THEN
    RETURN v_thread_id;
  END IF;

  SELECT id INTO v_provider_id
  FROM public.providers
  WHERE profile_id = p_craftsman_user_id;
  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: craftsman has no provider profile' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.chat_threads (
    channel_type, customer_user_id, craftsman_user_id, provider_id, title
  )
  VALUES ('customer', v_uid, p_craftsman_user_id, v_provider_id, p_title)
  RETURNING id INTO v_thread_id;

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES
    (v_thread_id, v_uid, 'customer', public.epoch_ms()),
    (v_thread_id, p_craftsman_user_id, 'craftsman', public.epoch_ms())
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_chat_customer_thread(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_or_create_chat_customer_thread(uuid, text) TO authenticated;

-- =============================================================================
-- SECTION 7 — rpc_enqueue_thread_migration: is_active filter (P1-A)
-- =============================================================================

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
        AND COALESCE(mtp.is_active, true) = true;
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
    PERFORM net.http_post(
      url := 'https://itdntawwuzqfwmcwnwjr.supabase.co/functions/v1/chat-thread-migrator',
      headers := '{"Content-Type":"application/json"}'::jsonb,
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
GRANT EXECUTE ON FUNCTION public.rpc_enqueue_thread_migration(text, text, int) TO authenticated;

-- =============================================================================
-- SECTION 8 — rpc_send_chat_message_with_attachments (P0-3 atomic send)
-- =============================================================================
-- Atomic send for messages with attachments. UI uploads files first to storage,
-- then calls this RPC with the storage paths to insert chat_messages +
-- chat_attachments rows in a single transaction. If the RPC fails, both rows
-- are rolled back together — no orphan UI state.
--
-- The trigger fn_chat_set_message_type_on_attachment fires per attachment
-- INSERT and promotes message_type to 'image'/'document'/'voice'/'video' or
-- 'mixed' depending on the asset types.
--
-- Auth + RBAC:
--   - auth.uid() required
--   - caller must be participant of thread (chat_participants left_at IS NULL)
--   - worker → customer-channel rejected
--
-- Returns: jsonb { message_id: uuid, attachment_ids: uuid[], message_type: text }

CREATE OR REPLACE FUNCTION public.rpc_send_chat_message_with_attachments(
  p_thread_id uuid,
  p_client_message_id uuid,
  p_body text,
  p_reply_to_message_id uuid,
  p_attachments jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid uuid;
  v_thread record;
  v_member_role text;
  v_message_id uuid;
  v_attachment_ids uuid[] := ARRAY[]::uuid[];
  v_attachment jsonb;
  v_attachment_id uuid;
  v_existing_message_id uuid;
  v_message_type text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  IF p_thread_id IS NULL OR p_client_message_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: thread_id + client_message_id required' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_attachments) <> 'array' OR jsonb_array_length(p_attachments) = 0 THEN
    RAISE EXCEPTION 'invalid_argument: attachments must be non-empty array' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_attachments) > 20 THEN
    RAISE EXCEPTION 'invalid_argument: maximum 20 attachments per message' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency: if a message with this client_message_id already exists for
  -- this sender, return it (matches chat_messages UNIQUE constraint).
  SELECT id INTO v_existing_message_id
  FROM public.chat_messages
  WHERE sender_user_id = v_uid
    AND client_message_id = p_client_message_id;
  IF v_existing_message_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'message_id', v_existing_message_id,
      'attachment_ids', (
        SELECT COALESCE(jsonb_agg(id), '[]'::jsonb)
        FROM public.chat_attachments
        WHERE message_id = v_existing_message_id
      ),
      'message_type', (
        SELECT message_type FROM public.chat_messages WHERE id = v_existing_message_id
      ),
      'idempotent', true
    );
  END IF;

  SELECT * INTO v_thread FROM public.chat_threads WHERE id = p_thread_id;
  IF v_thread.id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: thread % not found', p_thread_id USING ERRCODE = 'P0001';
  END IF;

  SELECT cp.role INTO v_member_role
  FROM public.chat_participants cp
  WHERE cp.thread_id = p_thread_id
    AND cp.user_id = v_uid
    AND cp.left_at IS NULL;
  IF v_member_role IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller is not a participant of this thread' USING ERRCODE = 'P0001';
  END IF;

  -- Worker-Hard-Exclusion (defense-in-depth: also enforced by RLS + workflow)
  IF v_member_role = 'worker' AND v_thread.channel_type = 'customer' THEN
    RAISE EXCEPTION 'access_denied: workers cannot send in customer channels' USING ERRCODE = 'P0001';
  END IF;
  IF v_member_role = 'customer' AND v_thread.channel_type IN ('office', 'team', 'assignment') THEN
    RAISE EXCEPTION 'access_denied: customers cannot send in internal channels' USING ERRCODE = 'P0001';
  END IF;

  -- Insert message row first; attachments reference it via FK.
  -- message_type starts as 'text'; the per-attachment trigger promotes it to
  -- the actual asset_type or 'mixed'.
  INSERT INTO public.chat_messages (
    thread_id, sender_user_id, client_message_id, body, message_type, reply_to_message_id
  )
  VALUES (
    p_thread_id, v_uid, p_client_message_id, p_body, 'text', p_reply_to_message_id
  )
  RETURNING id INTO v_message_id;

  -- Insert each attachment. The trigger fires per row.
  FOR v_attachment IN SELECT * FROM jsonb_array_elements(p_attachments)
  LOOP
    INSERT INTO public.chat_attachments (
      message_id,
      asset_type,
      mime_type,
      size_bytes,
      storage_bucket,
      storage_path,
      width,
      height,
      duration_ms,
      poster_storage_path
    )
    VALUES (
      v_message_id,
      v_attachment->>'asset_type',
      v_attachment->>'mime_type',
      (v_attachment->>'size_bytes')::bigint,
      v_attachment->>'storage_bucket',
      v_attachment->>'storage_path',
      NULLIF(v_attachment->>'width', '')::int,
      NULLIF(v_attachment->>'height', '')::int,
      NULLIF(v_attachment->>'duration_ms', '')::int,
      NULLIF(v_attachment->>'poster_storage_path', '')
    )
    RETURNING id INTO v_attachment_id;
    v_attachment_ids := array_append(v_attachment_ids, v_attachment_id);
  END LOOP;

  -- Read final message_type after trigger has run for all attachments
  SELECT message_type INTO v_message_type
  FROM public.chat_messages WHERE id = v_message_id;

  RETURN jsonb_build_object(
    'message_id', v_message_id,
    'attachment_ids', to_jsonb(v_attachment_ids),
    'message_type', v_message_type,
    'idempotent', false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_send_chat_message_with_attachments(uuid, uuid, text, uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rpc_send_chat_message_with_attachments(uuid, uuid, text, uuid, jsonb) TO authenticated;

COMMIT;

-- =============================================================================
-- SECTION R — Reversal Plan (NOT executed automatically)
-- =============================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.rpc_send_chat_message_with_attachments(uuid, uuid, text, uuid, jsonb);
-- -- Restore previous (pre-P0) versions of fn_resolve_provider_for_caller,
-- -- fn_seed_chat_participants_for_provider, rpc_get_or_create_chat_assignment_thread,
-- -- rpc_get_or_create_chat_customer_thread, rpc_enqueue_thread_migration from
-- -- migration 20260514000001 (unchanged in this patch except the noted fields).
-- -- Restore fn_chat_set_message_type_on_attachment from migration 20260513000001.
-- -- Drop 'mixed' from chat_messages.message_type CHECK:
-- ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_message_type_check;
-- ALTER TABLE public.chat_messages ADD CONSTRAINT chat_messages_message_type_check
--   CHECK (message_type = ANY (ARRAY['text','image','document','voice','video','artifact_card','system']));
-- COMMIT;
