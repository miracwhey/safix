-- =============================================================================
-- pgTAP behavioral test: P5b — payments FSM terminal client-lockdown (MED#1+MED#4)
-- =============================================================================
-- Source of truth (the fix):
--   supabase/migrations/20260621000000_p5b_payment_terminal_client_lockdown.sql
--   (CREATE OR REPLACE on enforce_payment_fsm, on top of P5 20260617000000).
-- Schema reconciled against LIVE prod 2026-06-21 (itdntawwuzqfwmcwnwjr):
--   payments.job_id/craftsman_user_id/customer_user_id/provider_id uuid ·
--   jobs.id/customer_user_id uuid · jobs.craftsman_user_id TEXT ·
--   providers(id uuid default, profile_id uuid nullable) ·
--   payments.status CHECK includes the legacy states (captured/authorized/...).
--
-- WHAT THIS PROVES (behavioral, not review-by-reading):
--   P5b hardens the P5 trigger from a payee-only authority guard into a blanket
--   terminal lockdown — once the client routes every released/refunded write
--   through finalize_payment_state_atomic, NO authenticated client may write a
--   money terminal directly:
--     * The PAYEE craftsman still cannot self-release/-refund (42501) — now via
--       the blanket 4a lockdown (message changed: payment_terminal_requires_rpc).
--     * MED#1 CLOSED: the NON-payee customer can NO LONGER drive
--       release_pending -> released / in_escrow -> refunded client-direct (42501);
--       the row is unchanged. (Under P5 this was deliberately allowed.)
--     * A provider-linked payee is blocked too (42501) — P5b subsumes the old
--       per-payee provider authority arm into the identity-agnostic 4a.
--     * MED#4 CLOSED: a canonical terminal is immutable from the client —
--       released -> work_in_progress is rejected 23514 (payment_terminal_immutable),
--       and a legacy-hop INTO a terminal (captured -> refunded) is rejected 42501.
--     * A pure illegal FSM jump that is NOT a terminal (in_escrow -> deposit_paid)
--       is still 23514 (payment_fsm_illegal_transition).
--     * Forward escrow steps + dispute-open stay client-writable (no corridor
--       regression): craftsman in_escrow -> work_in_progress passes.
--     * finalize_payment_state_atomic: rejected 42501 for the craftsman (payee),
--       succeeds for the customer (its own UPDATE passes via the bypass sentinel).
--     * service_role (auth.uid() IS NULL) may still drive release directly (webhook).
--
-- HOW / WHEN TO RUN — read before executing:
--   * ONLY against a prod-near DB with BOTH 20260617000000 AND 20260621000000
--     APPLIED (post-apply gate). Repo migration ledger has known systemic drift;
--     a local `supabase start` shadow DB may not match prod.
--   * Command: `supabase test db` (pg_prove -r auto-discovers this dir).
-- Helpers vendored INLINE inside BEGIN..ROLLBACK — nothing persists.
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
  reset role;  -- must run as session superuser to read auth.users + switch role
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

create or replace function tests.clear_authentication()
  returns void
  language plpgsql
  set search_path = auth, public, pg_catalog, pg_temp
as $fn$
begin
  reset role;
  perform set_config('request.jwt.claims', null, true);
end;
$fn$;

grant usage on schema tests to authenticated, service_role, anon;
grant execute on all functions in schema tests to authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
-- Plan
-- ---------------------------------------------------------------------------
select plan(28);

-- ---------------------------------------------------------------------------
-- Setup (superuser session — auth.uid() IS NULL = trusted service path; the
-- BEFORE UPDATE trigger only fires on UPDATE, so these INSERTs are unguarded).
-- ---------------------------------------------------------------------------
select tests.create_supabase_user('fsm_customer');
select tests.create_supabase_user('fsm_craftsman');
select tests.create_supabase_user('fsm_provider');

insert into public.profiles (id)
select tests.get_supabase_uid(i)
from unnest(array['fsm_customer','fsm_craftsman','fsm_provider']) as i
on conflict (id) do nothing;

-- providers row (only profile_id needed; other NOT NULLs have defaults).
insert into public.providers (id, profile_id)
values ('bb150000-0000-4000-8000-0000000000c1', tests.get_supabase_uid('fsm_provider'));

-- One job per payment (payments.job_id FK -> jobs.id). jobs.craftsman_user_id is
-- TEXT, jobs.customer_user_id is uuid. Finalize rows use status='waiting_payment'
-- so the RPC's CASE flips them to 'completed'.
insert into public.jobs (id, title, status, customer_user_id, craftsman_user_id)
values
  ('bb150000-0000-4000-8000-000000000001', 'P5b payee self-release',     'in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-000000000002', 'P5b customer release blocked','in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-000000000003', 'P5b service release',        'in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-000000000004', 'P5b illegal non-terminal',   'in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-000000000005', 'P5b forward step',           'in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-000000000006', 'P5b finalize as craftsman',  'waiting_payment',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-000000000007', 'P5b finalize as customer',   'waiting_payment',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-000000000008', 'P5b payee self-refund',      'in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-000000000009', 'P5b customer refund blocked','in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-00000000000a', 'P5b terminal immutable',     'in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-00000000000b', 'P5b legacy-hop into terminal','in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman')::text),
  ('bb150000-0000-4000-8000-00000000000c', 'P5b provider-arm blocked',   'in_progress',
     tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_provider')::text);

-- Payments. f10 seeded directly as 'released', f11 as legacy 'captured' (INSERT is
-- unguarded — the trigger is BEFORE UPDATE only). f12 carries provider_id AND a
-- craftsman_user_id = provider uid so the provider passes membership RLS and the
-- UPDATE actually reaches the trigger (RLS-filtered 0 rows would raise nothing).
insert into public.payments (id, job_id, status, customer_user_id, craftsman_user_id, provider_id, total_amount)
values
  ('bb150000-0000-4000-8000-0000000000f1', 'bb150000-0000-4000-8000-000000000001',
     'release_pending', tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000f2', 'bb150000-0000-4000-8000-000000000002',
     'release_pending', tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000f3', 'bb150000-0000-4000-8000-000000000003',
     'release_pending', tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000f4', 'bb150000-0000-4000-8000-000000000004',
     'in_escrow',       tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000f5', 'bb150000-0000-4000-8000-000000000005',
     'in_escrow',       tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000f6', 'bb150000-0000-4000-8000-000000000006',
     'release_pending', tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000f7', 'bb150000-0000-4000-8000-000000000007',
     'release_pending', tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000f8', 'bb150000-0000-4000-8000-000000000008',
     'release_pending', tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000f9', 'bb150000-0000-4000-8000-000000000009',
     'in_escrow',       tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000fa', 'bb150000-0000-4000-8000-00000000000a',
     'released',        tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000fb', 'bb150000-0000-4000-8000-00000000000b',
     'captured',        tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_craftsman'), null, 500),
  ('bb150000-0000-4000-8000-0000000000fc', 'bb150000-0000-4000-8000-00000000000c',
     'release_pending', tests.get_supabase_uid('fsm_customer'), tests.get_supabase_uid('fsm_provider'),
     'bb150000-0000-4000-8000-0000000000c1', 500);

-- ---------------------------------------------------------------------------
-- 1.-3. Schema pins
-- ---------------------------------------------------------------------------
select has_function('public', 'enforce_payment_fsm', '{}'::name[],
  'schema pin: enforce_payment_fsm() exists');
select has_trigger('public', 'payments', 'enforce_payment_fsm_tg',
  'schema pin: enforce_payment_fsm_tg installed on public.payments');
select has_function('public', 'payment_fsm_is_allowed', array['text','text']::name[],
  'schema pin: payment_fsm_is_allowed(text,text) exists');

-- ---------------------------------------------------------------------------
-- 4.-6. Grant pins: anon stripped, authenticated keeps trigger-guarded UPDATE.
-- ---------------------------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.payments', 'UPDATE'),
  'grant: anon has NO UPDATE on payments');
select ok(not has_table_privilege('anon', 'public.payments', 'INSERT'),
  'grant: anon has NO INSERT on payments');
select ok(has_table_privilege('authenticated', 'public.payments', 'UPDATE'),
  'grant: authenticated keeps UPDATE on payments (now trigger-guarded)');

-- ======================= act as the CRAFTSMAN (the PAYEE) ====================
select tests.authenticate_as('fsm_craftsman');

-- 7./8. Payee self-release of release_pending -> released is blocked (now via the
--       blanket terminal lockdown, message changed to payment_terminal_requires_rpc).
select throws_ok(
  $q$ update public.payments set status = 'released'
       where id = 'bb150000-0000-4000-8000-0000000000f1' $q$,
  '42501', null,
  'LOCKDOWN: craftsman (payee) CANNOT self-release release_pending -> released (42501)'
);
select throws_like(
  $q$ update public.payments set status = 'released'
       where id = 'bb150000-0000-4000-8000-0000000000f1' $q$,
  '%payment_terminal_requires_rpc%',
  'LOCKDOWN: the refusal is payment_terminal_requires_rpc (terminal lockdown 4a)'
);

-- 9. The blocked attempt changed nothing.
select results_eq(
  $q$ select status from public.payments
       where id = 'bb150000-0000-4000-8000-0000000000f1' $q$,
  array['release_pending'],
  'integrity: payment still release_pending after blocked self-release'
);

-- 10. Payee also cannot drive release_pending -> refunded.
select throws_ok(
  $q$ update public.payments set status = 'refunded'
       where id = 'bb150000-0000-4000-8000-0000000000f8' $q$,
  '42501', null,
  'LOCKDOWN: craftsman (payee) CANNOT drive release_pending -> refunded (42501)'
);

-- 11./12. Legit forward escrow step by the craftsman participant still passes
--         (no corridor regression — forward steps stay client-writable).
select isnt_empty(
  $q$ update public.payments set status = 'work_in_progress'
       where id = 'bb150000-0000-4000-8000-0000000000f5'
   returning id $q$,
  'forward: craftsman may move in_escrow -> work_in_progress (participant step)'
);
select results_eq(
  $q$ select status from public.payments
       where id = 'bb150000-0000-4000-8000-0000000000f5' $q$,
  array['work_in_progress'],
  'forward: the in_escrow -> work_in_progress step actually persisted'
);

-- ======================= act as the CUSTOMER (non-payee) ====================
select tests.authenticate_as('fsm_customer');

-- 13./14. MED#1 CLOSED: customer (non-payee) can NO LONGER drive
--         release_pending -> released client-direct (was allowed under P5).
select throws_ok(
  $q$ update public.payments set status = 'released'
       where id = 'bb150000-0000-4000-8000-0000000000f2' $q$,
  '42501', null,
  'MED#1: customer (non-payee) CANNOT client-direct release anymore (42501)'
);
select throws_like(
  $q$ update public.payments set status = 'released'
       where id = 'bb150000-0000-4000-8000-0000000000f2' $q$,
  '%payment_terminal_requires_rpc%',
  'MED#1: refusal is payment_terminal_requires_rpc (must use finalize RPC)'
);

-- 15. The blocked customer release changed nothing (row still release_pending).
select results_eq(
  $q$ select status from public.payments
       where id = 'bb150000-0000-4000-8000-0000000000f2' $q$,
  array['release_pending'],
  'integrity: payment still release_pending after blocked customer release'
);

-- 16. MED#1: customer cannot client-direct refund either (in_escrow -> refunded
--     is FSM-legal, but a terminal write — must go through the RPC).
select throws_ok(
  $q$ update public.payments set status = 'refunded'
       where id = 'bb150000-0000-4000-8000-0000000000f9' $q$,
  '42501', null,
  'MED#1: customer cannot client-direct refund (42501) even on an FSM-legal edge'
);

