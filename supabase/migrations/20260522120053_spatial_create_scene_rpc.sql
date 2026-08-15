-- Spatial Canonical · Szenen-Produktion · B1 · RPC spatial_create_scene
--
-- Purpose:
--   Provides the single non-RLS-blocked, transactional INSERT path for
--   `public.spatial_scenes`. Until this migration there was NO path that
--   turned a scan into a `spatial_scenes` row — the `spatial_scenes_insert`
--   policy is `WITH CHECK (false)` (service_role only), and no edge function
--   or RPC ever performed the insert. Result: 0 scenes in prod, the whole
--   canonical pipeline never ran end-to-end (Ship-Blocker §4).
--
--   This SECURITY DEFINER RPC closes that gap. The client generates the
--   scene id (so the Storage path can embed it before the row exists),
--   uploads the parametric blob, then calls this RPC to create the header
--   row atomically — ownership-checked, idempotent per source scan.
--
-- Architecture decision AD-2 (FINAL 2026-05-22):
--   A SECURITY DEFINER RPC — NOT an edge function. Rationale: transactional
--   atomicity, schema-coupled, no deploy lifecycle, no secret, synchronous.
--
-- Supersedes stale references:
--   Earlier migrations describe a "convert-scan edge function" as the
--   service-role insert path:
--     - 20260520120010_spatial_canonical_rls.sql  (lines 19, 97)
--     - 20260520120046_spatial_multi_tenant.sql    (line 29)
--   That edge function was never built. The append-only convention forbids
--   editing those files; this comment records that `spatial_create_scene`
--   is the actual, shipped scene-INSERT path. The `spatial_scenes_insert`
--   policy stays `WITH CHECK (false)` UNCHANGED — this RPC bypasses it via
--   SECURITY DEFINER, exactly as those comments anticipated for "server-side
--   RPCs".
--
-- Schema facts verified read-only against prod (itdntawwuzqfwmcwnwjr · 2026-05-22):
--   - spatial_scenes has NO `validation_report` column → the optional
--     validation report is folded into `metadata.validation_report`.
--   - jobs.provider_id / jobs.assigned_provider_id are FKs to `providers.id`
--     (the provider BUSINESS), NOT auth users. spatial_scenes.provider_id is
--     an auth user → derived via `providers.profile_id`; provider_org_id is
--     `jobs.provider_id` directly.
--   - projects.craftsman_user_id is unreliable (9/10 prod values are stale /
--     do not resolve to a provider) → provider is derived ONLY from a job.
--   - The only BEFORE INSERT trigger on spatial_scenes is
--     `spatial_scenes_fill_provider_org_trg`; no FSM trigger fires on INSERT,
--     so an explicit `validation_state` is accepted as-is (table CHECK gates it).
--
-- External steps:
--   1. Supabase Dashboard → Settings → API → Reload schema cache
--      (required so PostgREST exposes the new RPC at /rest/v1/rpc/).
--   No env vars, no edge-function deploy, no webhook changes.
--
-- Plan reference: ~/.claude/plans/spatial-v1-scene-production-plan.md §B1

-- ── 1. Idempotency · unique partial index on source_scan_id ──────────────────
-- One scan → exactly one scene. The B1 RPC relies on this index for its
-- `ON CONFLICT (source_scan_id)` arbiter. 20260520120001 shipped a NON-unique
-- index on the same column+predicate; it is fully superseded by this unique
-- index (a unique index serves equally as a lookup index) and is dropped to
-- avoid a redundant index maintained on every write. Safe: prod spatial_scenes
-- has 0 rows, so the uniqueness promotion cannot fail on existing data.

DROP INDEX IF EXISTS public.spatial_scenes_source_scan_id_idx;

CREATE UNIQUE INDEX IF NOT EXISTS spatial_scenes_source_scan_id_uidx
  ON public.spatial_scenes (source_scan_id)
  WHERE source_scan_id IS NOT NULL;

COMMENT ON INDEX public.spatial_scenes_source_scan_id_uidx IS
  'Idempotency guard for spatial_create_scene: one source scan maps to at most '
  'one scene. Partial (source_scan_id IS NOT NULL) so job-origin scenes are '
  'unconstrained. Replaces the non-unique spatial_scenes_source_scan_id_idx.';

