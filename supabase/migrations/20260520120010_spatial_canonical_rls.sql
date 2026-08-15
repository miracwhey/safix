-- Spatial Canonical · Day 7 · (1/2) · RLS Policies
--
-- Covers the 8 tables introduced in Day 6 (20260520120001..120005):
--   spatial_scenes · spatial_edit_history · spatial_node_overrides
--   spatial_assets · spatial_materials · spatial_node_links
--   dispute_spatial_evidence · spatial_change_orders
--
-- RLS was already ENABLED on all 8 tables in Day 6 migrations.
-- This migration adds the allow-paths on top of the default-deny baseline.
--
-- REUSED helpers (do NOT redefine here — already in 20260518000003_spatial_core_block_a_rls.sql):
--   public.spatial_is_operator(uuid)   — operator check via profiles.is_operator
--
-- NEW helper defined here:
--   public.spatial_can_view_scene(uuid, uuid) — scene-actor check (customer | provider | service_role)
--
-- service_role bypass: one FOR ALL policy per table (auth.role() = 'service_role').
--   PostgREST sets role = 'service_role' for requests authenticated with the service key.
--   This gives the convert-scan edge function and server-side RPCs unrestricted access
--   without needing to be an operator user.
--
-- Append-only tables (spatial_edit_history · dispute_spatial_evidence):
--   REVOKE INSERT/UPDATE/DELETE/TRUNCATE already applied in Day 6 schema migrations.
--   A USING (false) INSERT policy is added here purely for policy-table consistency.
--   Inserts flow through SECURITY DEFINER RPCs (Day 7 triggers file).
--
-- MR1 reinforcement — TRUNCATE confirmation:
--   REVOKE TRUNCATE was applied in Day 6 schema migrations.
--   Verified present; not re-emitted here to avoid duplicate-revoke noise.
--
-- SQLSTATE for SpatialFsmViolation → '45SPF'
--   (defined and documented in 20260520120011_spatial_canonical_triggers.sql)
--
-- External steps:
--   1. Schema cache refresh (Supabase Dashboard → Settings → API → Reload)
--      required after any new RLS helper function (spatial_can_view_scene).
--   2. Day 8 TS repositories check: ensure `.code === '45SPF'` dispatch is wired.
--
-- Plan reference: ~/.claude/plans/spatial-v1-day-6-17-NEXT-CHAT-HANDOVER.md §4 Day 7

-- ── Helper: spatial_can_view_scene ───────────────────────────────────────────
--
-- Returns true when the given uid is a scene-actor (customer or provider of the
-- scene) or when the current Postgres role is 'service_role'.
--
-- STABLE + SECURITY DEFINER + locked search_path:
--   - Prevents RLS recursion (the function body runs outside RLS on spatial_scenes).
--   - Prevents policy-spoofing via search_path tricks (Block-A convention).
--
-- DO NOT inline this check in policy expressions — always call the helper.
-- This ensures the scene-actor definition can be updated in one place.

CREATE OR REPLACE FUNCTION public.spatial_can_view_scene(p_scene_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.spatial_scenes s
      WHERE s.id = p_scene_id
        AND (
          s.customer_id = p_uid
          OR s.provider_id = p_uid
        )
    );
$$;

COMMENT ON FUNCTION public.spatial_can_view_scene(uuid, uuid) IS
  'Spatial Canonical Day 7 RLS helper: returns true when p_uid is the customer or '
  'provider of the given scene, or when auth.role() = ''service_role''. '
  'SECURITY DEFINER + locked search_path to prevent RLS recursion (Block-A pattern).';

-- Grant: authenticated can call it (service_role bypasses RLS entirely; anon must not)
REVOKE EXECUTE ON FUNCTION public.spatial_can_view_scene(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_can_view_scene(uuid, uuid) TO authenticated;


-- ── Policies · spatial_scenes ─────────────────────────────────────────────────

-- service_role bypass (full access for edge functions + server-side RPCs)
DROP POLICY IF EXISTS spatial_scenes_service_role_all ON public.spatial_scenes;
CREATE POLICY spatial_scenes_service_role_all ON public.spatial_scenes
  FOR ALL TO public
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- SELECT: customer or provider of the scene
DROP POLICY IF EXISTS spatial_scenes_select ON public.spatial_scenes;
CREATE POLICY spatial_scenes_select ON public.spatial_scenes
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scene(id, (SELECT auth.uid())));

