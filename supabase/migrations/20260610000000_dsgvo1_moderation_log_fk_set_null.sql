-- =============================================================================
-- DSGVO-1: moderation_action_log darf Account-Deletion nie blockieren
-- =============================================================================
-- Problem (LIVE prod verifiziert 2026-06-10, 0 Rows → latent):
--   3 FKs mit ON DELETE RESTRICT blocken via profiles.id→auth.users CASCADE
--   jeden admin.deleteUser für je-moderierte User PERMANENT (Art. 17 DSGVO +
--   Apple 5.1.1(v)); report_id→user_reports blockt TRANSITIV, weil
--   user_reports.reporter_id/reported_id→profiles ON DELETE CASCADE sind.
--   Storage-Purge + account_cascade_delete_owned_rows (Step 3.5) laufen davor
--   und sind unwiderruflich → Zombie-Account.
-- Fix: FK-Level ON DELETE SET NULL (engine-enforced, pfadunabhängig).
--   NULL = DSGVO-konforme Anonymisierung; Audit-Fakten (action_type,
--   target_entity_*, notes, suspension_until, created_at) bleiben erhalten.
--   Append-Only intakt: SET NULL läuft als interner RI-Trigger des Owners,
--   KEINE GRANT-Änderung nötig (writes bereits revoked von PUBLIC/anon/
--   authenticated, nur SELECT für authenticated — live verifiziert).
--   Idiom-Vorbild: user_reports.reviewed_by ON DELETE SET NULL.

ALTER TABLE public.moderation_action_log
  ALTER COLUMN operator_id    DROP NOT NULL,
  ALTER COLUMN target_user_id DROP NOT NULL,
  ALTER COLUMN report_id      DROP NOT NULL;

ALTER TABLE public.moderation_action_log
  DROP CONSTRAINT moderation_action_log_operator_id_fkey,
  ADD CONSTRAINT moderation_action_log_operator_id_fkey
    FOREIGN KEY (operator_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.moderation_action_log
  DROP CONSTRAINT moderation_action_log_target_user_id_fkey,
  ADD CONSTRAINT moderation_action_log_target_user_id_fkey
    FOREIGN KEY (target_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.moderation_action_log
  DROP CONSTRAINT moderation_action_log_report_id_fkey,
  ADD CONSTRAINT moderation_action_log_report_id_fkey
    FOREIGN KEY (report_id) REFERENCES public.user_reports(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.moderation_action_log.operator_id IS
  'NULL = Operator-Konto geloescht (DSGVO Art. 17, FK ON DELETE SET NULL).';
COMMENT ON COLUMN public.moderation_action_log.target_user_id IS
  'NULL = Ziel-Konto geloescht (DSGVO Art. 17, FK ON DELETE SET NULL).';
COMMENT ON COLUMN public.moderation_action_log.report_id IS
  'NULL = zugehoeriger user_reports-Eintrag via Account-Cascade geloescht.';

NOTIFY pgrst, 'reload schema';
