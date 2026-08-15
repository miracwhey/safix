-- H12: Terminal-Status-Immutability für public.jobs
-- Prod-Grounding (Dumps 2026-06-10): jobs hat NUR Trigger set_jobs_updated_at
-- (BEFORE UPDATE → set_updated_at()); jobs_status_check erlaubt
-- new|booked|scheduled|in_progress|waiting_payment|completed|cancelled,
-- erzwingt aber keine Übergänge. Client-FSM (stateMachine.ts):
-- completed/cancelled sind terminal.
-- Bypass-Muster gespiegelt von public.disputes_status_change_guard (Prod):
-- service-role (auth.uid() IS NULL: stripe-webhook, Cron-Reconciliation,
-- api/* Admin-Client) und Operatoren dürfen reparieren.
-- ERRCODE 23514 (check_violation): wird von src/lib/persistence/classifyFailure.ts
-- (Klasse 23) als 'business-rejected' klassifiziert → flushPendingMutations
-- dropt den Queue-Eintrag permanent statt endlos zu replayen.

CREATE OR REPLACE FUNCTION public.jobs_terminal_status_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF auth.uid() IS NULL OR public.is_current_user_operator() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'terminal_status_immutable: job % cannot leave terminal status % (attempted %)',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Default-EXECUTE-Hygiene (CREATE FUNCTION grantet via Default-Privileges an PUBLIC/anon):
REVOKE ALL ON FUNCTION public.jobs_terminal_status_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS jobs_terminal_status_guard_tg ON public.jobs;
CREATE TRIGGER jobs_terminal_status_guard_tg
  BEFORE UPDATE OF status ON public.jobs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.jobs_terminal_status_guard();

-- Defensiv: stale PostgREST-Schema-Cache nach Migration
NOTIFY pgrst, 'reload schema';
