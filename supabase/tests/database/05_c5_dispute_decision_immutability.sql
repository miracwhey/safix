-- =============================================================================
-- pgTAP behavioral test: C4 + C5 — dispute decision immutability on the four
--   operator RPCs + reject settlement_status='pending' fix
-- =============================================================================
-- VERIFIED-REAL SCHEMA (live prod pg_get_functiondef reads 2026-06-10).
-- Source of truth:
--   supabase/migrations/20260610090000_c4_c5_dispute_decision_immutability.sql (the fix)
--   supabase/migrations/20260429000001_dispute_alignment_v2.sql (applied baseline,
--     contains the C4 'settled' bug at line 930 and the pre-fix C5 overwrite)
--   ~/.claude/plans/release-gate-2026-06-10/spec-C4-C5.md (§prodState live defs)
--
-- WHAT THIS PROVES (behavioral, not review-by-reading):
--   * C5: a dispute resolved with decision='release' can NOT be re-resolved as
--     refund or reject — both raise 'decision_immutable…' (ERRCODE P0001).
--     Pre-fix all four RPCs accepted from_status='resolved' and silently
--     overwrote the terminal decision, enabling a second conflicting money
--     movement (stripe.refunds.create fires before finalize can stop it).
--   * Same-decision re-run on a still-PENDING settlement stays allowed
--     (operator amends amounts before the money leg).
--   * C4: operator_reject_dispute now writes settlement_status='pending'
--     (pre-fix 'settled' — retry CTA never appeared, UI showed green
--     "Abgewickelt" with an unpaid provider).
--   * Settled no-op: a fully settled dispute is immutable — same-decision
--     re-run is an idempotent no-op (NO amount overwrite, NEVER a
--     settled→pending regression that would re-arm the retry CTA), and a
--     different decision still raises decision_immutable.
--   * Operator gate intact: non-operator authenticated → 42501
--     (operator_required); anon → 42501 (EXECUTE revoked).
--   * Textual pin: all four RPC defs carry the decision_immutable guard
--     (the split path has no extra behavioral case here — the pin covers it).
--   * operator_mark_dispute_under_review is intentionally NOT exercised — its
--     whitelist already excludes 'resolved' (not C5-affected, unchanged).
--
-- HOW / WHEN TO RUN — read before executing:
--   * ONLY against a prod-near database with migration
--     20260610090000_c4_c5_dispute_decision_immutability.sql APPLIED
--     (post-apply gate). The repo migration ledger has known systemic drift
--     (disputes/jobs in prod are uuid+timestamptz; old repo files say
--     text+bigint) — a `supabase start` shadow DB built from the local ledger
--     will NOT match prod and this file is NOT expected to pass there.
--   * Do NOT run pre-apply: assertions 5–25 pin the FIXED behavior.
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
  -- Reset to the session superuser first: a previous authenticate_as may have
  -- left us as `authenticated`, which cannot read auth.users or switch role.
  -- (The helper must NOT be SECURITY DEFINER — Postgres forbids setting `role`
  -- inside a security-definer function.)
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
select plan(25);

-- ---------------------------------------------------------------------------
-- Setup (superuser session — RLS/grants/trigger-guard bypassed legitimately
-- for seeding: auth.uid() is NULL here, so disputes_status_change_guard and
-- jobs triggers treat this as the trusted service path).
-- ---------------------------------------------------------------------------
select tests.create_supabase_user('c5_operator');
select tests.create_supabase_user('c5_party');

-- handle_new_user (AFTER INSERT on auth.users) creates profiles(id) rows;
-- defensive double-insert in case the stack lacks the trigger.
insert into public.profiles (id)
select tests.get_supabase_uid(i)
from unnest(array['c5_operator','c5_party']) as i
on conflict (id) do nothing;

-- Operator flag — is_current_user_operator() / _assert_caller_is_operator()
-- read profiles.is_operator.
update public.profiles
   set is_operator = true
 where id = tests.get_supabase_uid('c5_operator');

