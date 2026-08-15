-- =============================================================================
-- CHAT-CUTOVER Slice A: Inquiry-Metadaten auf chat_threads + RPCs
-- =============================================================================
-- Kontext: Erstkontakt + Anfrage-Eingang ziehen von legacy conversations auf
-- chat_threads um (Cutover-Block, Plan: chat-cutover-block-2026-06-10-plan.md).
-- Der Brücken-Grant 20260610190000 bleibt bis Slice E (Final-Revoke) bestehen.
--
-- Inhalt:
--   1. 6 neue Spalten auf chat_threads (inquiry_origin, declined_at,
--      reviewed_at, source_project_id, inquiry_criteria, display_metadata)
--      + CHECK auf inquiry_origin + Partial-Index für die Craftsman-Inbox.
--   2. rpc_get_or_create_chat_customer_thread: Signatur erweitert um
--      Inquiry-/Display-Metadaten. ⚠️ DROP vor CREATE — CREATE OR REPLACE mit
--      neuen Parametern würde eine zweite Overload-Signatur anlegen und
--      PostgREST-rpc-Calls ambiguos machen. Neue Parameter haben DEFAULT NULL,
--      bestehende Client-Calls (p_craftsman_user_id, p_title) bleiben gültig.
--      Inquiry-Pfad-Reuse: bei p_inquiry_origin IS NOT NULL wird der jüngste
--      offene Customer-Pair-Thread wiederverwendet (Produkt-Semantik „ein
--      Thread pro Kunde↔Handwerker-Paar", deckungsgleich mit dem App-seitigen
--      Dedup deduplicateConversationsByPair) statt des 60s-Cooldown-Fensters;
--      Inquiry-Felder werden dabei NUR gesetzt wenn noch keine vorhanden sind
--      (keine Überschreib-Semantik). Parität zum Legacy-Verhalten: ein bereits
--      declined Pair-Thread wird unverändert wiederverwendet und NICHT
--      re-opened (gleiches Verhalten wie conversations heute — dokumentierter
--      Folge-Befund, kein Scope dieses Blocks).
--   3. rpc_update_chat_thread_inquiry_state: reviewed_at/declined_at
--      set-only-if-null (idempotent), Caller muss der craftsman_user_id des
--      Threads sein (IS DISTINCT FROM — NULL-craftsman ⇒ deny, kein
--      Three-Valued-Logic-Bypass).
--
-- display_metadata-Format (camelCase, vom Client geschrieben/gelesen):
--   { customerName, customerAvatarUrl, craftsmanName, craftsmanHandle,
--     craftsmanAvatarUrl, projectTitle, projectSubtitle, projectDescription,
--     projectLocation, projectCostRange, projectDuration, projectStatusLabel,
--     syntheticProjectId }
--
-- RLS: keine Policy-Änderung nötig — SELECT deckt beide Parteien
-- (customer_user_id/craftsman_user_id = auth.uid()), Writes laufen
-- ausschließlich über die SECDEF-RPCs.
-- =============================================================================

-- ── 1. Spalten ──────────────────────────────────────────────────────────────

ALTER TABLE public.chat_threads
  ADD COLUMN IF NOT EXISTS inquiry_origin    text,
  ADD COLUMN IF NOT EXISTS declined_at       bigint,
  ADD COLUMN IF NOT EXISTS reviewed_at       bigint,
  ADD COLUMN IF NOT EXISTS source_project_id text,
  ADD COLUMN IF NOT EXISTS inquiry_criteria  jsonb,
  ADD COLUMN IF NOT EXISTS display_metadata  jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_threads_inquiry_origin_check'
      AND conrelid = 'public.chat_threads'::regclass
  ) THEN
    ALTER TABLE public.chat_threads
      ADD CONSTRAINT chat_threads_inquiry_origin_check
      CHECK (inquiry_origin IS NULL OR inquiry_origin IN ('reel','profile','category','project'));
  END IF;
END $$;

-- Craftsman-Inbox: offene Anfragen pro Handwerker, newest-first.
CREATE INDEX IF NOT EXISTS chat_threads_craftsman_inbox_idx
  ON public.chat_threads (craftsman_user_id, last_message_at DESC)
  WHERE channel_type = 'customer'
    AND inquiry_origin IS NOT NULL
    AND declined_at IS NULL;

