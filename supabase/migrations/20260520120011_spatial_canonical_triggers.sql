-- Spatial Canonical · Day 7 · (2/2) · Triggers + SECURITY DEFINER RPCs
--
-- SQLSTATE convention for SpatialFsmViolation:
--   ERRCODE = '45SPF'
--   Category '45' = SQLSTATE class "unhandled_exception" (user-defined).
--   Sub-code 'SPF' = Spatial FSM (mnemonic).
--   Postgres does NOT allow custom SQLSTATE registration — this is a convention.
--   TypeScript callers dispatch on: err.code === '45SPF' → SpatialFsmViolation.
--   Postgres ERROR SQLSTATE reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
--   Custom class 45 is in the "unhandled_exception" family (safe for user-defined use).
--
-- REUSED infrastructure (do NOT redefine):
--   public.set_updated_at()              — defined in 20260518000002_spatial_core_block_a_schema.sql
--   public.spatial_is_operator(uuid)     — defined in 20260518000003_spatial_core_block_a_rls.sql
--   public.spatial_scan_is_locked(uuid)  — defined in 20260518000003_spatial_core_block_a_rls.sql
--   public.spatial_can_view_scene(uuid, uuid) — defined in 20260520120010_spatial_canonical_rls.sql
--
-- Contents:
--   1. updated_at triggers (spatial_scenes, spatial_node_overrides, spatial_assets,
--      spatial_materials, spatial_change_orders)
--   2. spatial_scenes_immutable_cols — BEFORE UPDATE, blocks id/source_scan_id/
--      source_job_id/created_at mutations
--   3. spatial_scenes_validation_state_fsm — BEFORE UPDATE, 5-state validation_state FSM
--   4. spatial_scenes_customer_verify_fsm — BEFORE UPDATE, 5-state customer_verify_state FSM
--   5. spatial_change_orders_status_fsm — BEFORE UPDATE, status FSM
--   6. RPC: spatial_edit_history_append — SECURITY DEFINER insert into append-only table
--   7. RPC: dispute_spatial_evidence_append — SECURITY DEFINER insert into append-only table
--
-- Audit-bake-ins:
--   XM-6/XM-7: SpatialFsmViolation surfaces at the SQL boundary as ERRCODE '45SPF'.
--   MR1: append-only tables already have REVOKE in Day 6; RPCs here are the sole write path.
--
-- Plan reference: ~/.claude/plans/spatial-v1-day-6-17-NEXT-CHAT-HANDOVER.md §4 Day 7

-- ── 1. updated_at triggers ────────────────────────────────────────────────────
-- public.set_updated_at() already exists (20260518000002_spatial_core_block_a_schema.sql).
-- We just bind it to the Day-6 tables that have an updated_at column.
-- spatial_edit_history and dispute_spatial_evidence are append-only — no updated_at column.

DROP TRIGGER IF EXISTS spatial_scenes_set_updated_at          ON public.spatial_scenes;
CREATE TRIGGER        spatial_scenes_set_updated_at
  BEFORE UPDATE ON public.spatial_scenes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS spatial_node_overrides_set_updated_at  ON public.spatial_node_overrides;
CREATE TRIGGER        spatial_node_overrides_set_updated_at
  BEFORE UPDATE ON public.spatial_node_overrides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS spatial_assets_set_updated_at          ON public.spatial_assets;
CREATE TRIGGER        spatial_assets_set_updated_at
  BEFORE UPDATE ON public.spatial_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS spatial_materials_set_updated_at       ON public.spatial_materials;
CREATE TRIGGER        spatial_materials_set_updated_at
  BEFORE UPDATE ON public.spatial_materials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS spatial_change_orders_set_updated_at   ON public.spatial_change_orders;
CREATE TRIGGER        spatial_change_orders_set_updated_at
  BEFORE UPDATE ON public.spatial_change_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── 2. Immutable column guard · spatial_scenes ────────────────────────────────
