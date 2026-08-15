-- Spatial Canonical · Phase C · RLS Hardening (post-review fix)
--
-- Fixes two defects found in the Phase C hard-review of migrations
-- 20260521120047 (spatial_rescan_requests) and 120048 (spatial_pin_reviews).
--
-- DEFECT 1 — cross-org INSERT guard is a tautology.
--   The INSERT WITH CHECK clause on BOTH tables contained the sub-clause
--   `s.provider_org_id = provider_org_id` inside an `EXISTS (SELECT 1 FROM
--   spatial_scenes s ...)`.  The unqualified `provider_org_id` was intended
--   to reference the NEW row, but Postgres resolves an unqualified column
--   inside the sub-query against the sub-query's own FROM table — collapsing
--   the check to `s.provider_org_id = s.provider_org_id` (always true).
--   The "target scene belongs to this org" guard was therefore dead: an
--   authenticated user could insert a row referencing ANY provider's scene
--   (the scene's customer would then see a forged re-scan request).
--   Fix: compare the scene's org directly against the caller's resolved org
--   via spatial_user_provider_org(auth.uid()) — unambiguous, no NEW-row ref.
--   Combined with the unchanged outer clause
--   `provider_org_id = spatial_user_provider_org(auth.uid())` this transitively
--   enforces NEW.provider_org_id = scene.provider_org_id.
--
-- DEFECT 2 — TRUNCATE is not governed by RLS.
--   anon/authenticated hold the Supabase-default blanket table GRANTs.  RLS
--   gates row-level DML but NOT TRUNCATE — any authenticated user could
--   `TRUNCATE public.spatial_pin_reviews` and wipe every org's data.
--   spatial_rescan_requests additionally still held UPDATE/DELETE grants it
--   never uses (append-only; status transitions only via the RPC).
--   Fix: REVOKE ALL from anon + authenticated, then GRANT back only the
--   minimal verbs each table's policies actually need.  Matches the spatial
--   schema convention (20260520120010 §"TRUNCATE already REVOKEd").
--
-- service_role is intentionally untouched — it bypasses RLS by design.
-- No data migration, no FSM impact.  Re-runnable.
--
-- Apply after: 20260521120051_spatial_annotation_photos_bucket.sql

-- ── DEFECT 1 · spatial_rescan_requests INSERT policy ──────────────────────────
ALTER POLICY spatial_rescan_requests_insert
  ON public.spatial_rescan_requests
  WITH CHECK (
    provider_org_id = public.spatial_user_provider_org(auth.uid())
    AND requested_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
        FROM public.spatial_scenes s
        WHERE s.id = spatial_rescan_requests.scene_id
          AND s.provider_org_id = public.spatial_user_provider_org(auth.uid())
    )
  );

-- ── DEFECT 1 · spatial_pin_reviews INSERT policy ─────────────────────────────
ALTER POLICY spatial_pin_reviews_insert
  ON public.spatial_pin_reviews
  WITH CHECK (
    provider_org_id = public.spatial_user_provider_org(auth.uid())
    AND reviewed_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
        FROM public.spatial_scenes s
        WHERE s.id = spatial_pin_reviews.scene_id
          AND s.provider_org_id = public.spatial_user_provider_org(auth.uid())
    )
  );

-- ── DEFECT 2 · table-privilege hardening ─────────────────────────────────────
-- spatial_rescan_requests — append-only for clients: SELECT + INSERT only.
-- UPDATE/DELETE happen exclusively through spatial_rescan_request_respond()
-- (SECURITY DEFINER); TRUNCATE is never a client operation.
REVOKE ALL ON public.spatial_rescan_requests FROM anon, authenticated;
GRANT  SELECT, INSERT ON public.spatial_rescan_requests TO authenticated;

-- spatial_pin_reviews — full row CRUD via policies, but never TRUNCATE.
REVOKE ALL ON public.spatial_pin_reviews FROM anon, authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.spatial_pin_reviews TO authenticated;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- The pre-fix policies and blanket grants were defective; there is no
-- meaningful rollback target.  To revert, restore the WITH CHECK clauses from
-- 20260521120047/120048 and re-run `GRANT ALL ON <table> TO anon, authenticated`
-- (NOT recommended — that reinstates the cross-org hole and the TRUNCATE hole).
