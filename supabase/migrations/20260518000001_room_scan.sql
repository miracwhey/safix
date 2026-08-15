-- M3: RoomPlan / LiDAR Scan
-- Adds room_scan_url + room_scan_metadata to projects.
-- Path schema: {userId}/{projectId}/scan.usdz
--
-- Column types:
--   projects.id: uuid | projects.customer_user_id: uuid
--   jobs.project_id: text | jobs.craftsman_user_id: text
--   storage.foldername()[n]: text | auth.uid(): uuid

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS room_scan_url      text,
  ADD COLUMN IF NOT EXISTS room_scan_metadata jsonb;

-- Upload: only the customer who owns the project
DROP POLICY IF EXISTS project_scans_insert ON storage.objects;
CREATE POLICY project_scans_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'project-scans'
    AND (storage.foldername(name))[1]::uuid = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.projects
      WHERE id               = (storage.foldername(name))[2]::uuid
        AND customer_user_id = (SELECT auth.uid())
    )
  );

-- Update: re-scan overwrite, same guard
DROP POLICY IF EXISTS project_scans_update ON storage.objects;
CREATE POLICY project_scans_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'project-scans'
    AND (storage.foldername(name))[1]::uuid = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.projects
      WHERE id               = (storage.foldername(name))[2]::uuid
        AND customer_user_id = (SELECT auth.uid())
    )
  );

-- Delete: owner only
DROP POLICY IF EXISTS project_scans_delete ON storage.objects;
CREATE POLICY project_scans_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-scans'
    AND (storage.foldername(name))[1]::uuid = (SELECT auth.uid())
  );

-- Select: project customer OR craftsman with a linked job
DROP POLICY IF EXISTS project_scans_select ON storage.objects;
CREATE POLICY project_scans_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-scans'
    AND (
      EXISTS (
        SELECT 1 FROM public.projects
        WHERE id               = (storage.foldername(name))[2]::uuid
          AND customer_user_id = (SELECT auth.uid())
      )
      OR
      EXISTS (
        SELECT 1 FROM public.jobs
        WHERE project_id        = (storage.foldername(name))[2]
          AND craftsman_user_id = (SELECT auth.uid())::text
      )
    )
  );

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- ALTER TABLE public.projects DROP COLUMN IF EXISTS room_scan_url;
-- ALTER TABLE public.projects DROP COLUMN IF EXISTS room_scan_metadata;
-- DROP POLICY IF EXISTS project_scans_insert ON storage.objects;
-- DROP POLICY IF EXISTS project_scans_update ON storage.objects;
-- DROP POLICY IF EXISTS project_scans_delete ON storage.objects;
-- DROP POLICY IF EXISTS project_scans_select ON storage.objects;

-- ── External steps (done) ─────────────────────────────────────────────────────
-- Storage bucket 'project-scans' created: private, MIME model/vnd.usdz+zip, max 20 MB
