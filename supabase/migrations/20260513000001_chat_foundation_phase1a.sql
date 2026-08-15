-- =============================================================================
-- Block D Slice 1 Phase 1a — Unified Chat Foundation
-- =============================================================================
-- New tables:    chat_threads, chat_messages, chat_participants,
--                chat_attachments, chat_thread_migration_status,
--                user_notification_preferences
-- Additive:      profiles.timezone
-- Helper:        epoch_ms()
-- Triggers:      4 (last_message denorm, message_type promote, set_updated_at × 2)
-- Realtime:      4 chat tables added to supabase_realtime publication
-- REPLICA ID:    FULL on 5 chat tables (für filtered DELETE-Realtime)
-- RLS:           12 policies + Block-0.5-Pattern REVOKE/GRANT
-- Search:        body_tsv (german tsconfig) GIN index
--
-- Pre-verified gegen Prod 2026-05-10 (alle 6 Probes erwartet):
--   - 0 chat_* / user_notification_preferences Tabellen existieren
--   - profiles.timezone existiert nicht
--   - german tsconfig vorhanden
--   - 0 chat-* Buckets
--   - profiles.id ist uuid (FK-Target safe)
--   - 0 chat-Tabellen in supabase_realtime
--
-- Block 0.5 confirmed live: messages.rls=true, conversations.rls=true
--
-- KEINE Daten-Migrationen, KEIN Drop von Legacy, KEIN UI-Cutover.
-- Atomar in Transaction. Reversal-Plan in Section R.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 0 — Helper-Function epoch_ms()
-- =============================================================================
-- Shared default expression für alle bigint-Timestamps.

CREATE OR REPLACE FUNCTION public.epoch_ms()
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
$$;

REVOKE EXECUTE ON FUNCTION public.epoch_ms() FROM public, anon, authenticated;

-- =============================================================================
-- SECTION 1 — profiles.timezone (Foundation für Quiet-Hours)
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/Berlin';

-- =============================================================================
-- SECTION 2 — user_notification_preferences
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
  user_id                       uuid        NOT NULL,
  quiet_hours_start             smallint    CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end               smallint    CHECK (quiet_hours_end   BETWEEN 0 AND 23),
  is_always_reachable           boolean     NOT NULL DEFAULT false,
  count_customer_chat_unread    boolean     NOT NULL DEFAULT true,
  count_office_chat_unread      boolean     NOT NULL DEFAULT false,
  count_team_chat_unread        boolean     NOT NULL DEFAULT false,
  count_assignment_chat_unread  boolean     NOT NULL DEFAULT false,
  count_dispute_chat_unread     boolean     NOT NULL DEFAULT true,
  created_at                    bigint      NOT NULL DEFAULT public.epoch_ms(),
  updated_at                    bigint      NOT NULL DEFAULT public.epoch_ms(),

  CONSTRAINT user_notification_preferences_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_notification_preferences_user_fk
    FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE
);

