-- Migration: portfolio likes
-- Likes belong to a specific published provider_media item (kind='portfolio').
-- One user can like each item once; a second action removes the like.
-- RLS: anyone can read counts; only the authenticated liker can write/delete.

CREATE TABLE public.provider_media_likes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id   uuid        NOT NULL REFERENCES public.provider_media(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, user_id)
);

CREATE INDEX idx_provider_media_likes_media_id ON public.provider_media_likes (media_id);
CREATE INDEX idx_provider_media_likes_user_id  ON public.provider_media_likes (user_id);

ALTER TABLE public.provider_media_likes ENABLE ROW LEVEL SECURITY;

-- Anyone (incl. anon) can read like counts
CREATE POLICY "provider_media_likes_select"
  ON public.provider_media_likes
  FOR SELECT USING (true);

-- Authenticated users can add their own like
CREATE POLICY "provider_media_likes_insert"
  ON public.provider_media_likes
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can remove only their own like
CREATE POLICY "provider_media_likes_delete"
  ON public.provider_media_likes
  FOR DELETE USING (auth.uid() = user_id);
