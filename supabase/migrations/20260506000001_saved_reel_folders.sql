-- 20260506000001_saved_reel_folders.sql
--
-- Saved-Reels Folder-Surface (Block 1)
--
-- User-eigene Ordner für gespeicherte Reels (Pinterest-Boards-Style).
-- `provider_media_saves` (existing) hängt Reels per `folder_id` an einen
-- Ordner. `folder_id IS NULL` repräsentiert den virtuellen Default-Ordner
-- "Alle gespeicherten" — kein DB-Row, rein Client-Konstrukt. Vorteil:
-- kein Signup-Trigger nötig, kein Ghost-Save-Risiko bei Folder-Delete
-- (`ON DELETE SET NULL` re-parkt Saves automatisch im Default).
--
-- RLS: own-row für alle CRUD-Pfade.
-- Realtime: full publication + REPLICA IDENTITY FULL für gefilterte
-- DELETE-Events (Filter user_id=eq.<self> braucht user_id im OLD-Payload).

CREATE TABLE IF NOT EXISTS public.saved_reel_folders (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  sort_order  bigint      NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT srf_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 60)
);

-- Case-insensitive Unique pro User. lower(btrim(...)) verhindert
-- "Inspiration" + "inspiration" Duplikate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_reel_folders_user_name_ci
  ON public.saved_reel_folders (user_id, lower(btrim(name)));

CREATE INDEX IF NOT EXISTS idx_saved_reel_folders_user_sort
  ON public.saved_reel_folders (user_id, sort_order, created_at DESC);

ALTER TABLE public.saved_reel_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS srf_select ON public.saved_reel_folders;
CREATE POLICY srf_select
  ON public.saved_reel_folders
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS srf_insert ON public.saved_reel_folders;
CREATE POLICY srf_insert
  ON public.saved_reel_folders
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS srf_update ON public.saved_reel_folders;
CREATE POLICY srf_update
  ON public.saved_reel_folders
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS srf_delete ON public.saved_reel_folders;
CREATE POLICY srf_delete
  ON public.saved_reel_folders
  FOR DELETE
  USING (auth.uid() = user_id);

-- updated_at-Trigger. Wiederverwendet falls schon existiert.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS srf_touch_updated_at ON public.saved_reel_folders;
CREATE TRIGGER srf_touch_updated_at
  BEFORE UPDATE ON public.saved_reel_folders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Realtime publication. Idempotent guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'saved_reel_folders'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.saved_reel_folders';
  END IF;
END$$;

ALTER TABLE public.saved_reel_folders REPLICA IDENTITY FULL;
