-- Provider Media — H.264 fallback URL (Reels Maturity Block 0)
--
-- iPhone-recorded portfolio videos land in Storage as HEVC inside an .mov
-- container. Android Chromium browsers cannot decode HEVC, so #840 added
-- a poster frame that keeps the tile visible and #842/#843 added the
-- "Nur iOS" badge plus a fullscreen explainer banner. Block 0 closes the
-- gap by holding a transcoded H.264 .mp4 alongside the original.
--
-- Pipeline (built progressively across PRs):
--   1. Capture-side: client uploads `.mov`. (existing)
--   2. Schema:       this migration adds `h264_url` text NULL.
--   3. Trigger:      a Supabase Database Webhook on INSERT into
--                    provider_media (where mediaType='video') invokes the
--                    `transcode-portfolio-video` Edge Function (Block 0
--                    PR carries the function skeleton — the external
--                    transcoding service the function calls is a
--                    deliberate decision point for the operator).
--   4. Transcode:    function downloads the original from Storage, asks
--                    the chosen service (Mux / Cloudflare Stream / etc.)
--                    for an H.264 1080p .mp4, uploads the result back,
--                    UPDATEs `provider_media.h264_url` with the public URL.
--   5. Render:       client `selectVideoSource(item)` prefers `h264_url`
--                    on Android-Chromium and clears the playback-block
--                    reason once the column is set.
--
-- The column is purely additive and idempotent. Backfill of historical
-- HEVC clips is a separate operator-driven script (out of scope for the
-- DDL).

ALTER TABLE public.provider_media
  ADD COLUMN IF NOT EXISTS h264_url text;

COMMENT ON COLUMN public.provider_media.h264_url IS
  'Public URL of an H.264 .mp4 transcode of the source video. Set asynchronously by the transcode pipeline (Block 0); null while pending or for non-video items. Renderers prefer this URL on browsers that cannot decode the source codec.';
