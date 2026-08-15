-- =============================================================================
-- Block D Slice 1 Phase 1b — Chat-Thread Create RPCs + assignment FK
-- =============================================================================
-- Adds RPCs that create chat_threads directly (no longer via legacy
-- message_threads / conversations). Used by Phase 1b UI-Cutover so new
-- threads land in the unified schema from day one.
--
-- New column:   chat_threads.assignment_calendar_entry_id (uuid, nullable)
-- New indexes:  partial-unique on (provider_id, channel_type) for office/team
--               partial-unique on (provider_id, assignment_calendar_entry_id)
-- New RPCs:     rpc_get_or_create_chat_office_thread()
--               rpc_get_or_create_chat_team_thread()
--               rpc_get_or_create_chat_assignment_thread(uuid)
--               rpc_get_or_create_chat_customer_thread(uuid, text)
--               rpc_enqueue_thread_migration(text, text, int)
--
-- Atomar in Transaction. Idempotent. Reversal in Section R.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1 — chat_threads.assignment_calendar_entry_id (additive)
-- =============================================================================

ALTER TABLE public.chat_threads
  ADD COLUMN IF NOT EXISTS assignment_calendar_entry_id uuid;

-- Partial-unique-index: 1 office-thread + 1 team-thread per provider
CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_provider_internal_unique
  ON public.chat_threads (provider_id, channel_type)
  WHERE channel_type IN ('office', 'team');

-- Partial-unique-index: 1 assignment-thread per (provider, calendar_entry)
CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_provider_assignment_unique
  ON public.chat_threads (provider_id, assignment_calendar_entry_id)
  WHERE channel_type = 'assignment' AND assignment_calendar_entry_id IS NOT NULL;

-- =============================================================================
-- SECTION 2 — Helper: resolve_provider_for_caller
-- =============================================================================
-- Internal helper. Returns (team_member_id, profile_id, provider_id, role).
-- Used by office/team/assignment RPCs to identify caller's provider context.

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
    LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_resolve_provider_for_caller() FROM public, anon, authenticated;