-- =============================================================================
-- SECTION 3 — chat_threads
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.chat_threads (
  id                  uuid    NOT NULL DEFAULT gen_random_uuid(),
  channel_type        text    NOT NULL,
  customer_user_id    uuid,
  craftsman_user_id   uuid,
  provider_id         uuid,
  legacy_thread_id    text,
  legacy_source       text,
  title               text,
  last_message_id     uuid,
  last_message_at     bigint,
  last_message_body   text,
  created_at          bigint  NOT NULL DEFAULT public.epoch_ms(),
  updated_at          bigint  NOT NULL DEFAULT public.epoch_ms(),
  closed_at           bigint,

  CONSTRAINT chat_threads_pkey PRIMARY KEY (id),
  CONSTRAINT chat_threads_channel_type_check
    CHECK (channel_type IN ('customer','office','team','assignment','dispute')),
  CONSTRAINT chat_threads_legacy_source_check
    CHECK (legacy_source IN ('conversations','message_threads') OR legacy_source IS NULL),
  CONSTRAINT chat_threads_customer_channel_check CHECK (
    channel_type <> 'customer'
    OR (customer_user_id IS NOT NULL AND craftsman_user_id IS NOT NULL AND provider_id IS NOT NULL)
  ),
  CONSTRAINT chat_threads_provider_required_check CHECK (
    channel_type = 'customer'
    OR provider_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS chat_threads_channel_last_msg_idx
  ON public.chat_threads (channel_type, last_message_at DESC);
CREATE INDEX IF NOT EXISTS chat_threads_provider_channel_idx
  ON public.chat_threads (provider_id, channel_type);
CREATE INDEX IF NOT EXISTS chat_threads_customer_user_idx
  ON public.chat_threads (customer_user_id) WHERE customer_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_threads_craftsman_user_idx
  ON public.chat_threads (craftsman_user_id) WHERE craftsman_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_threads_legacy_thread_id_idx
  ON public.chat_threads (legacy_thread_id) WHERE legacy_thread_id IS NOT NULL;

-- =============================================================================
-- SECTION 4 — chat_messages
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id                  uuid    NOT NULL DEFAULT gen_random_uuid(),
  thread_id           uuid    NOT NULL,
  sender_user_id      uuid    NOT NULL,
  client_message_id   uuid    NOT NULL,
  body                text,
  message_type        text    NOT NULL DEFAULT 'text',
  artifact_type       text,
  artifact_id         text,
  reply_to_message_id uuid,
  created_at          bigint  NOT NULL DEFAULT public.epoch_ms(),
  server_received_at  bigint  NOT NULL DEFAULT public.epoch_ms(),
  delivered_at        bigint,
  legacy_message_id   text,
  legacy_source       text,
  deleted_at          bigint,
  redacted            boolean NOT NULL DEFAULT false,
  redacted_at         bigint,
  redacted_reason     text,
  idempotency_key     uuid,
  body_tsv            tsvector GENERATED ALWAYS AS (
                        to_tsvector('german', coalesce(body, ''))
                      ) STORED,

  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT chat_messages_thread_fk
    FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE,
  CONSTRAINT chat_messages_reply_fk
    FOREIGN KEY (reply_to_message_id) REFERENCES public.chat_messages(id),
  CONSTRAINT chat_messages_message_type_check
    CHECK (message_type IN ('text','image','document','voice','video','artifact_card','system')),
  CONSTRAINT chat_messages_legacy_source_check
    CHECK (legacy_source IN ('messages','internal_messages','thread_artifacts') OR legacy_source IS NULL),
  CONSTRAINT chat_messages_client_dedup_uq
    UNIQUE (sender_user_id, client_message_id)
);

-- Idempotency-Key UNIQUE als partial Index (NULL erlaubt mehrfach)
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_idempotency_uq
  ON public.chat_messages (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_messages_thread_created_idx
  ON public.chat_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_body_tsv_idx
  ON public.chat_messages USING GIN (body_tsv);
CREATE INDEX IF NOT EXISTS chat_messages_legacy_message_id_idx
  ON public.chat_messages (legacy_message_id) WHERE legacy_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_messages_message_type_idx
  ON public.chat_messages (message_type);
CREATE INDEX IF NOT EXISTS chat_messages_deleted_idx
  ON public.chat_messages (deleted_at) WHERE deleted_at IS NOT NULL;

-- =============================================================================
-- SECTION 5 — chat_participants
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.chat_participants (
  thread_id               uuid    NOT NULL,
  user_id                 uuid    NOT NULL,
  role                    text    NOT NULL,
  joined_at               bigint  NOT NULL DEFAULT public.epoch_ms(),
  left_at                 bigint,
  last_read_message_id    uuid,
  last_read_at            bigint,
  muted_until             bigint,
  pinned                  boolean NOT NULL DEFAULT false,
  notification_preference jsonb,

  CONSTRAINT chat_participants_pkey PRIMARY KEY (thread_id, user_id),
  CONSTRAINT chat_participants_thread_fk
    FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE,
  CONSTRAINT chat_participants_last_read_msg_fk
    FOREIGN KEY (last_read_message_id) REFERENCES public.chat_messages(id),
  CONSTRAINT chat_participants_role_check
    CHECK (role IN ('owner','craftsman','worker','customer','admin'))
);

CREATE INDEX IF NOT EXISTS chat_participants_user_active_idx
  ON public.chat_participants (user_id, left_at) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS chat_participants_thread_role_idx
  ON public.chat_participants (thread_id, role);

-- =============================================================================
-- SECTION 6 — chat_attachments
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.chat_attachments (
  id                    uuid    NOT NULL DEFAULT gen_random_uuid(),
  message_id            uuid    NOT NULL,
  asset_type            text    NOT NULL,
  mime_type             text    NOT NULL,
  size_bytes            bigint  NOT NULL,
  storage_bucket        text    NOT NULL,
  storage_path          text    NOT NULL,
  width                 integer,
  height                integer,
  duration_ms           integer,
  poster_storage_path   text,
  transcript            text,
  transcript_language   text,
  uploaded_at           bigint  NOT NULL DEFAULT public.epoch_ms(),
  deleted_at            bigint,

  CONSTRAINT chat_attachments_pkey PRIMARY KEY (id),
  CONSTRAINT chat_attachments_message_fk
    FOREIGN KEY (message_id) REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  CONSTRAINT chat_attachments_asset_type_check
    CHECK (asset_type IN ('image','document','voice','video')),
  CONSTRAINT chat_attachments_storage_bucket_check
    CHECK (storage_bucket IN ('chat-customer','chat-internal','chat-dispute'))
);

CREATE INDEX IF NOT EXISTS chat_attachments_message_idx
  ON public.chat_attachments (message_id);
CREATE INDEX IF NOT EXISTS chat_attachments_asset_type_idx
  ON public.chat_attachments (asset_type);
CREATE INDEX IF NOT EXISTS chat_attachments_deleted_idx
  ON public.chat_attachments (deleted_at) WHERE deleted_at IS NOT NULL;

-- =============================================================================
-- SECTION 7 — chat_thread_migration_status
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.chat_thread_migration_status (
  thread_id        uuid       NOT NULL,
  legacy_thread_id text       NOT NULL,
  legacy_source    text       NOT NULL,
  status           text       NOT NULL DEFAULT 'not_migrated',
  priority         smallint   NOT NULL DEFAULT 0,
  started_at       bigint,
  completed_at     bigint,
  verified_at      bigint,
  failed_at        bigint,
  failure_reason   text,
  failed_step      text,
  attempts         smallint   NOT NULL DEFAULT 0,
  lock_owner       text,
  lock_until       bigint,
  created_at       bigint     NOT NULL DEFAULT public.epoch_ms(),
  updated_at       bigint     NOT NULL DEFAULT public.epoch_ms(),

  CONSTRAINT chat_thread_migration_status_pkey PRIMARY KEY (thread_id),
  CONSTRAINT chat_thread_migration_status_thread_fk
    FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE,
  CONSTRAINT chat_thread_migration_status_status_check
    CHECK (status IN (
      'not_migrated','migration_queued','migrating',
      'migration_complete','migration_verified','migration_failed'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_migration_legacy_unique_idx
  ON public.chat_thread_migration_status (legacy_thread_id, legacy_source);
CREATE INDEX IF NOT EXISTS chat_migration_status_queue_idx
  ON public.chat_thread_migration_status (status, priority DESC, updated_at);

-- =============================================================================
-- SECTION 8 — Trigger Functions
-- =============================================================================

-- 8a. Update chat_threads denormalized last_message_* on INSERT
CREATE OR REPLACE FUNCTION public.fn_chat_update_thread_last_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.chat_threads
  SET
    last_message_id   = NEW.id,
    last_message_at   = NEW.created_at,
    last_message_body = CASE
                          WHEN NEW.deleted_at IS NOT NULL THEN NULL
                          WHEN NEW.message_type = 'image' THEN '[Bild]'
                          WHEN NEW.message_type = 'document' THEN '[Dokument]'
                          WHEN NEW.message_type = 'voice' THEN '[Sprachnachricht]'
                          WHEN NEW.message_type = 'video' THEN '[Video]'
                          WHEN NEW.message_type = 'system' THEN NEW.body
                          ELSE NEW.body
                        END,
    updated_at        = NEW.created_at
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_chat_update_thread_last_message() FROM public, anon, authenticated;

CREATE OR REPLACE TRIGGER chat_messages_after_insert
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_chat_update_thread_last_message();

-- 8b. Promote message_type when attachment inserted
CREATE OR REPLACE FUNCTION public.fn_chat_set_message_type_on_attachment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.chat_messages
  SET message_type = NEW.asset_type
  WHERE id = NEW.message_id
    AND message_type = 'text';
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_chat_set_message_type_on_attachment() FROM public, anon, authenticated;

CREATE OR REPLACE TRIGGER chat_attachments_after_insert
  AFTER INSERT ON public.chat_attachments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_chat_set_message_type_on_attachment();

-- 8c. set_updated_at für chat_thread_migration_status
CREATE OR REPLACE FUNCTION public.fn_chat_migration_status_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = public.epoch_ms();
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_chat_migration_status_set_updated_at() FROM public, anon, authenticated;

CREATE OR REPLACE TRIGGER chat_migration_status_set_updated_at
  BEFORE UPDATE ON public.chat_thread_migration_status
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_chat_migration_status_set_updated_at();

-- 8d. set_updated_at für user_notification_preferences
CREATE OR REPLACE FUNCTION public.fn_user_notification_prefs_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = public.epoch_ms();
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_user_notification_prefs_set_updated_at() FROM public, anon, authenticated;

CREATE OR REPLACE TRIGGER user_notification_prefs_set_updated_at
  BEFORE UPDATE ON public.user_notification_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_user_notification_prefs_set_updated_at();

-- =============================================================================
-- SECTION 9 — REPLICA IDENTITY FULL
-- =============================================================================

ALTER TABLE public.chat_threads                  REPLICA IDENTITY FULL;
ALTER TABLE public.chat_messages                 REPLICA IDENTITY FULL;
ALTER TABLE public.chat_participants             REPLICA IDENTITY FULL;
ALTER TABLE public.chat_attachments              REPLICA IDENTITY FULL;
ALTER TABLE public.chat_thread_migration_status  REPLICA IDENTITY FULL;

-- =============================================================================
-- SECTION 10 — Realtime Publication
-- =============================================================================
-- chat_thread_migration_status NICHT in Pub (admin-internal worker-only)

ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_threads;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_participants;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_attachments;

-- =============================================================================
-- SECTION 11 — RLS Enable + REVOKE (Block-0.5-Pattern)
-- =============================================================================

ALTER TABLE public.chat_threads                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_participants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_attachments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_thread_migration_status  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notification_preferences ENABLE ROW LEVEL SECURITY;

-- REVOKE Default-PUBLIC Grants
REVOKE ALL ON public.chat_threads                  FROM anon, authenticated;
REVOKE ALL ON public.chat_messages                 FROM anon, authenticated;
REVOKE ALL ON public.chat_participants             FROM anon, authenticated;
REVOKE ALL ON public.chat_attachments              FROM anon, authenticated;
REVOKE ALL ON public.chat_thread_migration_status  FROM anon, authenticated;
REVOKE ALL ON public.user_notification_preferences FROM anon, authenticated;

-- GRANT nur was RLS-Policies dann gaten (no DELETE — Soft-Delete, no TRUNCATE)
GRANT SELECT, INSERT, UPDATE ON public.chat_threads                  TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.chat_messages                 TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.chat_participants             TO authenticated;
GRANT SELECT, INSERT         ON public.chat_attachments              TO authenticated;
-- chat_thread_migration_status: SELECT für Diagnostic + Repo-Read; INSERT/UPDATE nur via service_role
GRANT SELECT ON public.chat_thread_migration_status TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_notification_preferences TO authenticated;

-- =============================================================================
-- SECTION 12 — RLS Policies
-- =============================================================================
-- Performance-Pattern: (SELECT auth.uid()) — einmal pro Query, nicht per-row
-- Worker-Hard-Exclusion: AND NOT (channel_type='customer' AND role='worker')

-- 12.1 chat_threads ----------------------------------------------------------

DROP POLICY IF EXISTS chat_threads_select_participant ON public.chat_threads;
CREATE POLICY chat_threads_select_participant ON public.chat_threads
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_participants cp
      WHERE cp.thread_id = chat_threads.id
        AND cp.user_id   = (SELECT auth.uid())
        AND cp.left_at   IS NULL
    )
  );

DROP POLICY IF EXISTS chat_threads_insert_customer ON public.chat_threads;
CREATE POLICY chat_threads_insert_customer ON public.chat_threads
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_type = 'customer'
    AND customer_user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS chat_threads_insert_provider ON public.chat_threads;
CREATE POLICY chat_threads_insert_provider ON public.chat_threads
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_type <> 'customer'
    AND provider_id IN (
      SELECT id FROM public.providers
      WHERE profile_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS chat_threads_update_participant ON public.chat_threads;
CREATE POLICY chat_threads_update_participant ON public.chat_threads
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_participants cp
      WHERE cp.thread_id = chat_threads.id
        AND cp.user_id   = (SELECT auth.uid())
        AND cp.left_at   IS NULL
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.chat_participants cp
      WHERE cp.thread_id = chat_threads.id
        AND cp.user_id   = (SELECT auth.uid())
        AND cp.left_at   IS NULL
    )
  );

-- 12.2 chat_messages ---------------------------------------------------------

DROP POLICY IF EXISTS chat_messages_select_participant ON public.chat_messages;
CREATE POLICY chat_messages_select_participant ON public.chat_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.chat_participants cp
      JOIN public.chat_threads      ct ON ct.id = cp.thread_id
      WHERE cp.thread_id = chat_messages.thread_id
        AND cp.user_id   = (SELECT auth.uid())
        AND cp.left_at   IS NULL
        AND NOT (ct.channel_type = 'customer' AND cp.role = 'worker')
    )
  );

