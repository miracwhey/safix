-- =====================================================================
-- Disputes SLA Reminder — partial index for the cron query
-- =====================================================================
-- Block N13.SLA-Cron — supports the hourly query
--   SELECT id, job_id, status, updated_at, metadata
--   FROM disputes
--   WHERE status IN ('customer_waiting', 'provider_waiting')
--     AND updated_at <= now - 24h
--   LIMIT 100
--
-- Without the partial index the planner falls back to a status-only
-- scan + filter on updated_at; once *_waiting volumes grow that is a
-- table-scan tail. The partial index keeps only the rows the cron
-- actually iterates.
--
-- Pre-deploy schema verification (against prod via MCP, 2026-05-03):
--   • disputes.status, disputes.updated_at exist          ✅
--   • disputes_status_idx already covers status alone     ⚠ but no
--     (updated_at) component for the cutoff filter
--   • disputes table is small today; index cost minimal
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_disputes_sla_waiting_updated_at
  ON public.disputes (updated_at)
  WHERE status IN ('customer_waiting', 'provider_waiting');

COMMENT ON INDEX public.idx_disputes_sla_waiting_updated_at IS
  'N13.SLA-Cron: partial index over *_waiting disputes for the hourly '
  'SLA-reminder cron query (status IN (..._waiting) AND updated_at <= cutoff).';

-- ---------------------------------------------------------------------------
-- Reset trigger
-- ---------------------------------------------------------------------------
-- When the operator re-arms a dispute by flipping status BACK to
-- `customer_waiting` or `provider_waiting` (operator request_evidence
-- workflow), the per-row `metadata.sla_reminders_sent` flags from a
-- previous waiting round MUST be cleared. Without the clear, the new
-- waiting clock would inherit the prior h24/h48/h72 = true flags and
-- the cron would never fire again for that dispute, defeating the
-- whole point of the re-arm.
--
-- The trigger fires on every UPDATE that transitions INTO a *_waiting
-- state from a non-waiting state. It edits NEW.metadata in place — no
-- visible behaviour outside the SLA-Cron contract.

CREATE OR REPLACE FUNCTION public.disputes_sla_reset_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('customer_waiting', 'provider_waiting')
     AND (OLD.status IS NULL OR OLD.status NOT IN ('customer_waiting', 'provider_waiting'))
  THEN
    NEW.metadata = COALESCE(NEW.metadata, '{}'::jsonb) - 'sla_reminders_sent';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS disputes_sla_reset_trigger ON public.disputes;

CREATE TRIGGER disputes_sla_reset_trigger
  BEFORE UPDATE OF status ON public.disputes
  FOR EACH ROW
  EXECUTE FUNCTION public.disputes_sla_reset_trigger_fn();

COMMENT ON FUNCTION public.disputes_sla_reset_trigger_fn IS
  'N13.SLA-Cron: clears metadata.sla_reminders_sent when a dispute '
  're-enters customer_waiting / provider_waiting from any other state, '
  'so a fresh round of SLA reminders can fire. No-op on transitions '
  'within the *_waiting set (which never happen in the FSM today, but '
  'the guard keeps the contract explicit).';
