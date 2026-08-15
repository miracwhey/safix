-- Spatial Hotfix Round 4 · spatial_parametric_select path-owner branch
--
-- Symptom: storage upload to spatial-parametric returnt 400 "new row violates
-- RLS" auch nach Round 3 (chat_participants recursion fix). Pure INSERT ohne
-- RETURNING geht durch — INSERT WITH RETURNING failt.
--
-- Root cause: identisch zum scans_select Bug (PR #942). storage-api macht
-- POST /storage/v1/object → INSERT … RETURNING *. Postgres evaluiert die
-- SELECT-USING policy auf die NEW row. spatial_parametric_select USING
-- ruft `spatial_can_view_scene(<sceneId>, uid)` — aber der scene-row mit
-- dieser source_scan_id existiert noch nicht (Workflow-Order: blob upload
-- FIRST, scene-create RPC SECOND). → can_view_scene false → SELECT-policy
-- fails for RETURNING → 42501 maskiert als WITH-CHECK violation.
--
-- Fix: SELECT-USING erweitern um path-owner-OR-branch. Der Uploader darf
-- immer seine eigenen Pfade lesen, unabhängig davon ob die Scene schon
-- existiert. Sobald die Scene angelegt ist, greift der spatial_can_view_
-- scene Pfad für andere Viewer (Customer/Provider/Org). Owner-only-Read
-- ist sicher weil foldername[1] = auth.uid() bedingung ja schon im
-- INSERT/UPDATE/DELETE policy gate steht.
--
-- Migration-apply: Standard policy DDL läuft als `postgres`. storage.objects
-- ist von supabase_storage_admin owned — MCP `apply_migration` schafft das
-- trotzdem; `execute_sql` mit explicit `SET ROLE` wird hingegen mit
-- 42501 abgelehnt (siehe feedback_supabase_mcp_alter_database_denied).

DROP POLICY IF EXISTS spatial_parametric_select ON storage.objects;
CREATE POLICY spatial_parametric_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'spatial-parametric'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.spatial_can_view_scene(
        public.spatial_parametric_scene_id(name), auth.uid()
      )
    )
  );

COMMENT ON POLICY spatial_parametric_select ON storage.objects IS
  'Spatial Phase C (C-2) · Lane-3-Hotfix 20260526: SELECT extended with path-owner branch so INSERT…RETURNING from storage-api works (scene-row doesn''t exist yet at upload time). Cross-actor read (customer/provider/org) still goes via spatial_can_view_scene once the scene is materialised.';
