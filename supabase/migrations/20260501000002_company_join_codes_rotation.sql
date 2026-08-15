-- Block 7.2.1d · M3 Code-Rotation Feature
-- ALTER company_join_codes (NOT rename) + audit table + rotate RPC + generator + update join RPC

-- 0. pgcrypto required for gen_random_bytes (already installed in prod, IF NOT EXISTS for branch DBs)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. New columns on company_join_codes
ALTER TABLE public.company_join_codes
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotated')),
  ADD COLUMN IF NOT EXISTS rotated_at timestamptz,
  ADD COLUMN IF NOT EXISTS rotated_by uuid,
  ADD COLUMN IF NOT EXISTS replaced_by uuid REFERENCES public.company_join_codes(id);

-- 2. Backfill status from is_active (idempotent)
UPDATE public.company_join_codes
SET status = CASE WHEN is_active THEN 'active' ELSE 'rotated' END
WHERE (status = 'active' AND is_active = false)
   OR (status = 'rotated' AND is_active = true);

-- 3. Replace is_active partial unique indexes with status-based equivalents
DROP INDEX IF EXISTS public.idx_company_join_codes_provider_active;
DROP INDEX IF EXISTS public.idx_company_join_codes_code_active;

CREATE UNIQUE INDEX IF NOT EXISTS company_join_codes_provider_active
  ON public.company_join_codes (provider_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS company_join_codes_code_active
  ON public.company_join_codes (code) WHERE status = 'active';

-- 4. Deprecate is_active (kept for rollback safety, removed in cleanup block)
COMMENT ON COLUMN public.company_join_codes.is_active IS
  'DEPRECATED — replaced by status (active|rotated). Cleanup-Block entfernt.';

-- 5. Audit table — append-only, INSERT only via RPC
CREATE TABLE IF NOT EXISTS public.company_code_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  old_code_id uuid REFERENCES public.company_join_codes(id),
  new_code_id uuid REFERENCES public.company_join_codes(id),
  rotated_by uuid NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  reason text
);

CREATE INDEX IF NOT EXISTS idx_company_code_audit_provider_rotated_at
  ON public.company_code_audit (provider_id, rotated_at DESC);

ALTER TABLE public.company_code_audit ENABLE ROW LEVEL SECURITY;

-- Owner reads own team's audit log
DROP POLICY IF EXISTS "company_code_audit_select_owner" ON public.company_code_audit;
CREATE POLICY "company_code_audit_select_owner" ON public.company_code_audit
  FOR SELECT TO authenticated USING (
    provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies → enforced append-only via SECURITY DEFINER RPC

-- 6. Code generator — CSPRNG via gen_random_bytes
CREATE OR REPLACE FUNCTION public.generate_unique_company_code()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 chars (no O/0, I/1)
  v_charlen int := length(v_chars);                     -- 32
  v_bytes bytea;
  v_code text;
  v_attempt int := 0;
BEGIN
  -- 256 / 32 = 8 → exact divisor, no modulo bias
  LOOP
    v_bytes := gen_random_bytes(6);
    v_code := '';
    FOR i IN 0..5 LOOP
      v_code := v_code || substr(v_chars, 1 + (get_byte(v_bytes, i) % v_charlen)::int, 1);
    END LOOP;
    -- Check against ALL codes (active + rotated) to keep audit trail unambiguous
    IF NOT EXISTS (SELECT 1 FROM public.company_join_codes WHERE code = v_code) THEN
      RETURN v_code;
    END IF;
    v_attempt := v_attempt + 1;
    IF v_attempt > 5 THEN
      RAISE EXCEPTION 'code_collision_unrecoverable';
    END IF;
  END LOOP;
END;
$$;

-- 7. Rotation RPC — atomic: lock old, insert new, audit
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

  -- RBAC: caller must be owner of this provider
  SELECT tm.role INTO v_role
  FROM public.team_members tm
  WHERE tm.provider_id = p_provider_id
    AND tm.profile_id = v_caller_uid;

  IF v_role IS NULL OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'rbac_owner_required' USING ERRCODE = '28000';
  END IF;

  -- Rate-limit: 5 rotations per 24h per provider
  SELECT count(*) INTO v_recent_count
  FROM public.company_code_audit
  WHERE provider_id = p_provider_id
    AND rotated_at > now() - interval '24 hours';

  IF v_recent_count >= 5 THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = '53400';
  END IF;

  -- Lock the active code row (serializes concurrent rotations on same team)
  SELECT id INTO v_old_code_id
  FROM public.company_join_codes
  WHERE provider_id = p_provider_id AND status = 'active'
  FOR UPDATE;

  IF v_old_code_id IS NULL THEN
    RAISE EXCEPTION 'no_active_code';
  END IF;

  v_new_code := public.generate_unique_company_code();

  -- Mark old as rotated FIRST (drops it from partial unique index),
  -- then insert new active row. Reverse order would violate the unique index.
  UPDATE public.company_join_codes
  SET status = 'rotated',
      is_active = false,
      rotated_at = now(),
      rotated_by = v_caller_uid,
      updated_at = now()
  WHERE id = v_old_code_id;

  INSERT INTO public.company_join_codes (provider_id, code, target_role, status, is_active)
  VALUES (p_provider_id, v_new_code, 'worker', 'active', true)
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

-- 8. Update existing join_company_with_code RPC: is_active=true → status='active'
--    Body preserved verbatim from original (jsonb return, idempotent insert,
--    EXCEPTION-safe error wrapping). Only the active-code lookup predicate changes.
CREATE OR REPLACE FUNCTION public.join_company_with_code(p_code text, p_full_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code_row RECORD;
BEGIN
  SELECT "id", "provider_id", "target_role"
  INTO v_code_row
  FROM "company_join_codes"
  WHERE "code"   = UPPER(TRIM(p_code))
    AND "status" = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'Code ungültig oder abgelaufen.',
      'code',  'invalid_code'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM "team_members"
    WHERE "provider_id" = v_code_row."provider_id"
      AND "profile_id"  = "auth"."uid"()
  ) THEN
    RETURN jsonb_build_object(
      'ok',          true,
      'provider_id', v_code_row."provider_id"
    );
  END IF;

  INSERT INTO "team_members" (
    "provider_id",
    "profile_id",
    "full_name",
    "role",
    "is_active"
  )
  VALUES (
    v_code_row."provider_id",
    "auth"."uid"(),
    COALESCE(NULLIF(TRIM(p_full_name), ''), 'Mitarbeiter'),
    v_code_row."target_role",
    true
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'ok',          true,
    'provider_id', v_code_row."provider_id"
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'ok',    false,
    'error', 'Beitritt fehlgeschlagen. Bitte versuche es erneut.',
    'code',  'unknown'
  );
END;
$$;