-- INSERT: service_role only.
-- V1 path: the convert-scan edge function runs with the service_role key.
-- Authenticated INSERT is intentionally blocked — no direct user path in V1.
DROP POLICY IF EXISTS spatial_scenes_insert ON public.spatial_scenes;
CREATE POLICY spatial_scenes_insert ON public.spatial_scenes
  FOR INSERT TO authenticated
  WITH CHECK (false);

-- UPDATE: customer or provider of the scene may mutate mutable columns.
-- Immutable columns (id, source_scan_id, source_job_id, created_at) are enforced
-- by the spatial_scenes_immutable_cols BEFORE UPDATE trigger in Day 7 triggers file.
DROP POLICY IF EXISTS spatial_scenes_update ON public.spatial_scenes;
CREATE POLICY spatial_scenes_update ON public.spatial_scenes
  FOR UPDATE TO authenticated
  USING      (public.spatial_can_view_scene(id, (SELECT auth.uid())))
  WITH CHECK (public.spatial_can_view_scene(id, (SELECT auth.uid())));

-- DELETE: default-deny for authenticated (no explicit policy = no delete allowed).
-- TRUNCATE already REVOKEd in Day 6.


-- ── Policies · spatial_edit_history ──────────────────────────────────────────
-- Append-only audit log. REVOKE already applied in Day 6.
-- SECURITY DEFINER RPC (spatial_edit_history_append) is the sole insert path.

-- service_role bypass
DROP POLICY IF EXISTS spatial_edit_history_service_role_all ON public.spatial_edit_history;
CREATE POLICY spatial_edit_history_service_role_all ON public.spatial_edit_history
  FOR ALL TO public
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- SELECT: scene-actor (customer or provider)
DROP POLICY IF EXISTS spatial_edit_history_select ON public.spatial_edit_history;
CREATE POLICY spatial_edit_history_select ON public.spatial_edit_history
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scene(scene_id, (SELECT auth.uid())));

-- INSERT: USING (false) — policy-table consistency marker.
-- Actual inserts flow through the SECURITY DEFINER RPC which bypasses this policy.
-- REVOKE in Day 6 already prevents direct INSERT from authenticated.
DROP POLICY IF EXISTS spatial_edit_history_insert_deny ON public.spatial_edit_history;
CREATE POLICY spatial_edit_history_insert_deny ON public.spatial_edit_history
  FOR INSERT TO authenticated
  WITH CHECK (false);

-- UPDATE: blocked (no policy = denied).
-- DELETE: blocked (no policy = denied).
-- TRUNCATE: REVOKEd in Day 6.


-- ── Policies · spatial_node_overrides ────────────────────────────────────────
-- V1.x preparation table. No policies in V1 — default-deny stands for all operations.
-- SELECT is blocked intentionally: V1 reads overrides from the parametric blob (Decision #6),
-- not from this table. Activate in V1.x by adding policies here.

-- service_role bypass only (allows ops tooling to inspect rows if any land via migration)
DROP POLICY IF EXISTS spatial_node_overrides_service_role_all ON public.spatial_node_overrides;
CREATE POLICY spatial_node_overrides_service_role_all ON public.spatial_node_overrides
  FOR ALL TO public
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- NO further policies added here.
-- V1.x: activate INSERT/UPDATE/SELECT by adding policies in a follow-up RLS migration.
-- TRUNCATE already REVOKEd in Day 6.


-- ── Policies · spatial_assets ─────────────────────────────────────────────────
-- Operator-managed catalog; end-users SELECT published rows only.

-- service_role bypass
DROP POLICY IF EXISTS spatial_assets_service_role_all ON public.spatial_assets;
CREATE POLICY spatial_assets_service_role_all ON public.spatial_assets
  FOR ALL TO public
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- SELECT: any authenticated user may read published assets; service_role sees all.
-- Non-published rows (draft catalog entries) are invisible to authenticated users.
DROP POLICY IF EXISTS spatial_assets_select ON public.spatial_assets;
CREATE POLICY spatial_assets_select ON public.spatial_assets
  FOR SELECT TO authenticated
  USING (published = true);

-- INSERT / UPDATE / DELETE: service_role bypass handles operator write path.
-- Authenticated INSERT/UPDATE/DELETE are blocked (no policies = denied).
-- TRUNCATE already REVOKEd in Day 6.


-- ── Policies · spatial_materials ─────────────────────────────────────────────
-- Analogous to spatial_assets (same operator-managed catalog pattern).

-- service_role bypass
DROP POLICY IF EXISTS spatial_materials_service_role_all ON public.spatial_materials;
CREATE POLICY spatial_materials_service_role_all ON public.spatial_materials
  FOR ALL TO public
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- SELECT: authenticated users see published materials only.
DROP POLICY IF EXISTS spatial_materials_select ON public.spatial_materials;
CREATE POLICY spatial_materials_select ON public.spatial_materials
  FOR SELECT TO authenticated
  USING (published = true);

-- INSERT / UPDATE / DELETE: blocked for authenticated (service_role bypass only).
-- TRUNCATE already REVOKEd in Day 6.


-- ── Policies · spatial_node_links ────────────────────────────────────────────
-- Cross-domain bridge: scene-actor can SELECT and INSERT; UPDATE/DELETE are
-- append-only (V1: links accumulate, not mutated).

-- service_role bypass
DROP POLICY IF EXISTS spatial_node_links_service_role_all ON public.spatial_node_links;
CREATE POLICY spatial_node_links_service_role_all ON public.spatial_node_links
  FOR ALL TO public
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- SELECT: scene-actor
DROP POLICY IF EXISTS spatial_node_links_select ON public.spatial_node_links;
CREATE POLICY spatial_node_links_select ON public.spatial_node_links
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scene(scene_id, (SELECT auth.uid())));

