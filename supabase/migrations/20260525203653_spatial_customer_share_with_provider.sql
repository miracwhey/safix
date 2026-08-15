-- Spatial CAD Lane V1.5.1 · M1 · Customer→HW Direct-Share
--
-- Adds a direct Customer-to-HW share path that does NOT depend on a job
-- existing yet. The motivation is the Hannover-Pilot lead-conversion USP:
-- the Customer scans a room and wants a specific HW to see it BEFORE the
-- Anfrage is converted to a job (= before `jobs.craftsman_user_id` is set
-- by the offer-accept workflow).
--
-- Architecture:
--   - `scans.shared_with_provider_id uuid` (nullable, FK → auth.users) —
--     0..1 directly-targeted HW per scan. NULL = not direct-shared.
--   - Single-target by design (V1.5.1). Multi-HW direct-share would need a
--     separate `customer_scan_shares` table and is deferred to V1.6.
--   - Orthogonal to `scans.job_id` (the "An Anfrage hängen"-pathway from
--     Block 4): a scan can carry BOTH a job_id link AND a direct HW share.
--     Both are independent visibility gates inside `spatial_can_view_scan`.
--
-- Schema facts (verified read-only against prod 2026-05-25):
--   - `auth.users` is the canonical user table; `profiles.id` mirrors
--     `auth.users.id`. We FK against `auth.users` to match how Lane-3
--     Block-1 `scans_log_share_action` already wires audit `actor_user_id`.
--   - `scans.owner_type` exists (Block 1 schema). The CHECK below relies
--     on that column.
--
-- Append-only convention: the share-audit trigger from Block 1 is left in
-- place; this migration adds an analogous trigger for the provider-side
-- column rather than mutating the customer-side trigger. The audit table
-- `spatial_share_audit` is reused — the existing CHECK on `action` accepts
-- only `'shared'|'unshared'`, which fits both directions; we add a column
-- comment instead of widening the schema.
--
-- External steps:
--   1. Supabase Dashboard → Settings → API → Reload schema cache (PostgREST
--      surfaces the new column to clients).
--   No env vars, no edge-function deploy, no webhook changes.
--
-- Plan reference: ~/.claude/plans/spatial-cad-lane-handover.md §6 Phase 0
--                 (subset, lifted into V1.5.1 Phase B for pre-job HW UX)

-- ── 1. Column + CHECK + index ──────────────────────────────────────────────

ALTER TABLE public.scans
  ADD COLUMN IF NOT EXISTS shared_with_provider_id  uuid NULL,
  ADD COLUMN IF NOT EXISTS shared_with_provider_at  timestamptz NULL;

ALTER TABLE public.scans
  DROP CONSTRAINT IF EXISTS scans_shared_with_provider_fk;
ALTER TABLE public.scans
  ADD CONSTRAINT scans_shared_with_provider_fk
  FOREIGN KEY (shared_with_provider_id)
  REFERENCES auth.users(id)
  ON DELETE SET NULL;

ALTER TABLE public.scans
  DROP CONSTRAINT IF EXISTS scans_shared_with_provider_kind_chk;
ALTER TABLE public.scans
  ADD CONSTRAINT scans_shared_with_provider_kind_chk
  CHECK (shared_with_provider_id IS NULL OR owner_type = 'customer');

CREATE INDEX IF NOT EXISTS scans_shared_with_provider_idx
  ON public.scans (shared_with_provider_id)
  WHERE shared_with_provider_id IS NOT NULL;

COMMENT ON COLUMN public.scans.shared_with_provider_id IS
  'V1.5.1 Phase B: Customer-to-HW direct share target. NULL = not direct-shared. '
  'Only legal when owner_type=''customer'' (enforced via scans_shared_with_provider_kind_chk). '
  'Orthogonal to scans.shared_with_customer (HW→Customer direction).';
COMMENT ON COLUMN public.scans.shared_with_provider_at IS
  'V1.5.1 Phase B: timestamp the current shared_with_provider_id was set; cleared on unshare.';

-- ── 2. Audit trigger (re-uses spatial_share_audit) ─────────────────────────
--
-- Reuses the existing spatial_share_audit table from Lane 3 Block 1. The
-- `action` CHECK accepts 'shared'|'unshared'; both apply to provider-side
-- transitions too. The trigger writes the rows server-side (SECURITY
-- DEFINER bypasses REVOKE INSERT FROM authenticated on the audit table).

CREATE OR REPLACE FUNCTION public.spatial_log_provider_share_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
DECLARE
  v_action text;
  v_actor  uuid;
BEGIN
  IF OLD.shared_with_provider_id IS NOT DISTINCT FROM NEW.shared_with_provider_id THEN
    RETURN NEW;
  END IF;

  v_action := CASE
    WHEN NEW.shared_with_provider_id IS NOT NULL THEN 'shared'
    ELSE 'unshared'
  END;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.shared_with_provider_id IS NOT NULL THEN
    NEW.shared_with_provider_at := now();
  ELSE
    NEW.shared_with_provider_at := NULL;
  END IF;

  INSERT INTO public.spatial_share_audit (scan_id, actor_user_id, action, job_id)
  VALUES (NEW.id, v_actor, v_action, NEW.job_id);

  RETURN NEW;
END;
$f$;

DROP TRIGGER IF EXISTS scans_log_provider_share_action ON public.scans;
CREATE TRIGGER scans_log_provider_share_action
  BEFORE UPDATE OF shared_with_provider_id ON public.scans
  FOR EACH ROW
  EXECUTE FUNCTION public.spatial_log_provider_share_action();