-- Blocks any UPDATE that attempts to change id, source_scan_id, source_job_id,
-- or created_at. These columns define the identity and origin of a canonical scene
-- and must never be rewritten post-insert.
-- Operators are NOT exempt — origin columns are forensically significant.
-- ERRCODE '45SPF' → SpatialFsmViolation in TypeScript.
--
-- CASCADE PASS-THROUGH:
-- source_scan_id and source_job_id have ON DELETE SET NULL on their FKs. Postgres
-- implements that referential action as an internal UPDATE that fires this trigger
-- (pg_trigger_depth() > 1). Without the gate below, deleting a referenced scan or
-- job would crash with 45SPF, permanently blocking origin-row deletion.
-- We pass cascade-driven UPDATEs through; direct user UPDATEs (depth = 1) stay
-- strict.

CREATE OR REPLACE FUNCTION public.spatial_scenes_immutable_cols_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- FK ON DELETE SET NULL is executed as a nested trigger (depth > 1).
  -- Pass cascade-driven mutations through so deletes of the referenced
  -- scan/job row are not blocked. Direct UPDATEs (depth = 1) remain guarded.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: spatial_scenes.id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  IF (NEW.source_scan_id IS DISTINCT FROM OLD.source_scan_id) THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: spatial_scenes.source_scan_id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  IF (NEW.source_job_id IS DISTINCT FROM OLD.source_job_id) THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: spatial_scenes.source_job_id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  IF NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: spatial_scenes.created_at is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.spatial_scenes_immutable_cols_guard() IS
  'BEFORE UPDATE trigger: blocks mutations to id, source_scan_id, source_job_id, created_at. '
  'Raises ERRCODE ''45SPF'' (SpatialFsmViolation). TypeScript: err.code === ''45SPF''. '
  'Passes cascade-driven updates through (pg_trigger_depth() > 1) so FK ON DELETE '
  'SET NULL on source_scan_id/source_job_id is not blocked.';

-- aaa_ prefix forces alphabetical-first execution. Postgres fires BEFORE
-- triggers in name-alphabetical order; without the prefix, customer_verify_fsm
-- (c) would run before immutable_cols (i), violating the identity-first
-- invariant.
DROP TRIGGER IF EXISTS spatial_scenes_immutable_cols     ON public.spatial_scenes;
DROP TRIGGER IF EXISTS spatial_scenes_aaa_immutable_cols ON public.spatial_scenes;
CREATE TRIGGER        spatial_scenes_aaa_immutable_cols
  BEFORE UPDATE ON public.spatial_scenes
  FOR EACH ROW EXECUTE FUNCTION public.spatial_scenes_immutable_cols_guard();

-- Trigger execution order within BEFORE UPDATE on spatial_scenes
-- (Postgres fires BEFORE triggers in name-alphabetical order):
--   1. spatial_scenes_aaa_immutable_cols       (a — identity guard runs FIRST)
--   2. spatial_scenes_customer_verify_fsm      (c — state FSMs after identity)
--   3. spatial_scenes_set_updated_at           (s — timestamp bump)
--   4. spatial_scenes_validation_state_fsm     (v — state FSM)
-- This ordering means identity is sealed before any state transition or
-- timestamp mutation. Do not rename without re-validating order.


-- ── 3. validation_state FSM · spatial_scenes ─────────────────────────────────
-- Allowed transitions:
--   pending               → passed | passed_with_warnings | blocked
--   passed                → re_review | blocked
--   passed_with_warnings  → passed | re_review | blocked
--   blocked               → re_review | pending
--   re_review             → passed | passed_with_warnings | blocked
--
-- Any other transition raises ERRCODE '45SPF'.

