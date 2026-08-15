-- =============================================================================
-- pgTAP behavioral test: DSGVO-1 — moderation_action_log must never block
--   account deletion (auth.users DELETE → profiles CASCADE).
-- =============================================================================
-- VERIFIED-REAL SCHEMA (live prod read 2026-06-10). Source of truth:
--   supabase/migrations/20260603000000_moderation_enforcement.sql  (original RESTRICT FKs)
--   supabase/migrations/20260610000000_dsgvo1_moderation_log_fk_set_null.sql (the fix)
--
-- WHAT THIS PROVES (behavioral, not review-by-reading):
--   * Deleting a MODERATED user's auth.users row succeeds (pre-fix: 23503 via
--     FK RESTRICT — operator_id/target_user_id→profiles, report_id→user_reports
--     transitively, because user_reports.reporter/reported→profiles CASCADE).
--   * The audit log row SURVIVES with the person reference nulled
--     (Art. 17 anonymisation) while the factual audit data stays intact.
--   * Deleting the OPERATOR account works the same way (operator_id → NULL).
--   * Schema pin: all 3 FKs are ON DELETE SET NULL (confdeltype = 'n').
--   * Append-only stays intact: authenticated gets 42501 on INSERT/UPDATE/DELETE.
--
-- Helpers vendored INLINE inside BEGIN..ROLLBACK (basejump patterns) — nothing
-- persists. Run with: supabase test db
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path to public, extensions, tests, auth, pg_catalog;

-- ---------------------------------------------------------------------------
-- Vendored supabase-test-helpers (basejump patterns), test-only, rolled back.
-- ---------------------------------------------------------------------------
create schema if not exists tests;

create or replace function tests.create_supabase_user(identifier text)
  returns uuid
  language plpgsql
  security definer
  set search_path = auth, public, pg_catalog, pg_temp
as $fn$
declare
  uid uuid := gen_random_uuid();
begin
  insert into auth.users
    (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, aud, role)
  values
    (uid,
     identifier || '@test.fixup.local',
     jsonb_build_object('test_identifier', identifier),
     '{}'::jsonb,
     now(), now(), 'authenticated', 'authenticated');
  return uid;
end;
$fn$;

create or replace function tests.get_supabase_uid(identifier text)
  returns uuid
  language plpgsql
  security definer
  set search_path = auth, public, pg_catalog, pg_temp
as $fn$
declare
  uid uuid;
begin
  select id into uid
    from auth.users
   where raw_user_meta_data ->> 'test_identifier' = identifier
   limit 1;
  if uid is null then
    raise exception 'supabase test user with identifier % not found', identifier;
  end if;
  return uid;
end;
$fn$;

create or replace function tests.authenticate_as(identifier text)
  returns void
  language plpgsql
  set search_path = auth, public, pg_catalog, pg_temp
as $fn$
declare
  u auth.users%rowtype;
begin
  reset role;  -- must run as session superuser to read auth.users + switch role; NOT security definer (Postgres forbids SET role there)
  select * into u
    from auth.users
   where raw_user_meta_data ->> 'test_identifier' = identifier
   limit 1;
  if u.id is null then
    raise exception 'supabase test user with identifier % not found', identifier;
  end if;
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', u.id::text, 'email', u.email, 'role', 'authenticated')::text,
    true
  );
end;
$fn$;

create or replace function tests.authenticate_as_service_role()
  returns void
  language plpgsql
  set search_path = auth, public, pg_catalog, pg_temp
as $fn$
begin
  reset role;
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', null, true);
end;
$fn$;

grant usage on schema tests to authenticated, service_role, anon;
grant execute on all functions in schema tests to authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
-- Plan
-- ---------------------------------------------------------------------------
select plan(13);

-- ---------------------------------------------------------------------------
-- Setup (superuser session — RLS/grants bypassed legitimately for seeding)
-- ---------------------------------------------------------------------------
select tests.create_supabase_user('dsgvo1_operator');
select tests.create_supabase_user('dsgvo1_target');

-- handle_new_user (AFTER INSERT on auth.users) creates profiles(id) rows;
-- defensive double-insert in case the local stack lacks the trigger.
insert into public.profiles (id)
select tests.get_supabase_uid('dsgvo1_operator')
on conflict (id) do nothing;
insert into public.profiles (id)
select tests.get_supabase_uid('dsgvo1_target')
on conflict (id) do nothing;

insert into public.user_reports (id, reporter_id, reported_id, reason, status)
values (
  '99999999-9999-4999-8999-999999999991',
  tests.get_supabase_uid('dsgvo1_operator'),
  tests.get_supabase_uid('dsgvo1_target'),
  'fraud',
  'actioned'
);

