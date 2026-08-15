-- 20260506000005_enforce_parent_comment_id_immutable.sql
--
-- Härtung der UPDATE-Policy auf provider_media_comments. Block 2 hat
-- die UPDATE-RLS-Policy auf `auth.uid() = user_id` gesetzt — Author
-- darf seinen Comment editieren. Das WITH CHECK kann Row-Comparison
-- (OLD vs NEW) nicht ausdrücken, deshalb hier ein Trigger: wenn ein
-- UPDATE versucht, parent_comment_id zu verändern, throwt der Trigger.
--
-- Begründung: Threading-Tree muss stabil bleiben — sonst könnte ein
-- Author seinen Reply auf einen ANDEREN Top-Level-Comment umhängen
-- und Replies driften aus dem Render-Pfad raus.

CREATE OR REPLACE FUNCTION public.enforce_parent_comment_id_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_comment_id IS DISTINCT FROM OLD.parent_comment_id THEN
    RAISE EXCEPTION 'PARENT_COMMENT_ID_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS pmc_parent_immutable ON public.provider_media_comments;
CREATE TRIGGER pmc_parent_immutable
  BEFORE UPDATE ON public.provider_media_comments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_parent_comment_id_immutable();
