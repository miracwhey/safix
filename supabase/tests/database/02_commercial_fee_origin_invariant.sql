-- =============================================================================
-- pgTAP behavioral test: DB-enforced commercial-fee-tier invariant on
--   public.customer_provider_relationships
-- =============================================================================
-- VERIFIED-REAL SCHEMA. Source of truth:
--   supabase/migrations/20260409000004_commercial_attribution.sql
--     CREATE TABLE customer_provider_relationships (
--       id UUID PK DEFAULT gen_random_uuid(),
--       customer_user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
--       craftsman_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
--       commercial_origin TEXT NOT NULL
--         CHECK (commercial_origin IN ('merchant_brought','platform_acquired')),
--       origin_context TEXT CHECK (... nullable ...),
--       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--       UNIQUE (customer_user_id, craftsman_user_id))
--
-- WHY THIS IS THE REAL INVARIANT (per CLAUDE.md domain rule "Fee: 5%
-- merchant_brought / 9% default, immutable. Never use 12%."):
--   The fee NUMBER is computed in app code (resolveCommercialFeeRate), but the
--   DB hard-gates *which* fee tier is even reachable via this CHECK constraint.
--   merchant_brought -> 5% tier, platform_acquired -> 9% tier. Any other origin
--   (i.e. a would-be 12% tier) is impossible to persist. This test proves that
--   guarantee behaviorally at the database layer, not by reading app code.
--
-- All inserts run as the superuser session (RLS bypassed), so this isolates the
-- CHECK constraint itself, not RLS. Helpers are vendored inline (basejump
-- supabase-test-helpers patterns); everything is rolled back -> prod untouched.
-- Run with: supabase test db   (see supabase/tests/database/README.md)
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path to public, extensions, tests, auth, pg_catalog;

-- ---------------------------------------------------------------------------
-- Vendored supabase-test-helpers (basejump patterns), test-only, rolled back.
-- Only the two functions this test needs.
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

-- ---------------------------------------------------------------------------
-- Plan
-- ---------------------------------------------------------------------------
select plan(3);

-- FK targets (real auth.users rows). Distinct craftsmen so each insert uses a
-- fresh (customer, craftsman) pair and can never trip the UNIQUE constraint --
-- only the commercial_origin CHECK is under test.
select tests.create_supabase_user('cust');
select tests.create_supabase_user('craftsman_5pct');
select tests.create_supabase_user('craftsman_9pct');
select tests.create_supabase_user('craftsman_bad');

-- 1. Valid 5% tier (merchant_brought) is accepted.
select lives_ok(
  $q$ insert into public.customer_provider_relationships
        (customer_user_id, craftsman_user_id, commercial_origin)
      values ((select tests.get_supabase_uid('cust')),
              (select tests.get_supabase_uid('craftsman_5pct')),
              'merchant_brought') $q$,
  'fee invariant: merchant_brought (5% tier) accepted by commercial_origin CHECK'
);

-- 2. Valid 9% tier (platform_acquired) is accepted (different pair).
select lives_ok(
  $q$ insert into public.customer_provider_relationships
        (customer_user_id, craftsman_user_id, commercial_origin)
      values ((select tests.get_supabase_uid('cust')),
              (select tests.get_supabase_uid('craftsman_9pct')),
              'platform_acquired') $q$,
  'fee invariant: platform_acquired (9% tier) accepted by commercial_origin CHECK'
);

-- 3. INVARIANT: any non-5%/9% origin (the would-be 12% tier) is rejected at the
--    DB layer with a CHECK violation (23514). Fresh pair (cust, craftsman_bad)
--    so only the CHECK -- never the UNIQUE -- can fire.
select throws_ok(
  $q$ insert into public.customer_provider_relationships
        (customer_user_id, craftsman_user_id, commercial_origin)
      values ((select tests.get_supabase_uid('cust')),
              (select tests.get_supabase_uid('craftsman_bad')),
              'platform_12_percent') $q$,
  '23514',
  null,
  'fee invariant: invalid commercial_origin (non 5%/9% tier) rejected by CHECK'
);

select * from finish();

rollback;