DROP POLICY IF EXISTS chat_messages_insert_participant ON public.chat_messages;
CREATE POLICY chat_messages_insert_participant ON public.chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.chat_participants cp
      JOIN public.chat_threads      ct ON ct.id = cp.thread_id
      WHERE cp.thread_id = chat_messages.thread_id
        AND cp.user_id   = (SELECT auth.uid())
        AND cp.left_at   IS NULL
        AND NOT (ct.channel_type = 'customer' AND cp.role = 'worker')
    )
  );

DROP POLICY IF EXISTS chat_messages_update_own ON public.chat_messages;
CREATE POLICY chat_messages_update_own ON public.chat_messages
  FOR UPDATE TO authenticated
  USING (sender_user_id = (SELECT auth.uid()))
  WITH CHECK (sender_user_id = (SELECT auth.uid()));

-- 12.3 chat_participants -----------------------------------------------------

DROP POLICY IF EXISTS chat_participants_select_self_or_owner ON public.chat_participants;
CREATE POLICY chat_participants_select_self_or_owner ON public.chat_participants
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.chat_participants cp2
      WHERE cp2.thread_id = chat_participants.thread_id
        AND cp2.user_id   = (SELECT auth.uid())
        AND cp2.role      IN ('owner', 'admin')
        AND cp2.left_at   IS NULL
    )
  );

