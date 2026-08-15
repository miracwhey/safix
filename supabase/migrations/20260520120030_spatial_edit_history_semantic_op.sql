-- Spatial Canonical · Phase 2 · Edit-System · semantic_op column + RPC update
--
-- Purpose:
--   The append-only `spatial_edit_history` audit table records the COARSE
--   override primitive in its `command` column (`set` / `delete` / `restore`).
--   The Phase-2 command-pattern edit-system operates at a finer granularity:
--   every user edit is one of 8 typed `EditOperation`s (`move_node`,
--   `resize_wall`, `add_door`, `delete_node`, `snap_object`, `set_material`,
--   `move_pin`, `set_room_height`).
--
--   Without recording the semantic operation, the future History-Timeline UI
--   (Block 2.13-2.16) could only show "set" / "delete" / "restore" — it could
--   not tell the user "Wall verschoben" vs "Material geändert".
--
--   This migration adds a nullable `semantic_op text` column and threads the
--   value through the `spatial_edit_history_append()` SECURITY DEFINER RPC.
--
-- Why a follow-on migration (not an in-place edit of 20260520120002):
--   The table is defined in 20260520120002_spatial_overrides_history.sql but
--   the RPC that is the sole write-path is defined three migrations later in
--   20260520120011_spatial_canonical_triggers.sql. Editing the table file
--   in-place would split a single coherent change (column + RPC parameter)
--   across two files. A forward-only follow-on migration keeps the column
--   addition and the RPC signature change atomic and reviewable in one place
--   (Risk R9 · forward-only migration · matches the canonical-migration
--   convention). All canonical migrations are still unapplied (Phase 1+2 run
--   in-memory) so the follow-on carries zero production cost.
--
-- Coherence guarantee:
--   After this migration the column and the RPC are consistent — every row
--   inserted via the RPC carries the semantic operation, and `semantic_op`
--   is constrained to the 8 canonical EditOperation discriminators (plus the
--   `restore` reverter path). Direct INSERT remains REVOKEd; the RPC is still
--   the only write-path.
--
-- Plan reference: ~/.claude/plans/spatial-v1-renderer-edit-verify-MASTER-PLAN.md
--   §4 Pre-2 + §7 HIST-SCHEMA decision (confirmed).

-- ── 1. Column: spatial_edit_history.semantic_op ──────────────────────────────

ALTER TABLE public.spatial_edit_history
  ADD COLUMN IF NOT EXISTS semantic_op text NULL;

-- Constrain to the 8 canonical EditOperation discriminators. NULL is allowed
-- so rows written by code paths that predate the command-pattern (or future
-- system-generated rows) are not rejected; the RPC always supplies a value
-- for command-pattern writes.
ALTER TABLE public.spatial_edit_history
  DROP CONSTRAINT IF EXISTS spatial_edit_history_semantic_op_chk;
ALTER TABLE public.spatial_edit_history
  ADD CONSTRAINT spatial_edit_history_semantic_op_chk
    CHECK (
      semantic_op IS NULL OR semantic_op IN (
        'move_node',
        'resize_wall',
        'add_door',
        'delete_node',
        'snap_object',
        'set_material',
        'move_pin',
        'set_room_height'
      )
    );

COMMENT ON COLUMN public.spatial_edit_history.semantic_op IS
  'Fine-grained Phase-2 EditOperation discriminator (move_node | resize_wall | '
  'add_door | delete_node | snap_object | set_material | move_pin | set_room_height). '
  'NULL for legacy / system-generated rows. The coarse override primitive stays '
  'in the `command` column (set | delete | restore).';

-- ── 2. RPC: spatial_edit_history_append — add p_semantic_op parameter ────────
--
-- CREATE OR REPLACE cannot change a function's argument list, so the prior
-- 7-argument signature is dropped and the 8-argument variant recreated. The
-- new parameter is appended last and validated against the same 8-value set
-- as the column CHECK constraint above.

DROP FUNCTION IF EXISTS public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text);

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
       'move_node','resize_wall','add_door','delete_node',
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
  'Spatial Canonical Phase 2: SECURITY DEFINER RPC for append-only insert into '
  'spatial_edit_history. Validates scene-actor membership, command enum, and the '
  'optional semantic_op EditOperation discriminator. actor_id is always set to '
  'auth.uid() — caller cannot spoof attribution. Returns the inserted row id (uuid).';

REVOKE EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text)
  TO authenticated, service_role;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text);
-- (recreate the 7-arg variant from 20260520120011_spatial_canonical_triggers.sql)
-- ALTER TABLE public.spatial_edit_history DROP CONSTRAINT IF EXISTS spatial_edit_history_semantic_op_chk;
-- ALTER TABLE public.spatial_edit_history DROP COLUMN IF EXISTS semantic_op;
