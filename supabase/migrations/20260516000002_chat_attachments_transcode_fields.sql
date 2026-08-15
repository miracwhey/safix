-- Add transcode-readiness columns to chat_attachments.
-- V1: all values stay at defaults (no transcoding pipeline active).
-- V2 wiring: provider webhook → Edge Function sets h264_url, poster_url,
--   transcode_status = 'ready'; Realtime UPDATE delivers enriched row to clients.

ALTER TABLE public.chat_attachments
  ADD COLUMN IF NOT EXISTS transcode_status   text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS h264_url           text NULL,
  ADD COLUMN IF NOT EXISTS poster_url         text NULL,
  ADD COLUMN IF NOT EXISTS transcode_provider text NULL,
  ADD COLUMN IF NOT EXISTS transcode_error    text NULL;

ALTER TABLE public.chat_attachments
  ADD CONSTRAINT chat_attachments_transcode_status_check
  CHECK (transcode_status IN ('none', 'pending', 'processing', 'ready', 'failed'));