-- 17./18./19. A pure illegal FSM jump that is NOT a terminal stays 23514.
select throws_ok(
  $q$ update public.payments set status = 'deposit_paid'
       where id = 'bb150000-0000-4000-8000-0000000000f4' $q$,
  '23514', null,
  'FSM: in_escrow -> deposit_paid is an illegal non-terminal jump (23514)'
);
select throws_like(
  $q$ update public.payments set status = 'deposit_paid'
       where id = 'bb150000-0000-4000-8000-0000000000f4' $q$,
  '%payment_fsm_illegal_transition%',
  'FSM: the non-terminal refusal is payment_fsm_illegal_transition'
);
select results_eq(
  $q$ select status from public.payments
       where id = 'bb150000-0000-4000-8000-0000000000f4' $q$,
  array['in_escrow'],
  'integrity: payment still in_escrow after blocked illegal jump'
);

-- 20./21./22. MED#4: a canonical terminal is immutable from the client.
select throws_ok(
  $q$ update public.payments set status = 'work_in_progress'
       where id = 'bb150000-0000-4000-8000-0000000000fa' $q$,
  '23514', null,
  'MED#4: released -> work_in_progress (move OUT of terminal) is blocked (23514)'
);
select throws_like(
  $q$ update public.payments set status = 'work_in_progress'
       where id = 'bb150000-0000-4000-8000-0000000000fa' $q$,
  '%payment_terminal_immutable%',
  'MED#4: the refusal is payment_terminal_immutable'
);
select results_eq(
  $q$ select status from public.payments
       where id = 'bb150000-0000-4000-8000-0000000000fa' $q$,
  array['released'],
  'integrity: terminal payment still released after blocked escape'
);