-- One job per dispute (disputes_one_active_per_job_idx allows only one ACTIVE
-- dispute per job). Ids are uuid-shaped unknown literals → valid for uuid or
-- text columns alike.
insert into public.jobs (id, title, status, customer_user_id, dispute_status)
values
  ('c5d10000-0000-4000-8000-000000000001', 'C5 job d1', 'in_progress', tests.get_supabase_uid('c5_party'), 'open'),
  ('c5d10000-0000-4000-8000-000000000002', 'C5 job d2', 'in_progress', tests.get_supabase_uid('c5_party'), 'open'),
  ('c5d10000-0000-4000-8000-000000000003', 'C5 job d3', 'in_progress', tests.get_supabase_uid('c5_party'), 'open');

-- Three OPEN disputes (whitelisted from_status). Column set mirrors what
-- open_dispute_atomic v2 (applied) inserts; decision/settlement_status start
-- NULL like every real freshly-opened dispute.
insert into public.disputes
  (id, job_id, opened_by_profile_id, customer_profile_id, status,
   reason, description, raised_by, metadata, opened_at, created_at, updated_at)
values
  ('c5d10000-0000-4000-8000-0000000000d1', 'c5d10000-0000-4000-8000-000000000001',
   tests.get_supabase_uid('c5_party'), tests.get_supabase_uid('c5_party'), 'open',
   'other', 'pgTAP C5 seed d1', (tests.get_supabase_uid('c5_party'))::text, '{}'::jsonb, now(), now(), now()),
  ('c5d10000-0000-4000-8000-0000000000d2', 'c5d10000-0000-4000-8000-000000000002',
   tests.get_supabase_uid('c5_party'), tests.get_supabase_uid('c5_party'), 'open',
   'other', 'pgTAP C4 seed d2', (tests.get_supabase_uid('c5_party'))::text, '{}'::jsonb, now(), now(), now()),
  ('c5d10000-0000-4000-8000-0000000000d3', 'c5d10000-0000-4000-8000-000000000003',
   tests.get_supabase_uid('c5_party'), tests.get_supabase_uid('c5_party'), 'open',
   'other', 'pgTAP settled seed d3', (tests.get_supabase_uid('c5_party'))::text, '{}'::jsonb, now(), now(), now());

-- ---------------------------------------------------------------------------
-- 1–4. Signature pins: the four live RPC signatures the fix replaced in-place.
-- ---------------------------------------------------------------------------
select has_function('public', 'operator_reject_dispute', array['uuid','text'],
  'signature pin: operator_reject_dispute(uuid,text)');
select has_function('public', 'operator_resolve_dispute_release', array['uuid','text','numeric','numeric'],
  'signature pin: operator_resolve_dispute_release(uuid,text,numeric,numeric)');
select has_function('public', 'operator_resolve_dispute_refund', array['uuid','text','numeric','numeric'],
  'signature pin: operator_resolve_dispute_refund(uuid,text,numeric,numeric)');
select has_function('public', 'operator_resolve_dispute_split', array['uuid','numeric','text','numeric','numeric'],
  'signature pin: operator_resolve_dispute_split(uuid,numeric,text,numeric,numeric)');

-- 5. Migration-applied pin: ALL four defs carry the decision_immutable guard
--    (covers the split path, which has no dedicated behavioral case below).
select results_eq(
  $q$ select count(*)::int
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('operator_reject_dispute',
                           'operator_resolve_dispute_release',
                           'operator_resolve_dispute_refund',
                           'operator_resolve_dispute_split')
         and pg_get_functiondef(p.oid) like '%decision_immutable%' $q$,
  array[4],
  'guard pin: all 4 operator RPCs contain the decision_immutable guard'
);

-- ====================== act as the OPERATOR =================================
select tests.authenticate_as('c5_operator');