-- INSERT: scene-actor AND the row's created_by must equal the caller.
-- Prevents one scene-actor from impersonating another as the link author.
DROP POLICY IF EXISTS spatial_node_links_insert ON public.spatial_node_links;
CREATE POLICY spatial_node_links_insert ON public.spatial_node_links
  FOR INSERT TO authenticated
  WITH CHECK (
    public.spatial_can_view_scene(scene_id, (SELECT auth.uid()))
    AND created_by = (SELECT auth.uid())
  );

-- UPDATE: blocked — cross-domain links are append-only in V1.
-- DELETE: blocked — default-deny stands.
-- TRUNCATE already REVOKEd in Day 6.


-- ── Policies · dispute_spatial_evidence ──────────────────────────────────────
-- Append-only forensic bridge. REVOKE already applied in Day 6.
-- SECURITY DEFINER RPC (dispute_spatial_evidence_append) is the sole insert path.
--
-- Dispute-actor check:
--   The disputes table has no single-column foreign key exposable as a helper
--   without coupling to its RLS internals. V1 uses scene-actor as the gate:
--   if you can view the scene, you can view / submit evidence on it.
--   Full dispute-party check (opened_by_profile_id / customer_profile_id / provider_id)
--   is deferred to Phase 5 BoM when the dispute-evidence workflow activates (Day 41-47).
--   TODO(Phase5): add dispute_can_view helper that checks all three dispute-actor
--   columns and compose it here with spatial_can_view_scene.

-- service_role bypass
DROP POLICY IF EXISTS dispute_spatial_evidence_service_role_all ON public.dispute_spatial_evidence;
CREATE POLICY dispute_spatial_evidence_service_role_all ON public.dispute_spatial_evidence
  FOR ALL TO public
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- SELECT: scene-actor (V1 gate; see TODO above for Phase 5 expansion)
DROP POLICY IF EXISTS dispute_spatial_evidence_select ON public.dispute_spatial_evidence;
CREATE POLICY dispute_spatial_evidence_select ON public.dispute_spatial_evidence
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scene(scene_id, (SELECT auth.uid())));

-- INSERT: USING (false) — policy-table consistency marker.
-- REVOKE in Day 6 already prevents direct INSERT from authenticated.
-- Actual inserts flow through dispute_spatial_evidence_append SECURITY DEFINER RPC.
DROP POLICY IF EXISTS dispute_spatial_evidence_insert_deny ON public.dispute_spatial_evidence;
CREATE POLICY dispute_spatial_evidence_insert_deny ON public.dispute_spatial_evidence
  FOR INSERT TO authenticated
  WITH CHECK (false);

-- UPDATE / DELETE / TRUNCATE: blocked.
-- TRUNCATE already REVOKEd in Day 6.


-- ── Policies · spatial_change_orders ─────────────────────────────────────────
-- Phase 5 BoM: provider-proposed scope changes.

-- service_role bypass
DROP POLICY IF EXISTS spatial_change_orders_service_role_all ON public.spatial_change_orders;
CREATE POLICY spatial_change_orders_service_role_all ON public.spatial_change_orders
  FOR ALL TO public
  USING      (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- SELECT: scene-actor (customer or provider)
DROP POLICY IF EXISTS spatial_change_orders_select ON public.spatial_change_orders;
CREATE POLICY spatial_change_orders_select ON public.spatial_change_orders
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scene(scene_id, (SELECT auth.uid())));

