-- =============================================================================
-- pgTAP behavioral test: RLS cross-tenant isolation on
--   public.notification_device_tokens
-- =============================================================================
-- VERIFIED-REAL SCHEMA. Source of truth:
--   supabase/migrations/20260420000010_notification_device_tokens.sql
--     CREATE TABLE public.notification_device_tokens (
--       user_id text NOT NULL, token text NOT NULL,
--       platform text NOT NULL DEFAULT 'ios',
--       updated_at bigint NOT NULL DEFAULT 0,
--       PRIMARY KEY (user_id, token))
--     ALTER TABLE ... ENABLE ROW LEVEL SECURITY
--     POLICY ndt_select_own  FOR SELECT USING      (user_id = auth.uid()::text)
--     POLICY ndt_insert_own  FOR INSERT WITH CHECK (user_id = auth.uid()::text)
--     POLICY ndt_update_own  FOR UPDATE USING      (user_id = auth.uid()::text)
--     POLICY ndt_delete_own  FOR DELETE USING      (user_id = auth.uid()::text)
--
-- WHAT THIS PROVES (behavioral, not review-by-reading):
--   * tenant B cannot SELECT / UPDATE / DELETE tenant A's row (RLS filters it).
--   * tenant B cannot forge a row owned by tenant A (INSERT WITH CHECK -> 42501).
--   * tenant A's row survives all of B's attempts.
--   * ALLOWED PATH: tenant A can read and insert its own rows.
--
-- Helpers (tests.create_supabase_user / get_supabase_uid / authenticate_as /
-- authenticate_as_service_role) are the basejump supabase-test-helpers patterns,
-- vendored INLINE inside the BEGIN..ROLLBACK so the harness is self-contained and
-- NOTHING (helpers, pgTAP, or auth.users rows) ever persists to a real database.
-- Run with: supabase test db   (see supabase/tests/database/README.md)
-- =============================================================================

begin;

-- pgTAP + helper functions live only for the life of this transaction.
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
  -- set_config(..., is_local := true) persists for the rest of this transaction,
  -- so auth.uid() resolves to this user and RLS is enforced as `authenticated`.
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

-- Make the helpers callable after we SET ROLE away from the superuser session.
grant usage on schema tests to authenticated, service_role, anon;
grant execute on all functions in schema tests to authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
-- Plan
-- ---------------------------------------------------------------------------
select plan(7);

-- Two isolated tenants (real auth.users rows).
select tests.create_supabase_user('tenant_a');
select tests.create_supabase_user('tenant_b');

-- Seed tenant A's device token as the superuser session (RLS bypassed for setup).
insert into public.notification_device_tokens (user_id, token, platform, updated_at)
values (tests.get_supabase_uid('tenant_a')::text, 'apns-token-A', 'ios', 0);

-- ====================== act as tenant B (the attacker) =====================
select tests.authenticate_as('tenant_b');

-- 1. SELECT: B cannot read A's row.
select is_empty(
  $q$ select token from public.notification_device_tokens where token = 'apns-token-A' $q$,
  'RLS: tenant B cannot SELECT tenant A device token'
);

-- 2. UPDATE: RLS USING filters A's row out -> 0 rows affected, nothing returned.
select is_empty(
  $q$ update public.notification_device_tokens
         set platform = 'android'
       where token = 'apns-token-A'
   returning token $q$,
  'RLS: tenant B cannot UPDATE tenant A device token (0 rows)'
);

-- 3. DELETE: same, 0 rows affected.
select is_empty(
  $q$ delete from public.notification_device_tokens
       where token = 'apns-token-A'
   returning token $q$,
  'RLS: tenant B cannot DELETE tenant A device token (0 rows)'
);

-- 4. INSERT: forging a row owned by A violates WITH CHECK -> 42501.
select throws_ok(
  $q$ insert into public.notification_device_tokens (user_id, token)
      values ((select tests.get_supabase_uid('tenant_a')::text), 'forged-token-by-B') $q$,
  '42501',
  null,
  'RLS: tenant B cannot INSERT a token on behalf of tenant A (WITH CHECK)'
);

-- ====================== integrity check as service_role ====================
select tests.authenticate_as_service_role();

-- 5. A's original row survived every one of B's attempts.
select isnt_empty(
  $q$ select 1 from public.notification_device_tokens where token = 'apns-token-A' $q$,
  'integrity: tenant A token still intact after tenant B attempts'
);

-- ====================== ALLOWED PATH: act as tenant A ======================
select tests.authenticate_as('tenant_a');

-- 6. A can read its own row.
select isnt_empty(
  $q$ select token from public.notification_device_tokens where token = 'apns-token-A' $q$,
  'allowed path: tenant A CAN SELECT its own device token'
);

-- 7. A can insert another of its own tokens (WITH CHECK satisfied).
select lives_ok(
  $q$ insert into public.notification_device_tokens (user_id, token, platform, updated_at)
      values (auth.uid()::text, 'apns-token-A2', 'ios', 0) $q$,
  'allowed path: tenant A CAN INSERT its own device token'
);

select * from finish();

rollback;
