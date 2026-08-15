-- =============================================================================
-- Migration: BLOCK 59 – Base schema for conversations & messages tables
-- =============================================================================
-- The conversations and messages tables are central to the FixUp messaging
-- domain but were never declared by a CREATE TABLE migration.  Earlier
-- migrations assumed the tables pre-existed (e.g. 20240400000000 runs
-- ALTER TABLE … ENABLE ROW LEVEL SECURITY).
--
-- This migration closes that gap so that a fresh Supabase project can be
-- fully bootstrapped by running all migrations in lexicographic order.
--
-- All statements use IF NOT EXISTS guards so the migration is idempotent and
-- safe to run against a database that already has the tables (as would be
-- the case for any existing deployment).
--
-- Column set is the union of all columns referenced across:
--   • SupabaseMessageRepository  (src/lib/messages/repository/SupabaseMessageRepository.ts)
--   • migration 20240400000000_rls_ownership_hardening.sql
--   • migration 20241000000000_conversations_customer_user_id.sql
--   • migration 20241200000000_conversations_messages_timestamps.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. conversations
--    One row per inquiry/project thread.
--    Either party (craftsman OR customer) may read and update.
--    Only the customer may insert (customer_user_id = auth.uid()).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.conversations (
  id                    text        PRIMARY KEY,

  -- Customer display info
  customer_name         text        NOT NULL DEFAULT '',
  customer_avatar_url   text        NOT NULL DEFAULT '',
  -- Direct ownership link stamped at conversation-creation time
  customer_user_id      text,

  -- Craftsman display info
  craftsman_name        text        NOT NULL DEFAULT '',
  craftsman_handle      text        NOT NULL DEFAULT '',
  craftsman_avatar_url  text        NOT NULL DEFAULT '',
  craftsman_user_id     text,

  -- Denormalised project context (avoids a JOIN in every query)
  project_title         text        NOT NULL DEFAULT '',
  project_subtitle      text        NOT NULL DEFAULT '',
  project_location      text,
  project_cost_range    text,
  project_duration      text,
  project_status_label  text,

  -- UI display labels (may be NULL when not yet set)
  time_label            text,
  unread_count          integer,

  -- Inquiry metadata
  inquiry_origin        text,
  source_project_id     text,

  -- Lifecycle timestamps (NULL means not yet reached)
  reviewed_at           bigint,
  declined_at           bigint,

  -- Sort key: epoch ms stamped when thread is first created
  -- (added by migration 20241200000000; DEFAULT 0 preserves pre-existing rows)
  created_at            bigint      NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conversations_craftsman_user_id
  ON public.conversations (craftsman_user_id)
  WHERE craftsman_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_customer_user_id
  ON public.conversations (customer_user_id)
  WHERE customer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_created_at
  ON public.conversations (created_at);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

-- SELECT: either party (craftsman or customer) may read the thread
DROP POLICY IF EXISTS conversations_select_own ON public.conversations;
CREATE POLICY conversations_select_own ON public.conversations
  FOR SELECT USING (
    craftsman_user_id = auth.uid()::text
    OR customer_user_id = auth.uid()::text
  );

-- INSERT: only the initiating customer may create a conversation
DROP POLICY IF EXISTS conversations_insert_own ON public.conversations;
CREATE POLICY conversations_insert_own ON public.conversations
  FOR INSERT WITH CHECK (customer_user_id = auth.uid()::text);

-- UPDATE: both parties may update (e.g. mark reviewed/declined, clear unread)
DROP POLICY IF EXISTS conversations_update_own ON public.conversations;
CREATE POLICY conversations_update_own ON public.conversations
  FOR UPDATE USING (
    craftsman_user_id = auth.uid()::text
    OR customer_user_id = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- 2. messages
--    One row per individual message in a conversation.
--    Ownership chain: message.conversation_id → conversations owned by user.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.messages (
  id                  text        PRIMARY KEY,
  conversation_id     text        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,

  -- 'user' = the sending party (relative to who created the message),
  -- 'counterparty' = the other side
  sender              text        NOT NULL DEFAULT 'user',
  text                text        NOT NULL DEFAULT '',

  -- Display label stored at send time so it remains accurate after reload
  created_at_label    text        NOT NULL DEFAULT '',

  -- Sort key: epoch ms stamped when message is sent
  -- (added by migration 20241200000000; DEFAULT 0 preserves pre-existing rows)
  created_at          bigint      NOT NULL DEFAULT 0,

  -- Optional project-card attachment
  attachment_type     text,
  project_attachment  jsonb
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON public.messages (conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON public.messages (created_at);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- SELECT: either party to a conversation may read its messages
DROP POLICY IF EXISTS messages_select_own ON public.messages;
CREATE POLICY messages_select_own ON public.messages
  FOR SELECT USING (
    conversation_id IN (
      SELECT id FROM public.conversations
      WHERE craftsman_user_id = auth.uid()::text
         OR customer_user_id  = auth.uid()::text
    )
  );

-- INSERT: either party may send messages in a conversation they participate in
DROP POLICY IF EXISTS messages_insert_own ON public.messages;
CREATE POLICY messages_insert_own ON public.messages
  FOR INSERT WITH CHECK (
    conversation_id IN (
      SELECT id FROM public.conversations
      WHERE craftsman_user_id = auth.uid()::text
         OR customer_user_id  = auth.uid()::text
    )
  );

-- =============================================================================
-- BLOCK 59 COMPLETION SUMMARY
-- =============================================================================
-- After this migration a fresh Supabase project has:
--   • conversations table with all columns used by SupabaseMessageRepository
--   • messages table with all columns used by SupabaseMessageRepository
--   • Correct RLS policies scoping both tables to the conversation participants
--   • Indexes for all query-path columns (craftsman_user_id, customer_user_id,
--     created_at, conversation_id, created_at for messages)
--
-- This migration is the authoritative source for the table schemas.
-- The earlier ADD COLUMN IF NOT EXISTS statements in previous migrations
-- remain harmless (idempotent) because they use IF NOT EXISTS guards.
-- =============================================================================