-- INSERT: provider-only. The inserting user must be the provider on the
-- target scene AND must claim themselves as the proposer.
-- Per domain contract, change orders are provider-proposed scope changes;
-- this triple-bind (auth.uid() = scene.provider_id = proposer_id) prevents
-- a customer from inserting a change order at all, and prevents a provider
-- from inserting one attributed to someone else.
DROP POLICY IF EXISTS spatial_change_orders_insert ON public.spatial_change_orders;
CREATE POLICY spatial_change_orders_insert ON public.spatial_change_orders
  FOR INSERT TO authenticated
  WITH CHECK (
    proposer_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.spatial_scenes s
      WHERE s.id = scene_id
        AND s.provider_id = (SELECT auth.uid())
    )
  );

-- UPDATE: proposer only. USING gates which rows are eligible (status='proposed');
-- WITH CHECK only re-asserts the immutable proposer_id so the row cannot be
-- re-attributed during a status transition. The FSM trigger
-- (spatial_change_orders_status_fsm) enforces the legal NEW.status set
-- ('accepted' | 'rejected' | 'withdrawn') — duplicating status='proposed' here
-- would block every legal transition because NEW.status is by definition
-- no longer 'proposed' after the update.
DROP POLICY IF EXISTS spatial_change_orders_update ON public.spatial_change_orders;
CREATE POLICY spatial_change_orders_update ON public.spatial_change_orders
  FOR UPDATE TO authenticated
  USING (
    proposer_id = (SELECT auth.uid())
    AND status = 'proposed'
  )
  WITH CHECK (
    proposer_id = (SELECT auth.uid())
  );

-- DELETE / TRUNCATE: blocked. No policy = denied. TRUNCATE REVOKEd in Day 6.


-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Run this block to undo all changes in this migration.
-- NOTE: set_updated_at() is shared infrastructure — do NOT drop it here.
--
-- DROP POLICY IF EXISTS spatial_scenes_service_role_all         ON public.spatial_scenes;
-- DROP POLICY IF EXISTS spatial_scenes_select                   ON public.spatial_scenes;
-- DROP POLICY IF EXISTS spatial_scenes_insert                   ON public.spatial_scenes;
-- DROP POLICY IF EXISTS spatial_scenes_update                   ON public.spatial_scenes;
--
-- DROP POLICY IF EXISTS spatial_edit_history_service_role_all   ON public.spatial_edit_history;
-- DROP POLICY IF EXISTS spatial_edit_history_select             ON public.spatial_edit_history;
-- DROP POLICY IF EXISTS spatial_edit_history_insert_deny        ON public.spatial_edit_history;
--
-- DROP POLICY IF EXISTS spatial_node_overrides_service_role_all ON public.spatial_node_overrides;
--
-- DROP POLICY IF EXISTS spatial_assets_service_role_all         ON public.spatial_assets;
-- DROP POLICY IF EXISTS spatial_assets_select                   ON public.spatial_assets;
--
-- DROP POLICY IF EXISTS spatial_materials_service_role_all      ON public.spatial_materials;
-- DROP POLICY IF EXISTS spatial_materials_select                ON public.spatial_materials;
--
-- DROP POLICY IF EXISTS spatial_node_links_service_role_all     ON public.spatial_node_links;
-- DROP POLICY IF EXISTS spatial_node_links_select               ON public.spatial_node_links;
-- DROP POLICY IF EXISTS spatial_node_links_insert               ON public.spatial_node_links;
--
-- DROP POLICY IF EXISTS dispute_spatial_evidence_service_role_all  ON public.dispute_spatial_evidence;
-- DROP POLICY IF EXISTS dispute_spatial_evidence_select            ON public.dispute_spatial_evidence;
-- DROP POLICY IF EXISTS dispute_spatial_evidence_insert_deny       ON public.dispute_spatial_evidence;
--
-- DROP POLICY IF EXISTS spatial_change_orders_service_role_all  ON public.spatial_change_orders;
-- DROP POLICY IF EXISTS spatial_change_orders_select            ON public.spatial_change_orders;
-- DROP POLICY IF EXISTS spatial_change_orders_insert            ON public.spatial_change_orders;
-- DROP POLICY IF EXISTS spatial_change_orders_update            ON public.spatial_change_orders;
--
-- REVOKE EXECUTE ON FUNCTION public.spatial_can_view_scene(uuid, uuid) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.spatial_can_view_scene(uuid, uuid);
