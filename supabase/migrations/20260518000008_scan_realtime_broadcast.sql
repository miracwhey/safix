-- Spatial Core · Block A.1 · Realtime Broadcast-from-DB + Topic Authorization
--
-- Decision (revised after audit, see Obsidian: 2026-05-17 Spatial V1 Roadmap A1 Handover):
-- For the spatial domain we use **Broadcast-from-DB** (`realtime.send()`) rather
-- than postgres_changes via the `supabase_realtime` publication.
--
-- Why:
--   * No REPLICA IDENTITY FULL gotcha for filtered DELETE-events.
--   * Trigger controls the payload shape — lean events instead of full rows.
--   * Channel auth on `realtime.messages` lets us gate per-scan / per-project
--     topics with the same `spatial_can_view_scan` helpers used by table RLS.
--   * The trigger runs SECURITY DEFINER so it bypasses RLS on the broadcast
--     path itself — clients still hit `realtime.messages` RLS on subscribe.
--
-- Topic-schema (lowercase, anchored regex on subscribe):
--   scan:{scanId}                  — single-scan presence/broadcast
--   project:{projectId}:scans      — project fanout (all scans of a project)
--
-- Subscribers MUST set `{ config: { private: true } }` on the channel,
-- and the client MUST call `supabase.realtime.setAuth()` after every
-- TOKEN_REFRESHED auth event (otherwise the JOIN runs as anon and the
-- RLS denies silently with a CHANNEL_ERROR).
--
-- External step (one-time, per project):
--   * Dashboard → Realtime → Settings: turn OFF "Allow public access"
--     so every channel must pass RLS. Cannot be set via SQL.

-- ── 1. Broadcast trigger function (per-row, AFTER, SECURITY DEFINER) ─────────
CREATE OR REPLACE FUNCTION public.spatial_scan_broadcast()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, realtime
AS $$
DECLARE
  v_scan_id    uuid;
  v_project_id uuid;
  v_payload    jsonb;
BEGIN
  v_scan_id    := COALESCE(NEW.id, OLD.id);
  v_project_id := COALESCE(NEW.project_id, OLD.project_id);

  v_payload := jsonb_build_object(
    'op',         TG_OP,
    'id',         v_scan_id,
    'status',     COALESCE(NEW.status, OLD.status),
    'project_id', v_project_id,
    'job_id',     COALESCE(NEW.job_id, OLD.job_id),
    'updated_at', COALESCE(NEW.updated_at, OLD.updated_at)
  );

  PERFORM realtime.send(v_payload, TG_OP, 'scan:' || v_scan_id::text, true);
  IF v_project_id IS NOT NULL THEN
    PERFORM realtime.send(v_payload, TG_OP, 'project:' || v_project_id::text || ':scans', true);
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.spatial_scan_broadcast()
  IS 'Spatial Core: lean per-row broadcast to scan:{id} + project:{id}:scans topics on INSERT/UPDATE/DELETE of public.scans. Payload is metadata only — clients re-fetch detail on receipt.';

REVOKE EXECUTE ON FUNCTION public.spatial_scan_broadcast() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS scans_broadcast_aiud ON public.scans;
CREATE TRIGGER scans_broadcast_aiud
  AFTER INSERT OR UPDATE OR DELETE ON public.scans
  FOR EACH ROW
  EXECUTE FUNCTION public.spatial_scan_broadcast();

-- ── 2. scan_events broadcast (INSERT only — append-only audit) ───────────────
CREATE OR REPLACE FUNCTION public.spatial_scan_event_broadcast()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, realtime
AS $$
DECLARE
  v_project_id uuid;
  v_payload    jsonb;
BEGIN
  SELECT project_id INTO v_project_id FROM public.scans WHERE id = NEW.scan_id;

  v_payload := jsonb_build_object(
    'op',        'INSERT',
    'kind',      'scan_event',
    'id',        NEW.id,
    'scan_id',   NEW.scan_id,
    'action',    NEW.action,
    'actor_id',  NEW.actor_id,
    'at',        NEW.at
  );

  PERFORM realtime.send(v_payload, 'scan_event', 'scan:' || NEW.scan_id::text, true);
  IF v_project_id IS NOT NULL THEN
    PERFORM realtime.send(v_payload, 'scan_event', 'project:' || v_project_id::text || ':scans', true);
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.spatial_scan_event_broadcast()
  IS 'Spatial Core: broadcasts scan_events.INSERT to scan + project topics. Read via spatial_can_view_scan-gated channel auth.';

REVOKE EXECUTE ON FUNCTION public.spatial_scan_event_broadcast() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS scan_events_broadcast_ai ON public.scan_events;
CREATE TRIGGER scan_events_broadcast_ai
  AFTER INSERT ON public.scan_events
  FOR EACH ROW
  EXECUTE FUNCTION public.spatial_scan_event_broadcast();

-- ── 3. scan_quality_reports broadcast (INSERT — Quality Engine outputs) ──────
CREATE OR REPLACE FUNCTION public.spatial_scan_quality_broadcast()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, realtime
AS $$
DECLARE
  v_project_id uuid;
  v_payload    jsonb;
