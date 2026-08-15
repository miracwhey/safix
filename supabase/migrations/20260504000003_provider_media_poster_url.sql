-- provider_media.poster_url — first-frame thumbnail for video items.
--
-- Why
--   iPhones default-record HEVC inside a `.mov` container. iOS Safari plays
--   it natively but Chrome/Android cannot decode HEVC, so a customer who
--   opens the public profile on Android sees a black <video> tile until the
--   browser gives up — perceived as a broken upload. A static JPEG poster
--   guarantees that even when the codec fails to play, the cover frame is
--   still visible. The same poster powers the Reels grid and the
--   craftsman-side portfolio tiles, so we extract once at upload time and
--   reuse everywhere.
--
-- Shape
--   Nullable text. Existing rows have no poster — the renderer falls back
--   to publicUrl/native-loading when this is null. Future Edge-Function
--   transcode pass can backfill posters for legacy items without touching
--   the schema again.
--
-- RLS / policies
--   No new policies required: poster_url is a sibling column on a row
--   already owned by the existing provider_media RLS rules
--   (20260317000014_provider_media.sql + 20260504000001_provider_media_owner_access.sql).

ALTER TABLE public.provider_media
  ADD COLUMN IF NOT EXISTS poster_url text;
