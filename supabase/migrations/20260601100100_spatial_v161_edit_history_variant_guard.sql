-- Spatial V1.6.1 · H2 audit-fix — server-side role↔variant guard in
-- spatial_edit_history_append.
--
-- The effective RPC (8-arg, 20260520120046) authorizes only via
-- spatial_can_view_scene and then inserts p_variant_id VERBATIM. The matching
-- client guard (spatialEditPermissions.assertCanWriteVariant) runs in the store
-- (editHistoryStore.ts) + workflow, but it is browser-reachable: a console-
-- crafted command can append into ANY variant a viewer can see — including
-- another provider's annotations or an immutable variant. This re-defines the
-- function (body-only CREATE OR REPLACE — signature + grants unchanged) to
-- derive the caller's single writable variant server-side (mirroring
-- resolveWritableVariantId) and reject a mismatching p_variant_id with 42501.
--
-- Behaviour-preserving for legitimate clients: the client always sends the
-- role-correct variant (operator→operator_review, customer→customer_corrections,
-- provider→provider_<uid>_annotations), so only spoofed mismatches are rejected.
-- Immutable variants (base_roomplan / job_<id>_final) are never any role's
-- writable variant, so the single equality check rejects them implicitly.
--
-- Prod clean window (verified 2026-06-01): 0 edit_history rows → no data risk.

CREATE OR REPLACE FUNCTION public.spatial_edit_history_append(
  p_scene_id        uuid,
  p_variant_id      text,
  p_base_node_id    text,
  p_override_fields jsonb,
  p_command         text,
  p_sha_before      text,
  p_sha_after       text,
  p_semantic_op     text DEFAULT NULL::text
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid              uuid;
  v_row_id           uuid;
  v_validation       text;
  v_source_scan_id   uuid;
  v_provider_org_id  uuid;
  v_provider_id      uuid;
  v_expected_variant text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_edit_history_append: authentication required'
      USING ERRCODE = '28000';
  END IF;

  IF NOT public.spatial_can_view_scene(p_scene_id, v_uid) THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: caller is not a scene-actor (scene=%)', p_scene_id
      USING ERRCODE = '42501';
  END IF;

  SELECT validation_state, source_scan_id, provider_org_id, provider_id
    INTO v_validation, v_source_scan_id, v_provider_org_id, v_provider_id
    FROM public.spatial_scenes
    WHERE id = p_scene_id;
  IF v_validation IS NULL THEN
    RAISE EXCEPTION 'spatial_edit_history_append: scene % not found', p_scene_id
      USING ERRCODE = 'P0002';
  END IF;

  -- H2 · role↔variant guard. Derive the caller's ONE writable variant
  -- server-side (mirror of spatialEditPermissions.resolveWritableVariantId) and
  -- reject any other p_variant_id. Operator is resolved FIRST (matches the
  -- client precedence), the scene provider writes their own annotations
  -- variant, everyone else (the customer / shared recipient) writes
  -- customer_corrections. Immutable variants (base_roomplan / job_<id>_final)
  -- equal none of these, so they are rejected by the equality check below.
  --
  -- INVARIANT: this "everyone non-provider → customer_corrections" fallthrough
  -- is correct ONLY because spatial_can_view_scene (20260525062412) has NO
  -- org-membership branch — the sole craftsman view-path is provider_id = uid,
  -- so the only craftsman that reaches this guard IS the scene provider. If a
  -- future migration adds an org-worker branch to spatial_can_view_scene, an
  -- org worker would be mis-classified here as a customer_corrections writer —
  -- revisit this derivation (and re-run the variant-spoof prod repro) then.
  IF public.spatial_is_operator(v_uid) THEN
    v_expected_variant := 'operator_review';
  ELSIF v_provider_id IS NOT NULL AND v_uid = v_provider_id THEN
    v_expected_variant := 'provider_' || v_uid::text || '_annotations';
  ELSE
    v_expected_variant := 'customer_corrections';
  END IF;
  IF p_variant_id IS DISTINCT FROM v_expected_variant THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: caller may not write variant % (role-writable variant is %)',
      p_variant_id, v_expected_variant
      USING ERRCODE = '42501';
  END IF;

  IF v_validation = 'blocked' THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: scene % is in validation_state=blocked — edits not permitted',
      p_scene_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_source_scan_id IS NOT NULL
     AND NOT public.spatial_is_operator(v_uid)
     AND public.spatial_scan_is_locked(v_source_scan_id)
  THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: source scan % is locked_for_dispute — edits blocked',
      v_source_scan_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_command NOT IN ('set','delete','restore') THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: invalid command %; must be set|delete|restore', p_command
      USING ERRCODE = '22023';
  END IF;

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

  INSERT INTO public.spatial_edit_history (
    scene_id, actor_id, provider_org_id, variant_id, base_node_id,
    override_fields, command, semantic_op,
    parametric_sha256_before, parametric_sha256_after
  )
  VALUES (
    p_scene_id, v_uid, v_provider_org_id, p_variant_id, p_base_node_id,
    p_override_fields, p_command, p_semantic_op,
    p_sha_before, p_sha_after
  )
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END;
$function$;

-- CREATE OR REPLACE preserves the existing ACL; re-assert defensively.
REVOKE ALL ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.spatial_edit_history_append(uuid, text, text, jsonb, text, text, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
