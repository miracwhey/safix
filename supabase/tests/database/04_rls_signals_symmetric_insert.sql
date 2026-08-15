-- =============================================================================
-- pgTAP behavioral test: CHAT-4 — symmetric INSERT + text ids on
--   public.notification_signals / public.timeline_signals
-- =============================================================================
-- VERIFIED-REAL SCHEMA (live prod dumps 2026-06-10 + rescue baseline DDL).
-- Source of truth:
--   supabase/migrations/20260610155500_chat4_signals_symmetric_insert_text_ids.sql (the fix)
--   ~/.claude/plans/release-gate-2026-06-10/partial-CHAT-4.md (pre-fix live policies)
--
-- WHAT THIS PROVES (behavioral, not review-by-reading):
--   * CUSTOMER can INSERT notification/timeline signals on OWN jobs — including
--     recipient_role='craftsman' rows that notify the other side (pre-fix:
--     42501 → recordPersistenceFailure → red SyncStatusBar in money flows).
--   * Deterministic TEXT ids (`notif-…-c`, `reminder-a-b`,
--     `timeline_payout_completed__tr_x`) insert cleanly (pre-fix: 22P02
--     before RLS, both roles, retryable webhook loop).
--   * CUSTOMER cannot INSERT on a foreign job (WITH CHECK → 42501), on either
--     table.
--   * OWNER PROVIDER path keeps working (regression), and still sees
--     craftsman-recipient rows.
--   * ASSIGNED provider (provider_id NULL, assigned_provider_id set) can
--     INSERT — and NEWLY can SELECT + UPDATE its signals (select/update
--     policies were joined on j.provider_id only pre-fix; strict widening).
--   * Assigned provider is still fenced off other providers' jobs (42501).
--   * Recipient semantics unchanged: customer never sees craftsman-recipient
--     rows; markRead UPDATE path works for the recipient.
--   * anon is fully revoked: INSERT and SELECT both fail (REVOKE hygiene —
--     RLS alone would not cover TRUNCATE/default grants).
--   * Integrity: every allowed-path row actually persisted.
--
-- Helpers vendored INLINE inside BEGIN..ROLLBACK (basejump patterns) — nothing
-- persists. Run with: supabase test db
-- NOTE: requires a prod-like schema (jobs/providers predate the repo migration
-- ledger — known drift; suite is advisory in CI until the ledger is healed).
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
select plan(19);

-- ---------------------------------------------------------------------------
-- Setup (superuser session — RLS/grants bypassed legitimately for seeding)
-- ---------------------------------------------------------------------------
select tests.create_supabase_user('chat4_customer');
select tests.create_supabase_user('chat4_customer_foreign');
select tests.create_supabase_user('chat4_provider');
select tests.create_supabase_user('chat4_assigned');

-- handle_new_user (AFTER INSERT on auth.users) creates profiles(id) rows;
-- defensive double-insert in case the local stack lacks the trigger.
-- (jobs.customer_user_id and providers.profile_id are FKs → profiles.id.)
insert into public.profiles (id)
select tests.get_supabase_uid(i)
from unnest(array['chat4_customer','chat4_customer_foreign','chat4_provider','chat4_assigned']) as i
on conflict (id) do nothing;

-- Two provider orgs: the classic owner and a purely-assigned org.
insert into public.providers (id, profile_id, company_name, is_public)
values
  ('c4a70000-0000-4000-8000-000000000001', tests.get_supabase_uid('chat4_provider'), 'CHAT4 Owner GmbH', false),
  ('c4a70000-0000-4000-8000-000000000002', tests.get_supabase_uid('chat4_assigned'), 'CHAT4 Assigned GmbH', false);

-- job_own:      customer chat4_customer ↔ owner provider (provider_id set)
-- job_assigned: customer chat4_customer ↔ assigned org ONLY (provider_id NULL)
-- job_foreign:  belongs to chat4_customer_foreign — attack target
insert into public.jobs (id, title, status, customer_user_id, provider_id, assigned_provider_id)
values
  ('c4a70000-0000-4000-8000-000000000011', 'CHAT4 own job',      'in_progress', tests.get_supabase_uid('chat4_customer'),         'c4a70000-0000-4000-8000-000000000001', null),
  ('c4a70000-0000-4000-8000-000000000012', 'CHAT4 assigned job', 'in_progress', tests.get_supabase_uid('chat4_customer'),         null,                                   'c4a70000-0000-4000-8000-000000000002'),
  ('c4a70000-0000-4000-8000-000000000013', 'CHAT4 foreign job',  'in_progress', tests.get_supabase_uid('chat4_customer_foreign'), 'c4a70000-0000-4000-8000-000000000001', null);

