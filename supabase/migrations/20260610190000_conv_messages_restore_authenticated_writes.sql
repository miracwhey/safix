-- =============================================================================
-- CONV-GRANT (Brücke): Erstkontakt-Schreibrechte auf Legacy-Inbox wiederherstellen
-- =============================================================================
-- Befund (read-only Prod, 2026-06-10): authenticated hatte auf public.conversations
-- UND public.messages NUR SELECT/REFERENCES/TRIGGER — die Table-GRANTs INSERT/UPDATE
-- fehlten, obwohl die RLS-Policies live sind (conversations_insert_own WITH CHECK
-- customer_user_id=auth.uid() · conversations_update_own beide Parteien ·
-- messages_insert_own · spatial_scan_topic_write). PostgreSQL prüft den GRANT VOR
-- der RLS-Policy → jeder Erstkontakt Kunde→Handwerker (alle 5 Inquiry-Einstiege in
-- exploreInquiryWorkflow.ts via SupabaseMessageRepository.addConversation():607 +
-- addMessageAndUpdateConversation) failte mit 42501, ebenso die Spatial-Topic-Writes
-- auf messages. Vermutliche Ursache: Slice-7-Retire-Revoke lief, der zugehörige
-- Chat-Cutover (conversations-Retire → chat_threads) wurde aber nie scharf geschaltet.
-- Repo-Migration 20260512000001 erwartet die Grants (revoked nur DELETE/TRUNCATE).
--
-- ⚠️ BRÜCKE, kein Endzustand: Der Chat-Cutover-Block (Erstkontakt + Anfrage-Eingang
-- vollständig auf chat_threads, conversations-Retire) ist verbindlich geplant —
-- siehe Obsidian Current Block. Bis dahin ist die RLS der Zaun: INSERT nur als
-- Kunde der eigenen Row, UPDATE nur eigene Rows; messages hat keine UPDATE/DELETE-
-- Policy → bleibt default-deny (kein UPDATE-Grant nötig, minimal-invasiv).

GRANT INSERT, UPDATE ON public.conversations TO authenticated;
GRANT INSERT         ON public.messages      TO authenticated;

NOTIFY pgrst, 'reload schema';
