-- Lane-2.5 · Stream B · B3 — register add_wall + delete_wall semantic_op kinds.
--
-- AddWallCommand + DeleteWallCommand back the Tap-to-Place tool (B5) and the
-- wall-delete affordance on the manual-room edit-mode (B6). Without this
-- extension the spatial_edit_history_append RPC rejects the edit with a
-- CHECK violation on `semantic_op`.
--
-- Already applied to prod via MCP (apply_migration) — this file mirrors that
-- change into the repo so future env-rebuilds + local stacks stay in sync.

ALTER TABLE public.spatial_edit_history
  DROP CONSTRAINT IF EXISTS spatial_edit_history_semantic_op_chk;

ALTER TABLE public.spatial_edit_history
  ADD CONSTRAINT spatial_edit_history_semantic_op_chk
  CHECK (
    semantic_op IS NULL OR semantic_op = ANY (ARRAY[
      'move_node',
      'resize_wall',
      'add_door',
      'add_pin',
      'delete_node',
      'snap_object',
      'set_material',
      'move_pin',
      'set_room_height',
      'add_wall',
      'delete_wall'
    ])
  );
