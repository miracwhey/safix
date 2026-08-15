-- Block 7.2.7b · Phase 4 Auto-Apply (wrong_time)
-- approveCorrectionWorkflow soll bei kind='wrong_time' die vorgeschlagene Zeit
-- automatisch auf den verknüpften calendar_entry anwenden. Best-effort:
-- Format-Fail / Repo-Error → Status-Update geht durch, Skip-Reason persistiert.
--
-- Pre-State verified 2026-05-02 via MCP execute_sql:
--   - 16 Spalten, 4 structured-fields aus 7.2.3 vorhanden
--   - apply-Trace-Spalten NICHT vorhanden
--   - 1 Bestand-Row (kind='wrong_time', noch pending) → NULL-Defaults sicher
-- Forward-only additive Migration. Keine RLS-Touch, keine Index-Änderung.

ALTER TABLE public.correction_requests
  ADD COLUMN IF NOT EXISTS applied_at bigint,
  ADD COLUMN IF NOT EXISTS applied_target_entry_id uuid,
  ADD COLUMN IF NOT EXISTS apply_skip_reason text;
