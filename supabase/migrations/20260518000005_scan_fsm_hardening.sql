-- Spatial Core · Block A.1 · Scan FSM Hardening
--
-- Promotes the scan-status state machine from app-code convention to a
-- DB-enforced invariant. Two new tables, one trigger, one function. Once
-- this migration lands, no app-code path (or hand-written UPDATE) can move
-- a scan into an illegal state — the trigger raises 'check_violation' and
-- the transaction rolls back atomically.
--
-- Decisions wired in (see Obsidian: 2026-05-17 Spatial V1 Roadmap A1 Handover):
--   D14 — FSM as DB-trigger now (A.1), not app-code-FSM later.
--
-- Hardening over the minimal trigger:
--   * Append-only audit table (scan_status_transition_log) with RLS deny-all
--     writes + REVOKE INSERT/UPDATE/DELETE/TRUNCATE — defense-in-depth.
--   * actor_id NULL allowed but only when reason IS NOT NULL (CHECK) — cron
--     and SECURITY DEFINER paths must explain themselves; no ghost transitions.
--   * INSERT-side guard: new scans must start at status='draft' — the trigger
--     fires BEFORE INSERT too, so a hand-rolled INSERT with status='offer_ready'
--     is rejected.
--   * Same-state UPDATEs short-circuit (IS NOT DISTINCT FROM) so the function
--     is essentially free for non-status updates and idempotent for re-locks.
--   * Operator unlock paths from 'locked_for_dispute' are seeded explicitly
--     (provider_verified / offer_ready / archived) — the existing dispute-lock
--     guard already gates who can fire the UPDATE; the FSM gates where to.
--
-- Lock semantics: a tuple's row-lock from UPDATE already serializes concurrent
-- transitions on the same scan. A second writer blocks on the lock, then re-reads
-- the post-commit status and re-evaluates the FSM. No pg_advisory_xact_lock
-- needed — adding one would just expand deadlock surface for no gain.
--
-- Trigger fire order is alphabetical by trigger name on the same event:
--   scans_dispute_lock_guard  (existing, from _block_a_schema migration)
--   scans_enforce_fsm         (this migration, after `d` lexically)
-- Result: a locked scan is rejected by dispute-lock-guard before the FSM is
-- even consulted. Operator unlocks pass the dispute-lock-guard (operator role
-- bypass) and then must pass the FSM check.

-- ── 1. Lookup table: allowed (from -> to) edges ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.scan_status_transition_allowed (
  from_status public.scan_status NOT NULL,
  to_status   public.scan_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

COMMENT ON TABLE public.scan_status_transition_allowed
  IS 'Spatial Core FSM: allowed (from -> to) edges for scans.status. Seed-driven, change via migration only. Mirror in src/lib/spatial/repository/fsm.ts.';

INSERT INTO public.scan_status_transition_allowed (from_status, to_status) VALUES
  -- Capture loop
  ('draft',                  'capturing'),
  ('capturing',              'captured'),
  ('capturing',              'draft'),
  -- Quality + verification
  ('captured',               'quality_checked'),
  ('captured',               'capturing'),
  ('quality_checked',        'needs_rescan'),
  ('quality_checked',        'needs_provider_review'),
  ('quality_checked',        'provider_verified'),
  ('needs_rescan',           'capturing'),
  ('needs_provider_review',  'provider_verified'),
  ('needs_provider_review',  'needs_rescan'),
  -- Provider sign-off → offer
  ('provider_verified',      'offer_ready'),
  ('provider_verified',      'locked_for_dispute'),
  ('offer_ready',            'locked_for_dispute'),
  ('offer_ready',            'archived'),
  -- Operator unlock paths (dispute-lock guard allows operator-only UPDATE out
  -- of locked_for_dispute; the FSM permits the destinations explicitly).
  ('locked_for_dispute',     'provider_verified'),
  ('locked_for_dispute',     'offer_ready'),
  ('locked_for_dispute',     'archived')
ON CONFLICT DO NOTHING;

ALTER TABLE public.scan_status_transition_allowed ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scan_status_transition_allowed FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.scan_status_transition_allowed TO authenticated;

DROP POLICY IF EXISTS scan_status_transition_allowed_select_authenticated
  ON public.scan_status_transition_allowed;
CREATE POLICY scan_status_transition_allowed_select_authenticated
  ON public.scan_status_transition_allowed
  FOR SELECT TO authenticated
  USING (true);

-- ── 2. Append-only audit log ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scan_status_transition_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id     uuid NOT NULL REFERENCES public.scans(id) ON DELETE CASCADE,
  from_status public.scan_status,
  to_status   public.scan_status NOT NULL,
  actor_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason      text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scan_status_transition_log_actor_or_reason_chk
    CHECK (actor_id IS NOT NULL OR reason IS NOT NULL),
  CONSTRAINT scan_status_transition_log_progress_chk
    CHECK (from_status IS DISTINCT FROM to_status)
);