CREATE OR REPLACE FUNCTION public.spatial_scenes_validation_state_fsm_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allowed text[];
BEGIN
  -- No change — skip
  IF NEW.validation_state = OLD.validation_state THEN
    RETURN NEW;
  END IF;

  v_allowed := CASE OLD.validation_state
    WHEN 'pending'              THEN ARRAY['passed','passed_with_warnings','blocked']
    WHEN 'passed'               THEN ARRAY['re_review','blocked']
    WHEN 'passed_with_warnings' THEN ARRAY['passed','re_review','blocked']
    WHEN 'blocked'              THEN ARRAY['re_review','pending']
    WHEN 're_review'            THEN ARRAY['passed','passed_with_warnings','blocked']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.validation_state = ANY(v_allowed)) THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: illegal validation_state transition % → % (scene=%)',
      OLD.validation_state, NEW.validation_state, OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.spatial_scenes_validation_state_fsm_guard() IS
  'BEFORE UPDATE trigger: enforces validation_state FSM on spatial_scenes. '
  'Raises ERRCODE ''45SPF'' on illegal transition. '
  'Valid paths: pending→{passed,passed_with_warnings,blocked}, '
  'passed→{re_review,blocked}, passed_with_warnings→{passed,re_review,blocked}, '
  'blocked→{re_review,pending}, re_review→{passed,passed_with_warnings,blocked}.';

DROP TRIGGER IF EXISTS spatial_scenes_validation_state_fsm ON public.spatial_scenes;
CREATE TRIGGER        spatial_scenes_validation_state_fsm
  BEFORE UPDATE ON public.spatial_scenes
  FOR EACH ROW EXECUTE FUNCTION public.spatial_scenes_validation_state_fsm_guard();


-- ── 4. customer_verify_state FSM · spatial_scenes ────────────────────────────
-- Allowed transitions:
--   not_started  → in_progress
--   in_progress  → approved | rejected | expired
--   approved     → not_started   (re-scan flow: provider corrects, customer re-verifies)
--   rejected     → in_progress   (provider corrected, re-submit for customer review)
--   expired      → in_progress   (timeout reset: re-submit)
--
-- Any other transition raises ERRCODE '45SPF'.

CREATE OR REPLACE FUNCTION public.spatial_scenes_customer_verify_fsm_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allowed text[];
BEGIN
  -- No change — skip
  IF NEW.customer_verify_state = OLD.customer_verify_state THEN
    RETURN NEW;
  END IF;

  v_allowed := CASE OLD.customer_verify_state
    WHEN 'not_started'  THEN ARRAY['in_progress']
    WHEN 'in_progress'  THEN ARRAY['approved','rejected','expired']
    WHEN 'approved'     THEN ARRAY['not_started']
    WHEN 'rejected'     THEN ARRAY['in_progress']
    WHEN 'expired'      THEN ARRAY['in_progress']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.customer_verify_state = ANY(v_allowed)) THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: illegal customer_verify_state transition % → % (scene=%)',
      OLD.customer_verify_state, NEW.customer_verify_state, OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.spatial_scenes_customer_verify_fsm_guard() IS
  'BEFORE UPDATE trigger: enforces customer_verify_state FSM on spatial_scenes. '
  'Raises ERRCODE ''45SPF'' on illegal transition. '
  'Valid paths: not_started→{in_progress}, in_progress→{approved,rejected,expired}, '
  'approved→{not_started}, rejected→{in_progress}, expired→{in_progress}.';

DROP TRIGGER IF EXISTS spatial_scenes_customer_verify_fsm ON public.spatial_scenes;
CREATE TRIGGER        spatial_scenes_customer_verify_fsm
  BEFORE UPDATE ON public.spatial_scenes
  FOR EACH ROW EXECUTE FUNCTION public.spatial_scenes_customer_verify_fsm_guard();


-- ── 4b. Immutable column guard · spatial_change_orders ──────────────────────
-- Blocks UPDATEs that attempt to change id, scene_id, proposer_id, node_id,
-- or created_at on a change order. These identify which scene/node the order
-- targets and who proposed it — once proposed, a change order cannot be
-- re-attributed or re-anchored. The status FSM handles legal lifecycle moves.
-- pg_trigger_depth gate mirrors the spatial_scenes guard so FK ON DELETE
-- CASCADE (when the parent scene is deleted) is not mistaken for a forbidden
-- mutation.