insert into public.moderation_action_log
  (id, operator_id, report_id, action_type, target_user_id, notes)
values (
  '99999999-9999-4999-8999-999999999992',
  tests.get_supabase_uid('dsgvo1_operator'),
  '99999999-9999-4999-8999-999999999991',
  'ban',
  tests.get_supabase_uid('dsgvo1_target'),
  'repro'
);

-- ---------------------------------------------------------------------------
-- 1–3. Schema pin: all 3 FKs are ON DELETE SET NULL ('n'), not RESTRICT ('r').
-- ---------------------------------------------------------------------------
select results_eq(
  $q$ select confdeltype::text from pg_constraint
      where conname = 'moderation_action_log_operator_id_fkey' $q$,
  array['n'],
  'schema pin: operator_id FK is ON DELETE SET NULL'
);
select results_eq(
  $q$ select confdeltype::text from pg_constraint
      where conname = 'moderation_action_log_target_user_id_fkey' $q$,
  array['n'],
  'schema pin: target_user_id FK is ON DELETE SET NULL'
);
select results_eq(
  $q$ select confdeltype::text from pg_constraint
      where conname = 'moderation_action_log_report_id_fkey' $q$,
  array['n'],
  'schema pin: report_id FK is ON DELETE SET NULL'
);

-- ---------------------------------------------------------------------------
-- 4. THE behavioral repro: deleting the moderated user's auth.users row must
--    succeed. Pre-fix this throws 23503 (FK RESTRICT blocks the profiles
--    CASCADE — directly via target_user_id, transitively via report_id).
-- ---------------------------------------------------------------------------
select lives_ok(
  $q$ delete from auth.users
      where id = tests.get_supabase_uid('dsgvo1_target') $q$,
  'DSGVO-1: deleting a moderated user account succeeds (no FK RESTRICT)'
);

-- 5. The audit log row SURVIVES the deletion.
select results_eq(
  $q$ select count(*)::int from public.moderation_action_log
      where id = '99999999-9999-4999-8999-999999999992' $q$,
  array[1],
  'audit row survives account deletion'
);

-- 6. Person references are nulled: target directly, report transitively
--    (user_reports row cascaded away via reported_id → SET NULL on report_id).
select results_eq(
  $q$ select (target_user_id is null) and (report_id is null)
      from public.moderation_action_log
      where id = '99999999-9999-4999-8999-999999999992' $q$,
  array[true],
  'target_user_id and report_id anonymised to NULL'
);

-- 7. Factual audit data stays intact (Art. 17 removes the person reference,
--    not the moderation facts).
select results_eq(
  $q$ select (action_type = 'ban') and (notes = 'repro') and (created_at is not null)
      from public.moderation_action_log
      where id = '99999999-9999-4999-8999-999999999992' $q$,
  array[true],
  'audit facts (action_type, notes, created_at) intact'
);

-- 8. Operator account deletion works the same way.
select lives_ok(
  $q$ delete from auth.users
      where id = tests.get_supabase_uid('dsgvo1_operator') $q$,
  'DSGVO-1: deleting the operator account succeeds'
);

-- 9. operator_id nulled, row still present.
select results_eq(
  $q$ select (operator_id is null) from public.moderation_action_log
      where id = '99999999-9999-4999-8999-999999999992' $q$,
  array[true],
  'operator_id anonymised to NULL, audit row still present'
);

-- ---------------------------------------------------------------------------
-- 10–12. Append-only unchanged: authenticated has NO write path (42501).
-- ---------------------------------------------------------------------------
select tests.create_supabase_user('dsgvo1_attacker');
select tests.authenticate_as('dsgvo1_attacker');

select throws_ok(
  $q$ insert into public.moderation_action_log (action_type, notes)
      values ('warn', 'forged') $q$,
  '42501',
  null,
  'append-only: authenticated cannot INSERT into moderation_action_log'
);
select throws_ok(
  $q$ update public.moderation_action_log set notes = 'tampered' $q$,
  '42501',
  null,
  'append-only: authenticated cannot UPDATE moderation_action_log'
);
select throws_ok(
  $q$ delete from public.moderation_action_log $q$,
  '42501',
  null,
  'append-only: authenticated cannot DELETE from moderation_action_log'
);

-- 13. Integrity recheck as service_role: the audit row is still there.
select tests.authenticate_as_service_role();
select results_eq(
  $q$ select count(*)::int from public.moderation_action_log
      where id = '99999999-9999-4999-8999-999999999992' $q$,
  array[1],
  'integrity: audit row intact after attacker attempts'
);

select * from finish();

rollback;
