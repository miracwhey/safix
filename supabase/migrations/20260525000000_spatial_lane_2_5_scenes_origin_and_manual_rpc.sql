-- Lane-2.5 · Stream B · B0 — spatial_scenes.origin + spatial_create_manual_scene
--
-- Adds `origin` column to spatial_scenes ('roomplan' | 'manual' | 'example_room')
-- and relaxes the anchor-requirement so manual + example_room scenes can stand
-- without a source_scan_id / source_job_id. Introduces the
-- `spatial_create_manual_scene` RPC for client-driven manual aufmaße (the
-- "Vorlage 2×2 m" + "Leerer Raum" entry-points on the Privat-Tab empty-state).
--
-- Auth model for the new RPC: caller must be the presales-project's creator,
-- a member of the same provider_org, or an operator. There is no scan/job
-- to authorise against for manual scenes, so the presales-project anchor
-- carries the access guard.
--
-- Already applied to prod via MCP (apply_migration) — this file mirrors that
-- change into the repo so future env-rebuilds + local stacks stay in sync.

-- ── 1. Add `origin` column ────────────────────────────────────────────────
ALTER TABLE public.spatial_scenes
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'roomplan';

ALTER TABLE public.spatial_scenes
  DROP CONSTRAINT IF EXISTS spatial_scenes_origin_value_chk;

ALTER TABLE public.spatial_scenes
  ADD CONSTRAINT spatial_scenes_origin_value_chk
  CHECK (origin IN ('roomplan', 'manual', 'example_room'));

-- ── 2. Relax anchor-requirement (was: spatial_scenes_origin_chk) ──────────
ALTER TABLE public.spatial_scenes
  DROP CONSTRAINT IF EXISTS spatial_scenes_origin_chk;

ALTER TABLE public.spatial_scenes
  ADD CONSTRAINT spatial_scenes_anchor_chk
  CHECK (
    COALESCE(source_scan_id::text, '') <> ''
    OR COALESCE(source_job_id::text, '') <> ''
    OR origin IN ('manual', 'example_room')
  );

-- ── 3. Partial index for filtering ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_spatial_scenes_origin
  ON public.spatial_scenes (origin)
  WHERE origin <> 'roomplan';

-- ── 4. RPC: spatial_create_manual_scene ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.spatial_create_manual_scene(
  p_id uuid,
  p_presales_project_id uuid,
  p_parametric_storage_path text,
  p_parametric_sha256 text DEFAULT NULL,
  p_parametric_size_bytes integer DEFAULT NULL,
  p_origin text DEFAULT 'manual',
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_schema_version text DEFAULT '1.0'
)
RETURNS public.spatial_scenes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid              uuid := auth.uid();
  v_scene            public.spatial_scenes;
  v_provider_org_id  uuid;
  v_provider_user_id uuid;
  v_owner_user_id    uuid;
  v_authorized       boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_create_manual_scene: authentication required'
      USING ERRCODE = '28000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'spatial_create_manual_scene: p_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_presales_project_id IS NULL THEN
    RAISE EXCEPTION 'spatial_create_manual_scene: p_presales_project_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_parametric_storage_path, '') = '' THEN
    RAISE EXCEPTION 'spatial_create_manual_scene: p_parametric_storage_path is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_origin NOT IN ('manual', 'example_room') THEN
    RAISE EXCEPTION
      'spatial_create_manual_scene: origin must be manual or example_room (got %)',
      p_origin
      USING ERRCODE = '22023';
  END IF;

  SELECT pp.provider_org_id, pp.created_by_user_id
    INTO v_provider_org_id, v_owner_user_id
    FROM public.provider_presales_projects pp
    WHERE pp.id = p_presales_project_id;
  IF v_provider_org_id IS NULL THEN
    RAISE EXCEPTION
      'spatial_create_manual_scene: presales project % not found',
      p_presales_project_id
      USING ERRCODE = '22023';
  END IF;

  v_authorized := (v_owner_user_id = v_uid)
    OR (v_provider_org_id = public.spatial_user_provider_org(v_uid))
    OR public.spatial_is_operator(v_uid);
  IF NOT v_authorized THEN
    RAISE EXCEPTION
      'spatial_create_manual_scene: caller % not authorised for presales project %',
      v_uid, p_presales_project_id
      USING ERRCODE = '42501';
  END IF;

  SELECT p.profile_id INTO v_provider_user_id
    FROM public.providers p
    WHERE p.id = v_provider_org_id;

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
    provider_id,
    provider_org_id,
    metadata,
    origin
  )
  VALUES (
    p_id,
    NULL,
    NULL,
    p_parametric_storage_path,
    p_parametric_size_bytes,
    p_parametric_sha256,
    COALESCE(p_schema_version, '1.0'),
    'passed',
    true,
    false,
    v_provider_user_id,
    v_provider_org_id,
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object('presales_project_id', p_presales_project_id),
    p_origin
  )
  RETURNING * INTO v_scene;

  RETURN v_scene;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.spatial_create_manual_scene(
  uuid, uuid, text, text, integer, text, jsonb, text
) TO authenticated;