CREATE OR REPLACE FUNCTION public.spatial_change_orders_immutable_cols_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: spatial_change_orders.id is immutable (id=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  IF NEW.scene_id <> OLD.scene_id THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: spatial_change_orders.scene_id is immutable (id=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  IF NEW.proposer_id <> OLD.proposer_id THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: spatial_change_orders.proposer_id is immutable (id=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  IF NEW.node_id IS DISTINCT FROM OLD.node_id THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: spatial_change_orders.node_id is immutable (id=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  IF NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: spatial_change_orders.created_at is immutable (id=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.spatial_change_orders_immutable_cols_guard() IS
  'BEFORE UPDATE trigger: blocks mutations to id, scene_id, proposer_id, '
  'node_id, created_at on spatial_change_orders. Raises ERRCODE ''45SPF''. '
  'Passes cascade-driven updates through (pg_trigger_depth() > 1).';

-- aaa_ prefix forces identity-first execution before the status FSM.
DROP TRIGGER IF EXISTS spatial_change_orders_aaa_immutable_cols ON public.spatial_change_orders;
CREATE TRIGGER        spatial_change_orders_aaa_immutable_cols
  BEFORE UPDATE ON public.spatial_change_orders
  FOR EACH ROW EXECUTE FUNCTION public.spatial_change_orders_immutable_cols_guard();


-- ── 5. status FSM · spatial_change_orders ────────────────────────────────────
-- Allowed transitions:
--   proposed → accepted | rejected | withdrawn
--   accepted / rejected / withdrawn are terminal (no outgoing transitions).
--
-- The status=proposed gate on the RLS UPDATE policy is the first-line guard.
-- This trigger is the second-line guard and also enforces service_role callers.

CREATE OR REPLACE FUNCTION public.spatial_change_orders_status_fsm_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allowed text[];
BEGIN
  -- No change — skip
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  v_allowed := CASE OLD.status
    WHEN 'proposed'   THEN ARRAY['accepted','rejected','withdrawn']
    WHEN 'accepted'   THEN ARRAY[]::text[]  -- terminal
    WHEN 'rejected'   THEN ARRAY[]::text[]  -- terminal
    WHEN 'withdrawn'  THEN ARRAY[]::text[]  -- terminal
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status = ANY(v_allowed)) THEN
    RAISE EXCEPTION
      'SPATIAL_FSM_VIOLATION: illegal spatial_change_orders.status transition % → % (id=%)',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = '45SPF';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.spatial_change_orders_status_fsm_guard() IS
  'BEFORE UPDATE trigger: enforces status FSM on spatial_change_orders. '
  'Raises ERRCODE ''45SPF'' on illegal transition. '
  'Valid paths: proposed→{accepted,rejected,withdrawn}. '
  'Terminal states: accepted, rejected, withdrawn.';

DROP TRIGGER IF EXISTS spatial_change_orders_status_fsm ON public.spatial_change_orders;
CREATE TRIGGER        spatial_change_orders_status_fsm
  BEFORE UPDATE ON public.spatial_change_orders
  FOR EACH ROW EXECUTE FUNCTION public.spatial_change_orders_status_fsm_guard();


-- ── 5b. Dispute-lock guard · canonical scenes + descendants ──────────────────
--
-- Block-A defines `spatial_dispute_lock_guard` for `scans` + its descendants
-- (scan_rooms, scan_assets, etc.). Canonical scenes live downstream of a
-- scan — every spatial_scene row points back at a scan via `source_scan_id`.
-- When that source scan transitions to `locked_for_dispute`, all
-- canonical-side writes anchored to it must freeze too: otherwise a provider
-- could keep editing overrides or proposing change orders against evidence
-- that has already been locked for dispute review.
--
-- This guard:
--   - Resolves the relevant `source_scan_id` for the row being written.
--   - Allows operators (spatial_is_operator) to bypass.
--   - Blocks the write when spatial_scan_is_locked() returns true.
--   - Permits writes when `source_scan_id IS NULL` (scene was created from a
--     job without a scan; no dispute-lock semantics apply yet).
--
-- Phase 5 TODO: also gate on `dispute_can_view`/`disputes.status` once
-- canonical-scene-level disputes (independent of source-scan disputes) are
-- modeled; for V1 the scan-level lock is the sole authority.

CREATE OR REPLACE FUNCTION public.spatial_canonical_dispute_lock_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid          uuid;
  v_scene_id     uuid;
  v_scan_id      uuid;
BEGIN
  -- FK cascades must pass through (mirrors immutable-cols guard rationale).
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_uid := auth.uid();

  -- Resolve the canonical scene id depending on table.
  IF TG_TABLE_NAME = 'spatial_scenes' THEN
    v_scene_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME IN ('spatial_node_overrides', 'spatial_change_orders') THEN
    v_scene_id := COALESCE(NEW.scene_id, OLD.scene_id);
  ELSE
    -- Unknown table — fail open rather than silently block; defence-in-depth
    -- is RLS + the FSM triggers.
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_scene_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Resolve scan id from scene. Scenes without a source_scan_id (job-only
  -- origin) are not gated by scan-lock — that's the desired V1 semantic.
  SELECT s.source_scan_id INTO v_scan_id
  FROM public.spatial_scenes s
  WHERE s.id = v_scene_id;

  IF v_scan_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Operators bypass the lock (matches Block-A behaviour).
  IF public.spatial_is_operator(v_uid) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF public.spatial_scan_is_locked(v_scan_id) THEN
    RAISE EXCEPTION
      'spatial_scene % is locked for dispute (source scan %) — writes blocked on table %',
      v_scene_id, v_scan_id, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.spatial_canonical_dispute_lock_guard() IS
  'BEFORE UPDATE/DELETE trigger: blocks writes on canonical-scene rows whose '
  'source scan is locked_for_dispute. Operators bypass; scenes without a '
  'source_scan_id are not gated (V1 semantic). Cascades pass through via '
  'pg_trigger_depth() > 1.';

-- Attach. Note: spatial_edit_history is append-only via SECURITY DEFINER RPC;
-- the RPC validates scan-lock separately (see H-A5 follow-up). dispute_
-- spatial_evidence is also RPC-only. spatial_assets / spatial_materials are
-- catalog rows shared across scenes — not gated here.
DROP TRIGGER IF EXISTS spatial_scenes_dispute_lock_guard ON public.spatial_scenes;
CREATE TRIGGER        spatial_scenes_dispute_lock_guard
  BEFORE UPDATE OR DELETE ON public.spatial_scenes
  FOR EACH ROW EXECUTE FUNCTION public.spatial_canonical_dispute_lock_guard();

DROP TRIGGER IF EXISTS spatial_node_overrides_dispute_lock_guard ON public.spatial_node_overrides;
CREATE TRIGGER        spatial_node_overrides_dispute_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.spatial_node_overrides
  FOR EACH ROW EXECUTE FUNCTION public.spatial_canonical_dispute_lock_guard();

DROP TRIGGER IF EXISTS spatial_change_orders_dispute_lock_guard ON public.spatial_change_orders;
CREATE TRIGGER        spatial_change_orders_dispute_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.spatial_change_orders
  FOR EACH ROW EXECUTE FUNCTION public.spatial_canonical_dispute_lock_guard();


-- ── 6. RPC: spatial_edit_history_append ──────────────────────────────────────
-- SECURITY DEFINER: runs as the function owner (postgres), bypassing the REVOKE
-- that blocks direct INSERT from authenticated/anon on spatial_edit_history.
--
-- Validation performed before insert:
--   1. auth.uid() is not null (authenticated callers only)
--   2. caller is a scene-actor (spatial_can_view_scene)
--   3. scene.validation_state is editable (not 'blocked')
--   4. source scan (if any) is not locked_for_dispute (unless operator)
--   5. p_command is one of the allowed values ('set','delete','restore')
--
-- Returns the uuid of the inserted row.
-- actor_id is always set to auth.uid() — caller cannot spoof attribution.
--
-- Grant: authenticated + service_role. Public and anon excluded.

CREATE OR REPLACE FUNCTION public.spatial_edit_history_append(
  p_scene_id      uuid,
  p_variant_id    text,
  p_base_node_id  text,
  p_override_fields jsonb,
  p_command       text,
  p_sha_before    text,
  p_sha_after     text
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

  -- 3. Scene must be in an editable validation_state. 'blocked' means the
  --    L1 validator rejected critical invariants; appending edits would
  --    perpetuate broken state. Operators must clear the block (move the
  --    scene to 're_review') before any new edits land. The RLS service_role
  --    bypass path still works because that role does not go through this
  --    RPC.
  SELECT validation_state, source_scan_id
    INTO v_validation, v_source_scan_id
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

  -- 4. Source scan must not be locked_for_dispute (operator bypass mirrors
  --    the dispute-lock-guard semantic). Mirrors §5b for direct DML; the RPC
  --    needs the same check because triggers don't fire on this code path
  --    until the INSERT line below — and we want a clearer error.
  IF v_source_scan_id IS NOT NULL
     AND NOT public.spatial_is_operator(v_uid)
     AND public.spatial_scan_is_locked(v_source_scan_id)
  THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: source scan % is locked_for_dispute — edits blocked',
      v_source_scan_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 5. Command must be in the allowed set (mirrors the table CHECK constraint,
  --    validated here so the error is surfaced as an RPC-level rejection rather
  --    than a raw constraint violation)
  IF p_command NOT IN ('set','delete','restore') THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: invalid command %; must be set|delete|restore', p_command
      USING ERRCODE = '22023';
  END IF;

  -- 6. Insert — actor_id is always the authenticated caller, never p_*
  INSERT INTO public.spatial_edit_history (
    scene_id,
    actor_id,
    variant_id,
    base_node_id,
    override_fields,
    command,
    parametric_sha256_before,
    parametric_sha256_after
  )
  VALUES (
    p_scene_id,
    v_uid,
    p_variant_id,
    p_base_node_id,
    p_override_fields,
    p_command,
    p_sha_before,
    p_sha_after
  )
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END;
$$;

COMMENT ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text) IS
  'Spatial Canonical Day 7: SECURITY DEFINER RPC for append-only insert into '
  'spatial_edit_history. Validates scene-actor membership and command enum. '
  'actor_id is always set to auth.uid() — caller cannot spoof attribution. '
  'Returns the inserted row id (uuid).';

REVOKE EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text)
  TO authenticated, service_role;


-- ── 7. RPC: dispute_spatial_evidence_append ───────────────────────────────────
-- SECURITY DEFINER: sole insert path into dispute_spatial_evidence (append-only).
--
-- V1 gate: scene-actor only (spatial_can_view_scene).
-- Phase 5 TODO: add dispute-party check (opened_by_profile_id / customer_profile_id /
-- provider_id on the disputes table) once the full dispute-evidence workflow activates
-- (Day 41-47). A dispute_can_view helper should be added at that point and composed here.
--
-- submitted_by is always auth.uid() — caller cannot spoof attribution.
-- evidence_kind is validated against the table CHECK constraint values.
--
-- Grant: authenticated + service_role. Public and anon excluded.

CREATE OR REPLACE FUNCTION public.dispute_spatial_evidence_append(
  p_dispute_id    uuid,
  p_scene_id      uuid,
  p_node_id       text,
  p_evidence_kind text,
  p_metadata      jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid;
  v_row_id uuid;
BEGIN
  -- 1. Must be authenticated
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'dispute_spatial_evidence_append: authentication required'
      USING ERRCODE = '28000';
  END IF;

  -- 2. Must be a scene-actor (V1 gate; see Phase 5 TODO above)
  IF NOT public.spatial_can_view_scene(p_scene_id, v_uid) THEN
    RAISE EXCEPTION
      'dispute_spatial_evidence_append: caller is not a scene-actor (scene=%)', p_scene_id
      USING ERRCODE = '42501';
  END IF;

  -- 3. evidence_kind must be in the allowed set
  IF p_evidence_kind NOT IN ('damage_pin','photo','note','measurement') THEN
    RAISE EXCEPTION
      'dispute_spatial_evidence_append: invalid evidence_kind %; '
      'must be damage_pin|photo|note|measurement', p_evidence_kind
      USING ERRCODE = '22023';
  END IF;

  -- 4. Dispute must exist
  IF NOT EXISTS (SELECT 1 FROM public.disputes WHERE id = p_dispute_id) THEN
    RAISE EXCEPTION
      'dispute_spatial_evidence_append: dispute % not found', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 5. Insert — submitted_by is always the authenticated caller
  INSERT INTO public.dispute_spatial_evidence (
    dispute_id,
    scene_id,
    node_id,
    evidence_kind,
    submitted_by,
    metadata
  )
  VALUES (
    p_dispute_id,
    p_scene_id,
    p_node_id,
    p_evidence_kind,
    v_uid,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END;
$$;

COMMENT ON FUNCTION public.dispute_spatial_evidence_append(uuid, uuid, text, text, jsonb) IS
  'Spatial Canonical Day 7: SECURITY DEFINER RPC for append-only insert into '
  'dispute_spatial_evidence. V1 gate: scene-actor (spatial_can_view_scene). '
  'Phase 5 TODO: add dispute-party check (opened_by_profile_id / customer_profile_id / '
  'provider_id) when dispute-evidence workflow activates (Day 41-47). '
  'submitted_by is always set to auth.uid() — caller cannot spoof attribution. '
  'Returns the inserted row id (uuid).';

REVOKE EXECUTE ON FUNCTION public.dispute_spatial_evidence_append(uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.dispute_spatial_evidence_append(uuid, uuid, text, text, jsonb)
  TO authenticated, service_role;


-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Run this block to undo all changes in this migration.
-- NOTE: public.set_updated_at() is shared infrastructure — do NOT drop it here.
--
-- DROP TRIGGER IF EXISTS spatial_scenes_set_updated_at          ON public.spatial_scenes;
-- DROP TRIGGER IF EXISTS spatial_node_overrides_set_updated_at  ON public.spatial_node_overrides;
-- DROP TRIGGER IF EXISTS spatial_assets_set_updated_at          ON public.spatial_assets;
-- DROP TRIGGER IF EXISTS spatial_materials_set_updated_at       ON public.spatial_materials;
-- DROP TRIGGER IF EXISTS spatial_change_orders_set_updated_at   ON public.spatial_change_orders;
--
-- DROP TRIGGER IF EXISTS spatial_scenes_immutable_cols          ON public.spatial_scenes;
-- DROP TRIGGER IF EXISTS spatial_scenes_aaa_immutable_cols      ON public.spatial_scenes;
-- DROP FUNCTION IF EXISTS public.spatial_scenes_immutable_cols_guard();
--
-- DROP TRIGGER IF EXISTS spatial_scenes_validation_state_fsm    ON public.spatial_scenes;
-- DROP FUNCTION IF EXISTS public.spatial_scenes_validation_state_fsm_guard();
--
-- DROP TRIGGER IF EXISTS spatial_scenes_customer_verify_fsm     ON public.spatial_scenes;
-- DROP FUNCTION IF EXISTS public.spatial_scenes_customer_verify_fsm_guard();
--
-- DROP TRIGGER IF EXISTS spatial_change_orders_status_fsm       ON public.spatial_change_orders;
-- DROP FUNCTION IF EXISTS public.spatial_change_orders_status_fsm_guard();
--
-- DROP TRIGGER IF EXISTS spatial_change_orders_aaa_immutable_cols ON public.spatial_change_orders;
-- DROP FUNCTION IF EXISTS public.spatial_change_orders_immutable_cols_guard();
--
-- DROP TRIGGER IF EXISTS spatial_scenes_dispute_lock_guard          ON public.spatial_scenes;
-- DROP TRIGGER IF EXISTS spatial_node_overrides_dispute_lock_guard  ON public.spatial_node_overrides;
-- DROP TRIGGER IF EXISTS spatial_change_orders_dispute_lock_guard   ON public.spatial_change_orders;
-- DROP FUNCTION IF EXISTS public.spatial_canonical_dispute_lock_guard();
--
-- REVOKE EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text)
--   FROM authenticated, service_role;
-- DROP FUNCTION IF EXISTS public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text);
--
-- REVOKE EXECUTE ON FUNCTION public.dispute_spatial_evidence_append(uuid, uuid, text, text, jsonb)
--   FROM authenticated, service_role;
-- DROP FUNCTION IF EXISTS public.dispute_spatial_evidence_append(uuid, uuid, text, text, jsonb);