-- Pre-seeded recipient rows on job_own (recipient semantics fixture).
insert into public.notification_signals (id, job_id, type, priority, read, occurred_at, recipient_role)
values
  ('seed-cust-row',  'c4a70000-0000-4000-8000-000000000011', 'release_requested', 'low', false, 1, 'customer'),
  ('seed-craft-row', 'c4a70000-0000-4000-8000-000000000011', 'deposit_paid',      'low', false, 1, 'craftsman');

-- ---------------------------------------------------------------------------
-- Schema pins: id is text on both tables (uuid pre-fix → 22P02 for every
-- deterministic writer id)
-- ---------------------------------------------------------------------------
select col_type_is('public', 'notification_signals', 'id', 'text',
  'schema pin: notification_signals.id is text');
select col_type_is('public', 'timeline_signals', 'id', 'text',
  'schema pin: timeline_signals.id is text');

-- ====================== act as the CUSTOMER (the CHAT-4 fix) ===============
select tests.authenticate_as('chat4_customer');

-- 1. THE bug: customer writes a craftsman-recipient money-flow signal with a
--    deterministic bridge id on the own job (pre-fix: 42501 → red SyncStatusBar).
select lives_ok(
  $q$ insert into public.notification_signals
        (id, job_id, type, priority, read, occurred_at, recipient_role)
      values
        ('notif-7e000000-0000-4000-8000-000000000001-c',
         'c4a70000-0000-4000-8000-000000000011',
         'deposit_paid', 'low', false, 2, 'craftsman') $q$,
  'CHAT-4: customer CAN insert craftsman-recipient signal on own job (text bridge id)'
);

-- 2. Timeline layer (pre-fix provider-only — blocked customer money flows at
--    the timeline write already). Webhook-style deterministic text id.
select lives_ok(
  $q$ insert into public.timeline_signals (id, job_id, type, occurred_at)
      values ('timeline_payout_completed__tr_x',
              'c4a70000-0000-4000-8000-000000000011',
              'payout_completed', 2) $q$,
  'CHAT-4: customer CAN insert timeline signal on own job (webhook-style text id)'
);

-- 3./4. Cross-tenant fences hold on both tables (foreign job → WITH CHECK 42501).
select throws_ok(
  $q$ insert into public.notification_signals
        (id, job_id, type, priority, read, occurred_at, recipient_role)
      values ('forged-notif-by-customer',
              'c4a70000-0000-4000-8000-000000000013',
              'deposit_paid', 'low', false, 3, 'craftsman') $q$,
  '42501', null,
  'RLS: customer cannot INSERT notification signal on a foreign job'
);
select throws_ok(
  $q$ insert into public.timeline_signals (id, job_id, type, occurred_at)
      values ('forged-timeline-by-customer',
              'c4a70000-0000-4000-8000-000000000013',
              'deposit_paid', 3) $q$,
  '42501', null,
  'RLS: customer cannot INSERT timeline signal on a foreign job'
);

-- 5./6. Recipient semantics unchanged: the customer reads ONLY
--       recipient_role='customer' rows of own jobs.
select isnt_empty(
  $q$ select id from public.notification_signals where id = 'seed-cust-row' $q$,
  'recipient semantics: customer sees customer-recipient row of own job'
);
select is_empty(
  $q$ select id from public.notification_signals where id = 'seed-craft-row' $q$,
  'recipient semantics: customer does NOT see craftsman-recipient row'
);

-- 7. markRead UPDATE path for the recipient keeps working.
select isnt_empty(
  $q$ update public.notification_signals
         set read = true
       where id = 'seed-cust-row'
   returning id $q$,
  'allowed path: customer markRead UPDATE on own customer-recipient row'
);

-- ====================== act as the OWNER PROVIDER (regression) =============
select tests.authenticate_as('chat4_provider');