DROP POLICY IF EXISTS chat_participants_insert_owner_or_self ON public.chat_participants;
CREATE POLICY chat_participants_insert_owner_or_self ON public.chat_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.chat_participants cp2
      WHERE cp2.thread_id = chat_participants.thread_id
        AND cp2.user_id   = (SELECT auth.uid())
        AND cp2.role      IN ('owner', 'craftsman', 'admin')
        AND cp2.left_at   IS NULL
    )
    OR (
      user_id = (SELECT auth.uid())
      AND EXISTS (
        SELECT 1 FROM public.chat_threads ct
        WHERE ct.id          = chat_participants.thread_id
          AND ct.channel_type IN ('assignment', 'team')
      )
    )
  );

DROP POLICY IF EXISTS chat_participants_update_own ON public.chat_participants;
CREATE POLICY chat_participants_update_own ON public.chat_participants
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- 12.4 chat_attachments ------------------------------------------------------

DROP POLICY IF EXISTS chat_attachments_select_participant ON public.chat_attachments;
CREATE POLICY chat_attachments_select_participant ON public.chat_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.chat_messages       cm
      JOIN public.chat_participants   cp ON cp.thread_id = cm.thread_id
      JOIN public.chat_threads        ct ON ct.id        = cm.thread_id
      WHERE cm.id        = chat_attachments.message_id
        AND cp.user_id   = (SELECT auth.uid())
        AND cp.left_at   IS NULL
        AND NOT (ct.channel_type = 'customer' AND cp.role = 'worker')
    )
  );

