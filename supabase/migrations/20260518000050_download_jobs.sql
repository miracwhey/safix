-- Spatial Core · Block I.1 · download_jobs queue + RLS
--
-- Persists user-requested download artefacts (PDF report, floorplan SVG,
-- mesh-summary JSON) so the Cloud Run worker can pick them up async and
-- the UI can poll for `status = 'ready'` to surface a signed URL.
--
-- Why a dedicated table instead of riding `scan_assets`:
--   1. download artefacts have a TTL — they expire (auto-cleanup) where
--      scan_assets are permanent until lifecycle-archive (Block H).
--   2. user-scoped download history matters for audit ("who exported the
--      pin list with photos?"); scan_assets are scan-scoped only.
--   3. RPC entry point lets us enforce the spatial_can_view_scan invariant
--      uniformly without copying the check into 3 different INSERT paths.
--
-- INSERT path is intentionally locked off — clients invoke
-- `public.request_scan_download(scan_id, kind)` from migration 00051.

CREATE TABLE IF NOT EXISTS public.download_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id         uuid NOT NULL REFERENCES public.scans(id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('pdf_report','floorplan_svg','mesh_summary_json')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','ready','failed')),
  storage_path    text,
  expires_at      timestamptz,
  error_message   text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS download_jobs_scan_idx
  ON public.download_jobs(scan_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS download_jobs_user_idx
  ON public.download_jobs(requested_by, requested_at DESC);
CREATE INDEX IF NOT EXISTS download_jobs_pending_idx
  ON public.download_jobs(status, requested_at)
  WHERE status IN ('pending','processing');

ALTER TABLE public.download_jobs ENABLE ROW LEVEL SECURITY;

-- SELECT — requester OR anyone who can view the parent scan (operator path).
CREATE POLICY download_jobs_view ON public.download_jobs FOR SELECT
  TO authenticated
  USING (
    requested_by = auth.uid()
    OR public.spatial_can_view_scan(scan_id, auth.uid())
  );

-- Writes happen only through the SECURITY DEFINER RPC in migration 00051.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.download_jobs FROM anon, authenticated;

COMMENT ON TABLE public.download_jobs IS
  'Block I — async download artefacts (PDF / SVG / JSON) per scan. INSERT via request_scan_download() RPC only.';
