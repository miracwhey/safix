-- APPLY HELD: run only after explicit "ja apply"
-- =============================================================================
-- provider_media_saves: add missing UPDATE RLS policy (B4.3)
-- =============================================================================
-- The table had only SELECT / INSERT / DELETE policies. Moving an already-saved
-- reel between folders goes through setSaveFolder()'s UPDATE branch
-- (src/lib/providerMedia/portfolioSaveService.ts) — which hit RLS default-deny
-- for UPDATE and silently matched 0 rows, while the UI showed a success toast.
-- This adds the self-scoped UPDATE policy so the folder move actually persists.
-- Additive + idempotent; affects 0 existing rows (table currently empty).
-- =============================================================================

DROP POLICY IF EXISTS provider_media_saves_update ON public.provider_media_saves;

CREATE POLICY provider_media_saves_update
  ON public.provider_media_saves
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
