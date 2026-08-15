-- Spatial Canonical · Szenen-Produktion · B7 · Versioning-Linkage (Phase D2)
--
-- Purpose:
--   Closes the D2 versioning gap. After B1-B5 a scan can be promoted to a
--   scene end-to-end, but the schema cannot express "scene B replaces scene
--   A" — `spatial_scenes` has no `parent_scene_id`, and `spatial_rescan_
--   requests` has no `resulting_scene_id`. Without that linkage the customer
--   re-capture flow (B8) cannot tie an accepted request to its follow-up
--   scene, and the provider cannot diff parent ↔ child in JobSpatialCompareTab.
--
-- What this migration does:
--   1. Adds `spatial_scenes.parent_scene_id` (self-FK, ON DELETE SET NULL).
--   2. Adds `spatial_rescan_requests.resulting_scene_id` (FK → spatial_scenes,
--      ON DELETE SET NULL).
--   3. Extends `spatial_scenes_immutable_cols_guard` so `parent_scene_id` is
--      append-only once a child scene exists (matches the immutability stance
--      of source_scan_id / source_job_id — version linkage is intrinsic).
--   4. Replaces `spatial_create_scene` with a 14-param signature: two new
--      tail-defaulted params `p_parent_scene_id` + `p_rescan_request_id`,
--      every existing 12-param caller stays compatible (PostgREST resolves
--      RPCs by NAMED args; missing params default to NULL).
--   5. When `p_rescan_request_id` is set, the RPC enforces:
--      - request exists + status = 'accepted' (no in-flight or rejected
--        requests can spawn scenes),
--      - caller is the parent scene's customer (matches the
--        `spatial_rescan_request_respond` customer-only contract),
--      - idempotent: a request that already has a `resulting_scene_id`
--        short-circuits and returns the existing linked scene,
--      - server-side derivation of `p_parent_scene_id` from the request's
--        own `scene_id` when omitted (and rejects a mismatch when supplied).
--   6. When only `p_parent_scene_id` is set (no rescan_request), the caller
--      must hold view-rights on the parent (`spatial_can_view_scene`) — a
--      thinner guard for non-rescan version chains (e.g. worker self-rescan
--      without a customer-issued request).
--   7. Post-insert: when `p_rescan_request_id` is set, the new scene's id is
--      written onto the request's `resulting_scene_id` in the same TX —
--      atomic re-scan → scene linkage.
--
-- Architecture decisions reused (binding):
--   AD-1 native getCanonicalScene authoritative (B3, unchanged).
--   AD-2 SECURITY DEFINER RPC, no edge function (B1, extended here).
--   AD-3 voll: core → re-scan (D2 happens here) → worker-walk (D3).
--
-- Append-only convention:
--   The B1 RPC (migration 20260522120053) defined a 12-param signature. We
--   DROP that overload and `CREATE OR REPLACE` the function with the 14-param
--   signature. PostgREST identifies RPCs by named parameters, so existing
--   callers passing 12 args remain valid (the two new params default to
--   NULL). The previous RPC body's invariants (auth/origin/scan-or-job
--   guard/idempotency/customer+provider derivation) are preserved verbatim.
--
-- Schema facts verified read-only against prod (itdntawwuzqfwmcwnwjr · 2026-05-22):
--   - spatial_scenes lacks `parent_scene_id` (added here).
--   - spatial_rescan_requests lacks `resulting_scene_id` (added here).
--   - The only INSERT path that needs to be aware of the new columns is the
--     `spatial_create_scene` RPC; the `spatial_scenes_insert WITH CHECK
--     (false)` policy stays unchanged.
--   - spatial_scenes_aaa_immutable_cols_guard currently locks
--     id/source_scan_id/source_job_id/created_at — extended here.
--   - The dispute-lock guard fires on UPDATE — irrelevant for INSERT-only
--     paths used by this RPC, but `resulting_scene_id` writes on
--     spatial_rescan_requests use SECURITY DEFINER, bypassing RLS.
--
-- External steps:
--   1. Supabase Dashboard → Settings → API → Reload schema cache
--      (required so PostgREST exposes the 14-param overload + new columns).
--   No env vars, no edge-function deploy, no webhook changes.
--
-- Plan reference: ~/.claude/plans/spatial-scene-production-post-d1-handover.md §5
--                 ~/.claude/plans/spatial-v1-scene-production-plan.md (B7)


-- ── 1. spatial_scenes.parent_scene_id ────────────────────────────────────────
-- ON DELETE SET NULL: deleting a parent should not cascade-delete the child
-- scenes that referenced it. The version chain breaks gracefully (child
-- carries no parent), and the audit trail in spatial_edit_history is
-- unaffected. The column is nullable — V1 has root scenes (no parent).

ALTER TABLE public.spatial_scenes
  ADD COLUMN IF NOT EXISTS parent_scene_id uuid
    REFERENCES public.spatial_scenes(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.spatial_scenes.parent_scene_id IS
  'Spatial D2 (B7): the predecessor scene this one supersedes. NULL for root '
  'scenes (initial customer/provider capture). Set when the scene was produced '
  'as a re-scan response (via spatial_create_scene with p_parent_scene_id). '
  'Immutable post-insert (spatial_scenes_immutable_cols_guard) — the version '
  'chain is intrinsic to the scene''s identity.';

-- Partial index — read-side queries always start from a known child to walk
-- backwards (or list a parent's children). Excluding NULLs keeps the index
-- tight (V1: root scenes outnumber re-scans).
CREATE INDEX IF NOT EXISTS spatial_scenes_parent_scene_id_idx
  ON public.spatial_scenes (parent_scene_id)
  WHERE parent_scene_id IS NOT NULL;

COMMENT ON INDEX public.spatial_scenes_parent_scene_id_idx IS
  'Spatial D2 (B7): partial index supporting parent → children lookups for '
  'JobSpatialRescanTab + JobSpatialCompareTab. WHERE-clause keeps root scenes '
  'out of the index.';


-- ── 2. spatial_rescan_requests.resulting_scene_id ────────────────────────────
-- The scene that fulfilled this re-scan request. SET NULL on delete keeps
-- the request row visible as a historical record even if the scene is
-- removed later (rare — scenes don't auto-delete in V1).

ALTER TABLE public.spatial_rescan_requests
  ADD COLUMN IF NOT EXISTS resulting_scene_id uuid
    REFERENCES public.spatial_scenes(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.spatial_rescan_requests.resulting_scene_id IS
  'Spatial D2 (B7): the scene produced when the customer accepted this re-'
  'scan request and re-captured. NULL until the new scene exists. Written '
  'atomically by spatial_create_scene in the same TX that inserts the scene '
  '(SECURITY DEFINER bypasses the table''s default-deny UPDATE policy).';

-- Partial index — supports "did this request produce a scene yet?" lookups
-- from the Hub Activity-Feed + the rescan-completion UI badge.
CREATE INDEX IF NOT EXISTS spatial_rescan_requests_resulting_scene_id_idx
  ON public.spatial_rescan_requests (resulting_scene_id)
  WHERE resulting_scene_id IS NOT NULL;

COMMENT ON INDEX public.spatial_rescan_requests_resulting_scene_id_idx IS
  'Spatial D2 (B7): partial index supporting request → resulting-scene '
  'lookups in the Hub Activity-Feed and rescan-completion badges.';


-- ── 3. Extend the immutable-cols guard with parent_scene_id ──────────────────
-- parent_scene_id is set exactly once (at INSERT, by the RPC) and never
-- moves — the same semantics as source_scan_id / source_job_id. Locking it
-- in the trigger prevents post-hoc rewriting of the version chain, which
-- would silently invalidate JobSpatialCompareTab diffs.

CREATE OR REPLACE FUNCTION public.spatial_scenes_immutable_cols_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  IF (NEW.source_scan_id IS DISTINCT FROM OLD.source_scan_id) THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.source_scan_id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  IF (NEW.source_job_id IS DISTINCT FROM OLD.source_job_id) THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.source_job_id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  IF (NEW.parent_scene_id IS DISTINCT FROM OLD.parent_scene_id) THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.parent_scene_id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.created_at is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.spatial_scenes_immutable_cols_guard() IS
  'BEFORE UPDATE guard on spatial_scenes: id / source_scan_id / source_job_id '
  '/ parent_scene_id / created_at are append-only. Re-entrant trigger depth '
  '> 1 is exempt (allows SECURITY DEFINER helpers to back-fill on insert).';


-- ── 4. Replace spatial_create_scene with the 14-param signature ──────────────
-- DROP + CREATE OR REPLACE — the previous 12-param overload is fully
-- replaced. Every existing call-site (the SupabaseSpatialSceneRepository
-- + B4 promoteScanToScene workflow) passes its args by name, so the two
-- new params (p_parent_scene_id, p_rescan_request_id) default to NULL and
-- the old behaviour is preserved bit-for-bit when neither is supplied.

DROP FUNCTION IF EXISTS public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb
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

  -- 4. Re-scan-request linkage (D2 · B7).
  --    When the caller supplies p_rescan_request_id, the request must (a) be
  --    accepted, (b) not already have a resulting scene (idempotent return),
  --    and (c) match the parent_scene_id if one was supplied. The lock is
  --    held FOR UPDATE so two concurrent re-captures of the same request
  --    serialise — the loser sees the resulting_scene_id of the winner and
  --    returns it.
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
      -- Idempotent — request already produced a scene. Return that scene
      -- regardless of which scan_id the caller passed (the resulting scene
      -- is canonical for the request).
      SELECT *
        INTO v_scene
        FROM public.spatial_scenes
        WHERE id = v_req_resulting;
      IF FOUND THEN
        RETURN v_scene;
      END IF;
      -- A SET NULL cascade could have nulled this — fall through and create
      -- a fresh resulting scene; the linkage will be re-written below.
    END IF;

    IF v_req_status <> 'accepted' THEN
      RAISE EXCEPTION
        'spatial_create_scene: rescan_request status must be accepted (got %)',
        v_req_status
        USING ERRCODE = '22023';
    END IF;

    -- Derive / validate the parent_scene_id from the request.
    IF v_effective_parent IS NULL THEN
      v_effective_parent := v_req_scene_id;
    ELSIF v_effective_parent IS DISTINCT FROM v_req_scene_id THEN
      RAISE EXCEPTION
        'spatial_create_scene: parent_scene_id must match rescan_request.scene_id'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 5. Idempotency pre-check: one scan → one scene. A second promotion of the
  --    same scan returns the existing row instead of creating a duplicate.
  --    Runs AFTER the rescan-request idempotency so the request-linked scene
  --    wins when both paths would resolve.
  IF p_source_scan_id IS NOT NULL THEN
    SELECT * INTO v_scene
      FROM public.spatial_scenes
      WHERE source_scan_id = p_source_scan_id;
    IF FOUND THEN
      RETURN v_scene;
    END IF;
  END IF;

  -- 6. Resolve the effective job: an explicit p_source_job_id, otherwise the
  --    job the scan is linked to. Used for ownership + provider derivation.
  v_effective_job_id := p_source_job_id;
  IF v_effective_job_id IS NULL AND p_source_scan_id IS NOT NULL THEN
    SELECT s.job_id INTO v_effective_job_id
      FROM public.scans s
      WHERE s.id = p_source_scan_id;
  END IF;

  -- 7. Parent-scene authorization (D2 · B7).
  --    Rescan-request path → caller MUST be the parent scene's customer
  --      (matches spatial_rescan_request_respond's customer-only contract).
  --    Plain parent path (no request) → caller must hold view-rights on the
  --      parent (operator | customer | provider-org member).
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

  -- 8. Scan / job ownership guard (unchanged from B1).
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

  -- 10. Derive provider ownership from the job (the only well-typed FK to
  --     `providers`). provider_org_id IS a providers.id; spatial_scenes.
  --     provider_id is an auth user → resolved via providers.profile_id.
  --     No job → provider stays NULL (a valid customer-owned scene).
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

  -- 11. Insert. ON CONFLICT closes the race between two concurrent promotions
  --     of the same scan (the partial-index predicate must match exactly).
  --     spatial_scenes_fill_provider_org_trg respects the explicit
  --     provider_org_id; it only re-derives when that column is NULL.
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

  -- 12. ON CONFLICT DO NOTHING yields no row when a concurrent call won the
  --     race; re-read the winning scene so the caller always gets a row.
  IF v_scene.id IS NULL THEN
    SELECT * INTO v_scene
      FROM public.spatial_scenes
      WHERE source_scan_id = p_source_scan_id;
  END IF;

  -- 13. Atomically link the new scene back to the rescan_request (D2 · B7).
  --     SECURITY DEFINER bypasses the request table's default-deny UPDATE
  --     policy. updated_at is bumped server-side. Idempotent — a concurrent
  --     racer would have hit step 4's resulting-scene short-circuit.
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
  'Spatial Canonical B1+B7: the canonical scene-INSERT path (AD-2). SECURITY '
  'DEFINER RPC that bypasses the spatial_scenes_insert WITH CHECK (false) '
  'policy. Ownership-guarded (spatial_can_convert_scan for scan-origin; job '
  'customer / provider-org for job-origin; customer-of-parent for rescan-'
  'request linkage; spatial_can_view_scene for plain parent linkage). '
  'Idempotent per source_scan_id AND per rescan_request_id (returns the '
  'existing scene). Derives customer_id / provider_id / provider_org_id from '
  'the scan/job context server-side. p_validation_report is folded into '
  'metadata.validation_report (no dedicated column). When p_rescan_request_id '
  'is set, the new scene id is written onto resulting_scene_id atomically.';

-- Default PUBLIC EXECUTE is stripped; only authenticated callers (and the
-- service_role) may run it. anon stays locked out.
REVOKE EXECUTE ON FUNCTION public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb, uuid, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb, uuid, uuid
) TO authenticated, service_role;


-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.spatial_create_scene(
--   uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb, uuid, uuid);
-- -- Restore the 12-param B1 signature (copy body from 20260522120053).
--
-- -- Restore the pre-B7 immutable-cols guard (drop parent_scene_id branch):
-- CREATE OR REPLACE FUNCTION public.spatial_scenes_immutable_cols_guard()
-- RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$ ... $$;
--
-- DROP INDEX IF EXISTS public.spatial_rescan_requests_resulting_scene_id_idx;
-- DROP INDEX IF EXISTS public.spatial_scenes_parent_scene_id_idx;
-- ALTER TABLE public.spatial_rescan_requests DROP COLUMN IF EXISTS resulting_scene_id;
-- ALTER TABLE public.spatial_scenes DROP COLUMN IF EXISTS parent_scene_id;