-- 6. Bring d1 to resolved/decision='release' through the real RPC.
select lives_ok(
  $q$ select public.operator_resolve_dispute_release(
        'c5d10000-0000-4000-8000-0000000000d1', 'pgtap: first resolution', 100, 0) $q$,
  'operator resolves d1 as release (open -> resolved)'
);

-- 7. d1 terminal state is exactly what the RPC promises.
select results_eq(
  $q$ select (status = 'resolved' and decision = 'release'
              and resolution_type = 'release_full' and settlement_status = 'pending')
        from public.disputes
       where id = 'c5d10000-0000-4000-8000-0000000000d1' $q$,
  array[true],
  'd1 is resolved/release/release_full with settlement pending'
);

-- 8./9. THE C5 repro: re-resolving d1 with a DIFFERENT decision must fail.
--       Pre-fix this silently overwrote decision='release' with 'refund' and
--       opened the door to a second, conflicting money movement.
select throws_ok(
  $q$ select public.operator_resolve_dispute_refund(
        'c5d10000-0000-4000-8000-0000000000d1', 'pgtap: conflicting refund', 80, 0) $q$,
  'P0001', null,
  'C5: refund on a release-resolved dispute raises (ERRCODE P0001)'
);
select throws_like(
  $q$ select public.operator_resolve_dispute_refund(
        'c5d10000-0000-4000-8000-0000000000d1', 'pgtap: conflicting refund', 80, 0) $q$,
  '%decision_immutable%',
  'C5: the refusal is the decision_immutable guard, not a generic status error'
);

-- 10. Reject is equally blocked on a release-resolved dispute.
select throws_like(
  $q$ select public.operator_reject_dispute(
        'c5d10000-0000-4000-8000-0000000000d1', 'pgtap: conflicting reject') $q$,
  '%decision_immutable%',
  'C5: reject on a release-resolved dispute raises decision_immutable'
);

-- 11./12. Same-decision re-run stays allowed while settlement is pending
--         (operator amends amounts BEFORE the money leg runs).
select lives_ok(
  $q$ select public.operator_resolve_dispute_release(
        'c5d10000-0000-4000-8000-0000000000d1', 'pgtap: same-decision amend', 120, 0) $q$,
  'same-decision release re-run on pending settlement succeeds'
);
select results_eq(
  $q$ select (release_amount = 120 and settlement_status = 'pending')
        from public.disputes
       where id = 'c5d10000-0000-4000-8000-0000000000d1' $q$,
  array[true],
  'amend applied: release_amount updated to 120, settlement still pending'
);

-- ---------------------------------------------------------------------------
-- 13–16. C4: reject must leave settlement_status='pending' (money leg — the
--         release back to the provider — has NOT run yet at this point).
-- ---------------------------------------------------------------------------
select lives_ok(
  $q$ select public.operator_reject_dispute(
        'c5d10000-0000-4000-8000-0000000000d2', 'pgtap: c4 reject') $q$,
  'operator rejects fresh open dispute d2'
);
select results_eq(
  $q$ select (status = 'resolved' and decision = 'reject' and resolution_type = 'rejected')
        from public.disputes
       where id = 'c5d10000-0000-4000-8000-0000000000d2' $q$,
  array[true],
  'd2 is resolved/reject/rejected'
);
select results_eq(
  $q$ select settlement_status
        from public.disputes
       where id = 'c5d10000-0000-4000-8000-0000000000d2' $q$,
  array['pending'],
  'C4: reject writes settlement_status=pending (pre-fix bug wrote settled)'
);
select results_eq(
  $q$ select count(*)::int
        from public.dispute_status_history
       where dispute_id = 'c5d10000-0000-4000-8000-0000000000d2'
         and next_status = 'resolved'
         and source = 'admin' $q$,
  array[1],
  'reject wrote exactly one admin history row for d2'
);