-- ── 2. rpc_get_or_create_chat_customer_thread (erweitert) ──────────────────

DROP FUNCTION IF EXISTS public.rpc_get_or_create_chat_customer_thread(uuid, text);

CREATE FUNCTION public.rpc_get_or_create_chat_customer_thread(
  p_craftsman_user_id uuid,
  p_title             text  DEFAULT NULL,
  p_inquiry_origin    text  DEFAULT NULL,
  p_source_project_id text  DEFAULT NULL,
  p_inquiry_criteria  jsonb DEFAULT NULL,
  p_display_metadata  jsonb DEFAULT NULL
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

  IF p_inquiry_origin IS NOT NULL THEN
    -- Inquiry-Pfad: ein offener Thread pro Kunde↔Handwerker-Paar.
    SELECT id INTO v_thread_id
    FROM public.chat_threads
    WHERE channel_type = 'customer'
      AND customer_user_id = v_uid
      AND craftsman_user_id = p_craftsman_user_id
      AND closed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_thread_id IS NOT NULL THEN
      -- Nur Threads OHNE Inquiry-Metadaten anreichern — nie überschreiben.
      UPDATE public.chat_threads
      SET inquiry_origin    = p_inquiry_origin,
          source_project_id = COALESCE(source_project_id, p_source_project_id),
          inquiry_criteria  = COALESCE(inquiry_criteria, p_inquiry_criteria),
          display_metadata  = COALESCE(display_metadata, p_display_metadata),
          updated_at        = public.epoch_ms()
      WHERE id = v_thread_id
        AND inquiry_origin IS NULL;
      RETURN v_thread_id;
    END IF;
  ELSE
    -- Nicht-Inquiry-Pfad: bisheriges 60s-Cooldown-Fenster unverändert.
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
  END IF;

  SELECT id INTO v_provider_id
  FROM public.providers
  WHERE profile_id = p_craftsman_user_id;
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

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES
    (v_thread_id, v_uid, 'customer', public.epoch_ms()),
    (v_thread_id, p_craftsman_user_id, 'craftsman', public.epoch_ms())
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  RETURN v_thread_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_chat_customer_thread(uuid, text, text, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_get_or_create_chat_customer_thread(uuid, text, text, text, jsonb, jsonb) TO authenticated, service_role;

-- ── 3. rpc_update_chat_thread_inquiry_state (neu) ──────────────────────────

CREATE OR REPLACE FUNCTION public.rpc_update_chat_thread_inquiry_state(
  p_thread_id   uuid,
  p_reviewed_at bigint DEFAULT NULL,
  p_declined_at bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
  v_craftsman uuid;
  v_channel text;
  v_origin text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  IF p_thread_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: thread_id required' USING ERRCODE = 'P0001';
  END IF;

  SELECT craftsman_user_id, channel_type, inquiry_origin
    INTO v_craftsman, v_channel, v_origin
  FROM public.chat_threads
  WHERE id = p_thread_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: thread % does not exist', p_thread_id USING ERRCODE = 'P0001';
  END IF;
  IF v_channel <> 'customer' OR v_origin IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: thread % is not an inquiry thread', p_thread_id USING ERRCODE = 'P0001';
  END IF;
  -- IS DISTINCT FROM: craftsman_user_id NULL ⇒ deny (kein NULL-Bypass).
  IF v_craftsman IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'access_denied: caller is not the thread craftsman' USING ERRCODE = 'P0001';
  END IF;

  -- Set-only-if-null: erster Timestamp gewinnt, Wiederholungen sind No-Ops.
  UPDATE public.chat_threads
  SET reviewed_at = COALESCE(reviewed_at, p_reviewed_at),
      declined_at = COALESCE(declined_at, p_declined_at),
      updated_at  = public.epoch_ms()
  WHERE id = p_thread_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_update_chat_thread_inquiry_state(uuid, bigint, bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_update_chat_thread_inquiry_state(uuid, bigint, bigint) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
