-- =============================================================================
-- CHAT-CUTOVER Hotfix: epoch_ms() EXECUTE für authenticated
-- =============================================================================
-- Root-Cause (Device-Smoke 2026-06-10, behavioral-reproduziert via
-- SET ROLE authenticated + INSERT): direkter PostgREST-INSERT in
-- chat_messages failte mit 42501→403, weil die Spalten-DEFAULTs
-- (created_at / server_received_at = public.epoch_ms()) als CALLER evaluiert
-- werden und authenticated kein EXECUTE auf epoch_ms() hatte — eine frühere
-- Hardening-Migration revokte PUBLIC, ohne authenticated explizit zu granten.
--
-- Nie aufgefallen, weil alle bisherigen realen Writes auf Tabellen mit
-- epoch_ms-DEFAULT über SECDEF-RPCs liefen (Owner-Privilegien decken den
-- DEFAULT). Der Cutover-Chat-Send ist der ERSTE direkte authenticated-Write
-- auf so eine Tabelle. Policy-Funktionen (is_blocked_by_me,
-- is_caller_moderation_write_allowed, chat_user_is_thread_admin) hatten ihre
-- Grants — nur epoch_ms fehlte.
--
-- anon bleibt bewusst OHNE Grant (schreibt nirgends; Hygiene).
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.epoch_ms() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
