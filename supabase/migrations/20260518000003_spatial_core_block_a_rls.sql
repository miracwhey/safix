-- Spatial Core · Block A · RLS Policies + Dispute-Lock-Trigger (2/2)
--
-- ACL roles (mapped from existing FixUp domain):
--   Operator   : profiles.is_operator = true                            -> ALL on everything
--   Customer   : projects.customer_user_id = auth.uid()                 -> CRUD on own project's scans
--   Craftsman  : jobs.craftsman_user_id = auth.uid()::text              -> SELECT + measurement UPDATE on job's scans
--   Worker     : team_members.profile_id = auth.uid() AND active        -> SELECT + annotation INSERT on assigned-job scans
--                (via job_assignments.team_member_id)
--
-- Dispute-Lock: when scans.status = 'locked_for_dispute', ALL writes blocked
--               (INSERT for children + UPDATE/DELETE everywhere) via BEFORE-trigger.
--               Operator can transition OUT of locked via the unlock path.
--               INSERT on child tables is gated too -- otherwise evidence could
--               be fabricated post-lock (new measurement, new annotation, etc.).
--
-- scan_events: writes already REVOKEd (block_a_schema migration). SELECT policy only.
--              Insert path: SECURITY DEFINER RPCs (follow-up migration).
--
-- Helper functions are SECURITY DEFINER STABLE with locked search_path to avoid
-- RLS recursion and prevent policy-spoofing via search_path tricks.

-- ── Helper functions ──────────────────────────────────────────────────────────

-- Returns true if the given uid is an operator.
CREATE OR REPLACE FUNCTION public.spatial_is_operator(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_uid AND is_operator = true
  );
$$;

-- Returns true if the given uid can VIEW the scan
-- (Operator / Project-Customer / Job-Craftsman / Worker-on-Job-via-team_members).
CREATE OR REPLACE FUNCTION public.spatial_can_view_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects p ON p.id = s.project_id
      LEFT JOIN public.jobs     j ON j.id = s.job_id
      WHERE s.id = p_scan_id
        AND (
          -- Customer of the project
          p.customer_user_id = p_uid
          -- Craftsman of the job (text-cast: legacy column type)
          OR j.craftsman_user_id = p_uid::text
          -- Customer of the job (jobs has its own customer_user_id, may differ from project)
          OR j.customer_user_id  = p_uid
          -- Worker assigned via team_members
          OR EXISTS (
            SELECT 1
            FROM public.job_assignments ja
            JOIN public.team_members    tm ON tm.id = ja.team_member_id
            WHERE ja.job_id        = s.job_id
              AND tm.profile_id    = p_uid
              AND tm.is_active     = true
              AND ja.status        IN ('assigned', 'accepted', 'active', 'in_progress', 'completed')
          )
          -- Captured-by self (covers craftsman without job-link yet, e.g. draft scans)
          OR s.captured_by = p_uid
        )
    );
$$;

-- Returns true if the given uid can fully EDIT the scan (write all columns).
-- Project-Customer (owner) or Operator unconditionally.
-- captured_by gets edit-rights ONLY in draft/capturing status (legitimate self-edit
-- during the capture flow). After captured/quality_checked etc., captured_by alone
-- is no longer sufficient — otherwise a craftsman who inserts a scan on their own
-- job would retain edit on it post-capture (incl. status, project_id flip, delete).
-- Craftsman/Worker write paths use narrower per-table helpers (e.g. is_job_craftsman).
CREATE OR REPLACE FUNCTION public.spatial_can_edit_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects p ON p.id = s.project_id
      WHERE s.id = p_scan_id
        AND (
          -- Project owner: always
          p.customer_user_id = p_uid
          -- Captured-by: only during the active capture phase
          OR (s.captured_by = p_uid AND s.status IN ('draft', 'capturing'))
        )
    );
$$;

-- Returns true if uid is the Craftsman assigned to the scan's job (text-cast).
CREATE OR REPLACE FUNCTION public.spatial_is_job_craftsman(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.scans s
    JOIN public.jobs  j ON j.id = s.job_id
    WHERE s.id = p_scan_id
      AND j.craftsman_user_id = p_uid::text
  );
$$;

