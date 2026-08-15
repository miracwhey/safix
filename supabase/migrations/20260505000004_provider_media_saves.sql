-- 20260505000004_provider_media_saves.sql
--
-- Reels Save (Bookmark) — public counter, per-user state
--
-- Mirrors the `provider_media_likes` table contract from M2.2:
--   - One row per (media_id, user_id) pair (UNIQUE constraint).
--   - Public-read for count() so the bookmark counter on each reel card is
--     visible to everyone (Insta-style "X Saves" public number).
--   - Insert / Delete own-row only — toggling a save is the only write path.
--   - Realtime INSERT / DELETE so a save toggled on one device updates the
--     viewer-state and the counter live on another device.
--   - REPLICA IDENTITY FULL is set so DELETE realtime payloads carry
--     `user_id` in OLD (the per-user filter `user_id=eq.<self>` cannot
--     match the default-replica-identity DELETE payload, which only carries
--     the PK).  Same lesson as portfolio_likes_realtime / portfolio_realtime.
--
-- Counter is computed via `SELECT count(*) FROM provider_media_saves WHERE
-- media_id=?`. No counter column on `provider_media` and no Postgres
-- trigger — the saved-reel feature is small and the count call is indexed
-- on `media_id`. If save volume becomes significant we can promote to a
-- denormalized counter in a follow-up migration.

CREATE TABLE IF NOT EXISTS public.provider_media_saves (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id    uuid        NOT NULL REFERENCES public.provider_media(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_media_saves_media_id
  ON public.provider_media_saves (media_id);

CREATE INDEX IF NOT EXISTS idx_provider_media_saves_user_id
  ON public.provider_media_saves (user_id);

-- Sort ordering for the "my saved reels" list — newest first.
CREATE INDEX IF NOT EXISTS idx_provider_media_saves_user_created
  ON public.provider_media_saves (user_id, created_at DESC);

ALTER TABLE public.provider_media_saves ENABLE ROW LEVEL SECURITY;

-- Public read so the counter and "did I save this?" lookup work for any
-- caller. The `user_id` column is by definition tied to the saver — making
-- it readable is the same contract as the likes table.
DROP POLICY IF EXISTS provider_media_saves_select ON public.provider_media_saves;
CREATE POLICY provider_media_saves_select
  ON public.provider_media_saves
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS provider_media_saves_insert ON public.provider_media_saves;
CREATE POLICY provider_media_saves_insert
  ON public.provider_media_saves
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS provider_media_saves_delete ON public.provider_media_saves;
CREATE POLICY provider_media_saves_delete
  ON public.provider_media_saves
  FOR DELETE
  USING (auth.uid() = user_id);

-- Realtime publication. Idempotent guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'provider_media_saves'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_media_saves';
  END IF;
END$$;

-- DEFAULT replica identity ships only PK columns in OLD on DELETE, which
-- causes filtered subscriptions on `user_id=eq.<self>` to silently drop
-- the event. FULL ships the entire OLD row.
ALTER TABLE public.provider_media_saves REPLICA IDENTITY FULL;
