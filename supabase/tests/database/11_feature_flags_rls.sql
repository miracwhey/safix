-- =============================================================================
-- pgTAP behavioral test: feature_flags RLS — public read, operator-only write
-- =============================================================================
-- Source of truth: supabase/migrations/20260629000000_feature_flags.sql
--
-- WHAT THIS PROVES (behavioral, not review-by-reading):
--   * anon CAN SELECT (public read — flags resolve for logged-out sessions).
--   * anon CANNOT INSERT (no grant → 42501).
--   * authenticated NON-operator CAN SELECT but CANNOT INSERT (WITH CHECK 42501)
--     and an UPDATE affects ZERO rows (USING blocks silently — no error).
--   * authenticated OPERATOR (profiles.is_operator = true) CAN INSERT / UPDATE /
--     DELETE — the kill-switch is writable only by operators.
--
-- Mirrors the operator gate of analytics_events. Helpers vendored INLINE inside
-- BEGIN..ROLLBACK (basejump patterns) — nothing persists. Run: supabase test db
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path to public, extensions, tests, auth, pg_catalog;

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
  reset role;
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

create or replace function tests.authenticate_as_anon()
  returns void
  language plpgsql
  set search_path = auth, public, pg_catalog, pg_temp
as $fn$
begin
  reset role;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', null, true);
end;
$fn$;

grant usage on schema tests to authenticated, service_role, anon;
grant execute on all functions in schema tests to authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
select plan(10);

-- ---------------------------------------------------------------------------
-- Schema pins
-- ---------------------------------------------------------------------------
select has_table('public', 'feature_flags', 'feature_flags table exists');
select is(
  (select relrowsecurity from pg_class where oid = 'public.feature_flags'::regclass),
  true,
  'RLS is enabled on feature_flags'
);

-- ---------------------------------------------------------------------------
-- Setup (superuser — RLS/grants bypassed for seeding)
-- ---------------------------------------------------------------------------
select tests.create_supabase_user('ff_operator');
select tests.create_supabase_user('ff_user');

insert into public.profiles (id)
select tests.get_supabase_uid(i)
from unnest(array['ff_operator','ff_user']) as i
on conflict (id) do nothing;

update public.profiles set is_operator = true  where id = tests.get_supabase_uid('ff_operator');
update public.profiles set is_operator = false where id = tests.get_supabase_uid('ff_user');

insert into public.feature_flags (key, enabled, rollout_pct)
values ('ff_seed', true, 100);

-- ====================== anon (public read, no write) =======================
select tests.authenticate_as_anon();

select isnt_empty(
  $q$ select key from public.feature_flags where key = 'ff_seed' $q$,
  'anon CAN SELECT feature flags (public read)'
);
select throws_ok(
  $q$ insert into public.feature_flags (key, enabled) values ('ff_anon', true) $q$,
  '42501', null,
  'anon CANNOT INSERT feature flags (no grant)'
);

-- ====================== authenticated NON-operator =========================
select tests.authenticate_as('ff_user');

select isnt_empty(
  $q$ select key from public.feature_flags where key = 'ff_seed' $q$,
  'non-operator CAN SELECT feature flags'
);
select throws_ok(
  $q$ insert into public.feature_flags (key, enabled) values ('ff_user_forge', true) $q$,
  '42501', null,
  'non-operator CANNOT INSERT feature flags (WITH CHECK)'
);
-- UPDATE under a failing USING affects zero rows (no error) — assert no-op.
select is_empty(
  $q$ update public.feature_flags set enabled = false where key = 'ff_seed' returning key $q$,
  'non-operator UPDATE affects zero rows (USING blocks silently)'
);

-- ====================== authenticated OPERATOR =============================
select tests.authenticate_as('ff_operator');

select lives_ok(
  $q$ insert into public.feature_flags (key, enabled, rollout_pct, target_roles)
      values ('ff_op_insert', true, 50, array['owner']) $q$,
  'operator CAN INSERT feature flags'
);
select isnt_empty(
  $q$ update public.feature_flags set enabled = false where key = 'ff_seed' returning key $q$,
  'operator CAN UPDATE feature flags'
);
select isnt_empty(
  $q$ delete from public.feature_flags where key = 'ff_op_insert' returning key $q$,
  'operator CAN DELETE feature flags'
);

select * from finish();

rollback;
