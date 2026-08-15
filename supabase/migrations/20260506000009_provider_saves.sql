-- 20260506000009_provider_saves.sql
--
-- Provider Save (Bookmark) — customers can save/follow craftsmen profiles.
--
-- Mirrors the `provider_media_saves` table contract exactly:
--   - One row per (provider_id, user_id) pair (UNIQUE constraint).
--   - Public-read: save count and "did I save this?" lookup work for any
--     caller (same contract as media saves / likes).
--   - Insert / Delete own-row only — save is a toggle, no updates.
--   - Realtime INSERT / DELETE so a save toggled on one device reflects
--     live on another.
--   - REPLICA IDENTITY FULL so DELETE realtime payloads carry `user_id`
--     in OLD — required for `user_id=eq.<self>` filtered subscriptions.
--
-- `provider_id` is TEXT because craftsman_profiles.user_id is TEXT (auth.uid()
-- stored as text rather than uuid in that table). No FK enforced here to
-- avoid a cross-type constraint; application layer validates existence.
--
-- No counter column on craftsman_profiles — COUNT(*) WHERE provider_id=?
-- is cheap and indexed. Denormalize later if volume warrants it.

CREATE TABLE IF NOT EXISTS public.provider_saves (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text        NOT NULL,
  user_id     uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_saves_provider_id
  ON public.provider_saves (provider_id);

CREATE INDEX IF NOT EXISTS idx_provider_saves_user_id
  ON public.provider_saves (user_id);

-- Sort ordering for "my saved craftsmen" list — newest first.
CREATE INDEX IF NOT EXISTS idx_provider_saves_user_created
  ON public.provider_saves (user_id, created_at DESC);

ALTER TABLE public.provider_saves ENABLE ROW LEVEL SECURITY;

-- Public read: anyone can count saves and check their own save-state.
DROP POLICY IF EXISTS provider_saves_select ON public.provider_saves;
CREATE POLICY provider_saves_select
  ON public.provider_saves
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS provider_saves_insert ON public.provider_saves;
CREATE POLICY provider_saves_insert
  ON public.provider_saves
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS provider_saves_delete ON public.provider_saves;
CREATE POLICY provider_saves_delete
  ON public.provider_saves
  FOR DELETE
  USING (auth.uid() = user_id);

-- Realtime publication — idempotent guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'provider_saves'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_saves';
  END IF;
END$$;

-- FULL replica identity so filtered DELETE events on user_id=eq.<self>
-- carry the full OLD row (not just PK).
ALTER TABLE public.provider_saves REPLICA IDENTITY FULL;
