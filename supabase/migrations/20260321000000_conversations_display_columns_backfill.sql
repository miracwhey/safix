-- =============================================================================
-- Migration: Conversations display/context column backfill
-- =============================================================================
-- PROBLEM
--   Live runtime reported PGRST204 "could not find column craftsman_avatar_url
--   in schema cache" when inserting into public.conversations.  The table was
--   created without several display/context columns that SupabaseMessageRepository
--   now persists for reload-safe thread identity.
--
-- FIX
--   Add all required display/context columns with IF NOT EXISTS guards so the
--   live table matches the repository payload.  Defaults mirror the canonical
--   schema (empty string for display text, NULL for optional context, 0 for
--   created_at).
--
-- SAFETY
--   All statements are idempotent and safe on instances that already have the
--   columns or indexes.
-- =============================================================================

ALTER TABLE public.conversations
  -- Customer display / ownership
  ADD COLUMN IF NOT EXISTS customer_name        text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS customer_avatar_url  text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS customer_user_id     text,

  -- Craftsman display / ownership
  ADD COLUMN IF NOT EXISTS craftsman_name       text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS craftsman_handle     text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS craftsman_avatar_url text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS craftsman_user_id    text,

  -- Project context
  ADD COLUMN IF NOT EXISTS project_title        text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS project_subtitle     text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS project_location     text,
  ADD COLUMN IF NOT EXISTS project_cost_range   text,
  ADD COLUMN IF NOT EXISTS project_duration     text,
  ADD COLUMN IF NOT EXISTS project_status_label text,

  -- UI state
  ADD COLUMN IF NOT EXISTS time_label           text,
  ADD COLUMN IF NOT EXISTS unread_count         integer,

  -- Inquiry metadata
  ADD COLUMN IF NOT EXISTS inquiry_origin       text,
  ADD COLUMN IF NOT EXISTS source_project_id    text,

  -- Lifecycle timestamps
  ADD COLUMN IF NOT EXISTS reviewed_at          bigint,
  ADD COLUMN IF NOT EXISTS declined_at          bigint,

  -- Sort key
  ADD COLUMN IF NOT EXISTS created_at           bigint      NOT NULL DEFAULT 0;

-- Indexes for ownership and sorting (idempotent)
CREATE INDEX IF NOT EXISTS idx_conversations_craftsman_user_id
  ON public.conversations (craftsman_user_id)
  WHERE craftsman_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_customer_user_id
  ON public.conversations (customer_user_id)
  WHERE customer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_created_at
  ON public.conversations (created_at);
