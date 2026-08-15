-- Spatial Canonical · Phase 3 · Verify-Flow · `add_pin` semantic_op
--
-- Purpose:
--   The Customer-Verify-Flow Stage-4 (Wunsch-Pins · Implementation-Spec
--   §Stage-4) lets the customer DROP a new 3D-native pin onto a surface. Pin
--   creation is a new EditOperation kind — `add_pin` — analogous to `add_door`
--   (both introduce a NEW scene-graph node rather than overriding an existing
--   one). The Phase-2 `semantic_op` CHECK constraint + the
--   `spatial_edit_history_append()` RPC only knew the 8 Phase-2 operation
--   kinds; without this follow-on, every Stage-4 pin-drop audit row would be
--   rejected by the CHECK / RPC.
--
-- Why a forward-only follow-on (not an in-place edit of …120030):
--   …120030 is a Phase-2 migration. The canonical-migration convention
--   (Risk R9 · documented in …120030's own header) is forward-only follow-on
--   migrations — editing a prior migration in place is avoided. This file
--   extends BOTH the column CHECK and the RPC's mirror validation with the
--   single new value, keeping the two consistent in one reviewable change.
--
-- Production cost:
--   Zero. All canonical migrations are still unapplied (Phase 1-3 run
--   in-memory); this follow-on carries no production cost, exactly as
--   …120030's header notes for the canonical-migration set.
--
-- Plan reference: ~/.claude/plans/spatial-v1-verify-flow-implementation-spec.md
--   §Stage-4 + §6 #7 (EditOperation command-set · Pin-Ops).

-- ── 1. Column CHECK: add `add_pin` to the allowed semantic_op set ────────────

ALTER TABLE public.spatial_edit_history
  DROP CONSTRAINT IF EXISTS spatial_edit_history_semantic_op_chk;
ALTER TABLE public.spatial_edit_history
  ADD CONSTRAINT spatial_edit_history_semantic_op_chk
    CHECK (
      semantic_op IS NULL OR semantic_op IN (
        'move_node',
        'resize_wall',
        'add_door',
        'add_pin',
        'delete_node',
        'snap_object',
        'set_material',
        'move_pin',
        'set_room_height'
      )
    );

COMMENT ON COLUMN public.spatial_edit_history.semantic_op IS
  'Fine-grained EditOperation discriminator (move_node | resize_wall | add_door '
  '| add_pin | delete_node | snap_object | set_material | move_pin | '
  'set_room_height). NULL for legacy / system-generated rows. The coarse '
  'override primitive stays in the `command` column (set | delete | restore).';

-- ── 2. RPC: mirror the extended set in the append-function validation ────────
--
-- CREATE OR REPLACE keeps the 8-argument signature from …120030 unchanged;
-- only the inline `p_semantic_op` validation set is widened by one value so
-- the RPC and the column CHECK stay in lockstep.

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
  --     Mirrors spatial_edit_history_semantic_op_chk so the error surfaces as
  --     an RPC-level rejection rather than a raw constraint violation.
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

  -- 6. Insert — actor_id is always the authenticated caller, never p_*
  INSERT INTO public.spatial_edit_history (
    scene_id,
    actor_id,
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
  'Spatial Canonical Phase 2-3: SECURITY DEFINER RPC for append-only insert into '
  'spatial_edit_history. Validates scene-actor membership, command enum, and the '
  'optional semantic_op EditOperation discriminator (incl. the Phase-3 add_pin '
  'kind). actor_id is always set to auth.uid() — caller cannot spoof attribution. '
  'Returns the inserted row id (uuid).';

REVOKE EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text)
  TO authenticated, service_role;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Re-apply 20260520120030's CHECK + RPC (the 8-kind set without `add_pin`).
