-- =============================================================================
-- CHAT-CUTOVER Slice E/2: Legacy conversations/messages — Final-Revoke
-- =============================================================================
-- ⚠️ APPLY-GATE (Plan chat-cutover-block-2026-06-10-plan.md): erst NACH
--   (a) 20260611000000 + 20260611100000 applied,
--   (b) Vercel-Env-Flip VITE_CHAT_UI_CUTOVER_{CUSTOMER,CRAFTSMAN}=true
--       deployed (Erstkontakt + Anfrage-Eingang laufen auf chat_threads),
--   (c) Device-Smoke des Cutover-Blocks grün.
-- DB und Code müssen zusammen rollen — Revoke vor dem Flag-Flip bricht den
-- Erstkontakt erneut mit 42501 (Lehre aus 20260610190000).
--
-- Was passiert:
--   * Brücken-Grants aus 20260610190000 werden zurückgenommen (authenticated
--     verliert INSERT/UPDATE auf conversations, INSERT auf messages) — die
--     Legacy-Tabellen werden read-only für Clients.
--   * anon-Hygiene: SELECT/TRIGGER/REFERENCES auf beiden Tabellen revoked
--     (Befund 2026-06-10: anon hatte Default-Grants; RLS filterte zwar auf
--     0 Rows, aber die Fläche ist unnötig).
--   * authenticated behält SELECT (+TRIGGER/REFERENCES-Hygiene ebenfalls
--     weg): Read-Archive für Legacy-Lookups + Lazy-Message-Migration bis zum
--     DROP TABLE (separater Housekeeping-Block nach Safety-Window).
--
-- Rollback (nur zusammen mit Code-Rollback):
--   GRANT INSERT, UPDATE ON public.conversations TO authenticated;
--   GRANT INSERT         ON public.messages      TO authenticated;
-- =============================================================================

-- Brücken-Grants zurück (20260610190000-Inverse):
REVOKE INSERT, UPDATE ON public.conversations FROM authenticated;
REVOKE INSERT         ON public.messages      FROM authenticated;

-- anon-Hygiene (Default-Grant-Fläche):
REVOKE SELECT, TRIGGER, REFERENCES ON public.conversations FROM anon;
REVOKE SELECT, TRIGGER, REFERENCES ON public.messages      FROM anon;

-- authenticated-Hygiene: nur noch SELECT (Read-Archive).
REVOKE TRIGGER, REFERENCES ON public.conversations FROM authenticated;
REVOKE TRIGGER, REFERENCES ON public.messages      FROM authenticated;

COMMENT ON TABLE public.conversations IS
  'LEGACY (retired 2026-06-11, Chat-Cutover): read-only Archiv. Writes laufen auf chat_threads. DROP frühestens nach Safety-Window 2026-07-11, wenn Lazy-Message-Migration abgeschlossen ist.';
COMMENT ON TABLE public.messages IS
  'LEGACY (retired 2026-06-11, Chat-Cutover): read-only Archiv. Writes laufen auf chat_messages. DROP frühestens nach Safety-Window 2026-07-11, wenn Lazy-Message-Migration abgeschlossen ist.';

NOTIFY pgrst, 'reload schema';