-- ---------------------------------------------------------------------------
-- 17–21. Settled immutability on d3: resolve -> settle -> re-run is a no-op.
-- ---------------------------------------------------------------------------
select lives_ok(
  $q$ select public.operator_resolve_dispute_release(
        'c5d10000-0000-4000-8000-0000000000d3', 'pgtap: resolve before settle', 50, 0) $q$,
  'operator resolves d3 as release before settlement'
);

-- 18. Operator settles d3 directly (the real settleDispute path runs as
--     operator: disputes_update_own_side operator branch + status-change
--     guard operator branch must BOTH allow this write).
select isnt_empty(
  $q$ update public.disputes
         set settlement_status = 'settled'
       where id = 'c5d10000-0000-4000-8000-0000000000d3'
   returning id $q$,
  'operator can settle d3 (settlement pending -> settled)'
);

-- 19./20. Same-decision re-run on a SETTLED dispute is an idempotent no-op:
--         no amount overwrite, and — critically — NO settled->pending
--         regression that would re-arm the retry CTA and enable double release.
select lives_ok(
  $q$ select public.operator_resolve_dispute_release(
        'c5d10000-0000-4000-8000-0000000000d3', 'pgtap: settled same-decision retry', 999, 0) $q$,
  'same-decision re-run on settled dispute returns idempotently'
);
select results_eq(
  $q$ select (settlement_status = 'settled' and release_amount = 50)
        from public.disputes
       where id = 'c5d10000-0000-4000-8000-0000000000d3' $q$,
  array[true],
  'settled no-op: settlement stays settled, release_amount stays 50 (not 999)'
);

-- 21. Different decision on a settled dispute: decision guard fires first.
select throws_like(
  $q$ select public.operator_resolve_dispute_refund(
        'c5d10000-0000-4000-8000-0000000000d3', 'pgtap: refund after settle', 50, 0) $q$,
  '%decision_immutable%',
  'settled + different decision still raises decision_immutable'
);

-- ====================== fences: non-operator + anon =========================
select tests.authenticate_as('c5_party');

-- 22. Authenticated non-operator: EXECUTE is granted, the operator assert
--     inside the RPC refuses (operator_required, 42501).
select throws_ok(
  $q$ select public.operator_resolve_dispute_release(
        'c5d10000-0000-4000-8000-0000000000d1', 'pgtap: forged by party', 1, 0) $q$,
  '42501', null,
  'fence: non-operator authenticated caller gets 42501 (operator_required)'
);

select tests.authenticate_as_anon();

-- 23. anon has NO EXECUTE on the RPCs (REVOKE ... FROM PUBLIC, anon).
select throws_ok(
  $q$ select public.operator_resolve_dispute_release(
        'c5d10000-0000-4000-8000-0000000000d1', 'pgtap: forged by anon', 1, 0) $q$,
  '42501', null,
  'fence: anon cannot EXECUTE operator_resolve_dispute_release'
);

-- ====================== integrity check as service_role ====================
select tests.authenticate_as_service_role();

-- 24. Terminal decisions survived every attack attempt unchanged.
select results_eq(
  $q$ select (
        (select decision from public.disputes where id = 'c5d10000-0000-4000-8000-0000000000d1') = 'release'
        and (select decision from public.disputes where id = 'c5d10000-0000-4000-8000-0000000000d2') = 'reject'
        and (select settlement_status from public.disputes where id = 'c5d10000-0000-4000-8000-0000000000d3') = 'settled'
      ) $q$,
  array[true],
  'integrity: d1=release, d2=reject, d3 settled — nothing was overwritten'
);

-- 25. Job mirror writes happened for all three resolutions.
select results_eq(
  $q$ select count(*)::int
        from public.jobs
       where id in ('c5d10000-0000-4000-8000-000000000001',
                    'c5d10000-0000-4000-8000-000000000002',
                    'c5d10000-0000-4000-8000-000000000003')
         and dispute_status = 'resolved' $q$,
  array[3],
  'integrity: jobs.dispute_status mirrored to resolved for all 3 jobs'
);

select * from finish();

rollback;
