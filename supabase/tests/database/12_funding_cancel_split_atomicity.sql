-- =============================================================================
-- pgTAP: funding cancel/confirm handshake + split quota reservations
-- Targets migrations 20260713002430 and 20260713002434.
-- All fixtures and changes roll back.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path to public, extensions, auth, pg_catalog;

select plan(21);

-- Schema and privilege pins.
select has_function('public', 'confirm_funding_atomic', array['uuid','uuid','text']::name[],
  'confirm_funding_atomic(uuid,uuid,text) exists');
select has_function('public', 'reserve_split_release_quota', array['text','text','numeric']::name[],
  'reserve_split_release_quota(text,text,numeric) exists');
select has_function('public', 'release_split_release_reservation', array['text','text','numeric']::name[],
  'release_split_release_reservation(text,text,numeric) exists');
select has_trigger('public', 'jobs', 'guard_job_cancellation_against_funding_tg',
  'job cancellation funding guard is installed');
select has_trigger('public', 'projects', 'cascade_project_cancellation_to_job_tg',
  'project cancellation atomically cascades to its accepted job');
select has_column('public', 'escrow_tranches', 'split_reserved_gross',
  'split reservation gross is persisted');
select ok(not has_function_privilege('authenticated',
  'public.reserve_split_release_quota(text,text,numeric)', 'EXECUTE'),
  'authenticated clients cannot reserve money quota directly');
select ok(has_function_privilege('service_role',
  'public.reserve_split_release_quota(text,text,numeric)', 'EXECUTE'),
  'service_role can reserve money quota');

-- Minimal FK fixtures shared by the three scenarios.
insert into auth.users
  (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, aud, role)
values
  ('ca130000-0000-4000-8000-000000000031', 'cancel-customer-1@test.fixup.local', '{}'::jsonb, '{}'::jsonb, now(), now(), 'authenticated', 'authenticated'),
  ('ca130000-0000-4000-8000-000000000032', 'cancel-customer-2@test.fixup.local', '{}'::jsonb, '{}'::jsonb, now(), now(), 'authenticated', 'authenticated'),
  ('ca130000-0000-4000-8000-000000000033', 'split-customer@test.fixup.local', '{}'::jsonb, '{}'::jsonb, now(), now(), 'authenticated', 'authenticated'),
  ('ca130000-0000-4000-8000-000000000042', 'funding-provider-1@test.fixup.local', '{}'::jsonb, '{}'::jsonb, now(), now(), 'authenticated', 'authenticated'),
  ('ca130000-0000-4000-8000-000000000043', 'funding-provider-2@test.fixup.local', '{}'::jsonb, '{}'::jsonb, now(), now(), 'authenticated', 'authenticated');

insert into public.profiles (id)
values
  ('ca130000-0000-4000-8000-000000000031'),
  ('ca130000-0000-4000-8000-000000000032'),
  ('ca130000-0000-4000-8000-000000000033'),
  ('ca130000-0000-4000-8000-000000000042'),
  ('ca130000-0000-4000-8000-000000000043');

insert into public.providers (id)
values
  ('ca130000-0000-4000-8000-000000000041'),
  ('ca130000-0000-4000-8000-000000000042'),
  ('ca130000-0000-4000-8000-000000000043');

insert into public.offers (id, customer_user_id, craftsman_user_id, price, status)
values
  ('ca130000-0000-4000-8000-000000000021', 'ca130000-0000-4000-8000-000000000031',
   'ca130000-0000-4000-8000-000000000042', '100', 'accepted'),
  ('ca130000-0000-4000-8000-000000000022', 'ca130000-0000-4000-8000-000000000032',
   'ca130000-0000-4000-8000-000000000043', '100', 'accepted'),
  ('ca130000-0000-4000-8000-000000000023', 'ca130000-0000-4000-8000-000000000033',
   'ca130000-0000-4000-8000-000000000043', '100', 'accepted');

-- Incompatible plan: confirmation must write nothing.
insert into public.jobs (id, title, status)
values ('ca130000-0000-4000-8000-000000000001', 'confirm incompatible plan', 'in_progress');

insert into public.escrow_payment_plans
  (id, source_offer_id, job_id, customer_user_id, provider_id, total_amount, status)
values
  ('ca130000-0000-4000-8000-000000000011', 'ca130000-0000-4000-8000-000000000021',
   'ca130000-0000-4000-8000-000000000001', 'ca130000-0000-4000-8000-000000000031',
   'ca130000-0000-4000-8000-000000000041', 100, 'funding_failed');

insert into public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status)
values
  ('ca130000-0000-4000-8000-000000000051', 'ca130000-0000-4000-8000-000000000011',
   'deposit_release', 25, 25, 'work_started', 'pending_funding');

insert into public.funding_requests
  (id, source_offer_id, job_id, escrow_plan_id, customer_user_id, provider_id,
   provider_user_id, status, amount)
values
  ('ca130000-0000-4000-8000-000000000061', 'ca130000-0000-4000-8000-000000000021',
   'ca130000-0000-4000-8000-000000000001', 'ca130000-0000-4000-8000-000000000011',
   'ca130000-0000-4000-8000-000000000031', 'ca130000-0000-4000-8000-000000000041',
   'ca130000-0000-4000-8000-000000000042', 'sent', 100);

select is(
  (public.confirm_funding_atomic(
    'ca130000-0000-4000-8000-000000000061',
    'ca130000-0000-4000-8000-000000000011', 'pi_incompatible'
  )->>'outcome'),
  'invalid_state',
  'incompatible plan state is rejected before writes'
);
select results_eq(
  $$ select status from public.funding_requests where id = 'ca130000-0000-4000-8000-000000000061' $$,
  array['sent'],
  'rejected confirmation leaves funding request unchanged'
);
select results_eq(
  $$ select status from public.escrow_tranches where id = 'ca130000-0000-4000-8000-000000000051' $$,
  array['pending_funding'],
  'rejected confirmation leaves tranche unchanged'
);

