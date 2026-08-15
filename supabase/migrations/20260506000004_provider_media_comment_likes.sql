-- 20260506000004_provider_media_comment_likes.sql
--
-- Comment-Likes (Block 2). Mirror der `provider_media_likes`-Tabelle:
-- public-read, own-row insert/delete, Realtime mit REPLICA IDENTITY FULL.
--
-- Per-Kommentar-Like-Counter wird live via count(*) berechnet — keine
-- Denormalisierung. Der Lese-Pfad bündelt die Counts pro Top-Level-
-- Kommentar im RPC `comment_thread_summary` (separate Migration —
-- referenziert wird die Tabelle in der nächsten Service-Migration).

CREATE TABLE IF NOT EXISTS public.provider_media_comment_likes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id  uuid        NOT NULL REFERENCES public.provider_media_comments(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_media_comment_likes_comment
  ON public.provider_media_comment_likes (comment_id);

CREATE INDEX IF NOT EXISTS idx_provider_media_comment_likes_user
  ON public.provider_media_comment_likes (user_id);

ALTER TABLE public.provider_media_comment_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pmcl_select ON public.provider_media_comment_likes;
CREATE POLICY pmcl_select
  ON public.provider_media_comment_likes
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS pmcl_insert ON public.provider_media_comment_likes;
CREATE POLICY pmcl_insert
  ON public.provider_media_comment_likes
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS pmcl_delete ON public.provider_media_comment_likes;
CREATE POLICY pmcl_delete
  ON public.provider_media_comment_likes
  FOR DELETE
  USING (auth.uid() = user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'provider_media_comment_likes'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_media_comment_likes';
  END IF;
END$$;

ALTER TABLE public.provider_media_comment_likes REPLICA IDENTITY FULL;

-- Thread-Summary-RPC: pro Top-Level-Comment die Anzahl Replies + Likes +
-- ob aktueller User geliked hat. Single-Roundtrip statt N+1.
CREATE OR REPLACE FUNCTION public.comment_thread_summary(p_media_id uuid)
RETURNS TABLE(
  comment_id   uuid,
  reply_count  bigint,
  like_count   bigint,
  liked_by_me  boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH base AS (
    SELECT id
      FROM public.provider_media_comments
     WHERE media_id = p_media_id
       AND parent_comment_id IS NULL
  )
  SELECT
    b.id AS comment_id,
    (SELECT count(*) FROM public.provider_media_comments c WHERE c.parent_comment_id = b.id)::bigint AS reply_count,
    (SELECT count(*) FROM public.provider_media_comment_likes l WHERE l.comment_id = b.id)::bigint AS like_count,
    EXISTS (
      SELECT 1
        FROM public.provider_media_comment_likes l
       WHERE l.comment_id = b.id AND l.user_id = auth.uid()
    ) AS liked_by_me
  FROM base b;
$$;

GRANT EXECUTE ON FUNCTION public.comment_thread_summary(uuid) TO authenticated, anon;

-- Reply-Summary-RPC analog für Replies eines bestimmten Top-Level-Comment.
-- Für Reply-Lazy-Load: Summary + liked_by_me ohne N+1 Roundtrips.
CREATE OR REPLACE FUNCTION public.comment_reply_summary(p_parent_id uuid)
RETURNS TABLE(
  comment_id   uuid,
  like_count   bigint,
  liked_by_me  boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.id AS comment_id,
    (SELECT count(*) FROM public.provider_media_comment_likes l WHERE l.comment_id = c.id)::bigint AS like_count,
    EXISTS (
      SELECT 1
        FROM public.provider_media_comment_likes l
       WHERE l.comment_id = c.id AND l.user_id = auth.uid()
    ) AS liked_by_me
  FROM public.provider_media_comments c
 WHERE c.parent_comment_id = p_parent_id;
$$;

GRANT EXECUTE ON FUNCTION public.comment_reply_summary(uuid) TO authenticated, anon;
