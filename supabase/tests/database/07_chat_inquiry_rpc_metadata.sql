-- =============================================================================
-- pgTAP behavioral test: CHAT-CUTOVER Slice A — Inquiry-Metadaten + RPCs auf
--   public.chat_threads
-- =============================================================================
-- Source of truth:
--   supabase/migrations/20260611000000_chat_inquiry_metadata.sql
--   Plan: ~/.claude/plans/chat-cutover-block-2026-06-10-plan.md
--
-- WHAT THIS PROVES (behavioral, not review-by-reading):
--   * Die 6 neuen Spalten + CHECK + Inbox-Partial-Index existieren.
--   * rpc_get_or_create_chat_customer_thread (neue 6-Param-Signatur) erstellt
--     als CUSTOMER einen Thread MIT inquiry_origin/source_project_id/
--     inquiry_criteria/display_metadata und seedet beide Participants.
--   * Die alte 2-Param-Signatur ist WEG (kein PostgREST-Overload-Ambiguity).
--   * Inquiry-Reuse: zweiter Inquiry-Call fürs selbe Paar liefert denselben
--     Thread und ÜBERSCHREIBT vorhandene Inquiry-Metadaten NICHT.
--   * rpc_update_chat_thread_inquiry_state: Craftsman setzt reviewed_at/
--     declined_at; set-only-if-null (Wiederholung = No-Op, erster Wert bleibt);
--     CUSTOMER (Nicht-Craftsman) → P0001 access_denied; Nicht-Inquiry-Thread
--     → P0001 invalid_argument.
--   * anon hat auf beiden RPCs kein EXECUTE (REVOKE-Hygiene gegen
--     Default-Privileges — CREATE FUNCTION grantet sonst via PUBLIC an anon).
--
-- Helpers vendored INLINE inside BEGIN..ROLLBACK (basejump patterns) — nothing
-- persists. Run with: supabase test db
-- NOTE: requires a prod-like schema (chat_threads/providers predate the repo
-- migration ledger — known drift; suite is advisory in CI until healed).
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
  return uid;
end;
$fn$;

create or replace function tests.authenticate_as(identifier text)
  returns void
  language plpgsql
as $fn$
declare
  uid uuid := tests.get_supabase_uid(identifier);
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$fn$;

create or replace function tests.clear_authentication()
  returns void
  language plpgsql
as $fn$
begin
  perform set_config('request.jwt.claims', null, true);
  -- reset to the session superuser; set_config('role','postgres') fails when the
  -- current role is anon/authenticated (not a member of postgres).
  reset role;
end;
$fn$;

grant usage on schema tests to authenticated, service_role, anon;
grant execute on all functions in schema tests to authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres, RLS bypass)
-- ---------------------------------------------------------------------------
select tests.create_supabase_user('cutover_customer');
select tests.create_supabase_user('cutover_craftsman');
select tests.create_supabase_user('cutover_other');

insert into public.providers (profile_id)
values (tests.get_supabase_uid('cutover_craftsman'));

select plan(24);

-- ---------------------------------------------------------------------------
-- 1) Schema: Spalten + Constraint + Index + Funktions-Signaturen
-- ---------------------------------------------------------------------------
select has_column('public', 'chat_threads', 'inquiry_origin',    'chat_threads.inquiry_origin exists');
select has_column('public', 'chat_threads', 'declined_at',       'chat_threads.declined_at exists');
select has_column('public', 'chat_threads', 'reviewed_at',       'chat_threads.reviewed_at exists');
select has_column('public', 'chat_threads', 'source_project_id', 'chat_threads.source_project_id exists');
select has_column('public', 'chat_threads', 'inquiry_criteria',  'chat_threads.inquiry_criteria exists');
select has_column('public', 'chat_threads', 'display_metadata',  'chat_threads.display_metadata exists');

select ok(
  exists(select 1 from pg_indexes where schemaname='public' and indexname='chat_threads_craftsman_inbox_idx'),
  'partial index chat_threads_craftsman_inbox_idx exists'
);

select has_function('public', 'rpc_get_or_create_chat_customer_thread',
  array['uuid','text','text','text','jsonb','jsonb'],
  'get_or_create RPC has the extended 6-param signature');

select hasnt_function('public', 'rpc_get_or_create_chat_customer_thread',
  array['uuid','text'],
  'old 2-param overload is gone (no PostgREST ambiguity)');

select has_function('public', 'rpc_update_chat_thread_inquiry_state',
  array['uuid','bigint','bigint'],
  'inquiry-state RPC exists');

-- ---------------------------------------------------------------------------
-- 2) ACL: anon revoked auf beiden RPCs
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon',
    'public.rpc_get_or_create_chat_customer_thread(uuid,text,text,text,jsonb,jsonb)', 'EXECUTE'),
  'anon cannot execute get_or_create RPC'
);
select ok(
  not has_function_privilege('anon',
    'public.rpc_update_chat_thread_inquiry_state(uuid,bigint,bigint)', 'EXECUTE'),
  'anon cannot execute inquiry-state RPC'
);

