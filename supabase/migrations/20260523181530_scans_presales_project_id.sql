-- Spatial V1.5 · Provider-Pre-Sales-Spatial · Phase B-P1 · Migration 2/2
--
-- Extends `public.scans` so a scan can anchor to a provider-presales-project
-- instead of (or in addition to) a customer-project/job.
--
-- Changes:
--   1. New column `scans.presales_project_id` (FK → provider_presales_projects).
--   2. Loosen `scans_owner_anchor_chk` to accept ANY of the three anchors.
--   3. Replace `scans_insert` RLS to allow provider-org members to INSERT
--      scans anchored to one of their own presales projects.
--
-- Existing `spatial_can_view_scan` already grants view to `captured_by = uid`
-- so the provider who captured the scan can see it without additional helper
-- changes. Multi-member-provider-org sharing of presales scans is deferred to
-- a follow-up migration (V1.5.1) — V1.5 surfaces only the captured-by member's
-- scans.
--
-- External steps after apply:
--   - Run `supabase gen types` to regenerate TS types (Database['public']['Tables']['scans']['Row']).
--   - Verify `mcp__claude_ai_Supabase__list_tables` shows the new column.

-- ── 1. Column ────────────────────────────────────────────────────────────────
ALTER TABLE public.scans
  ADD COLUMN IF NOT EXISTS presales_project_id uuid
    REFERENCES public.provider_presales_projects(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.scans.presales_project_id IS
  'Optional anchor to a provider-presales-project (V1.5+). Mutually-exclusive '
  'conceptually with job_id+project_id but DB allows multiple for re-link '
  'scenarios; the owner_anchor_chk requires at least one of the three.';

-- ── 2. Index ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS scans_presales_project_id_idx
  ON public.scans(presales_project_id)
  WHERE presales_project_id IS NOT NULL;

-- ── 3. Loosen owner-anchor CHECK ─────────────────────────────────────────────
ALTER TABLE public.scans
  DROP CONSTRAINT IF EXISTS scans_owner_anchor_chk;

ALTER TABLE public.scans
  ADD CONSTRAINT scans_owner_anchor_chk
  CHECK (
    job_id IS NOT NULL
    OR project_id IS NOT NULL
    OR presales_project_id IS NOT NULL
  );

COMMENT ON CONSTRAINT scans_owner_anchor_chk ON public.scans IS
  'Each scan must anchor to at least one owner-context: customer-project, '
  'customer-job, or provider-presales-project. Extended in V1.5 to include presales.';

-- ── 4. Replace `scans_insert` RLS ────────────────────────────────────────────
DROP POLICY IF EXISTS scans_insert ON public.scans;
CREATE POLICY scans_insert ON public.scans
  FOR INSERT TO authenticated
  WITH CHECK (
    captured_by = (SELECT auth.uid())
    AND (
      public.spatial_is_operator((SELECT auth.uid()))
      OR (
        project_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.projects p
          WHERE p.id = project_id
            AND p.customer_user_id = (SELECT auth.uid())
        )
      )
      OR (
        job_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id = job_id
            AND (
              j.craftsman_user_id = (SELECT auth.uid())::text
              OR j.customer_user_id = (SELECT auth.uid())
            )
        )
      )
      OR (
        presales_project_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.provider_presales_projects pp
          WHERE pp.id = presales_project_id
            AND pp.provider_org_id = public.spatial_user_provider_org((SELECT auth.uid()))
        )
      )
    )
  );
