-- =============================================================================
-- pgTAP behavioral test: CHAT-CUTOVER Slice E — Legacy-Retire-Grants auf
--   public.conversations / public.messages
-- =============================================================================
-- Source of truth:
--   supabase/migrations/20260611200000_legacy_conversations_final_retire.sql
--   (Inverse der Brücke 20260610190000_conv_messages_restore_authenticated_writes)
--
-- WHAT THIS PROVES (grant-level — PostgreSQL prüft Grants VOR RLS, genau die
-- Schicht, deren Fehlen den Erstkontakt-42501 verursachte und deren
-- Wieder-Öffnung die Brücke war):
--   * anon hat auf beiden Tabellen weder SELECT noch INSERT noch UPDATE noch
--     TRIGGER/REFERENCES (Default-Grant-Fläche zu).
--   * authenticated ist read-only: SELECT ja, INSERT/UPDATE/TRIGGER/
--     REFERENCES nein (Brücken-Grants zurückgenommen).
--   * service_role behält Vollzugriff (Admin-/Migrationspfade).
--
-- Läuft NUR auf einem Stack, auf dem 20260611200000 applied ist — bis zum
-- Slice-E-Apply ist diese Suite erwartungsgemäß ROT auf Prod-nahen Ständen
-- (advisory, wie 04–07 am bekannten Ledger-Drift).
-- Run with: supabase test db
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path to public, extensions, pg_catalog;

select plan(14);

-- ── anon: alles zu ──────────────────────────────────────────────────────────
select ok(not has_table_privilege('anon', 'public.conversations', 'SELECT'), 'anon cannot SELECT conversations');
select ok(not has_table_privilege('anon', 'public.conversations', 'INSERT'), 'anon cannot INSERT conversations');
select ok(not has_table_privilege('anon', 'public.conversations', 'UPDATE'), 'anon cannot UPDATE conversations');
select ok(not has_table_privilege('anon', 'public.messages', 'SELECT'), 'anon cannot SELECT messages');
select ok(not has_table_privilege('anon', 'public.messages', 'INSERT'), 'anon cannot INSERT messages');
select ok(not has_table_privilege('anon', 'public.messages', 'UPDATE'), 'anon cannot UPDATE messages');

-- ── authenticated: read-only Archiv ────────────────────────────────────────
select ok(has_table_privilege('authenticated', 'public.conversations', 'SELECT'), 'authenticated keeps SELECT on conversations (read archive)');
select ok(not has_table_privilege('authenticated', 'public.conversations', 'INSERT'), 'authenticated cannot INSERT conversations (bridge revoked)');
select ok(not has_table_privilege('authenticated', 'public.conversations', 'UPDATE'), 'authenticated cannot UPDATE conversations (bridge revoked)');
select ok(has_table_privilege('authenticated', 'public.messages', 'SELECT'), 'authenticated keeps SELECT on messages (read archive)');
select ok(not has_table_privilege('authenticated', 'public.messages', 'INSERT'), 'authenticated cannot INSERT messages (bridge revoked)');
select ok(not has_table_privilege('authenticated', 'public.messages', 'TRIGGER'), 'authenticated TRIGGER hygiene on messages');

-- ── service_role: Vollzugriff bleibt ───────────────────────────────────────
select ok(has_table_privilege('service_role', 'public.conversations', 'INSERT'), 'service_role keeps INSERT on conversations');
select ok(has_table_privilege('service_role', 'public.messages', 'INSERT'), 'service_role keeps INSERT on messages');

select * from finish();

rollback;