-- ---------------------------------------------------------------------------
-- 3) Customer erstellt Inquiry-Thread mit Metadaten
-- ---------------------------------------------------------------------------
select tests.authenticate_as('cutover_customer');

create temporary table t_ctx on commit drop as
select public.rpc_get_or_create_chat_customer_thread(
  tests.get_supabase_uid('cutover_craftsman'),
  'Bad-Sanierung',
  'profile',
  null,
  null,
  jsonb_build_object('customerName','Kunde K','craftsmanHandle','meister-m','projectTitle','Bad-Sanierung','projectSubtitle','Neue Anfrage')
) as thread_id;

select isnt((select thread_id from t_ctx), null, 'inquiry create returns a thread id');

select tests.clear_authentication();

select is(
  (select inquiry_origin from public.chat_threads where id = (select thread_id from t_ctx)),
  'profile',
  'inquiry_origin persisted'
);
select is(
  (select display_metadata->>'craftsmanHandle' from public.chat_threads where id = (select thread_id from t_ctx)),
  'meister-m',
  'display_metadata persisted (camelCase keys)'
);
select is(
  (select count(*)::int from public.chat_participants where thread_id = (select thread_id from t_ctx)),
  2,
  'both participants seeded'
);

-- ---------------------------------------------------------------------------
-- 4) Inquiry-Reuse: selbes Paar → selber Thread, Metadaten NICHT überschrieben
-- ---------------------------------------------------------------------------
select tests.authenticate_as('cutover_customer');

select is(
  public.rpc_get_or_create_chat_customer_thread(
    tests.get_supabase_uid('cutover_craftsman'),
    'Zweite Anfrage', 'reel', null,
    jsonb_build_object('category','Sanitär'),
    jsonb_build_object('projectTitle','Sollte nicht gewinnen')
  ),
  (select thread_id from t_ctx),
  'second inquiry for same pair reuses the thread'
);

select tests.clear_authentication();

select is(
  (select inquiry_origin from public.chat_threads where id = (select thread_id from t_ctx)),
  'profile',
  'existing inquiry_origin NOT overwritten on reuse'
);

-- ---------------------------------------------------------------------------
-- 5) inquiry-state RPC: Craftsman review/decline, idempotent
-- ---------------------------------------------------------------------------
select tests.authenticate_as('cutover_craftsman');

select lives_ok(
  format($q$select public.rpc_update_chat_thread_inquiry_state(%L::uuid, 1000, null)$q$,
    (select thread_id from t_ctx)),
  'craftsman sets reviewed_at'
);

select lives_ok(
  format($q$select public.rpc_update_chat_thread_inquiry_state(%L::uuid, 2000, 3000)$q$,
    (select thread_id from t_ctx)),
  'second call is a no-op for reviewed_at and sets declined_at'
);

select tests.clear_authentication();

select is(
  (select reviewed_at from public.chat_threads where id = (select thread_id from t_ctx)),
  1000::bigint,
  'reviewed_at keeps the FIRST value (set-only-if-null)'
);
select is(
  (select declined_at from public.chat_threads where id = (select thread_id from t_ctx)),
  3000::bigint,
  'declined_at set on the later call'
);

-- ---------------------------------------------------------------------------
-- 6) Fences: Nicht-Craftsman + Nicht-Inquiry-Thread
-- ---------------------------------------------------------------------------
select tests.authenticate_as('cutover_customer');

select throws_ok(
  format($q$select public.rpc_update_chat_thread_inquiry_state(%L::uuid, 9, 9)$q$,
    (select thread_id from t_ctx)),
  'P0001',
  'access_denied: caller is not the thread craftsman',
  'customer cannot write inquiry state'
);

select tests.clear_authentication();

-- Nicht-Inquiry-Thread (inquiry_origin NULL) direkt seeden:
create temporary table t_plain on commit drop as
with ins as (
  insert into public.chat_threads (channel_type, customer_user_id, craftsman_user_id, provider_id)
  select 'customer',
         tests.get_supabase_uid('cutover_other'),
         tests.get_supabase_uid('cutover_craftsman'),
         (select id from public.providers where profile_id = tests.get_supabase_uid('cutover_craftsman'))
  returning id
)
select id as thread_id from ins;
grant select on t_plain to authenticated, anon;

select tests.authenticate_as('cutover_craftsman');

select throws_ok(
  format($q$select public.rpc_update_chat_thread_inquiry_state(%L::uuid, 9, 9)$q$,
    (select thread_id from t_plain)),
  'P0001',
  format('invalid_argument: thread %s is not an inquiry thread', (select thread_id from t_plain)),
  'non-inquiry thread is rejected'
);

select tests.clear_authentication();

select * from finish();

rollback;