REVOKE EXECUTE ON FUNCTION public.spatial_log_provider_share_action() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.spatial_log_provider_share_action() FROM authenticated;

COMMENT ON FUNCTION public.spatial_log_provider_share_action() IS
  'V1.5.1 Phase B: BEFORE UPDATE trigger on scans.shared_with_provider_id. '
  'Appends to spatial_share_audit (SECURITY DEFINER bypasses REVOKE). Stamps/clears '
  'scans.shared_with_provider_at atomically.';

-- ── 3. View-helper extension: HW sees direct-shared scan ────────────────────
--
-- Rewrites `spatial_can_view_scan` to add a single OR-clause:
-- `s.shared_with_provider_id = p_uid` (the HW receiving the direct share).
-- All other clauses from the Block-1 RLS body are preserved verbatim.

CREATE OR REPLACE FUNCTION public.spatial_can_view_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $f$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects    p  ON p.id  = s.project_id
      LEFT JOIN public.jobs        j  ON j.id  = s.job_id
      LEFT JOIN public.provider_presales_projects pp ON pp.id = s.presales_project_id
      WHERE s.id = p_scan_id
        AND (
          p.customer_user_id = p_uid
          OR j.craftsman_user_id = p_uid::text
          OR j.customer_user_id = p_uid
          OR EXISTS (
            SELECT 1
            FROM public.job_assignments ja
            JOIN public.team_members    tm ON tm.id = ja.team_member_id
            WHERE ja.job_id     = s.job_id
              AND tm.profile_id = p_uid
              AND tm.is_active  = true
              AND ja.status     IN ('assigned', 'accepted', 'active', 'in_progress', 'completed')
          )
          OR (s.captured_by = p_uid AND s.status IN ('draft', 'capturing'))
          OR (
            pp.provider_org_id IS NOT NULL
            AND pp.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
          OR (s.owner_type = 'customer' AND s.captured_by = p_uid)
          OR (
            s.shared_with_customer = true
            AND s.job_id IS NOT NULL
            AND j.customer_user_id = p_uid
          )
          -- V1.5.1 Phase B: Customer-to-HW direct share.
          OR s.shared_with_provider_id = p_uid
        )
    );
$f$;

COMMENT ON FUNCTION public.spatial_can_view_scan(uuid, uuid) IS
  'Spatial Core RLS helper: union view-access. V1.5.1 Phase B adds a direct '
  'Customer-to-HW share clause (shared_with_provider_id=p_uid). All other '
  'Lane-3 Block-1 clauses preserved verbatim.';

-- ── 4. scans_update WITH CHECK gate ─────────────────────────────────────────
--
-- The Block-1 scans_update policy already gates row mutations on
-- `spatial_can_edit_scan` (Self-Scan owner + operator) AND immutable
-- `captured_by` AND the HW-only shared_with_customer transition gate.
-- We add a similar transition gate for `shared_with_provider_id`: only
-- the scan owner (Self-Scan captured_by) can set/unset the target. The
-- column is otherwise untouched — preserves the column for the row owner.

DROP POLICY IF EXISTS scans_update ON public.scans;
CREATE POLICY scans_update ON public.scans
  FOR UPDATE TO authenticated
  USING (public.spatial_can_edit_scan(id, (SELECT auth.uid())))
  WITH CHECK (
    public.spatial_can_edit_scan(id, (SELECT auth.uid()))
    AND (
      public.spatial_is_operator((SELECT auth.uid()))
      OR captured_by = (SELECT s2.captured_by FROM public.scans s2 WHERE s2.id = scans.id)
    )
    AND (
      shared_with_customer = (SELECT s2.shared_with_customer FROM public.scans s2 WHERE s2.id = scans.id)
      OR public.spatial_is_operator((SELECT auth.uid()))
      OR (
        job_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id = scans.job_id
            AND j.craftsman_user_id = (SELECT auth.uid())::text
        )
      )
    )
    AND (
      -- V1.5.1 Phase B: shared_with_provider_id changes only by the Self-Scan owner.
      shared_with_provider_id IS NOT DISTINCT FROM
        (SELECT s2.shared_with_provider_id FROM public.scans s2 WHERE s2.id = scans.id)
      OR public.spatial_is_operator((SELECT auth.uid()))
      OR (
        (SELECT s2.owner_type FROM public.scans s2 WHERE s2.id = scans.id) = 'customer'
        AND (SELECT s2.captured_by FROM public.scans s2 WHERE s2.id = scans.id) = (SELECT auth.uid())
      )
    )
  );

-- ── 5. REPLICA IDENTITY FULL for filtered DELETE realtime ───────────────────
-- Block-1 schema already set this on scans; idempotent re-statement to make
-- the dependency explicit. Without FULL the realtime DELETE-event filter on
-- shared_with_provider_id would silently drop (feedback_postgres_replica_identity_realtime).

ALTER TABLE public.scans REPLICA IDENTITY FULL;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Restore the pre-M1 spatial_can_view_scan body by re-applying
-- 20260525062412 (Lane 3 Block 1 RLS). Drop the trigger + function:
--   DROP TRIGGER IF EXISTS scans_log_provider_share_action ON public.scans;
--   DROP FUNCTION IF EXISTS public.spatial_log_provider_share_action();
-- Drop the columns (cascades the FK):
--   ALTER TABLE public.scans DROP COLUMN IF EXISTS shared_with_provider_id;
--   ALTER TABLE public.scans DROP COLUMN IF EXISTS shared_with_provider_at;
