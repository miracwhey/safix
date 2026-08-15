-- =============================================================================
-- pgTAP behavioral test: H12 — terminal status immutability on public.jobs
-- =============================================================================
-- VERIFIED-REAL SCHEMA (prod dumps + pre-apply checks 2026-06-10).
-- Source of truth:
--   supabase/migrations/20260610154500_h12_jobs_terminal_status_immutability.sql (the fix)
--
-- WHAT THIS PROVES (behavioral, not review-by-reading):
--   * Authenticated NON-operator cannot pull a job out of a terminal status:
--     completed→in_progress and cancelled→new both raise ERRCODE 23514
--     (check_violation — classifyFailure.ts class 23 → 'business-rejected',
--     so flushPendingMutations drops the queue entry instead of replaying).
--   * No-op writes (SET status = status) PASS — the trigger's WHEN clause
--     (OLD.status IS DISTINCT FROM NEW.status) does not fire. This is the
--     load-bearing detail for the prod SECDEF-RPC inventory: 11 RPCs update
--     jobs, and the ONLY one that writes the status column is
--     finalize_payment_state_atomic — as
--       status = CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END
--     i.e. a no-op write on any terminal job (pre-apply check 2026-06-10).
--   * finalize_payment_state_atomic on a COMPLETED job does NOT fail when
--     called by an authenticated participant (the real browser release path):
--     status lands in the SET list but as a CASE no-op, so the guard never
--     fires and the payment still finalizes.
--   * service_role (auth.uid() IS NULL: stripe-webhook, cron reconciliation,
--     api/* admin client) MAY leave terminal — repair path stays open.
--   * Operators MAY leave terminal (same bypass pattern as
--     disputes_status_change_guard).
--   * waiting_payment is NOT terminal: waiting_payment→completed passes for
--     the authenticated customer (no conflict with finalize's CASE).
--
-- HOW / WHEN TO RUN — read before executing:
--   * ONLY against a prod-near database with migration
--     20260610154500_h12_jobs_terminal_status_immutability.sql APPLIED
--     (post-apply gate). The repo migration ledger has known systemic drift
--     (prod jobs/payments use uuid/timestamptz where old repo files say
--     text/bigint) — a `supabase start` shadow DB built from the local ledger
--     will NOT match prod and this file is NOT expected to pass there.
--   * Do NOT run pre-apply: assertions 3–18 pin the FIXED behavior.
--   * Command: `supabase test db` (pg_prove -r auto-discovers this dir).
--   * pgTAP CI is red/non-required (ledger drift) — treat as advisory there;
--     the authoritative run is the manual post-apply run.
--
-- Helpers vendored INLINE inside BEGIN..ROLLBACK (basejump patterns) — nothing
-- persists, no prod data is touched beyond the rolled-back transaction.
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
select plan(18);

-- ---------------------------------------------------------------------------
-- Setup (superuser session — RLS/grants/trigger bypassed legitimately for
-- seeding: auth.uid() is NULL here = trusted service path).
-- ---------------------------------------------------------------------------
select tests.create_supabase_user('h12_customer');
select tests.create_supabase_user('h12_operator');

insert into public.profiles (id)
select tests.get_supabase_uid(i)
from unnest(array['h12_customer','h12_operator']) as i
on conflict (id) do nothing;

update public.profiles
   set is_operator = true
 where id = tests.get_supabase_uid('h12_operator');

-- One job per scenario (independent assertions, no cross-contamination).
-- The test user is seeded as BOTH customer_user_id and craftsman_user_id so
-- the row passes jobs RLS and finalize's participant check regardless of
-- which side the live policy/RPC compares (prod: customer uuid, craftsman
-- text). Ids are uuid-shaped unknown literals → valid for uuid or text cols.
insert into public.jobs (id, title, status, customer_user_id, craftsman_user_id)
values
  ('aa120000-0000-4000-8000-000000000011', 'H12 terminal completed', 'completed',
   tests.get_supabase_uid('h12_customer'), tests.get_supabase_uid('h12_customer')),
  ('aa120000-0000-4000-8000-000000000012', 'H12 terminal cancelled', 'cancelled',
   tests.get_supabase_uid('h12_customer'), tests.get_supabase_uid('h12_customer')),
  ('aa120000-0000-4000-8000-000000000013', 'H12 waiting_payment',    'waiting_payment',
   tests.get_supabase_uid('h12_customer'), tests.get_supabase_uid('h12_customer')),
  ('aa120000-0000-4000-8000-000000000014', 'H12 service unlock',     'completed',
   tests.get_supabase_uid('h12_customer'), tests.get_supabase_uid('h12_customer')),
  ('aa120000-0000-4000-8000-000000000015', 'H12 operator unlock',    'completed',
   tests.get_supabase_uid('h12_operator'), tests.get_supabase_uid('h12_operator')),
  ('aa120000-0000-4000-8000-000000000016', 'H12 finalize on completed', 'completed',
   tests.get_supabase_uid('h12_customer'), tests.get_supabase_uid('h12_customer'));

-- Payment for the finalize case. 'release_pending' → target 'released' passes
-- the RPC's state machine. created_at/updated_at type differs between the
-- repo ledger (bigint epoch-ms) and prod (timestamptz) — branch on the live
-- column type so the seed works on whichever prod-near schema is present
-- (plpgsql plans branches lazily; the untaken branch is never type-checked).
do $seed$
declare
  v_ts_type text;
begin
  select data_type into v_ts_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'payments'
     and column_name  = 'created_at';

  if v_ts_type in ('bigint', 'integer', 'numeric') then
    insert into public.payments (id, job_id, status, total_amount, created_at, updated_at)
    values ('aa120000-0000-4000-8000-0000000000f1',
            'aa120000-0000-4000-8000-000000000016',
            'release_pending', 500,
            (extract(epoch from now()) * 1000)::bigint,
            (extract(epoch from now()) * 1000)::bigint);
  else
    insert into public.payments (id, job_id, status, total_amount, created_at, updated_at)
    values ('aa120000-0000-4000-8000-0000000000f1',
            'aa120000-0000-4000-8000-000000000016',
            'release_pending', 500, now(), now());
  end if;
end
$seed$;

-- ---------------------------------------------------------------------------
-- 1./2. Schema pins: guard function + trigger installed by 20260610154500.
-- ---------------------------------------------------------------------------
select has_function('public', 'jobs_terminal_status_guard', '{}'::name[],
  'schema pin: jobs_terminal_status_guard() exists');
select has_trigger('public', 'jobs', 'jobs_terminal_status_guard_tg',
  'schema pin: jobs_terminal_status_guard_tg trigger installed on public.jobs');

-- ====================== act as authenticated NON-operator ===================
select tests.authenticate_as('h12_customer');

-- 3./4. THE repro: terminal completed→in_progress is blocked with 23514.
select throws_ok(
  $q$ update public.jobs
         set status = 'in_progress'
       where id = 'aa120000-0000-4000-8000-000000000011' $q$,
  '23514', null,
  'H12: non-operator cannot move completed -> in_progress (23514)'
);
select throws_like(
  $q$ update public.jobs
         set status = 'in_progress'
       where id = 'aa120000-0000-4000-8000-000000000011' $q$,
  '%terminal_status_immutable%',
  'H12: the refusal is terminal_status_immutable, not a CHECK-constraint clash'
);

-- 5. cancelled→new is blocked the same way.
select throws_ok(
  $q$ update public.jobs
         set status = 'new'
       where id = 'aa120000-0000-4000-8000-000000000012' $q$,
  '23514', null,
  'H12: non-operator cannot move cancelled -> new (23514)'
);

-- 6./7. Blocked attempts changed nothing.
select results_eq(
  $q$ select status from public.jobs
       where id = 'aa120000-0000-4000-8000-000000000011' $q$,
  array['completed'],
  'integrity: completed job untouched after blocked attempts'
);
select results_eq(
  $q$ select status from public.jobs
       where id = 'aa120000-0000-4000-8000-000000000012' $q$,
  array['cancelled'],
  'integrity: cancelled job untouched after blocked attempt'
);

-- 8./9. No-op write passes: WHEN (OLD.status IS DISTINCT FROM NEW.status)
--       keeps the trigger silent even though status is in the SET list.
select isnt_empty(
  $q$ update public.jobs
         set status = status
       where id = 'aa120000-0000-4000-8000-000000000011'
   returning id $q$,
  'no-op: SET status = status on a completed job passes for non-operator'
);
select results_eq(
  $q$ select status from public.jobs
       where id = 'aa120000-0000-4000-8000-000000000011' $q$,
  array['completed'],
  'no-op: status still completed after the no-op write'
);

-- 10./11. waiting_payment is NOT terminal — the regular completion path of
--         the job FSM stays open for the customer.
select isnt_empty(
  $q$ update public.jobs
         set status = 'completed'
       where id = 'aa120000-0000-4000-8000-000000000013'
   returning id $q$,
  'not terminal: waiting_payment -> completed passes for non-operator'
);
select results_eq(
  $q$ select status from public.jobs
       where id = 'aa120000-0000-4000-8000-000000000013' $q$,
  array['completed'],
  'waiting_payment job is now completed'
);

-- 12. PROD-RPC parity: finalize_payment_state_atomic on a COMPLETED job must
--     NOT fail for an authenticated participant. Its jobs UPDATE always puts
--     status in the SET list, but as
--       CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END
--     — a no-op on a completed job, so the guard's WHEN clause never fires.
select lives_ok(
  $q$ select public.finalize_payment_state_atomic(
        'aa120000-0000-4000-8000-000000000016', 'released') $q$,
  'finalize_payment_state_atomic on a completed job does not trip the guard'
);

-- ====================== verify finalize effects as service_role =============
select tests.authenticate_as_service_role();

-- 13./14. The finalize actually committed: payment released, job untouched
--         in status but payment_state mirrored.
select results_eq(
  $q$ select status from public.payments
       where id = 'aa120000-0000-4000-8000-0000000000f1' $q$,
  array['released'],
  'finalize committed: payment status is released'
);
select results_eq(
  $q$ select (status = 'completed' and payment_state = 'released')
        from public.jobs
       where id = 'aa120000-0000-4000-8000-000000000016' $q$,
  array[true],
  'finalize committed: job stays completed, payment_state mirrored to released'
);

-- 15./16. service_role (auth.uid() IS NULL) may leave terminal — webhook/cron
--         repair path stays open.
select lives_ok(
  $q$ update public.jobs
         set status = 'in_progress'
       where id = 'aa120000-0000-4000-8000-000000000014' $q$,
  'bypass: service_role can move completed -> in_progress'
);
select results_eq(
  $q$ select status from public.jobs
       where id = 'aa120000-0000-4000-8000-000000000014' $q$,
  array['in_progress'],
  'bypass: service-role unlock actually persisted'
);

-- ====================== act as the OPERATOR =================================
select tests.authenticate_as('h12_operator');

-- 17./18. Operator may leave terminal (job_op is operator-owned so the row is
--         reachable through jobs RLS; the guard exempts via
--         is_current_user_operator()).
select lives_ok(
  $q$ update public.jobs
         set status = 'in_progress'
       where id = 'aa120000-0000-4000-8000-000000000015' $q$,
  'bypass: operator can move completed -> in_progress'
);
select results_eq(
  $q$ select status from public.jobs
       where id = 'aa120000-0000-4000-8000-000000000015' $q$,
  array['in_progress'],
  'bypass: operator unlock actually persisted'
);

select * from finish();

rollback;
