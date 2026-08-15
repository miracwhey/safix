-- =============================================================================
-- CHAT-CUTOVER Slice E/1: Backfill legacy conversations → chat_threads
-- =============================================================================
-- ⚠️ APPLY-GATE: erst NACH (a) Apply von 20260611000000, (b) App-Deploy mit
-- aktiven VITE_CHAT_UI_CUTOVER_{CUSTOMER,CRAFTSMAN}-Flags, (c) Device-Smoke
-- grün. Reihenfolge siehe Plan chat-cutover-block-2026-06-10-plan.md.
--
-- Grounding (read-only Prod 2026-06-10): 36 conversations (28 mit
-- inquiry_origin), 91 messages — kein Batching nötig.
-- Apply-Fix 2026-06-11: syntheticProjectId entfernt — Prod-conversations hat
-- keine project_id-Spalte (Repo-Schema-Drift); Client hat Fallback
-- (inquiry_<threadId>). Applied als Ledger-Version 20260611002711.
--
-- Was passiert:
--   * Jede legacy conversation mit auflösbarem Kunde↔Handwerker-Paar bekommt
--     einen chat_threads-Shell mit legacy_thread_id/legacy_source, kopierten
--     Inquiry-Feldern und aus den Legacy-Spalten zusammengesetztem
--     display_metadata (camelCase — Client-Lesekontrakt).
--   * Beide Participants werden geseedet.
--   * last_message_at/_body kommen aus der jüngsten legacy message, damit
--     Inbox-Sortierung und Preview ohne Message-Migration funktionieren.
--
-- Was NICHT passiert:
--   * Message-INHALTE werden nicht kopiert — das bleibt der bestehenden
--     Lazy-Migration-Pipeline (legacy_thread_id ist gesetzt; Coexistence-Read
--     im SupabaseChatRepository + rpc_enqueue_thread_migration übernehmen).
--   * Conversations, deren Paar bereits einen offenen chat_threads-Customer-
--     Thread hat, werden ÜBERSPRUNGEN (Produkt-Invariante: ein Thread pro
--     Paar — ein Backfill-Duplikat wäre schlimmer als ein nicht migrierter
--     Alt-Shell). Zählung im RAISE NOTICE unten prüfen.
--   * Kein DROP, kein Revoke — das ist 20260611200000.
--
-- Idempotent: NOT-EXISTS-Guards auf legacy_thread_id + Pair.
-- =============================================================================

DO $$
DECLARE
  v_inserted int;
  v_skipped_pair int;
  v_skipped_no_provider int;
BEGIN
  -- Vorab-Zählung der Skips (Sichtbarkeit im Apply-Log).
  SELECT count(*) INTO v_skipped_pair
  FROM public.conversations c
  WHERE c.customer_user_id IS NOT NULL
    AND c.craftsman_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.chat_threads t
      WHERE t.channel_type = 'customer'
        AND t.customer_user_id = c.customer_user_id
        AND t.craftsman_user_id = c.craftsman_user_id
    );

  SELECT count(*) INTO v_skipped_no_provider
  FROM public.conversations c
  WHERE c.craftsman_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.providers p WHERE p.profile_id = c.craftsman_user_id);

  WITH source AS (
    SELECT
      c.*,
      p.id AS provider_id,
      lm.last_created_at,
      lm.last_content
    FROM public.conversations c
    JOIN public.providers p ON p.profile_id = c.craftsman_user_id
    LEFT JOIN LATERAL (
      SELECT m.created_at AS last_created_at, m.content AS last_content
      FROM public.messages m
      WHERE m.conversation_id = c.id
      ORDER BY m.created_at DESC
      LIMIT 1
    ) lm ON true
    WHERE c.customer_user_id IS NOT NULL
      AND c.craftsman_user_id IS NOT NULL
      -- Re-Run-Guard: schon migriert
      AND NOT EXISTS (
        SELECT 1 FROM public.chat_threads t
        WHERE t.legacy_thread_id = c.id::text
      )
      -- Pair-Guard: Paar lebt schon in der neuen Welt
      AND NOT EXISTS (
        SELECT 1 FROM public.chat_threads t
        WHERE t.channel_type = 'customer'
          AND t.customer_user_id = c.customer_user_id
          AND t.craftsman_user_id = c.craftsman_user_id
      )
  ),
  inserted AS (
    INSERT INTO public.chat_threads (
      channel_type, customer_user_id, craftsman_user_id, provider_id,
      legacy_thread_id, legacy_source, title,
      inquiry_origin, source_project_id, inquiry_criteria,
      declined_at, reviewed_at,
      last_message_at, last_message_body,
      display_metadata,
      created_at, updated_at
    )
    SELECT
      'customer', s.customer_user_id, s.craftsman_user_id, s.provider_id,
      s.id::text, 'conversations', s.project_title,
      s.inquiry_origin, s.source_project_id, s.inquiry_criteria,
      s.declined_at, s.reviewed_at,
      s.last_created_at, left(s.last_content, 200),
      jsonb_strip_nulls(jsonb_build_object(
        'customerName',       s.customer_name,
        'customerAvatarUrl',  s.customer_avatar_url,
        'craftsmanName',      s.craftsman_name,
        'craftsmanHandle',    s.craftsman_handle,
        'craftsmanAvatarUrl', s.craftsman_avatar_url,
        'projectTitle',       s.project_title,
        'projectSubtitle',    s.project_subtitle,
        'projectDescription', s.project_description,
        'projectLocation',    s.project_location,
        'projectCostRange',   s.project_cost_range,
        'projectDuration',    s.project_duration,
        'projectStatusLabel', s.project_status_label
      )),
      COALESCE(s.created_at, public.epoch_ms()), public.epoch_ms()
    FROM source s
    RETURNING id, customer_user_id, craftsman_user_id
  ),
  parts AS (
    INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
    SELECT i.id, i.customer_user_id, 'customer', public.epoch_ms() FROM inserted i
    UNION ALL
    SELECT i.id, i.craftsman_user_id, 'craftsman', public.epoch_ms() FROM inserted i
    ON CONFLICT (thread_id, user_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM inserted;

  RAISE NOTICE 'chat_inquiry_backfill: % threads migrated, % skipped (pair exists in chat), % skipped (no provider row)',
    v_inserted, v_skipped_pair, v_skipped_no_provider;
END $$;

NOTIFY pgrst, 'reload schema';
