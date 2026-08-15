-- 20260506000002_provider_media_saves_folder_id.sql
--
-- Verknüpft `provider_media_saves` (existing) mit `saved_reel_folders`.
-- folder_id IS NULL = virtueller Default-Folder ("Alle gespeicherten").
-- ON DELETE SET NULL → Folder-Delete schiebt Saves zurück in Default,
-- kein Datenverlust.
--
-- Index optimiert die Folder-View `WHERE user_id=$1 AND folder_id IS NOT
-- DISTINCT FROM $2 ORDER BY created_at DESC`.

ALTER TABLE public.provider_media_saves
  ADD COLUMN IF NOT EXISTS folder_id uuid
    REFERENCES public.saved_reel_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_provider_media_saves_user_folder_created
  ON public.provider_media_saves (user_id, folder_id, created_at DESC);

-- Counter-RPC: ein Roundtrip statt N+1 für Folder-Tile-Counter.
-- SECURITY INVOKER + auth.uid()-Filter → RLS-equivalent.
-- Liegt in dieser Migration weil sie auf provider_media_saves.folder_id
-- referenziert, das gerade erst hinzugefügt wurde.
CREATE OR REPLACE FUNCTION public.saved_reels_count_by_folder()
RETURNS TABLE(folder_id uuid, save_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT pms.folder_id, count(*)::bigint AS save_count
    FROM public.provider_media_saves pms
   WHERE pms.user_id = auth.uid()
   GROUP BY pms.folder_id;
$$;

GRANT EXECUTE ON FUNCTION public.saved_reels_count_by_folder() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.saved_reels_count_by_folder() FROM anon, public;