-- 8. Provider insert keeps working — with a cron-style deterministic text id.
select lives_ok(
  $q$ insert into public.notification_signals
        (id, job_id, type, priority, read, occurred_at, recipient_role)
      values ('reminder-a-b',
              'c4a70000-0000-4000-8000-000000000011',
              'acceptance_reminder_24h', 'low', false, 4, 'customer') $q$,
  'regression: owner provider CAN still insert signals (cron-style text id)'
);

-- 9. Provider still sees craftsman-recipient rows (widening, not narrowing —
--    a plain COALESCE join would have STOLEN visibility from the owner here).
select isnt_empty(
  $q$ select id from public.notification_signals where id = 'seed-craft-row' $q$,
  'regression: owner provider still SELECTs craftsman-recipient row'
);

-- ====================== act as the ASSIGNED provider (new widening) ========
select tests.authenticate_as('chat4_assigned');

-- 10. INSERT on the assigned-only job (provider_id NULL).
select lives_ok(
  $q$ insert into public.notification_signals
        (id, job_id, type, priority, read, occurred_at, recipient_role)
      values ('notif-assigned-1',
              'c4a70000-0000-4000-8000-000000000012',
              'work_completed', 'low', false, 5, 'craftsman') $q$,
  'assigned provider CAN insert signal on assigned-only job'
);

-- 11. NEW: SELECT-visibility of its own signal (pre-fix the select policy
--     joined j.provider_id only → own insert was invisible, Realtime dead).
select isnt_empty(
  $q$ select id from public.notification_signals where id = 'notif-assigned-1' $q$,
  'widening: assigned provider SELECTs craftsman signal on assigned-only job'
);

-- 12. NEW: markRead UPDATE path for the assigned provider.
select isnt_empty(
  $q$ update public.notification_signals
         set read = true
       where id = 'notif-assigned-1'
   returning id $q$,
  'widening: assigned provider markRead UPDATE on assigned-only job signal'
);

-- 13. Timeline insert via the assigned branch.
select lives_ok(
  $q$ insert into public.timeline_signals (id, job_id, type, occurred_at)
      values ('tl-assigned-1', 'c4a70000-0000-4000-8000-000000000012',
              'work_completed', 5) $q$,
  'assigned provider CAN insert timeline signal on assigned-only job'
);

-- 14. Fence: assigned provider is NOT a party of job_own → 42501.
select throws_ok(
  $q$ insert into public.notification_signals
        (id, job_id, type, priority, read, occurred_at, recipient_role)
      values ('forged-notif-by-assigned',
              'c4a70000-0000-4000-8000-000000000011',
              'deposit_paid', 'low', false, 6, 'craftsman') $q$,
  '42501', null,
  'RLS: assigned provider cannot INSERT on another provider''s job'
);

-- ====================== act as anon (REVOKE hygiene) =======================
select tests.authenticate_as_anon();

-- 15./16. anon lost ALL table grants — INSERT and SELECT die at the grant
--         layer (42501), independent of RLS.
select throws_ok(
  $q$ insert into public.notification_signals
        (id, job_id, type, priority, read, occurred_at, recipient_role)
      values ('forged-notif-by-anon',
              'c4a70000-0000-4000-8000-000000000011',
              'deposit_paid', 'low', false, 7, 'craftsman') $q$,
  '42501', null,
  'REVOKE hygiene: anon cannot INSERT into notification_signals'
);
select throws_ok(
  $q$ select id from public.notification_signals limit 1 $q$,
  '42501', null,
  'REVOKE hygiene: anon cannot SELECT from notification_signals'
);

-- ====================== integrity check as service_role ====================
select tests.authenticate_as_service_role();

-- 17. Every allowed-path row persisted; no forged row exists.
select results_eq(
  $q$ select
        (select count(*)::int from public.notification_signals
          where id in ('seed-cust-row', 'seed-craft-row',
                       'notif-7e000000-0000-4000-8000-000000000001-c',
                       'reminder-a-b', 'notif-assigned-1')),
        (select count(*)::int from public.timeline_signals
          where id in ('timeline_payout_completed__tr_x', 'tl-assigned-1')),
        (select count(*)::int from public.notification_signals
          where id like 'forged-%') $q$,
  $q$ values (5, 2, 0) $q$,
  'integrity: 5 notification + 2 timeline rows persisted, zero forged rows'
);

select * from finish();

rollback;