-- 23. MED#4: a legacy-hop INTO a terminal (captured -> refunded) is blocked 42501
--     (4a fires on v_new regardless of the legacy OLD status).
select throws_ok(
  $q$ update public.payments set status = 'refunded'
       where id = 'bb150000-0000-4000-8000-0000000000fb' $q$,
  '42501', null,
  'MED#4: legacy-hop captured -> refunded INTO a terminal is blocked (42501)'
);

-- ======================= act as the PROVIDER (payee via provider_id) =========
select tests.authenticate_as('fsm_provider');

-- 24. Provider-linked payee is blocked too (P5b subsumes the per-payee provider
--     authority arm into the identity-agnostic terminal lockdown).
select throws_ok(
  $q$ update public.payments set status = 'released'
       where id = 'bb150000-0000-4000-8000-0000000000fc' $q$,
  '42501', null,
  'LOCKDOWN: provider-linked payee CANNOT self-release (42501)'
);

-- ======================= finalize_payment_state_atomic ======================
-- 25. finalize as the CRAFTSMAN: the payee is not an authorized finalizer.
select tests.authenticate_as('fsm_craftsman');
select throws_ok(
  $q$ select public.finalize_payment_state_atomic(
        'bb150000-0000-4000-8000-000000000006', 'released') $q$,
  '42501', null,
  'RPC: craftsman (payee) is NOT authorized to finalize release (42501)'
);

-- 26. finalize as the CUSTOMER: authorized; its own UPDATE passes the trigger via
--     the app.payment_fsm_bypass sentinel.
select tests.authenticate_as('fsm_customer');
select lives_ok(
  $q$ select public.finalize_payment_state_atomic(
        'bb150000-0000-4000-8000-000000000007', 'released') $q$,
  'RPC: customer finalize release succeeds (bypass sentinel lets its UPDATE through)'
);

-- ======================= verify as service_role =============================
select tests.authenticate_as_service_role();

-- 27. service_role (auth.uid() IS NULL) MAY drive release directly (webhook path).
select lives_ok(
  $q$ update public.payments set status = 'released'
       where id = 'bb150000-0000-4000-8000-0000000000f3' $q$,
  'bypass: service_role can drive release_pending -> released (webhook/cron path)'
);

-- 28. finalize committed: the customer-finalized payment is released.
select results_eq(
  $q$ select status from public.payments
       where id = 'bb150000-0000-4000-8000-0000000000f7' $q$,
  array['released'],
  'RPC: customer finalize committed — payment status is released'
);

select * from finish();

rollback;
