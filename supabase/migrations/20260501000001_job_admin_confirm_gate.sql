-- Block 7.2.1b — L4 Admin-Confirm-Gate Backend
--
-- Trennt den Job-Completion-Pfad in zwei Schritte:
--   1. Worker meldet die Arbeit als fertig (`work_marked_complete_at`).
--      → Kein Status-Change, keine Acceptance, keine Tranche-Eligibility.
--   2. Admin (Owner) bestätigt (`work_confirmed_complete_at`).
--      → Acceptance öffnet, Tranche 75% wird eligible, Job geht in
--        `waiting_payment`, Customer bekommt Push.
--
-- Status-Modell-Entscheidung:
-- Job bleibt während Worker-Mark im Status `in_progress`. Der Sub-State 2.5
-- ("Wartet auf Bestätigung") wird rein über die Stamps abgeleitet
-- (`work_marked_complete_at && !work_confirmed_complete_at`). Dadurch entfällt
-- eine Reverse-Transition `waiting_payment → in_progress` und die
-- State-Machine bleibt unangetastet.
--
-- Pre-Deploy-Verify gegen Prod 2026-05-01 (read-only via Supabase MCP):
--   * Spalten existieren noch nicht (0 Rows in information_schema.columns).
--   * 0 Bestand-Jobs mit `work_completed_at IS NOT NULL` → Backfill ist no-op.
--   * 12 Jobs total in Prod.
--
-- Die Co-Existenz-Spalte `work_completed_at` bleibt vorerst — sie wird ab
-- jetzt nur noch via `confirmJobCompletionWorkflow` als Alias auf
-- `work_confirmed_complete_at` gesetzt. Cleanup-Block entfernt sie, sobald
-- alle Konsumenten migriert sind.

-- 1) Neue Stamp-Spalten ─────────────────────────────────────────────────────
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS work_marked_complete_at bigint,
  ADD COLUMN IF NOT EXISTS work_confirmed_complete_at bigint;

-- 2) Backfill ────────────────────────────────────────────────────────────────
-- Bestand-Jobs mit gesetztem `work_completed_at` werden retroaktiv als
-- "Solo-Owner-Mark" interpretiert (sowohl gemeldet als auch bestätigt).
-- In Prod aktuell 0 Rows → effektiv no-op, aber idempotent für Re-Runs und
-- für die staging/local-Umgebungen.
UPDATE public.jobs
SET work_marked_complete_at = work_completed_at,
    work_confirmed_complete_at = work_completed_at
WHERE work_completed_at IS NOT NULL
  AND work_marked_complete_at IS NULL;

-- 3) Doc-Comment auf der Legacy-Spalte ──────────────────────────────────────
COMMENT ON COLUMN public.jobs.work_completed_at IS
  'DEPRECATED — alias für work_confirmed_complete_at. Wird via confirmJobCompletionWorkflow gesetzt. Cleanup-Block entfernt diese Spalte sobald alle Konsumenten migriert sind.';