-- =============================================================================
-- SECTION 3 — Helper: seed_chat_participants_for_provider
-- =============================================================================
-- Adds all team-members of a provider as chat_participants for an internal
-- thread (office/team). Idempotent via ON CONFLICT.

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
  ON CONFLICT (thread_id, user_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_seed_chat_participants_for_provider(uuid, uuid) FROM public, anon, authenticated;

-- =============================================================================
-- SECTION 4 — RPC: rpc_get_or_create_chat_office_thread()
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_get_or_create_chat_office_thread()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_caller record;
  v_thread_id uuid;
BEGIN
  SELECT * INTO v_caller FROM public.fn_resolve_provider_for_caller();
  IF v_caller.team_member_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_thread_id
  FROM public.chat_threads
  WHERE provider_id = v_caller.provider_id AND channel_type = 'office';

  IF v_thread_id IS NULL THEN
    INSERT INTO public.chat_threads (channel_type, provider_id, title)
    VALUES ('office', v_caller.provider_id, 'Büro')
    ON CONFLICT (provider_id, channel_type) WHERE channel_type IN ('office','team') DO NOTHING
    RETURNING id INTO v_thread_id;

    IF v_thread_id IS NULL THEN
      SELECT id INTO v_thread_id
      FROM public.chat_threads
      WHERE provider_id = v_caller.provider_id AND channel_type = 'office';
    END IF;
  END IF;

  PERFORM public.fn_seed_chat_participants_for_provider(v_thread_id, v_caller.provider_id);
  RETURN v_thread_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_chat_office_thread() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_or_create_chat_office_thread() TO authenticated;

-- =============================================================================
-- SECTION 5 — RPC: rpc_get_or_create_chat_team_thread()
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_get_or_create_chat_team_thread()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_caller record;
  v_thread_id uuid;
BEGIN
  SELECT * INTO v_caller FROM public.fn_resolve_provider_for_caller();
  IF v_caller.team_member_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_thread_id
  FROM public.chat_threads
  WHERE provider_id = v_caller.provider_id AND channel_type = 'team';

  IF v_thread_id IS NULL THEN
    INSERT INTO public.chat_threads (channel_type, provider_id, title)
    VALUES ('team', v_caller.provider_id, 'Team')
    ON CONFLICT (provider_id, channel_type) WHERE channel_type IN ('office','team') DO NOTHING
    RETURNING id INTO v_thread_id;

    IF v_thread_id IS NULL THEN
      SELECT id INTO v_thread_id
      FROM public.chat_threads
      WHERE provider_id = v_caller.provider_id AND channel_type = 'team';
    END IF;
  END IF;

  PERFORM public.fn_seed_chat_participants_for_provider(v_thread_id, v_caller.provider_id);
  RETURN v_thread_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_chat_team_thread() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_or_create_chat_team_thread() TO authenticated;

-- =============================================================================
-- SECTION 6 — RPC: rpc_get_or_create_chat_assignment_thread(p_calendar_entry_id)
-- =============================================================================
-- Assignment-channel: Worker + Craftsman per Einsatz. The calendar_entry
-- determines membership: assigned worker(s) + provider craftsman/owner.

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
BEGIN
  SELECT * INTO v_caller FROM public.fn_resolve_provider_for_caller();
  IF v_caller.team_member_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row' USING ERRCODE = 'P0001';
  END IF;

  -- Verify the calendar_entry belongs to caller's provider (RBAC)
  SELECT provider_id INTO v_calendar_provider_id
  FROM public.calendar_entries
  WHERE id = p_calendar_entry_id;

  IF v_calendar_provider_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: calendar_entry % not found', p_calendar_entry_id USING ERRCODE = 'P0001';
  END IF;
  IF v_calendar_provider_id <> v_caller.provider_id THEN
    RAISE EXCEPTION 'access_denied: calendar_entry belongs to different provider' USING ERRCODE = 'P0001';
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

  -- Seed participants: assigned worker(s) come from calendar_entries.assigned_member_ids[]
  -- (text[] holding team_members.id::text references)
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT
    v_thread_id,
    tm.profile_id,
    CASE WHEN tm.role = 'owner' THEN 'owner' ELSE 'worker' END,
    public.epoch_ms()
  FROM public.calendar_entries ce
  JOIN public.team_members tm ON tm.id::text = ANY(ce.assigned_member_ids)
  WHERE ce.id = p_calendar_entry_id AND tm.profile_id IS NOT NULL
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  -- Always include the caller (e.g., owner who creates the thread)
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES (
    v_thread_id,
    v_caller.profile_id,
    CASE WHEN v_caller.member_role = 'owner' THEN 'owner' ELSE 'worker' END,
    public.epoch_ms()
  )
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  -- Also include all owners of the provider so they can monitor assignment threads
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
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_chat_assignment_thread(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_or_create_chat_assignment_thread(uuid) TO authenticated;

-- =============================================================================
-- SECTION 7 — RPC: rpc_get_or_create_chat_customer_thread(p_craftsman_user_id, p_title?)
-- =============================================================================
-- Customer initiates contact with craftsman. Always CREATE NEW thread
-- (matches legacy `conversations` semantics — multiple threads per pair allowed,
-- one per project/inquiry). Caller must be the customer (auth.uid()).

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

  -- Seed both parties as participants
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
-- SECTION 8 — RPC: rpc_enqueue_thread_migration(legacy_thread_id, legacy_source, priority)
-- =============================================================================
-- Used by Coexistence-Read fallback path: when UI opens a legacy thread that
-- has not yet been migrated, this RPC enqueues the thread for the migrator
-- Edge Function. Auth check + Membership check.

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

  -- Membership-Pre-Check: caller must be participant in the legacy thread
  IF p_legacy_source = 'conversations' THEN
    PERFORM 1 FROM public.conversations
      WHERE id::text = p_legacy_thread_id
        AND (customer_user_id = v_uid OR craftsman_user_id = v_uid);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'access_denied: not a participant of conversation' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    PERFORM 1
      FROM public.message_threads mt
      JOIN public.message_thread_participants mtp ON mtp.thread_id = mt.id
      JOIN public.team_members tm ON tm.id::text = mtp.team_member_id
      WHERE mt.id::text = p_legacy_thread_id AND tm.profile_id = v_uid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'access_denied: not a participant of message_thread' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Check existing migration status
  SELECT thread_id, status INTO v_thread_id, v_status
  FROM public.chat_thread_migration_status
  WHERE legacy_thread_id = p_legacy_thread_id AND legacy_source = p_legacy_source;

  IF v_thread_id IS NOT NULL AND v_status IN ('migration_complete', 'migration_verified') THEN
    -- Already migrated, no-op
    RETURN;
  END IF;

  IF v_thread_id IS NULL THEN
    -- No status row yet. The Edge Function (chat-thread-migrator) will create
    -- both chat_threads and migration_status rows on next batch tick. We just
    -- send a hint via pg_net so it picks this up immediately rather than
    -- waiting up to 5 min for cron.
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

  -- Status exists; re-prioritize and unlock
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

COMMIT;

-- =============================================================================
-- SECTION R — Reversal Plan (NOT executed automatically)
-- =============================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.rpc_enqueue_thread_migration(text, text, int);
-- DROP FUNCTION IF EXISTS public.rpc_get_or_create_chat_customer_thread(uuid, text);
-- DROP FUNCTION IF EXISTS public.rpc_get_or_create_chat_assignment_thread(uuid);
-- DROP FUNCTION IF EXISTS public.rpc_get_or_create_chat_team_thread();
-- DROP FUNCTION IF EXISTS public.rpc_get_or_create_chat_office_thread();
-- DROP FUNCTION IF EXISTS public.fn_seed_chat_participants_for_provider(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.fn_resolve_provider_for_caller();
-- DROP INDEX IF EXISTS public.chat_threads_provider_assignment_unique;
-- DROP INDEX IF EXISTS public.chat_threads_provider_internal_unique;
-- ALTER TABLE public.chat_threads DROP COLUMN IF EXISTS assignment_calendar_entry_id;
-- COMMIT;
