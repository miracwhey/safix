-- Spatial Canonical · Phase C · (C-7) · Re-Scan customer read + realtime
--
-- Block C-7 closes the re-scan loop in BOTH directions. The customer needs a
-- screen that shows the request (reason) and offers accept / reject — but
-- 120047 deliberately gave the customer no row access (notification-only).
-- C-7 takes the customer-facing-screen scope, so the customer now needs a
-- SELECT path for their own scenes' requests.
--
-- Also adds the table to the realtime publication so the provider's Re-Scan
-- tab sees the customer's response live (REPLICA IDENTITY FULL so a future
-- scene_id-filtered event carries the full OLD row).
--
-- Apply after: 20260521120049_spatial_parametric_bucket.sql

-- ── Customer SELECT ───────────────────────────────────────────────────────────
-- RLS policies are permissive (OR-combined): this sits alongside the existing
-- org-scoped SELECT — a row is visible to an org member OR the scene customer.

DROP POLICY IF EXISTS spatial_rescan_requests_customer_select
  ON public.spatial_rescan_requests;
CREATE POLICY spatial_rescan_requests_customer_select
  ON public.spatial_rescan_requests
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.spatial_scenes s
      WHERE s.id = scene_id
        AND s.customer_id = auth.uid()
    )
  );

-- ── Realtime ──────────────────────────────────────────────────────────────────

ALTER TABLE public.spatial_rescan_requests REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.spatial_rescan_requests;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.spatial_rescan_requests;
-- ALTER TABLE public.spatial_rescan_requests REPLICA IDENTITY DEFAULT;
-- DROP POLICY IF EXISTS spatial_rescan_requests_customer_select ON public.spatial_rescan_requests;
