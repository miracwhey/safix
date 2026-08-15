-- Spatial V1.5 · Lane-1 Hotfix · RLS Helper + RPC presales-aware + polygon_outline
--
-- Purpose:
--   V1.5 (PR #934) introduced `scans.presales_project_id` as a third
--   ownership-anchor next to `scans.project_id` and `scans.job_id`. The
--   `scans_insert` policy was extended to recognise it, but the three RLS
--   helpers (`spatial_can_edit_scan`, `spatial_can_view_scan`,
--   `spatial_can_convert_scan`) and the canonical `spatial_create_scene`
--   RPC were not — they still resolve ownership only through project +
--   job. That mismatch breaks the full Provider-Pre-Sales-Spatial save
--   path: the first scan inserts fine (status='capturing', captured_by-
--   path), upload succeeds, but `finishCapture` (`scans.status=captured`)
--   re-evaluates `spatial_can_edit_scan` against the NEW row and the
--   only matching predicate (`captured_by = uid AND status IN
--   ('draft','capturing')`) no longer holds. PostgREST surfaces ERRCODE
--   42501. The archive-recovery in `captureScan.ts` hits the same wall
--   and is silently swallowed → orphan scan, no scene, no 3D in UI.
--
--   This migration closes the four presales-awareness gaps in a single
--   atomic deploy. It also adds `spatial_scenes.polygon_outline` for
--   the Stream-C iOS-Hebel E4 (per-wall world-space polygon corners from
--   Surface.polygonCorners on iOS 17+) so the canonical schema is ready
--   when the iOS plugin patch lands.
--
-- What this migration does:
--   1. K-1 · spatial_can_edit_scan: add presales-anchor branch, no
--      status-gate (org-binding is immutable, unlike captured_by which
--      can drift cross-tenant after reassignment).
--   2. K-2 · spatial_can_view_scan: same presales-anchor branch, no
--      status-gate.
--   3. K-3 · spatial_create_scene: derive `provider_org_id` /
--      `provider_id` from the presales-project when no job is linked.
--      Authorization still flows through `spatial_can_convert_scan`
--      (K-5 makes that presales-aware in the same migration).
--   4. K-5 · spatial_can_convert_scan: add presales-anchor branch with
--      the same archived/locked status-gate as the existing paths.
--      Future-trap closer: today no caller depends on this for presales,
--      but K-3's RPC will route through it after deploy.
--   5. E4 · spatial_scenes.polygon_outline: jsonb column for per-wall
--      polygon outlines (world-space, shape `{ wall_id: [[x,y,z], ...] }`).
--      NULL = renderer falls back to bbox approximation. NOT added to
--      the spatial_scenes_immutable_cols_guard — backfill from canonical
--      reconvert must remain possible.
--
-- Why everything in ONE migration:
--   - K-1 alone leaves K-3 broken (RPC still inserts NULL-ownership scene)
--   - K-3 alone needs K-5 to authorize (or it duplicates auth logic)
--   - Splitting would leave the save-path half-broken between deploys.
--
-- Schema facts verified read-only against prod (itdntawwuzqfwmcwnwjr ·
-- 2026-05-24):
--   - All four function signatures match the repo (4-arg helpers /
--     14-arg RPC).
--   - spatial_scenes columns confirmed: no polygon_outline; 22 columns
--     incl. parent_scene_id (B7), provider_org_id.
--   - scans_owner_anchor_chk already covers presales (V1.5 migration
--     20260523181530).
--   - Orphan count `status='capturing' AND presales_project_id IS NOT
--     NULL AND created_at < now() - interval '1 hour'` = 0 — no
--     post-deploy cleanup needed.
--
-- RLS pattern safety:
--   Every cross-row predicate in the presales branches qualifies the
--   column with the table alias (`pp.provider_org_id`) to avoid the
--   unqualified-column trap (where Postgres resolves the bare column to
--   the EXISTS subquery target, collapsing the cross-row guard to a
--   tautology). See feedback memory `rls_subquery_unqualified_column`.
--
-- Privileges:
--   CREATE OR REPLACE FUNCTION preserves existing GRANTs (set in
--   20260518000003 and 20260518000073). No re-GRANT needed.
--
-- External steps after apply:
--   - Run `supabase gen types` to regenerate TS types (spatial_scenes
--     now includes polygon_outline).
--   - Stream B (JS-Hotfix) can deploy after this migration is live —
--     promotion will succeed for presales scans end-to-end.
--   - Stream C (iOS plugin) consumes polygon_outline; can deploy
--     independently once Capacitor-Sync ready.
--
-- Plan reference:
--   ~/.claude/plans/spatial-lane1-hotfix-master-plan.md §3
--   FixUp/06 Decisions/2026-05-24 Spatial Radical Audit/12 Lane 1 Master Plan.md


-- ── 1. K-1 · spatial_can_edit_scan presales-aware ────────────────────────────
-- Adds the presales-org-member branch. NO status-gate on the presales
-- path: provider_presales_projects.provider_org_id is FK-CASCADE-bound
-- to providers.id and never moves, so the org-membership check is
-- immutable. (The captured_by status-gate stays as-is — it protects
-- against the post-reassignment leak that exists in the customer-job
-- flow but not here.)

CREATE OR REPLACE FUNCTION public.spatial_can_edit_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects p ON p.id = s.project_id
      LEFT JOIN public.provider_presales_projects pp ON pp.id = s.presales_project_id
      WHERE s.id = p_scan_id
        AND (
          -- Project owner: always
          p.customer_user_id = p_uid
          -- Captured-by: only during the active capture phase
          OR (s.captured_by = p_uid AND s.status IN ('draft', 'capturing'))
          -- V1.5 presales-anchor → any active member of the owning provider-org;
          -- no status-gate (org-binding immutable).
          OR (
            pp.provider_org_id IS NOT NULL
            AND pp.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
        )
    );
$$;

COMMENT ON FUNCTION public.spatial_can_edit_scan(uuid, uuid) IS
  'Spatial Core RLS helper: full edit-access (operator / customer / '
  'captured_by during draft|capturing / V1.5 presales-org-member). '
  'Narrower per-table policies for craftsman/worker.';


-- ── 2. K-2 · spatial_can_view_scan presales-aware ────────────────────────────
-- Mirrors K-1 — same presales-org-member branch, same no-status-gate
-- rationale. Preserves the existing job_assignments-via-team_members
-- worker path (verified read-only against prod 2026-05-24).

CREATE OR REPLACE FUNCTION public.spatial_can_view_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects p ON p.id = s.project_id
      LEFT JOIN public.jobs     j ON j.id = s.job_id
      LEFT JOIN public.provider_presales_projects pp ON pp.id = s.presales_project_id
      WHERE s.id = p_scan_id
        AND (
          p.customer_user_id = p_uid
          OR j.craftsman_user_id = p_uid::text
          OR j.customer_user_id  = p_uid
          OR EXISTS (
            SELECT 1
            FROM public.job_assignments ja
            JOIN public.team_members    tm ON tm.id = ja.team_member_id
            WHERE ja.job_id        = s.job_id
              AND tm.profile_id    = p_uid
              AND tm.is_active     = true
              AND ja.status        IN ('assigned', 'accepted', 'active', 'in_progress', 'completed')
          )
          -- Captured-by: only during the active capture phase. After capture
          -- finishes, view-access continues via role-based paths above.
          -- Prevents post-reassignment cross-tenant leak.
          OR (s.captured_by = p_uid AND s.status IN ('draft', 'capturing'))
          -- V1.5 presales-anchor → any active member of the owning provider-org;
          -- no status-gate (org-binding immutable).
          OR (
            pp.provider_org_id IS NOT NULL
            AND pp.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
        )
    );
$$;

COMMENT ON FUNCTION public.spatial_can_view_scan(uuid, uuid) IS
  'Spatial Core RLS helper: union view-access (operator / customer / '
  'craftsman / worker via team_members+job_assignments / captured_by '
  'during draft|capturing / V1.5 presales-org-member).';


-- ── 3. K-5 · spatial_can_convert_scan presales-aware ─────────────────────────
-- Same archived/locked status-gate as the existing paths, but the
-- positive predicate accepts the presales-org-member as a valid
-- convert-trigger principal. K-3 (the spatial_create_scene RPC) relies
-- on this to authorize presales scenes without duplicating helper logic.

CREATE OR REPLACE FUNCTION public.spatial_can_convert_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects p ON p.id = s.project_id
      LEFT JOIN public.provider_presales_projects pp ON pp.id = s.presales_project_id
      WHERE s.id = p_scan_id
        AND s.status <> 'archived'
        AND s.status <> 'locked_for_dispute'
        AND (
          p.customer_user_id = p_uid
          OR s.captured_by   = p_uid
          -- V1.5 presales-anchor → any active member of the owning provider-org.
          -- Same archived/locked gate applies (already filtered above), so
          -- presales paths can't convert orphans either.
          OR (
            pp.provider_org_id IS NOT NULL
            AND pp.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
        )
    );
$$;

COMMENT ON FUNCTION public.spatial_can_convert_scan(uuid, uuid) IS
  'P0 review fix + V1.5 hotfix — convert-permission helper. Wider than '
  'spatial_can_edit_scan: captured_by + presales-org-member retain '
  'convert-trigger access through captured/quality_checked/etc, but '
  'lose it on archived + locked_for_dispute.';


-- ── 4. E4 · spatial_scenes.polygon_outline column ────────────────────────────
-- Per-wall world-space polygon corners from Surface.polygonCorners
-- (iOS 17+, transformed to world via `simd_mul(surface.transform,
-- float4(corner, 1))` in the iOS plugin). Shape:
--   { wall_id: [[x, y, z], [x, y, z], ...] }
-- NULL = renderer falls back to bbox approximation (today's behaviour
-- for L-/U-/Erker-walls). Lane-2 renderer-side wires consumption.
--
-- Not added to spatial_scenes_immutable_cols_guard: backfilling from a
-- canonical reconvert must remain possible (no other column carries
-- this data; if we lock it on insert, a future iOS-mapping fix can't
-- update existing scenes).

ALTER TABLE public.spatial_scenes
  ADD COLUMN IF NOT EXISTS polygon_outline jsonb;

COMMENT ON COLUMN public.spatial_scenes.polygon_outline IS
  'V1.5 Hotfix E4: per-wall world-space polygon corners from '
  'Surface.polygonCorners (iOS 17+ only). Shape: { wall_id: [[x,y,z], '
  '...] }. NULL = renderer falls back to bbox approximation. Mutable '
  '(not in immutable-cols-guard) so canonical reconverts can backfill.';

-- Partial-index — keeps the index tight (most pre-E4 scenes have NULL).
-- Supports future Lane-2/Lane-3 queries that filter for outline-enriched
-- scenes (e.g. measurement-line rendering eligibility checks).
CREATE INDEX IF NOT EXISTS spatial_scenes_polygon_outline_present_idx
  ON public.spatial_scenes ((polygon_outline IS NOT NULL))
  WHERE polygon_outline IS NOT NULL;

COMMENT ON INDEX public.spatial_scenes_polygon_outline_present_idx IS
  'V1.5 Hotfix E4: partial index supporting "has polygon outline" '
  'filters for renderer-eligibility checks.';


-- ── 5. K-3 · spatial_create_scene presales-aware ─────────────────────────────
-- Replaces the 14-param RPC. Only two paths change vs. the B7 baseline:
--
--   (a) Provider-org derivation in step 10 — when no effective job exists
--       but the source scan carries a presales_project_id, derive
--       provider_org_id from provider_presales_projects.provider_org_id.
--       v_provider_user_id is still resolved via providers.profile_id
--       (the org's owner profile), matching the job-origin convention.
--
--   (b) Authorization in step 8 — unchanged. spatial_can_convert_scan
--       is now presales-aware (K-5 above), so the existing call site
--       handles presales scans without further branching.
--
-- Customer derivation (step 9) stays as-is: presales has no customer →
-- v_customer_id remains NULL, which the customer_id NULLable column
-- accepts (matches the "provider-owned scene without customer" state).
--
-- All other steps (auth required, required-inputs, origin-chk, rescan-
-- request linkage, parent authorization, idempotency, insert, ON CONFLICT,
-- post-insert rescan-request linkage) are preserved bit-for-bit from B7.
-- The DROP/CREATE strategy mirrors B7 (PostgREST identifies by NAMED
-- args; the 14-param signature is unchanged).

DROP FUNCTION IF EXISTS public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb, uuid, uuid
);

CREATE OR REPLACE FUNCTION public.spatial_create_scene(
  p_id                         uuid,
  p_parametric_storage_path    text,
  p_parametric_sha256          text    DEFAULT NULL,
  p_parametric_size_bytes      integer DEFAULT NULL,
  p_source_scan_id             uuid    DEFAULT NULL,
  p_source_job_id              uuid    DEFAULT NULL,
  p_schema_version             text    DEFAULT '1.0',
  p_validation_state           text    DEFAULT 'pending',
  p_validation_report          jsonb   DEFAULT '{}'::jsonb,
  p_is_renderable              boolean DEFAULT false,
  p_requires_user_confirmation boolean DEFAULT false,
  p_metadata                   jsonb   DEFAULT '{}'::jsonb,
  p_parent_scene_id            uuid    DEFAULT NULL,
  p_rescan_request_id          uuid    DEFAULT NULL
)
RETURNS public.spatial_scenes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_scene            public.spatial_scenes;
  v_effective_job_id uuid;
  v_customer_id      uuid;
  v_provider_org_id  uuid;
  v_provider_user_id uuid;
  v_authorized       boolean := false;
  v_req_status       text;
  v_req_scene_id     uuid;
  v_req_resulting    uuid;
  v_parent_customer  uuid;
  v_effective_parent uuid := p_parent_scene_id;
BEGIN
  -- 1. Must be authenticated.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_create_scene: authentication required'
      USING ERRCODE = '28000';
  END IF;

  -- 2. Required inputs.
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'spatial_create_scene: p_id is required (client-generated scene uuid)'
      USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_parametric_storage_path, '') = '' THEN
    RAISE EXCEPTION 'spatial_create_scene: p_parametric_storage_path is required'
      USING ERRCODE = '22023';
  END IF;

  -- 3. Origin check (mirrors the spatial_scenes_origin_chk constraint):
  --    at least one of source_scan_id / source_job_id must be set.
  IF p_source_scan_id IS NULL AND p_source_job_id IS NULL THEN
    RAISE EXCEPTION
      'spatial_create_scene: source_scan_id OR source_job_id required (R4)'
      USING ERRCODE = '22023';
  END IF;

  -- 4. Re-scan-request linkage (D2 · B7) — unchanged.
  IF p_rescan_request_id IS NOT NULL THEN
    SELECT r.status, r.scene_id, r.resulting_scene_id
      INTO v_req_status, v_req_scene_id, v_req_resulting
      FROM public.spatial_rescan_requests r
      WHERE r.id = p_rescan_request_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'spatial_create_scene: rescan_request % not found', p_rescan_request_id
        USING ERRCODE = '22023';
    END IF;

    IF v_req_resulting IS NOT NULL THEN
      SELECT *
        INTO v_scene
        FROM public.spatial_scenes
        WHERE id = v_req_resulting;
      IF FOUND THEN
        RETURN v_scene;
      END IF;
    END IF;

    IF v_req_status <> 'accepted' THEN
      RAISE EXCEPTION
        'spatial_create_scene: rescan_request status must be accepted (got %)',
        v_req_status
        USING ERRCODE = '22023';
    END IF;

    IF v_effective_parent IS NULL THEN
      v_effective_parent := v_req_scene_id;
    ELSIF v_effective_parent IS DISTINCT FROM v_req_scene_id THEN
      RAISE EXCEPTION
        'spatial_create_scene: parent_scene_id must match rescan_request.scene_id'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 5. Idempotency pre-check — unchanged.
  IF p_source_scan_id IS NOT NULL THEN
    SELECT * INTO v_scene
      FROM public.spatial_scenes
      WHERE source_scan_id = p_source_scan_id;
    IF FOUND THEN
      RETURN v_scene;
    END IF;
  END IF;

  -- 6. Resolve the effective job — unchanged.
  v_effective_job_id := p_source_job_id;
  IF v_effective_job_id IS NULL AND p_source_scan_id IS NOT NULL THEN
    SELECT s.job_id INTO v_effective_job_id
      FROM public.scans s
      WHERE s.id = p_source_scan_id;
  END IF;

  -- 7. Parent-scene authorization — unchanged.
  IF v_effective_parent IS NOT NULL THEN
    IF p_rescan_request_id IS NOT NULL THEN
      SELECT s.customer_id
        INTO v_parent_customer
        FROM public.spatial_scenes s
        WHERE s.id = v_effective_parent;
      IF v_parent_customer IS NULL THEN
        RAISE EXCEPTION
          'spatial_create_scene: parent scene % not found', v_effective_parent
          USING ERRCODE = '22023';
      END IF;
      IF v_parent_customer IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION
          'spatial_create_scene: caller % is not the customer of parent scene %',
          v_uid, v_effective_parent
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NOT public.spatial_can_view_scene(v_effective_parent, v_uid) THEN
        RAISE EXCEPTION
          'spatial_create_scene: caller % cannot view parent scene %',
          v_uid, v_effective_parent
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- 8. Scan / job ownership guard — unchanged.
  --    spatial_can_convert_scan is presales-aware (K-5 in this migration),
  --    so the existing call site handles presales scans automatically.
  IF p_source_scan_id IS NOT NULL THEN
    v_authorized := public.spatial_can_convert_scan(p_source_scan_id, v_uid);
  ELSE
    SELECT (
        public.spatial_is_operator(v_uid)
        OR j.customer_user_id = v_uid
        OR (j.provider_id IS NOT NULL
            AND j.provider_id = public.spatial_user_provider_org(v_uid))
        OR (j.assigned_provider_id IS NOT NULL
            AND j.assigned_provider_id = public.spatial_user_provider_org(v_uid))
      )
      INTO v_authorized
      FROM public.jobs j
      WHERE j.id = p_source_job_id;
  END IF;

  IF v_authorized IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'spatial_create_scene: caller % is not authorized for this scan/job', v_uid
      USING ERRCODE = '42501';
  END IF;

  -- 9. Derive customer ownership.
  --    scan-origin → the project's customer; fall back to the job's customer.
  --    Presales-anchor → no customer (v_customer_id stays NULL by design).
  IF p_source_scan_id IS NOT NULL THEN
    SELECT pr.customer_user_id
      INTO v_customer_id
      FROM public.scans s
      LEFT JOIN public.projects pr ON pr.id = s.project_id
      WHERE s.id = p_source_scan_id;
  END IF;
  IF v_customer_id IS NULL AND v_effective_job_id IS NOT NULL THEN
    SELECT j.customer_user_id INTO v_customer_id
      FROM public.jobs j
      WHERE j.id = v_effective_job_id;
  END IF;

  -- 10. Derive provider ownership.
  --     job-origin → from jobs.provider_id / assigned_provider_id (existing).
  --     V1.5 presales-origin → from scans.presales_project_id →
  --       provider_presales_projects.provider_org_id when no job is linked.
  --     v_provider_user_id is always resolved via providers.profile_id
  --     (the org's owner profile), matching the job-origin convention so
  --     spatial_scenes.provider_id consistently points at an auth user.
  IF v_effective_job_id IS NOT NULL THEN
    SELECT coalesce(j.provider_id, j.assigned_provider_id)
      INTO v_provider_org_id
      FROM public.jobs j
      WHERE j.id = v_effective_job_id;
  ELSIF p_source_scan_id IS NOT NULL THEN
    -- V1.5 Hotfix K-3: presales-anchor fallback when no job_id exists.
    -- The join on s.presales_project_id is qualified to avoid the
    -- unqualified-column trap, and the IS NOT NULL guard short-circuits
    -- non-presales scans cleanly (LEFT JOIN to keep the row).
    SELECT pp.provider_org_id
      INTO v_provider_org_id
      FROM public.scans s
      LEFT JOIN public.provider_presales_projects pp
        ON pp.id = s.presales_project_id
      WHERE s.id = p_source_scan_id
        AND s.presales_project_id IS NOT NULL;
  END IF;

  IF v_provider_org_id IS NOT NULL THEN
    SELECT p.profile_id INTO v_provider_user_id
      FROM public.providers p
      WHERE p.id = v_provider_org_id;
  END IF;

  -- 11. Insert — unchanged.
  INSERT INTO public.spatial_scenes (
    id,
    source_scan_id,
    source_job_id,
    parent_scene_id,
    parametric_storage_path,
    parametric_size_bytes,
    parametric_sha256,
    schema_version,
    validation_state,
    is_renderable,
    requires_user_confirmation,
    customer_id,
    provider_id,
    provider_org_id,
    metadata
  )
  VALUES (
    p_id,
    p_source_scan_id,
    p_source_job_id,
    v_effective_parent,
    p_parametric_storage_path,
    p_parametric_size_bytes,
    p_parametric_sha256,
    coalesce(p_schema_version, '1.0'),
    coalesce(p_validation_state, 'pending'),
    coalesce(p_is_renderable, false),
    coalesce(p_requires_user_confirmation, false),
    v_customer_id,
    v_provider_user_id,
    v_provider_org_id,
    coalesce(p_metadata, '{}'::jsonb)
      || CASE
           WHEN p_validation_report IS NOT NULL
             AND p_validation_report <> '{}'::jsonb
           THEN jsonb_build_object('validation_report', p_validation_report)
           ELSE '{}'::jsonb
         END
  )
  ON CONFLICT (source_scan_id) WHERE source_scan_id IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_scene;

  -- 12. ON CONFLICT DO NOTHING handling — unchanged.
  IF v_scene.id IS NULL THEN
    SELECT * INTO v_scene
      FROM public.spatial_scenes
      WHERE source_scan_id = p_source_scan_id;
  END IF;

  -- 13. Rescan-request linkage — unchanged.
  IF p_rescan_request_id IS NOT NULL AND v_scene.id IS NOT NULL THEN
    UPDATE public.spatial_rescan_requests
       SET resulting_scene_id = v_scene.id,
           updated_at         = now()
     WHERE id = p_rescan_request_id;
  END IF;

  RETURN v_scene;
END;
$$;

COMMENT ON FUNCTION public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb, uuid, uuid
) IS
  'Spatial Canonical B1+B7+V1.5-Hotfix: the canonical scene-INSERT path '
  '(AD-2). SECURITY DEFINER RPC. Ownership-guarded via '
  'spatial_can_convert_scan (presales-aware since V1.5 hotfix) for '
  'scan-origin; job customer / provider-org for job-origin; customer-of-'
  'parent for rescan-request linkage; spatial_can_view_scene for plain '
  'parent linkage. Idempotent per source_scan_id AND per '
  'rescan_request_id. Derives customer_id from project/job (NULL for '
  'presales); derives provider_org_id from job or presales_project; '
  'derives provider_id via providers.profile_id. validation_report is '
  'folded into metadata.validation_report (no dedicated column).';

-- GRANTs preserved by CREATE OR REPLACE (set in 20260522120054 B7).
-- Re-asserted defensively for idempotency.
REVOKE EXECUTE ON FUNCTION public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb, uuid, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb, uuid, uuid
) TO authenticated, service_role;


-- ── Rollback ─────────────────────────────────────────────────────────────────
-- Restore the four functions from their pre-V1.5-hotfix bodies:
--   spatial_can_edit_scan     → 20260518000003 :82-102
--   spatial_can_view_scan     → 20260518000072 :100-133
--   spatial_can_convert_scan  → 20260518000073 :13-33
--   spatial_create_scene      → 20260522120054 :183-470 (drop+recreate the
--                                                       14-param signature
--                                                       without the K-3 patch)
--
-- Drop the polygon_outline column (additive, safe to revert):
--   DROP INDEX IF EXISTS public.spatial_scenes_polygon_outline_present_idx;
--   ALTER TABLE public.spatial_scenes DROP COLUMN IF EXISTS polygon_outline;