DROP POLICY IF EXISTS chat_attachments_insert_sender ON public.chat_attachments;
CREATE POLICY chat_attachments_insert_sender ON public.chat_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.chat_messages     cm
      JOIN public.chat_participants cp ON cp.thread_id = cm.thread_id
      JOIN public.chat_threads      ct ON ct.id        = cm.thread_id
      WHERE cm.id              = chat_attachments.message_id
        AND cm.sender_user_id  = (SELECT auth.uid())
        AND cp.user_id         = (SELECT auth.uid())
        AND cp.left_at         IS NULL
        AND NOT (ct.channel_type = 'customer' AND cp.role = 'worker')
    )
  );

-- 12.5 chat_thread_migration_status — SELECT für Diagnostic, Writes nur via service_role
-- (Keine INSERT/UPDATE Policy für authenticated → default-deny; service_role bypasst RLS)

DROP POLICY IF EXISTS chat_thread_migration_status_select_diagnostic ON public.chat_thread_migration_status;
CREATE POLICY chat_thread_migration_status_select_diagnostic ON public.chat_thread_migration_status
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_participants cp
      WHERE cp.thread_id = chat_thread_migration_status.thread_id
        AND cp.user_id   = (SELECT auth.uid())
        AND cp.left_at   IS NULL
    )
  );