-- Returns true if uid is a Worker assigned via team_members to the scan's job.
CREATE OR REPLACE FUNCTION public.spatial_is_job_worker(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.scans            s
    JOIN public.job_assignments  ja ON ja.job_id     = s.job_id
    JOIN public.team_members     tm ON tm.id         = ja.team_member_id
    WHERE s.id = p_scan_id
      AND tm.profile_id = p_uid
      AND tm.is_active  = true
      AND ja.status     IN ('assigned', 'accepted', 'active', 'in_progress', 'completed')
  );
$$;

-- Returns true if the scan is locked for dispute (writes generally blocked).
CREATE OR REPLACE FUNCTION public.spatial_scan_is_locked(p_scan_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.scans
    WHERE id = p_scan_id
      AND status = 'locked_for_dispute'
  );
$$;

COMMENT ON FUNCTION public.spatial_is_operator(uuid)             IS 'Spatial Core RLS helper: operator check.';
COMMENT ON FUNCTION public.spatial_can_view_scan(uuid, uuid)     IS 'Spatial Core RLS helper: union view-access (operator / customer / craftsman / worker / captured_by).';
COMMENT ON FUNCTION public.spatial_can_edit_scan(uuid, uuid)     IS 'Spatial Core RLS helper: full edit-access (operator / customer / captured_by). Narrower per-table policies for craftsman/worker.';
COMMENT ON FUNCTION public.spatial_is_job_craftsman(uuid, uuid)  IS 'Spatial Core RLS helper: craftsman of the scan-linked job.';
COMMENT ON FUNCTION public.spatial_is_job_worker(uuid, uuid)     IS 'Spatial Core RLS helper: worker assigned to the scan-linked job via team_members.';
COMMENT ON FUNCTION public.spatial_scan_is_locked(uuid)          IS 'Spatial Core RLS helper: scan in dispute-locked state. Used by trigger + policies.';

-- ── Dispute-Lock trigger ──────────────────────────────────────────────────────
--
-- Blocks all writes on locked scans, EXCEPT:
--   - Operator (can unlock or correct)
--   - Status transition FROM locked_for_dispute (the unlock path)
--
-- Trigger fires:
--   scans         : BEFORE UPDATE OR DELETE
--                   (INSERT on scans is fine -- a brand-new scan can't already be
--                    pointing to itself as locked; status='locked_for_dispute' on
--                    INSERT is a separate concern handled in insert policies)
--   child tables  : BEFORE INSERT OR UPDATE OR DELETE
--                   (INSERT gate critical -- otherwise evidence can be fabricated
--                    post-lock: new measurement, new annotation, new room/surface).
--
-- scan_events is append-only via REVOKE in schema-migration (no trigger here).
-- scan_quality_reports has no write-policies for non-operator, so trigger not needed.

CREATE OR REPLACE FUNCTION public.spatial_dispute_lock_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_scan_id uuid;
  v_uid     uuid;
BEGIN
  v_uid := auth.uid();

  -- Resolve scan_id depending on table.
  IF TG_TABLE_NAME = 'scans' THEN
    v_scan_id := COALESCE(NEW.id, OLD.id);

    -- Allow operator transition out of locked_for_dispute
    IF TG_OP = 'UPDATE'
       AND OLD.status = 'locked_for_dispute'
       AND NEW.status <> 'locked_for_dispute'
       AND public.spatial_is_operator(v_uid)
    THEN
      RETURN NEW;
    END IF;

  ELSIF TG_TABLE_NAME = 'scan_rooms' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_measurements' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_annotations' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_assets' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_surfaces' THEN
    -- scan_surfaces sits under scan_rooms; resolve via room.
    v_scan_id := (
      SELECT r.scan_id FROM public.scan_rooms r
      WHERE r.id = COALESCE(NEW.room_id, OLD.room_id)
    );
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_scan_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Operator can do everything.
  IF public.spatial_is_operator(v_uid) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Block if scan is locked.
  IF public.spatial_scan_is_locked(v_scan_id) THEN
    RAISE EXCEPTION
      'scan % is locked_for_dispute - writes blocked (table %)', v_scan_id, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.spatial_dispute_lock_guard() IS 'Spatial Core: BEFORE-UPDATE/DELETE trigger that blocks writes on dispute-locked scans (operator-only unlock path).';

DROP TRIGGER IF EXISTS scans_dispute_lock_guard             ON public.scans;
CREATE TRIGGER        scans_dispute_lock_guard
  BEFORE UPDATE OR DELETE ON public.scans
  FOR EACH ROW EXECUTE FUNCTION public.spatial_dispute_lock_guard();

