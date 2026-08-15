-- Block 7.2.1f · Cleanup — drop deprecated is_active column on company_join_codes
-- 7.2.1d (_000002) introduced status text + DEPRECATED-comment on is_active.
-- All consumers now read/write status; this block drops the dual-write column.

-- Pre-state verified 2026-05-01:
--   - 4 rows total, all (is_active=true) ↔ (status='active'). No divergence.
--   - No indexes / RLS policies / views / triggers reference is_active.
--   - rotate_company_code RPC dual-writes is_active (recreated below).
--   - join_company_with_code touches team_members.is_active (different table, untouched).

-- 1. Recreate rotate_company_code without is_active writes.
--    Body byte-for-byte from 7.2.1d minus is_active = false (UPDATE) and is_active = true (INSERT).
CREATE OR REPLACE FUNCTION public.rotate_company_code(
  p_provider_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS TABLE(new_code text, new_code_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_role text;
  v_old_code_id uuid;
  v_new_code text;
  v_new_code_id uuid;
  v_recent_count int;
BEGIN
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT tm.role INTO v_role
  FROM public.team_members tm
  WHERE tm.provider_id = p_provider_id
    AND tm.profile_id = v_caller_uid;

  IF v_role IS NULL OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'rbac_owner_required' USING ERRCODE = '28000';
  END IF;

  SELECT count(*) INTO v_recent_count
  FROM public.company_code_audit
  WHERE provider_id = p_provider_id
    AND rotated_at > now() - interval '24 hours';

  IF v_recent_count >= 5 THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = '53400';
  END IF;

  SELECT id INTO v_old_code_id
  FROM public.company_join_codes
  WHERE provider_id = p_provider_id AND status = 'active'
  FOR UPDATE;

  IF v_old_code_id IS NULL THEN
    RAISE EXCEPTION 'no_active_code';
  END IF;

  v_new_code := public.generate_unique_company_code();

  UPDATE public.company_join_codes
  SET status = 'rotated',
      rotated_at = now(),
      rotated_by = v_caller_uid,
      updated_at = now()
  WHERE id = v_old_code_id;

  INSERT INTO public.company_join_codes (provider_id, code, target_role, status)
  VALUES (p_provider_id, v_new_code, 'worker', 'active')
  RETURNING id INTO v_new_code_id;

  UPDATE public.company_join_codes
  SET replaced_by = v_new_code_id
  WHERE id = v_old_code_id;

  INSERT INTO public.company_code_audit (provider_id, old_code_id, new_code_id, rotated_by, reason)
  VALUES (p_provider_id, v_old_code_id, v_new_code_id, v_caller_uid, p_reason);

  RETURN QUERY SELECT v_new_code, v_new_code_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rotate_company_code(uuid, text) TO authenticated;

-- 2. Drop deprecated column.
ALTER TABLE public.company_join_codes DROP COLUMN IF EXISTS is_active;