-- 12.6 user_notification_preferences — self only

DROP POLICY IF EXISTS user_notification_prefs_select_self ON public.user_notification_preferences;
CREATE POLICY user_notification_prefs_select_self ON public.user_notification_preferences
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS user_notification_prefs_insert_self ON public.user_notification_preferences;
CREATE POLICY user_notification_prefs_insert_self ON public.user_notification_preferences
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS user_notification_prefs_update_self ON public.user_notification_preferences;
CREATE POLICY user_notification_prefs_update_self ON public.user_notification_preferences
  FOR UPDATE TO authenticated
  USING  (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

COMMIT;

-- =============================================================================
-- Section R — Reversal-Plan (NICHT auto-ausgeführt)
-- =============================================================================
-- BEGIN;
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.chat_threads;
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.chat_messages;
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.chat_participants;
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.chat_attachments;
--   DROP TABLE IF EXISTS public.chat_thread_migration_status  CASCADE;
--   DROP TABLE IF EXISTS public.chat_attachments              CASCADE;
--   DROP TABLE IF EXISTS public.chat_participants             CASCADE;
--   DROP TABLE IF EXISTS public.chat_messages                 CASCADE;
--   DROP TABLE IF EXISTS public.chat_threads                  CASCADE;
--   DROP TABLE IF EXISTS public.user_notification_preferences CASCADE;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS timezone;
--   DROP FUNCTION IF EXISTS public.fn_chat_update_thread_last_message();
--   DROP FUNCTION IF EXISTS public.fn_chat_set_message_type_on_attachment();
--   DROP FUNCTION IF EXISTS public.fn_chat_migration_status_set_updated_at();
--   DROP FUNCTION IF EXISTS public.fn_user_notification_prefs_set_updated_at();
--   DROP FUNCTION IF EXISTS public.epoch_ms();
-- COMMIT;
-- =============================================================================