DROP TRIGGER IF EXISTS scan_assets_dispute_lock_guard       ON public.scan_assets;
CREATE TRIGGER        scan_assets_dispute_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.scan_assets
  FOR EACH ROW EXECUTE FUNCTION public.spatial_dispute_lock_guard();

DROP TRIGGER IF EXISTS scan_rooms_dispute_lock_guard        ON public.scan_rooms;
CREATE TRIGGER        scan_rooms_dispute_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.scan_rooms
  FOR EACH ROW EXECUTE FUNCTION public.spatial_dispute_lock_guard();

DROP TRIGGER IF EXISTS scan_surfaces_dispute_lock_guard     ON public.scan_surfaces;
CREATE TRIGGER        scan_surfaces_dispute_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.scan_surfaces
  FOR EACH ROW EXECUTE FUNCTION public.spatial_dispute_lock_guard();

DROP TRIGGER IF EXISTS scan_measurements_dispute_lock_guard ON public.scan_measurements;
CREATE TRIGGER        scan_measurements_dispute_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.scan_measurements
  FOR EACH ROW EXECUTE FUNCTION public.spatial_dispute_lock_guard();

DROP TRIGGER IF EXISTS scan_annotations_dispute_lock_guard  ON public.scan_annotations;
CREATE TRIGGER        scan_annotations_dispute_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.scan_annotations
  FOR EACH ROW EXECUTE FUNCTION public.spatial_dispute_lock_guard();

-- ── Policies · scans ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS scans_select ON public.scans;
CREATE POLICY scans_select ON public.scans
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scan(id, (SELECT auth.uid())));

-- INSERT: customer (own project) OR craftsman (own job) OR operator
DROP POLICY IF EXISTS scans_insert ON public.scans;
CREATE POLICY scans_insert ON public.scans
  FOR INSERT TO authenticated
  WITH CHECK (
    captured_by = (SELECT auth.uid())
    AND (
      public.spatial_is_operator((SELECT auth.uid()))
      OR (
        project_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.projects p
          WHERE p.id = project_id
            AND p.customer_user_id = (SELECT auth.uid())
        )
      )
      OR (
        job_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id = job_id
            AND (
              j.craftsman_user_id = (SELECT auth.uid())::text
              OR j.customer_user_id = (SELECT auth.uid())
            )
        )
      )
    )
  );

-- UPDATE: full-edit roles (customer, captured_by during draft/capturing, operator).
-- captured_by is IMMUTABLE on UPDATE for non-operators -- this prevents audit-attribution
-- rewrite (a project-customer flipping captured_by to a stranger to fake authorship,
-- or a craftsman moving authorship to themselves post-fact).
DROP POLICY IF EXISTS scans_update ON public.scans;
CREATE POLICY scans_update ON public.scans
  FOR UPDATE TO authenticated
  USING (public.spatial_can_edit_scan(id, (SELECT auth.uid())))
  WITH CHECK (
    public.spatial_can_edit_scan(id, (SELECT auth.uid()))
    AND (
      public.spatial_is_operator((SELECT auth.uid()))
      OR captured_by = (SELECT captured_by FROM public.scans WHERE id = scans.id)
    )
  );

-- DELETE: customer-of-project OR operator only
DROP POLICY IF EXISTS scans_delete ON public.scans;
CREATE POLICY scans_delete ON public.scans
  FOR DELETE TO authenticated
  USING (public.spatial_can_edit_scan(id, (SELECT auth.uid())));

-- ── Policies · scan_assets ────────────────────────────────────────────────────

