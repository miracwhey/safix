-- 20260506000003_provider_media_comments_threading.sql
--
-- Comments TikTok-Parity (Block 2)
--
-- Erweitert `provider_media_comments` (existing) um:
--   - `parent_comment_id` (self-ref, nullable, ON DELETE CASCADE)
--     1-Level Threading (Top-Level + Replies). Reply-on-Reply wird via
--     Trigger blockiert — DB-CHECK kann keinen Subquery, deshalb Trigger.
--   - `edited_at` (nullable timestamptz). Gesetzt durch Service beim
--     UPDATE-Pfad — nicht automatisch via DB-Trigger, weil INSERTs sonst
--     fälschlich als "bearbeitet" markiert werden müssten.
--   - UPDATE-RLS-Policy: nur eigene Author-Comments dürfen geändert
--     werden (Body-Edit). Provider hat KEIN Edit-Recht (RLS-Hardening).
--
-- INSERT- und DELETE-Policies bleiben unverändert (M2.3).

ALTER TABLE public.provider_media_comments
  ADD COLUMN IF NOT EXISTS parent_comment_id uuid
    REFERENCES public.provider_media_comments(id) ON DELETE CASCADE;

ALTER TABLE public.provider_media_comments
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_provider_media_comments_parent_created
  ON public.provider_media_comments (parent_comment_id, created_at);

-- Top-Level-Listing-Index: WHERE media_id = ? AND parent_comment_id IS NULL
-- ORDER BY created_at DESC. Partieller Index hält ihn schlank.
CREATE INDEX IF NOT EXISTS idx_provider_media_comments_media_root
  ON public.provider_media_comments (media_id, created_at DESC)
  WHERE parent_comment_id IS NULL;

-- Self-reference darf nicht auf sich selbst zeigen.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pmc_no_self_parent'
  ) THEN
    ALTER TABLE public.provider_media_comments
      ADD CONSTRAINT pmc_no_self_parent CHECK (parent_comment_id IS NULL OR parent_comment_id <> id);
  END IF;
END $$;

-- Reply-on-Reply blockieren (1-Level-Threading). DB-CHECK kann keinen
-- SELECT, deshalb Trigger. Reject mit ERRCODE 23514 (check_violation),
-- damit der Service einen erkennbaren Fehler bekommt.
CREATE OR REPLACE FUNCTION public.enforce_comment_depth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_comment_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.provider_media_comments
       WHERE id = NEW.parent_comment_id AND parent_comment_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'COMMENT_NESTING_TOO_DEEP'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS pmc_enforce_depth ON public.provider_media_comments;
CREATE TRIGGER pmc_enforce_depth
  BEFORE INSERT OR UPDATE ON public.provider_media_comments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_comment_depth();

-- UPDATE-Policy: nur Author. Body kann editiert werden, parent_comment_id
-- darf nicht ge-flipped werden (das würde Threading-Tree zerreißen).
DROP POLICY IF EXISTS provider_media_comments_update ON public.provider_media_comments;
CREATE POLICY provider_media_comments_update
  ON public.provider_media_comments
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