-- A live PI can lose the race to cancellation. Job cancellation commits while
-- the request remains initiated so confirm returns job_terminal for refund.
update public.escrow_payment_plans
   set status = 'funding_initiated'
 where id = 'ca130000-0000-4000-8000-000000000011';
update public.funding_requests
   set status = 'funding_initiated'
 where id = 'ca130000-0000-4000-8000-000000000061';
update public.jobs
   set status = 'cancelled'
 where id = 'ca130000-0000-4000-8000-000000000001';

select results_eq(
  $$ select status from public.funding_requests where id = 'ca130000-0000-4000-8000-000000000061' $$,
  array['funding_initiated'],
  'cancellation preserves live-PI request for terminal refund handling'
);
select is(
  (public.confirm_funding_atomic(
    'ca130000-0000-4000-8000-000000000061',
    'ca130000-0000-4000-8000-000000000011', 'pi_cancel_race'
  )->>'outcome'),
  'job_terminal',
  'confirmation that loses the job lock observes terminal cancellation'
);

-- Once funded, the cancellation trigger refuses to kill the job.
insert into public.jobs (id, title, status)
values ('ca130000-0000-4000-8000-000000000002', 'funded cancellation blocked', 'in_progress');
insert into public.escrow_payment_plans
  (id, source_offer_id, job_id, customer_user_id, provider_id, total_amount, status)
values
  ('ca130000-0000-4000-8000-000000000012', 'ca130000-0000-4000-8000-000000000022',
   'ca130000-0000-4000-8000-000000000002', 'ca130000-0000-4000-8000-000000000032',
   'ca130000-0000-4000-8000-000000000042', 100, 'funded_in_escrow');
insert into public.funding_requests
  (id, source_offer_id, job_id, escrow_plan_id, customer_user_id, provider_id,
   provider_user_id, status, amount)
values
  ('ca130000-0000-4000-8000-000000000062', 'ca130000-0000-4000-8000-000000000022',
   'ca130000-0000-4000-8000-000000000002', 'ca130000-0000-4000-8000-000000000012',
   'ca130000-0000-4000-8000-000000000032', 'ca130000-0000-4000-8000-000000000042',
   'ca130000-0000-4000-8000-000000000043', 'funded', 100);

select throws_like(
  $$ update public.jobs set status = 'cancelled' where id = 'ca130000-0000-4000-8000-000000000002' $$,
  '%job_cancel_blocked_by_funding%',
  'funded job cancellation is rejected atomically'
);
select results_eq(
  $$ select status from public.jobs where id = 'ca130000-0000-4000-8000-000000000002' $$,
  array['in_progress'],
  'blocked cancellation leaves funded job active'
);

-- Split reservation: first sibling consumes the exact target; the second
-- cannot reserve the same plan quota, and retrying the first is idempotent.
insert into public.jobs (id, title, status)
values ('ca130000-0000-4000-8000-000000000003', 'split reservation', 'waiting_payment');
insert into public.escrow_payment_plans
  (id, source_offer_id, job_id, customer_user_id, provider_id, total_amount, status)
values
  ('ca130000-0000-4000-8000-000000000013', 'ca130000-0000-4000-8000-000000000023',
   'ca130000-0000-4000-8000-000000000003', 'ca130000-0000-4000-8000-000000000033',
   'ca130000-0000-4000-8000-000000000043', 100, 'disputed');
insert into public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status)
values
  ('ca130000-0000-4000-8000-000000000053', 'ca130000-0000-4000-8000-000000000013',
   'deposit_release', 60, 60, 'work_started', 'eligible_for_release'),
  ('ca130000-0000-4000-8000-000000000054', 'ca130000-0000-4000-8000-000000000013',
   'final_release', 40, 40, 'work_completed', 'eligible_for_release');

select is(
  (public.reserve_split_release_quota(
    'ca130000-0000-4000-8000-000000000053',
    'ca130000-0000-4000-8000-000000000013', 0.60
  )->>'reserved_gross')::numeric,
  60::numeric,
  'first sibling reserves the exact provider target'
);
select is(
  (public.reserve_split_release_quota(
    'ca130000-0000-4000-8000-000000000054',
    'ca130000-0000-4000-8000-000000000013', 0.60
  )->>'outcome'),
  'quota_exhausted',
  'second sibling cannot double-spend an existing reservation'
);
select is(
  (public.reserve_split_release_quota(
    'ca130000-0000-4000-8000-000000000053',
    'ca130000-0000-4000-8000-000000000013', 0.60
  )->>'idempotent')::boolean,
  true,
  'same-tranche retry reuses its durable reservation'
);
select results_eq(
  $$ select split_reserved_gross from public.escrow_tranches
      where id = 'ca130000-0000-4000-8000-000000000053' $$,
  array[60::numeric],
  'reserved gross is persisted as database truth'
);
select is(
  public.release_split_release_reservation(
    'ca130000-0000-4000-8000-000000000053',
    'ca130000-0000-4000-8000-000000000013', 0.60
  ),
  true,
  'definitive no-movement path can release the reservation'
);
select results_eq(
  $$ select split_reserved_gross from public.escrow_tranches
      where id = 'ca130000-0000-4000-8000-000000000053' $$,
  array[null::numeric],
  'released reservation clears all quota state'
);

select * from finish();
rollback;