BEGIN
  SELECT project_id INTO v_project_id FROM public.scans WHERE id = NEW.scan_id;

  v_payload := jsonb_build_object(
    'op',           'INSERT',
    'kind',         'quality_report',
    'id',           NEW.id,
    'scan_id',      NEW.scan_id,
    'score',        NEW.score,
    'bucket',       NEW.bucket,
    'generated_at', NEW.generated_at
  );

  PERFORM realtime.send(v_payload, 'quality_report', 'scan:' || NEW.scan_id::text, true);
  IF v_project_id IS NOT NULL THEN
    PERFORM realtime.send(v_payload, 'quality_report', 'project:' || v_project_id::text || ':scans', true);
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.spatial_scan_quality_broadcast()
  IS 'Spatial Core: broadcasts scan_quality_reports.INSERT for instant UI bucket-update without re-fetch.';

REVOKE EXECUTE ON FUNCTION public.spatial_scan_quality_broadcast() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS scan_quality_reports_broadcast_ai ON public.scan_quality_reports;
CREATE TRIGGER scan_quality_reports_broadcast_ai
  AFTER INSERT ON public.scan_quality_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.spatial_scan_quality_broadcast();

-- ── 4. Topic-naming regex helper (anchored, lowercase-uuid only) ─────────────
CREATE OR REPLACE FUNCTION public.spatial_realtime_uuid_pat()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' $$;

COMMENT ON FUNCTION public.spatial_realtime_uuid_pat()
  IS 'Spatial Core: lowercase-uuid regex fragment used in realtime.messages RLS policies to prevent prefix-wildcard topic leaks.';

REVOKE EXECUTE ON FUNCTION public.spatial_realtime_uuid_pat() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_realtime_uuid_pat() TO authenticated;

-- ── 5. realtime.messages RLS — subscribe (SELECT) + send (INSERT) ────────────
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

-- scan:{scanId} — subscribe (SELECT) gated by spatial_can_view_scan
DROP POLICY IF EXISTS spatial_scan_topic_read ON realtime.messages;
CREATE POLICY spatial_scan_topic_read
  ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    extension IN ('broadcast', 'presence')
    AND realtime.topic() ~ ('^scan:' || public.spatial_realtime_uuid_pat() || '$')
    AND public.spatial_can_view_scan(
          substring(realtime.topic() from 6)::uuid,
          (SELECT auth.uid())
        )
  );

-- project:{projectId}:scans — subscribe gated by project membership
-- (customer-owner OR assigned craftsman OR team-member of the assigned office).
DROP POLICY IF EXISTS spatial_project_scans_topic_read ON realtime.messages;
CREATE POLICY spatial_project_scans_topic_read
  ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    extension IN ('broadcast', 'presence')
    AND realtime.topic() ~ ('^project:' || public.spatial_realtime_uuid_pat() || ':scans$')
    AND (
      EXISTS (
        SELECT 1 FROM public.projects
        WHERE id = substring(realtime.topic() from 9 for 36)::uuid
          AND customer_user_id = (SELECT auth.uid())
      )
      OR EXISTS (
        SELECT 1 FROM public.jobs
        WHERE project_id = substring(realtime.topic() from 9 for 36)
          AND craftsman_user_id = ((SELECT auth.uid()))::text
      )
    )
  );

-- scan:{scanId} — client send (INSERT). Edit-capability gate.
-- project:{...}:scans gets NO INSERT policy → fanout topics are server-only
-- (the trigger writes via realtime.send() and bypasses RLS by SECURITY DEFINER).
DROP POLICY IF EXISTS spatial_scan_topic_write ON realtime.messages;
CREATE POLICY spatial_scan_topic_write
  ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    extension IN ('broadcast', 'presence')
    AND realtime.topic() ~ ('^scan:' || public.spatial_realtime_uuid_pat() || '$')
    AND public.spatial_can_edit_scan(
          substring(realtime.topic() from 6)::uuid,
          (SELECT auth.uid())
        )
  );

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP POLICY  IF EXISTS spatial_scan_topic_write           ON realtime.messages;
-- DROP POLICY  IF EXISTS spatial_project_scans_topic_read   ON realtime.messages;
-- DROP POLICY  IF EXISTS spatial_scan_topic_read            ON realtime.messages;
-- DROP TRIGGER IF EXISTS scan_quality_reports_broadcast_ai  ON public.scan_quality_reports;
-- DROP TRIGGER IF EXISTS scan_events_broadcast_ai           ON public.scan_events;
-- DROP TRIGGER IF EXISTS scans_broadcast_aiud               ON public.scans;
-- DROP FUNCTION IF EXISTS public.spatial_realtime_uuid_pat();
-- DROP FUNCTION IF EXISTS public.spatial_scan_quality_broadcast();
-- DROP FUNCTION IF EXISTS public.spatial_scan_event_broadcast();
-- DROP FUNCTION IF EXISTS public.spatial_scan_broadcast();

-- ── External steps (NEEDS USER CONFIRMATION before going live) ───────────────
-- 1. Supabase Dashboard → Project Settings → Realtime → turn OFF "Allow public
--    access" (the public toggle bypasses RLS even on `private:true` channels).
-- 2. Client wiring (separate commit in this branch):
--    * Call `supabase.realtime.setAuth()` once after sign-in.
--    * Re-call on `auth.onAuthStateChange('TOKEN_REFRESHED')` event.
--    * Subscribe with `{ config: { private: true } }`.
