-- Spatial Canonical · Phase B · (B-0) · Provider Spatial Hub — Multi-Tenant Foundation
--
-- Purpose:
--   The Provider Spatial Hub (spec `spatial-v1-provider-hub-spec.md`) is a
--   multi-tenant work environment: a provider *business* (not a single user)
--   owns spatial scenes, and several team members (owner / worker / …) all
--   need to view and act on the business's jobs. The V1 canonical schema only
--   models a scene's provider as one auth user (`spatial_scenes.provider_id`
--   → auth.users). This migration adds the provider-ORG dimension so the Hub
--   can list "all my business's spatial jobs" and the audit log can be
--   org-scoped.
--
-- Spec mapping correction:
--   Spec §2.4 references a `provider_orgs` table. FixUp has NO such table —
--   the canonical provider-business entity is `public.providers` (uuid PK,
--   `profile_id` → auth.users). This migration FKs to `public.providers`.
--
-- What this migration does (additive — never edits a prior migration, R9):
--   1. `spatial_scenes.provider_org_id`        → providers(id)   (Hub job-listing scope)
--   2. `spatial_edit_history.provider_org_id`  → providers(id)   (spec §2.4 — org-scoped audit)
--   3. `spatial_node_overrides.created_by_user_id` + `created_by_role`  (spec §2.4 — V1.x audit)
--   4. helper `spatial_user_provider_org(uid)`    — resolve a user → their provider-org
--   5. helper `spatial_user_team_role(uid, org)`  — resolve a user's role within an org
--   6. EXTEND `spatial_can_view_scene(scene, uid)` — same signature, now also
--      grants scene visibility to every member of the scene's provider-org.
--      (Anti-Pattern #3: signature is NOT changed — only the body is widened.)
--   7. trigger `spatial_scenes_fill_provider_org` — auto-derive provider_org_id
--      from provider_id (scene INSERT is service-role only; keeps the column
--      self-maintaining without touching the convert-scan edge function).
--   8. RPC `spatial_edit_history_append` — same 8-arg signature, now also
--      stamps `provider_org_id` from the target scene.
--
-- What this migration does NOT do (by design):
--   - The 4-role *action* matrix (who may add pins / edit BoM / send quotes —
--     spec §2.2) is enforced in the WORKFLOW layer (CLAUDE.md: "Workflow-layer
--     RBAC guards mandatory"). RLS here only gates row VISIBILITY (org-wide
--     read) + keeps the append-only / write-blocked posture intact. The
--     `spatial_user_team_role` helper is the DB building block the workflow
--     layer consumes.
--   - `spatial_node_overrides` stays write-blocked (V1.x; Decision #6 — V1
--     reads overrides from the parametric blob). The two new columns are
--     schema-prep only, exactly as spec §2.4 intends.
--
-- Production state (verified read-only against prod 2026-05-21):
--   spatial_scenes / spatial_edit_history / spatial_node_overrides — all 0 rows.
--   → no backfill required; the defensive backfill UPDATEs below are no-ops.
--   team_members.role values in prod: 'owner', 'worker' (office / read_only
--   roles are not yet seeded — `created_by_role` is intentionally free text).
--
-- External steps:
--   1. Supabase Dashboard → Settings → API → Reload schema cache
--      (required after the two new helper functions are added).
--   No env vars, no edge-function redeploy, no webhook changes.
--
-- Plan reference: ~/.claude/plans/spatial-phase-b-code-handover.md §3 (CD-4 / Multi-Tenant)
--                 ~/.claude/plans/spatial-v1-provider-hub-spec.md §2

-- ── 1. spatial_scenes · provider_org_id ──────────────────────────────────────

ALTER TABLE public.spatial_scenes
  ADD COLUMN IF NOT EXISTS provider_org_id uuid
    REFERENCES public.providers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS spatial_scenes_provider_org_id_idx
  ON public.spatial_scenes(provider_org_id)
  WHERE provider_org_id IS NOT NULL;

COMMENT ON COLUMN public.spatial_scenes.provider_org_id IS
  'Provider Spatial Hub: the provider BUSINESS (public.providers.id) that owns '
  'this scene. Distinct from provider_id (one auth user). Drives the Hub job-'
  'listing scope so every team member of the business sees the org''s jobs. '
  'Auto-derived from provider_id by the spatial_scenes_fill_provider_org trigger.';

-- ── 2. spatial_edit_history · provider_org_id ────────────────────────────────

ALTER TABLE public.spatial_edit_history
  ADD COLUMN IF NOT EXISTS provider_org_id uuid
    REFERENCES public.providers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS spatial_edit_history_provider_org_id_idx
  ON public.spatial_edit_history(provider_org_id)
  WHERE provider_org_id IS NOT NULL;

COMMENT ON COLUMN public.spatial_edit_history.provider_org_id IS
  'Provider Spatial Hub (spec §2.4): the provider business this audit row '
  'belongs to. Stamped by spatial_edit_history_append() from the scene. '
  'Powers the org-scoped Activity-Feed (Hub-Dashboard Layer 3).';

-- ── 3. spatial_node_overrides · created_by audit columns ─────────────────────
-- spec §2.4. Schema-prep only — spatial_node_overrides remains write-blocked in
-- V1 (Decision #6). created_by_role is free text: prod team_members.role today
-- holds 'owner' | 'worker'; office / read_only land later without a migration.

ALTER TABLE public.spatial_node_overrides
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_role text;

CREATE INDEX IF NOT EXISTS spatial_node_overrides_created_by_user_id_idx
  ON public.spatial_node_overrides(created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

COMMENT ON COLUMN public.spatial_node_overrides.created_by_user_id IS
  'Provider Spatial Hub (spec §2.4): the team member who authored this override '
  'row. ON DELETE SET NULL — when a provider removes a user, their overrides '
  'survive with attribution dropped ("Ehem. Mitarbeiter"). V1.x-active.';

COMMENT ON COLUMN public.spatial_node_overrides.created_by_role IS
  'Provider Spatial Hub (spec §2.4): the author''s team role at write time '
  '(owner | worker | office | read_only — free text, mirrors team_members.role). '
  'Snapshot for audit: stays correct even if the user''s role later changes.';

-- ── 4. Helper · spatial_user_provider_org ────────────────────────────────────
--
-- Resolves an auth user to the provider business they belong to:
--   - a provider OWNER  → their own providers.id
--   - a TEAM MEMBER     → their team_members.provider_id (active membership)
-- Owner identity wins when a user is somehow both. Returns NULL for users with
-- no provider affiliation (customers).
--
-- STABLE + SECURITY DEFINER + locked search_path: runs outside RLS so it can
-- be called from within RLS helper functions without recursion (Block-A pattern).

CREATE OR REPLACE FUNCTION public.spatial_user_provider_org(p_uid uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT p.id
       FROM public.providers p
       WHERE p.profile_id = p_uid
       LIMIT 1),
    (SELECT tm.provider_id
       FROM public.team_members tm
       WHERE tm.profile_id = p_uid
         AND tm.is_active = true
       LIMIT 1)
  );
$$;

COMMENT ON FUNCTION public.spatial_user_provider_org(uuid) IS
  'Provider Spatial Hub: resolves an auth user to their provider business id '
  '(public.providers.id). Owner via providers.profile_id; otherwise active '
  'team_members.provider_id. NULL for non-provider users. SECURITY DEFINER + '
  'locked search_path — safe to call from inside RLS helpers.';

REVOKE EXECUTE ON FUNCTION public.spatial_user_provider_org(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_user_provider_org(uuid) TO authenticated, service_role;

-- ── 5. Helper · spatial_user_team_role ───────────────────────────────────────
--
-- Resolves a user's role WITHIN a given provider org:
--   - provider owner            → 'owner'   (= Foreman in spec terms)
--   - active team member        → team_members.role  ('worker' | 'office' | …)
--   - no membership in that org → NULL
-- This is the DB building block the workflow-layer RBAC guard consumes to gate
-- the spec §2.2 action matrix. RLS itself does not branch on role.

CREATE OR REPLACE FUNCTION public.spatial_user_team_role(p_uid uuid, p_provider_org_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_uid IS NULL OR p_provider_org_id IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM public.providers p
      WHERE p.id = p_provider_org_id
        AND p.profile_id = p_uid
    ) THEN 'owner'
    ELSE (
      SELECT tm.role
        FROM public.team_members tm
        WHERE tm.profile_id = p_uid
          AND tm.provider_id = p_provider_org_id
          AND tm.is_active = true
        LIMIT 1
    )
  END;
$$;

COMMENT ON FUNCTION public.spatial_user_team_role(uuid, uuid) IS
  'Provider Spatial Hub (spec §2.1/§2.2): a user''s role within a provider org '
  '— ''owner'' for the business owner (Foreman), else team_members.role, else '
  'NULL. Consumed by the workflow-layer RBAC guard. SECURITY DEFINER + locked '
  'search_path.';

REVOKE EXECUTE ON FUNCTION public.spatial_user_team_role(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_user_team_role(uuid, uuid) TO authenticated, service_role;

-- ── 6. EXTEND · spatial_can_view_scene ───────────────────────────────────────
--
-- Same signature as 20260520120010 (Anti-Pattern #3 — 16 triggers + 30+
-- policies reference this helper; the signature MUST stay (uuid, uuid)).
-- Only the body is widened: a scene is now visible to its customer, its
-- provider user, OR any member of the scene's provider org. This single
-- change extends org-wide read to spatial_scenes, spatial_edit_history,
-- spatial_node_links, dispute_spatial_evidence and spatial_change_orders —
-- every policy that already calls this helper.

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
          OR (
            s.provider_org_id IS NOT NULL
            AND s.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
        )
    );
$$;

COMMENT ON FUNCTION public.spatial_can_view_scene(uuid, uuid) IS
  'Spatial RLS helper (extended Phase B B-0): true when p_uid is the scene''s '
  'customer, its provider user, OR a member of the scene''s provider org '
  '(public.providers via spatial_user_provider_org), or when auth.role() = '
  '''service_role''. SECURITY DEFINER + locked search_path to prevent RLS '
  'recursion (Block-A pattern). Signature unchanged from 20260520120010.';

-- CREATE OR REPLACE preserves existing ACL; re-emitted here for explicitness.
REVOKE EXECUTE ON FUNCTION public.spatial_can_view_scene(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_can_view_scene(uuid, uuid) TO authenticated;

-- ── 7. Trigger · auto-derive spatial_scenes.provider_org_id ──────────────────
--
-- spatial_scenes INSERT is service-role only (RLS WITH CHECK (false) for
-- authenticated). Rather than require every service-side caller (convert-scan
-- edge function, future RPCs) to look up the provider org, this BEFORE trigger
-- derives provider_org_id from provider_id. An explicitly-supplied
-- provider_org_id is respected; it is (re)derived only when NULL or when
-- provider_id itself changes.

CREATE OR REPLACE FUNCTION public.spatial_scenes_fill_provider_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.provider_id IS NOT NULL THEN
    IF NEW.provider_org_id IS NULL
       OR (TG_OP = 'UPDATE' AND NEW.provider_id IS DISTINCT FROM OLD.provider_id)
    THEN
      NEW.provider_org_id := (
        SELECT p.id
          FROM public.providers p
          WHERE p.profile_id = NEW.provider_id
          LIMIT 1
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.spatial_scenes_fill_provider_org() IS
  'Provider Spatial Hub B-0: BEFORE INSERT/UPDATE trigger — keeps '
  'spatial_scenes.provider_org_id derived from provider_id so the column is '
  'self-maintaining (scene inserts are service-role only).';

-- Trigger functions are invoked by the trigger, never as an RPC. Strip the
-- default PUBLIC EXECUTE grant so it is not reachable via /rest/v1/rpc/.
REVOKE EXECUTE ON FUNCTION public.spatial_scenes_fill_provider_org()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS spatial_scenes_fill_provider_org_trg ON public.spatial_scenes;
CREATE TRIGGER spatial_scenes_fill_provider_org_trg
  BEFORE INSERT OR UPDATE OF provider_id, provider_org_id ON public.spatial_scenes
  FOR EACH ROW
  EXECUTE FUNCTION public.spatial_scenes_fill_provider_org();

-- ── 8. RPC · spatial_edit_history_append — stamp provider_org_id ─────────────
--
-- CREATE OR REPLACE keeps the 8-argument signature from 20260520120031
-- unchanged. The only additions: fetch the scene's provider_org_id alongside
-- the validation_state, and write it into the audit row. Every other line is
-- byte-for-byte the 120031 body so the validation contract is unchanged.

CREATE OR REPLACE FUNCTION public.spatial_edit_history_append(
  p_scene_id        uuid,
  p_variant_id      text,
  p_base_node_id    text,
  p_override_fields jsonb,
  p_command         text,
  p_sha_before      text,
  p_sha_after       text,
  p_semantic_op     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid             uuid;
  v_row_id          uuid;
  v_validation      text;
  v_source_scan_id  uuid;
  v_provider_org_id uuid;
BEGIN
  -- 1. Must be authenticated
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_edit_history_append: authentication required'
      USING ERRCODE = '28000';
  END IF;

  -- 2. Must be a scene-actor
  IF NOT public.spatial_can_view_scene(p_scene_id, v_uid) THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: caller is not a scene-actor (scene=%)', p_scene_id
      USING ERRCODE = '42501';
  END IF;

  -- 3. Scene must be in an editable validation_state.
  SELECT validation_state, source_scan_id, provider_org_id
    INTO v_validation, v_source_scan_id, v_provider_org_id
    FROM public.spatial_scenes
    WHERE id = p_scene_id;
  IF v_validation IS NULL THEN
    RAISE EXCEPTION 'spatial_edit_history_append: scene % not found', p_scene_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_validation = 'blocked' THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: scene % is in validation_state=blocked — edits not permitted',
      p_scene_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 4. Source scan must not be locked_for_dispute (operator bypass).
  IF v_source_scan_id IS NOT NULL
     AND NOT public.spatial_is_operator(v_uid)
     AND public.spatial_scan_is_locked(v_source_scan_id)
  THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: source scan % is locked_for_dispute — edits blocked',
      v_source_scan_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 5. Command must be in the allowed set (mirrors the table CHECK constraint).
  IF p_command NOT IN ('set','delete','restore') THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: invalid command %; must be set|delete|restore', p_command
      USING ERRCODE = '22023';
  END IF;

  -- 5b. semantic_op (when supplied) must be a canonical EditOperation kind.
  IF p_semantic_op IS NOT NULL
     AND p_semantic_op NOT IN (
       'move_node','resize_wall','add_door','add_pin','delete_node',
       'snap_object','set_material','move_pin','set_room_height'
     )
  THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: invalid semantic_op %; must be a canonical EditOperation kind',
      p_semantic_op
      USING ERRCODE = '22023';
  END IF;

  -- 6. Insert — actor_id is always the authenticated caller, never p_*.
  --    provider_org_id is stamped from the scene (Phase B B-0).
  INSERT INTO public.spatial_edit_history (
    scene_id,
    actor_id,
    provider_org_id,
    variant_id,
    base_node_id,
    override_fields,
    command,
    semantic_op,
    parametric_sha256_before,
    parametric_sha256_after
  )
  VALUES (
    p_scene_id,
    v_uid,
    v_provider_org_id,
    p_variant_id,
    p_base_node_id,
    p_override_fields,
    p_command,
    p_semantic_op,
    p_sha_before,
    p_sha_after
  )
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END;
$$;

COMMENT ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text) IS
  'Spatial Canonical Phase 2-3 + Phase B B-0: SECURITY DEFINER RPC for '
  'append-only insert into spatial_edit_history. Validates scene-actor '
  'membership, command enum, and the optional semantic_op discriminator. '
  'actor_id = auth.uid() (no spoofing); provider_org_id is stamped from the '
  'target scene for org-scoped audit. Returns the inserted row id (uuid).';

REVOKE EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text)
  TO authenticated, service_role;

-- ── 9. Defensive backfill (no-op on prod — all three tables are 0 rows) ──────
-- Idempotent: derives provider_org_id for any pre-existing scene/audit rows.
-- Documented for completeness; runs as a no-op against current prod.

UPDATE public.spatial_scenes s
  SET provider_org_id = p.id
  FROM public.providers p
  WHERE s.provider_org_id IS NULL
    AND s.provider_id IS NOT NULL
    AND p.profile_id = s.provider_id;

UPDATE public.spatial_edit_history h
  SET provider_org_id = s.provider_org_id
  FROM public.spatial_scenes s
  WHERE h.provider_org_id IS NULL
    AND h.scene_id = s.id
    AND s.provider_org_id IS NOT NULL;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Restores the pre-B-0 state. set_updated_at() and the 120031 RPC body are
-- shared infrastructure — the RPC rollback below re-applies the 120031 version.
--
-- DROP TRIGGER  IF EXISTS spatial_scenes_fill_provider_org_trg ON public.spatial_scenes;
-- DROP FUNCTION IF EXISTS public.spatial_scenes_fill_provider_org();
--
-- -- Re-apply 20260520120031's spatial_edit_history_append (without provider_org_id).
-- -- Re-apply 20260520120010's spatial_can_view_scene (without the org branch).
--
-- DROP FUNCTION IF EXISTS public.spatial_user_team_role(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.spatial_user_provider_org(uuid);
--
-- DROP INDEX IF EXISTS public.spatial_node_overrides_created_by_user_id_idx;
-- DROP INDEX IF EXISTS public.spatial_edit_history_provider_org_id_idx;
-- DROP INDEX IF EXISTS public.spatial_scenes_provider_org_id_idx;
--
-- ALTER TABLE public.spatial_node_overrides
--   DROP COLUMN IF EXISTS created_by_role,
--   DROP COLUMN IF EXISTS created_by_user_id;
-- ALTER TABLE public.spatial_edit_history DROP COLUMN IF EXISTS provider_org_id;
-- ALTER TABLE public.spatial_scenes       DROP COLUMN IF EXISTS provider_org_id;
