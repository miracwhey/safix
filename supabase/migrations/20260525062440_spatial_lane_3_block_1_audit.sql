-- Spatial Lane 3 · Block 1 · spatial_share_audit table + sharing trigger
-- Append-only audit for share/unshare actions on scans.
-- Two-layer write-protection: RLS default-deny + REVOKE INSERT/UPDATE/DELETE/TRUNCATE.
-- Inserts flow only via SECURITY DEFINER trigger on scans.shared_with_customer changes.

CREATE TABLE IF NOT EXISTS public.spatial_share_audit (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id        uuid        NOT NULL REFERENCES public.scans(id) ON DELETE CASCADE,
  actor_user_id  uuid        NOT NULL REFERENCES auth.users(id)  ON DELETE RESTRICT,
  action         text        NOT NULL,
  job_id         uuid        NULL       REFERENCES public.jobs(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spatial_share_audit_action_chk
    CHECK (action IN ('shared', 'unshared'))
);

ALTER TABLE public.spatial_share_audit ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.spatial_share_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.spatial_share_audit FROM authenticated;

CREATE INDEX IF NOT EXISTS spatial_share_audit_scan_id_idx
  ON public.spatial_share_audit (scan_id);
CREATE INDEX IF NOT EXISTS spatial_share_audit_actor_idx
  ON public.spatial_share_audit (actor_user_id);
CREATE INDEX IF NOT EXISTS spatial_share_audit_created_at_idx
  ON public.spatial_share_audit (created_at DESC);

COMMENT ON TABLE public.spatial_share_audit IS
  'Lane 3 V1.6: append-only log of HW share/unshare actions per scan. Writes only via SECURITY DEFINER trigger spatial_log_share_action. Two-layer protection: RLS default-deny + REVOKE writes from anon/authenticated.';

DROP POLICY IF EXISTS spatial_share_audit_select ON public.spatial_share_audit;
CREATE POLICY spatial_share_audit_select ON public.spatial_share_audit
  FOR SELECT TO authenticated
  USING (
    public.spatial_is_operator((SELECT auth.uid()))
    OR EXISTS (
      SELECT 1 FROM public.scans sc
      WHERE sc.id = spatial_share_audit.scan_id
        AND (
          sc.captured_by = (SELECT auth.uid())
          OR (
            sc.job_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.jobs j
              WHERE j.id = sc.job_id
                AND j.customer_user_id = (SELECT auth.uid())
            )
          )
        )
    )
  );

CREATE OR REPLACE FUNCTION public.spatial_log_share_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
DECLARE
  v_action text;
  v_actor  uuid;
BEGIN
  IF OLD.shared_with_customer = NEW.shared_with_customer THEN
    RETURN NEW;
  END IF;

  v_action := CASE
    WHEN NEW.shared_with_customer = true  THEN 'shared'
    WHEN NEW.shared_with_customer = false THEN 'unshared'
  END;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.shared_with_customer = true THEN
    NEW.shared_at := now();
  ELSE
    NEW.shared_at := NULL;
  END IF;

  INSERT INTO public.spatial_share_audit (scan_id, actor_user_id, action, job_id)
  VALUES (NEW.id, v_actor, v_action, NEW.job_id);

  RETURN NEW;
END;
$f$;

DROP TRIGGER IF EXISTS scans_log_share_action ON public.scans;
CREATE TRIGGER scans_log_share_action
  BEFORE UPDATE OF shared_with_customer ON public.scans
  FOR EACH ROW
  EXECUTE FUNCTION public.spatial_log_share_action();

REVOKE EXECUTE ON FUNCTION public.spatial_log_share_action() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.spatial_log_share_action() FROM authenticated;

COMMENT ON FUNCTION public.spatial_log_share_action() IS
  'Lane 3 V1.6: BEFORE UPDATE trigger on scans.shared_with_customer. Appends to spatial_share_audit (SECURITY DEFINER bypasses REVOKE). Also stamps/clears scans.shared_at in the same transaction.';