CREATE INDEX IF NOT EXISTS scan_status_transition_log_scan_id_at_idx
  ON public.scan_status_transition_log (scan_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS scan_status_transition_log_actor_id_idx
  ON public.scan_status_transition_log (actor_id)
  WHERE actor_id IS NOT NULL;

COMMENT ON TABLE public.scan_status_transition_log
  IS 'Spatial Core FSM: append-only transition history. Writes only via enforce_scan_fsm() (SECURITY DEFINER). Read via spatial_can_view_scan(scan_id).';
COMMENT ON CONSTRAINT scan_status_transition_log_actor_or_reason_chk
  ON public.scan_status_transition_log
  IS 'No ghost transitions: cron/system writes pass NULL actor_id but MUST supply a reason.';

ALTER TABLE public.scan_status_transition_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scan_status_transition_log FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.scan_status_transition_log FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.scan_status_transition_log FROM authenticated;
GRANT SELECT ON public.scan_status_transition_log TO authenticated;

DROP POLICY IF EXISTS scan_status_transition_log_select_viewer
  ON public.scan_status_transition_log;
CREATE POLICY scan_status_transition_log_select_viewer
  ON public.scan_status_transition_log
  FOR SELECT TO authenticated
  USING (public.spatial_can_view_scan(scan_id, (SELECT auth.uid())));

-- Operator delete kept on parity with scan_events (operator forensic-cleanup).
DROP POLICY IF EXISTS scan_status_transition_log_delete_operator
  ON public.scan_status_transition_log;
CREATE POLICY scan_status_transition_log_delete_operator
  ON public.scan_status_transition_log
  FOR DELETE TO authenticated
  USING (public.spatial_is_operator((SELECT auth.uid())));

-- ── 3. Trigger function ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_scan_fsm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor  uuid;
  v_reason text;
  v_old    public.scan_status;
  v_new    public.scan_status;
BEGIN
  -- INSERT: new scans must start at 'draft'.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'draft'::public.scan_status THEN
      RAISE EXCEPTION 'Illegal scan INSERT: new scans must start at status=draft (got %)', NEW.status
        USING ERRCODE = 'check_violation',
              HINT    = 'Insert with status=draft, then UPDATE via the FSM. See scan_status_transition_allowed.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: short-circuit if status unchanged (so unrelated UPDATEs are free).
  v_old := OLD.status;
  v_new := NEW.status;
  IF v_new IS NOT DISTINCT FROM v_old THEN
    RETURN NEW;
  END IF;

  -- Reject if (old -> new) is not a seeded edge.
  IF NOT EXISTS (
    SELECT 1
    FROM public.scan_status_transition_allowed
    WHERE from_status = v_old AND to_status = v_new
  ) THEN
    RAISE EXCEPTION 'Illegal scan transition: % -> %', v_old, v_new
      USING ERRCODE = 'check_violation',
            HINT    = 'See public.scan_status_transition_allowed for the FSM diagram.';
  END IF;

  -- Append-only audit. actor_id := auth.uid(); reason from session GUC if set.
  -- The GUC is intentionally optional so app-code paths (which always have
  -- auth.uid()) can fire UPDATEs without ceremony. Cron/SECURITY DEFINER
  -- writes are NULL actor — those MUST set the GUC or the CHECK rejects.
  v_actor  := auth.uid();
  v_reason := current_setting('app.scan_fsm_reason', true);
  IF v_reason = '' THEN
    v_reason := NULL;
  END IF;

  INSERT INTO public.scan_status_transition_log
    (scan_id, from_status, to_status, actor_id, reason)
  VALUES
    (NEW.id, v_old, v_new, v_actor, v_reason);

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_scan_fsm()
  IS 'Spatial Core FSM trigger: validates scans.status transitions against scan_status_transition_allowed and writes scan_status_transition_log. Fires alphabetically AFTER scans_dispute_lock_guard.';

REVOKE EXECUTE ON FUNCTION public.enforce_scan_fsm() FROM PUBLIC, anon, authenticated;

-- ── 4. Triggers (INSERT + UPDATE OF status) ──────────────────────────────────
DROP TRIGGER IF EXISTS scans_enforce_fsm_insert ON public.scans;
CREATE TRIGGER scans_enforce_fsm_insert
  BEFORE INSERT ON public.scans
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_scan_fsm();

DROP TRIGGER IF EXISTS scans_enforce_fsm_update ON public.scans;
CREATE TRIGGER scans_enforce_fsm_update
  BEFORE UPDATE OF status ON public.scans
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.enforce_scan_fsm();

-- ── Rollback (manual) ────────────────────────────────────────────────────────
-- DROP TRIGGER  IF EXISTS scans_enforce_fsm_update  ON public.scans;
-- DROP TRIGGER  IF EXISTS scans_enforce_fsm_insert  ON public.scans;
-- DROP FUNCTION IF EXISTS public.enforce_scan_fsm();
-- DROP TABLE    IF EXISTS public.scan_status_transition_log;
-- DROP TABLE    IF EXISTS public.scan_status_transition_allowed;
