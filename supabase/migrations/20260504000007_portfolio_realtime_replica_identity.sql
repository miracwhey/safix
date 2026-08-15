-- Reels engagement realtime — set REPLICA IDENTITY FULL
--
-- Background: the M2.2 (likes) and M2.3 (comments) hooks subscribe to
-- INSERT and DELETE postgres_changes filtered by `media_id`. With the
-- default replica identity (`d`, primary-key-only), the OLD row payload
-- of a DELETE event only carries the row's PK — `media_id` is missing —
-- so a server-side `filter: media_id=eq.<X>` cannot evaluate against
-- the OLD payload and the event is silently dropped. Net effect:
--   - Cross-client unlike (DELETE) does NOT update the receiver's count
--   - Cross-client comment-delete does NOT remove the row on receivers
--     (until the next full refetch on visibilitychange / mount).
-- INSERT events are unaffected because the NEW payload always carries
-- the full row.
--
-- Fix: REPLICA IDENTITY FULL for both small append-only tables. The WAL
-- carries the full OLD row on DELETE so the realtime filter matches and
-- subscribers get the event. Storage / WAL overhead is negligible for
-- these row sizes (small ints + uuid).
--
-- Idempotent: REPLICA IDENTITY is a relation property, repeated ALTER
-- statements are no-ops once already FULL.

ALTER TABLE public.provider_media_likes REPLICA IDENTITY FULL;
ALTER TABLE public.provider_media_comments REPLICA IDENTITY FULL;
