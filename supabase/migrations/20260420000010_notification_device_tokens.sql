-- =============================================================================
-- Migration: Block 3 – notification_device_tokens table
-- =============================================================================
-- Stores APNs device tokens per user so the server can target push delivery.
-- Primary key (user_id, token) allows one user to have multiple devices.
-- Token updates are idempotent via ON CONFLICT DO UPDATE in the client.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notification_device_tokens (
  user_id    text    NOT NULL,
  token      text    NOT NULL,
  platform   text    NOT NULL DEFAULT 'ios',
  updated_at bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, token)
);

ALTER TABLE public.notification_device_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ndt_select_own ON public.notification_device_tokens;

CREATE POLICY ndt_select_own
  ON public.notification_device_tokens
  FOR SELECT
  USING (user_id = auth.uid()::text);

DROP POLICY IF EXISTS ndt_insert_own ON public.notification_device_tokens;

CREATE POLICY ndt_insert_own
  ON public.notification_device_tokens
  FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

DROP POLICY IF EXISTS ndt_update_own ON public.notification_device_tokens;

CREATE POLICY ndt_update_own
  ON public.notification_device_tokens
  FOR UPDATE
  USING (user_id = auth.uid()::text);

DROP POLICY IF EXISTS ndt_delete_own ON public.notification_device_tokens;

CREATE POLICY ndt_delete_own
  ON public.notification_device_tokens
  FOR DELETE
  USING (user_id = auth.uid()::text);