DROP POLICY IF EXISTS scan_assets_select ON public.scan_assets;
CREATE POLICY scan_assets_select ON public.scan_assets
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scan(scan_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS scan_assets_insert ON public.scan_assets;
CREATE POLICY scan_assets_insert ON public.scan_assets
  FOR INSERT TO authenticated
  WITH CHECK (public.spatial_can_edit_scan(scan_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS scan_assets_update ON public.scan_assets;
CREATE POLICY scan_assets_update ON public.scan_assets
  FOR UPDATE TO authenticated
  USING      (public.spatial_can_edit_scan(scan_id, (SELECT auth.uid())))
  WITH CHECK (public.spatial_can_edit_scan(scan_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS scan_assets_delete ON public.scan_assets;
CREATE POLICY scan_assets_delete ON public.scan_assets
  FOR DELETE TO authenticated
  USING (public.spatial_can_edit_scan(scan_id, (SELECT auth.uid())));

-- ── Policies · scan_rooms ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS scan_rooms_select ON public.scan_rooms;
CREATE POLICY scan_rooms_select ON public.scan_rooms
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scan(scan_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS scan_rooms_insert ON public.scan_rooms;
CREATE POLICY scan_rooms_insert ON public.scan_rooms
  FOR INSERT TO authenticated
  WITH CHECK (public.spatial_can_edit_scan(scan_id, (SELECT auth.uid())));

-- UPDATE: customer + craftsman (für verified-Werte)
DROP POLICY IF EXISTS scan_rooms_update ON public.scan_rooms;
CREATE POLICY scan_rooms_update ON public.scan_rooms
  FOR UPDATE TO authenticated
  USING (
    public.spatial_can_edit_scan(scan_id, (SELECT auth.uid()))
    OR public.spatial_is_job_craftsman(scan_id, (SELECT auth.uid()))
  )
  WITH CHECK (
    public.spatial_can_edit_scan(scan_id, (SELECT auth.uid()))
    OR public.spatial_is_job_craftsman(scan_id, (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS scan_rooms_delete ON public.scan_rooms;
CREATE POLICY scan_rooms_delete ON public.scan_rooms
  FOR DELETE TO authenticated
  USING (public.spatial_can_edit_scan(scan_id, (SELECT auth.uid())));

-- ── Policies · scan_surfaces ──────────────────────────────────────────────────

-- Resolved via parent room -> scan
DROP POLICY IF EXISTS scan_surfaces_select ON public.scan_surfaces;
CREATE POLICY scan_surfaces_select ON public.scan_surfaces
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.scan_rooms r
      WHERE r.id = room_id
        AND public.spatial_can_view_scan(r.scan_id, (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS scan_surfaces_insert ON public.scan_surfaces;
CREATE POLICY scan_surfaces_insert ON public.scan_surfaces
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scan_rooms r
      WHERE r.id = room_id
        AND public.spatial_can_edit_scan(r.scan_id, (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS scan_surfaces_update ON public.scan_surfaces;
CREATE POLICY scan_surfaces_update ON public.scan_surfaces
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.scan_rooms r
      WHERE r.id = room_id
        AND (
          public.spatial_can_edit_scan(r.scan_id, (SELECT auth.uid()))
          OR public.spatial_is_job_craftsman(r.scan_id, (SELECT auth.uid()))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scan_rooms r
      WHERE r.id = room_id
        AND (
          public.spatial_can_edit_scan(r.scan_id, (SELECT auth.uid()))
          OR public.spatial_is_job_craftsman(r.scan_id, (SELECT auth.uid()))
        )
    )
  );

DROP POLICY IF EXISTS scan_surfaces_delete ON public.scan_surfaces;
CREATE POLICY scan_surfaces_delete ON public.scan_surfaces
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.scan_rooms r
      WHERE r.id = room_id
        AND public.spatial_can_edit_scan(r.scan_id, (SELECT auth.uid()))
    )
  );

-- ── Policies · scan_measurements ──────────────────────────────────────────────
-- Customer + Craftsman both can write verified values; this is the key
-- handwerker-verification path (D5).

DROP POLICY IF EXISTS scan_measurements_select ON public.scan_measurements;
CREATE POLICY scan_measurements_select ON public.scan_measurements
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scan(scan_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS scan_measurements_insert ON public.scan_measurements;
CREATE POLICY scan_measurements_insert ON public.scan_measurements
  FOR INSERT TO authenticated
  WITH CHECK (
    public.spatial_can_edit_scan(scan_id, (SELECT auth.uid()))
    OR public.spatial_is_job_craftsman(scan_id, (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS scan_measurements_update ON public.scan_measurements;
CREATE POLICY scan_measurements_update ON public.scan_measurements
  FOR UPDATE TO authenticated
  USING (
    public.spatial_can_edit_scan(scan_id, (SELECT auth.uid()))
    OR public.spatial_is_job_craftsman(scan_id, (SELECT auth.uid()))
  )
  WITH CHECK (
    public.spatial_can_edit_scan(scan_id, (SELECT auth.uid()))
    OR public.spatial_is_job_craftsman(scan_id, (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS scan_measurements_delete ON public.scan_measurements;
CREATE POLICY scan_measurements_delete ON public.scan_measurements
  FOR DELETE TO authenticated
  USING (public.spatial_can_edit_scan(scan_id, (SELECT auth.uid())));

-- ── Policies · scan_annotations ───────────────────────────────────────────────
-- Worker + Customer + Craftsman can all INSERT annotations (Damage-Pin Doku).
-- UPDATE: edit-roles + Craftsman + the annotation author (any-role) for resolving own pins.

DROP POLICY IF EXISTS scan_annotations_select ON public.scan_annotations;
CREATE POLICY scan_annotations_select ON public.scan_annotations
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scan(scan_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS scan_annotations_insert ON public.scan_annotations;
CREATE POLICY scan_annotations_insert ON public.scan_annotations
  FOR INSERT TO authenticated
  WITH CHECK (
    public.spatial_can_view_scan(scan_id, (SELECT auth.uid()))  -- see-can-pin (Worker erlaubt)
  );

DROP POLICY IF EXISTS scan_annotations_update ON public.scan_annotations;
CREATE POLICY scan_annotations_update ON public.scan_annotations
  FOR UPDATE TO authenticated
  USING (
    public.spatial_can_edit_scan(scan_id, (SELECT auth.uid()))
    OR public.spatial_is_job_craftsman(scan_id, (SELECT auth.uid()))
  )
  WITH CHECK (
    public.spatial_can_edit_scan(scan_id, (SELECT auth.uid()))
    OR public.spatial_is_job_craftsman(scan_id, (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS scan_annotations_delete ON public.scan_annotations;
CREATE POLICY scan_annotations_delete ON public.scan_annotations
  FOR DELETE TO authenticated
  USING (public.spatial_can_edit_scan(scan_id, (SELECT auth.uid())));

-- ── Policies · scan_quality_reports ───────────────────────────────────────────
-- Read-only for all viewers. INSERT path: pure-function Quality Engine runs in
-- SECURITY DEFINER context (later migration). No direct user INSERT/UPDATE/DELETE
-- (still allow operator to delete corrupt rows).

DROP POLICY IF EXISTS scan_quality_reports_select ON public.scan_quality_reports;
CREATE POLICY scan_quality_reports_select ON public.scan_quality_reports
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scan(scan_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS scan_quality_reports_operator_all ON public.scan_quality_reports;
CREATE POLICY scan_quality_reports_operator_all ON public.scan_quality_reports
  FOR ALL TO authenticated
  USING      (public.spatial_is_operator((SELECT auth.uid())))
  WITH CHECK (public.spatial_is_operator((SELECT auth.uid())));

-- ── Policies · scan_events ────────────────────────────────────────────────────
-- Writes already REVOKEd from anon/authenticated in block_a_schema migration.
-- Only need SELECT policy here (Insert via SECURITY DEFINER RPCs).

DROP POLICY IF EXISTS scan_events_select ON public.scan_events;
CREATE POLICY scan_events_select ON public.scan_events
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scan(scan_id, (SELECT auth.uid())));

-- Operator can also DELETE forensic-corrupt events (rare, but kept for cleanup).
DROP POLICY IF EXISTS scan_events_operator_delete ON public.scan_events;
CREATE POLICY scan_events_operator_delete ON public.scan_events
  FOR DELETE TO authenticated
  USING (public.spatial_is_operator((SELECT auth.uid())));

-- ── GRANTs for helper functions (callable by authenticated, NOT anon) ─────────

REVOKE EXECUTE ON FUNCTION public.spatial_is_operator(uuid)              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.spatial_can_view_scan(uuid, uuid)      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.spatial_can_edit_scan(uuid, uuid)      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.spatial_is_job_craftsman(uuid, uuid)   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.spatial_is_job_worker(uuid, uuid)      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.spatial_scan_is_locked(uuid)           FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.spatial_is_operator(uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.spatial_can_view_scan(uuid, uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.spatial_can_edit_scan(uuid, uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.spatial_is_job_craftsman(uuid, uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.spatial_is_job_worker(uuid, uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.spatial_scan_is_locked(uuid)           TO authenticated;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP TRIGGER  IF EXISTS scans_dispute_lock_guard             ON public.scans;
-- DROP TRIGGER  IF EXISTS scan_assets_dispute_lock_guard       ON public.scan_assets;
-- DROP TRIGGER  IF EXISTS scan_rooms_dispute_lock_guard        ON public.scan_rooms;
-- DROP TRIGGER  IF EXISTS scan_surfaces_dispute_lock_guard     ON public.scan_surfaces;
-- DROP TRIGGER  IF EXISTS scan_measurements_dispute_lock_guard ON public.scan_measurements;
-- DROP TRIGGER  IF EXISTS scan_annotations_dispute_lock_guard  ON public.scan_annotations;
--
-- DROP POLICY   IF EXISTS scans_select                         ON public.scans;
-- DROP POLICY   IF EXISTS scans_insert                         ON public.scans;
-- DROP POLICY   IF EXISTS scans_update                         ON public.scans;
-- DROP POLICY   IF EXISTS scans_delete                         ON public.scans;
-- DROP POLICY   IF EXISTS scan_assets_select                   ON public.scan_assets;
-- DROP POLICY   IF EXISTS scan_assets_insert                   ON public.scan_assets;
-- DROP POLICY   IF EXISTS scan_assets_update                   ON public.scan_assets;
-- DROP POLICY   IF EXISTS scan_assets_delete                   ON public.scan_assets;
-- DROP POLICY   IF EXISTS scan_rooms_select                    ON public.scan_rooms;
-- DROP POLICY   IF EXISTS scan_rooms_insert                    ON public.scan_rooms;
-- DROP POLICY   IF EXISTS scan_rooms_update                    ON public.scan_rooms;
-- DROP POLICY   IF EXISTS scan_rooms_delete                    ON public.scan_rooms;
-- DROP POLICY   IF EXISTS scan_surfaces_select                 ON public.scan_surfaces;
-- DROP POLICY   IF EXISTS scan_surfaces_insert                 ON public.scan_surfaces;
-- DROP POLICY   IF EXISTS scan_surfaces_update                 ON public.scan_surfaces;
-- DROP POLICY   IF EXISTS scan_surfaces_delete                 ON public.scan_surfaces;
-- DROP POLICY   IF EXISTS scan_measurements_select             ON public.scan_measurements;
-- DROP POLICY   IF EXISTS scan_measurements_insert             ON public.scan_measurements;
-- DROP POLICY   IF EXISTS scan_measurements_update             ON public.scan_measurements;
-- DROP POLICY   IF EXISTS scan_measurements_delete             ON public.scan_measurements;
-- DROP POLICY   IF EXISTS scan_annotations_select              ON public.scan_annotations;
-- DROP POLICY   IF EXISTS scan_annotations_insert              ON public.scan_annotations;
-- DROP POLICY   IF EXISTS scan_annotations_update              ON public.scan_annotations;
-- DROP POLICY   IF EXISTS scan_annotations_delete              ON public.scan_annotations;
-- DROP POLICY   IF EXISTS scan_quality_reports_select          ON public.scan_quality_reports;
-- DROP POLICY   IF EXISTS scan_quality_reports_operator_all    ON public.scan_quality_reports;
-- DROP POLICY   IF EXISTS scan_events_select                   ON public.scan_events;
-- DROP POLICY   IF EXISTS scan_events_operator_delete          ON public.scan_events;
--
-- DROP FUNCTION IF EXISTS public.spatial_dispute_lock_guard();
-- DROP FUNCTION IF EXISTS public.spatial_scan_is_locked(uuid);
-- DROP FUNCTION IF EXISTS public.spatial_is_job_worker(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.spatial_is_job_craftsman(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.spatial_can_edit_scan(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.spatial_can_view_scan(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.spatial_is_operator(uuid);

-- ── External steps (still pending) ────────────────────────────────────────────
-- 1. SECURITY DEFINER RPCs for scan_events INSERT (record_scan_event, scan_event_log, etc.)
--    + Quality Engine SECURITY DEFINER (scan_quality_reports INSERT)
-- 2. Storage RLS for project-scans bucket sub-paths per asset kind:
--      {userId}/{scanId}/scan.usdz
--      {userId}/{scanId}/scan.gltf
--      {userId}/{scanId}/scan.json
--      {userId}/{scanId}/mesh_summary.json
--      {userId}/{scanId}/thumbnail_*.png
--      {userId}/{scanId}/floorplan.svg
-- 3. Realtime publication add for scan_annotations + scan_measurements (V1+)
-- 4. job_assignments status enum freeze (currently text - the assignment-status
--    list in helper functions is best-effort; pin via enum in a follow-up).