-- ── 2. RPC · spatial_create_scene ────────────────────────────────────────────
--
-- SECURITY DEFINER so it can bypass the `spatial_scenes_insert WITH CHECK
-- (false)` policy. `auth.uid()` / `auth.role()` still reflect the CALLER
-- (the JWT GUC is unaffected by SECURITY DEFINER) — verified by the existing
-- `spatial_edit_history_append` RPC which uses the same pattern.
--
-- search_path is pinned to `public, pg_temp` (pg_temp last, so a malicious
-- temp object cannot shadow a public one) — mandatory for SECURITY DEFINER.
--
-- Ownership guard:
--   - scan-origin  → `spatial_can_convert_scan(scan, auth.uid())` (operator,
--                    project customer, or the capturing user).
--   - job-origin   → operator, the job's customer, or a member of the job's
--                    provider org (resolved via `spatial_user_provider_org`).
--
-- Idempotency: a pre-check returns an existing scene for the same scan; the
-- INSERT additionally uses `ON CONFLICT (source_scan_id) DO NOTHING` to close
-- the race between two concurrent calls, then re-reads the winning row.

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
  p_metadata                   jsonb   DEFAULT '{}'::jsonb
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

  -- 4. Idempotency pre-check: one scan → one scene. A second promotion of the
  --    same scan returns the existing row instead of creating a duplicate.
  IF p_source_scan_id IS NOT NULL THEN
    SELECT * INTO v_scene
      FROM public.spatial_scenes
      WHERE source_scan_id = p_source_scan_id;
    IF FOUND THEN
      RETURN v_scene;
    END IF;
  END IF;

  -- 5. Resolve the effective job: an explicit p_source_job_id, otherwise the
  --    job the scan is linked to. Used for ownership + provider derivation.
  v_effective_job_id := p_source_job_id;
  IF v_effective_job_id IS NULL AND p_source_scan_id IS NOT NULL THEN
    SELECT s.job_id INTO v_effective_job_id
      FROM public.scans s
      WHERE s.id = p_source_scan_id;
  END IF;

  -- 6. Ownership guard.
  IF p_source_scan_id IS NOT NULL THEN
    -- scan-origin: operator | project customer | capturing user.
    v_authorized := public.spatial_can_convert_scan(p_source_scan_id, v_uid);
  ELSE
    -- job-origin (no scan): operator | job customer | member of the job's
    -- provider org. Columns are table-qualified so the EXISTS-style check
    -- cannot collapse to a tautology (feedback_rls_subquery_unqualified_column).
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

  -- 7. Derive customer ownership.
  --    scan-origin → the project's customer; fall back to the job's customer.
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

  -- 8. Derive provider ownership from the job (the only well-typed FK to
  --    `providers`). provider_org_id IS a providers.id; spatial_scenes.
  --    provider_id is an auth user → resolved via providers.profile_id.
  --    No job → provider stays NULL (a valid customer-owned scene).
  IF v_effective_job_id IS NOT NULL THEN
    SELECT coalesce(j.provider_id, j.assigned_provider_id)
      INTO v_provider_org_id
      FROM public.jobs j
      WHERE j.id = v_effective_job_id;
    IF v_provider_org_id IS NOT NULL THEN
      SELECT p.profile_id INTO v_provider_user_id
        FROM public.providers p
        WHERE p.id = v_provider_org_id;
    END IF;
  END IF;

  -- 9. Insert. ON CONFLICT closes the race between two concurrent promotions
  --    of the same scan (the partial-index predicate must match exactly).
  --    spatial_scenes_fill_provider_org_trg respects the explicit
  --    provider_org_id; it only re-derives when that column is NULL.
  INSERT INTO public.spatial_scenes (
    id,
    source_scan_id,
    source_job_id,
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

  -- 10. ON CONFLICT DO NOTHING yields no row when a concurrent call won the
  --     race; re-read the winning scene so the caller always gets a row.
  IF v_scene.id IS NULL THEN
    SELECT * INTO v_scene
      FROM public.spatial_scenes
      WHERE source_scan_id = p_source_scan_id;
  END IF;

  RETURN v_scene;
END;
$$;

COMMENT ON FUNCTION public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb
) IS
  'Spatial Canonical B1: the canonical scene-INSERT path (AD-2). SECURITY '
  'DEFINER RPC that bypasses the spatial_scenes_insert WITH CHECK (false) '
  'policy. Ownership-guarded (spatial_can_convert_scan for scan-origin; job '
  'customer / provider-org for job-origin). Idempotent per source_scan_id '
  '(returns the existing scene). Derives customer_id / provider_id / '
  'provider_org_id from the scan/job context. p_validation_report is folded '
  'into metadata.validation_report (no dedicated column). Returns the scene row.';

-- Default PUBLIC EXECUTE is stripped; only authenticated callers (and the
-- service_role) may run it. anon stays locked out.
REVOKE EXECUTE ON FUNCTION public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb
) TO authenticated, service_role;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.spatial_create_scene(
--   uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb);
-- DROP INDEX IF EXISTS public.spatial_scenes_source_scan_id_uidx;
-- CREATE INDEX IF NOT EXISTS spatial_scenes_source_scan_id_idx
--   ON public.spatial_scenes(source_scan_id) WHERE source_scan_id IS NOT NULL;
