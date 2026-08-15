-- Provider Media Comments (Reels Maturity M2.3)
--
-- One row per comment posted by an authenticated customer on a published
-- portfolio reel. Body is stored verbatim (server-side trim only) and the
-- service layer enforces a hard length cap of 500 chars before insert.
--
-- Moderation hooks:
--   * the comment author can hard-delete their own row (DELETE own).
--   * the provider that owns the media can hard-delete any comment on it
--     (provider-as-host moderation; future operator-level overrides land
--     in the existing reports/blocks pipeline rather than a per-table policy).
--   * UPDATE is intentionally not exposed — edits open a re-moderation
--     surface that the engagement loop does not need today; M2.3 ships
--     post-only / delete-only.
--
-- Anyone can read so the lightbox shows the thread to anonymous browsers.
-- The Realtime publication is added in the same DDL so the M2.3 hook can
-- subscribe without a follow-up migration.
--
-- Indices: media_id+created_at desc covers the canonical "newest first"
-- thread render; user_id supports "my comments" feeds in a future
-- self-moderation surface (out of scope for this block).

CREATE TABLE IF NOT EXISTS public.provider_media_comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id   uuid        NOT NULL REFERENCES public.provider_media(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_media_comments_body_nonempty CHECK (length(btrim(body)) > 0),
  CONSTRAINT provider_media_comments_body_max_len CHECK (length(body) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_provider_media_comments_media_id_created_at
  ON public.provider_media_comments (media_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_media_comments_user_id
  ON public.provider_media_comments (user_id);

ALTER TABLE public.provider_media_comments ENABLE ROW LEVEL SECURITY;

-- Anyone (anon + authenticated) can read comments
DROP POLICY IF EXISTS "provider_media_comments_select" ON public.provider_media_comments;
CREATE POLICY "provider_media_comments_select"
  ON public.provider_media_comments
  FOR SELECT USING (true);

-- Authenticated users can insert their own comments
DROP POLICY IF EXISTS "provider_media_comments_insert" ON public.provider_media_comments;
CREATE POLICY "provider_media_comments_insert"
  ON public.provider_media_comments
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Author OR provider that owns the media can delete.
-- Provider→auth mapping: providers.profile_id REFERENCES profiles(id), and
-- profiles.id REFERENCES auth.users(id) — verified against the live schema
-- 2026-05-04 (no providers.user_id column exists in Prod).
DROP POLICY IF EXISTS "provider_media_comments_delete" ON public.provider_media_comments;
CREATE POLICY "provider_media_comments_delete"
  ON public.provider_media_comments
  FOR DELETE
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1
      FROM public.provider_media pm
      JOIN public.providers p ON p.id = pm.provider_id
      WHERE pm.id = provider_media_comments.media_id
        AND p.profile_id = auth.uid()
    )
  );

-- Realtime publication — subscribers in the lightbox panel rely on INSERT
-- and DELETE events for cross-client sync.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'provider_media_comments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_media_comments;
  END IF;
END$$;
