-- =============================================================================
-- pgTAP behavioral test: P1.5 realigned public.ledger_entries write shape
-- =============================================================================
-- VERIFIED-REAL SCHEMA. Source of truth: PROD DB (project itdntawwuzqfwmcwnwjr),
-- verified live 2026-06-13 (0 rows), realigned by
--   supabase/migrations/20260613010000_p1_5_ledger_movement_realign.sql
--
-- Prod public.ledger_entries:
--   id uuid PK default gen_random_uuid(); payment_id uuid NULL; job_id uuid NULL;
--   dispute_id uuid NULL; entry_type text NOT NULL CHECK(enum); amount numeric
--   NOT NULL CHECK(>=0); currency text default 'EUR'; created_at timestamptz
--   NOT NULL default now(); metadata jsonb default '{}'; type text NULL (legacy).
--   + (P1.5) movement_ref text NOT NULL default ''.
--   UNIQUE(payment_id, entry_type, movement_ref)  [replaced UNIQUE(payment_id,entry_type)]
--
-- WHY THIS IS THE REAL INVARIANT
--   The first real escrow movement (tranche payout / refund / reversal /
--   supplementary) must persist a ledger row. The pre-P1.5 writers emitted a
--   shape prod rejects (entry_type NULL -> 23502, 'tranche_release' not in enum
--   -> 23514, missing `note` column, epoch-ms into timestamptz). This test proves
--   BEHAVIORALLY, at the DB layer, that:
--     - the prod-valid shape (id+created_at omitted -> defaults) persists,
--     - the legacy values are rejected by the entry_type CHECK,
--     - NULL entry_type / negative amount are rejected,
--     - the widened UNIQUE lets N distinct movements on one payment coexist
--       (the tranche/SPR collision fix) while still deduping true retries.
--
-- Prod has NO FK on payment_id, so arbitrary uuids insert with no fixtures.
-- All inserts run as the superuser session (RLS bypassed) — this isolates the
-- column DEFAULTS + CHECK + UNIQUE, not RLS. Everything rolls back -> prod untouched.
-- Run with: supabase test db   (see supabase/tests/database/README.md)
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path to public, extensions, pg_catalog;

select plan(18);

-- A fixed payment_id reused across rows; movements differ by (entry_type, movement_ref).
-- (Prod payment_id is uuid; on the drifted local chain it may be text — a uuid
--  literal stores fine into either, and this test never asserts its type.)

-- ── Shape (the realigned columns exist with the right nullability/type) ───────
select has_column('ledger_entries', 'entry_type',
  'ledger_entries.entry_type column exists (prod NOT NULL enum)');
select col_not_null('ledger_entries', 'entry_type',
  'ledger_entries.entry_type is NOT NULL');
select has_column('ledger_entries', 'movement_ref',
  'ledger_entries.movement_ref discriminator column exists (P1.5)');
select col_not_null('ledger_entries', 'movement_ref',
  'ledger_entries.movement_ref is NOT NULL');
select has_column('ledger_entries', 'metadata',
  'ledger_entries.metadata jsonb column exists (carries the human note)');
select col_type_is('ledger_entries', 'created_at', 'timestamp with time zone',
  'ledger_entries.created_at is timestamptz (never epoch-ms bigint)');

-- ── Defaults fire when id + created_at are OMITTED (the realigned writer shape) ─
select lives_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', 'payout', 100, 't1') $q$,
  'realigned payout row (id+created_at omitted) persists'
);
select ok(
  (select created_at is not null and id is not null
     from public.ledger_entries
    where payment_id::text = '00000000-0000-0000-0000-000000000001'
      and entry_type = 'payout' and movement_ref = 't1'),
  'omitted id + created_at were filled by column DEFAULTs (gen_random_uuid / now)'
);

-- ── Legacy / out-of-enum entry_type values are rejected by the CHECK (23514) ──
select throws_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', 'tranche_release', 100, 'tx1') $q$,
  '23514',
  null,
  'legacy entry_type=tranche_release rejected by entry_type CHECK'
);
select throws_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', 'transfer_reversal', 100, 'tx2') $q$,
  '23514',
  null,
  'legacy entry_type=transfer_reversal rejected by entry_type CHECK'
);
select throws_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', 'supplementary_payout', 100, 'tx3') $q$,
  '23514',
  null,
  'legacy entry_type=supplementary_payout rejected by entry_type CHECK'
);

-- ── NOT NULL on entry_type (23502) and amount>=0 CHECK (23514) ────────────────
select throws_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', null, 100, 'tn') $q$,
  '23502',
  null,
  'NULL entry_type rejected by NOT NULL'
);
select throws_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', 'payout', -1, 'tneg') $q$,
  '23514',
  null,
  'negative amount rejected by amount>=0 CHECK'
);

-- ── Collision fix: two distinct movements, same (payment_id,'payout') coexist ─
-- This is the REAL first-complete-job case: deposit_release + final_release both
-- map to entry_type='payout' on the SAME payment_id; distinct movement_ref lets
-- both persist instead of the second 23505-ing after Stripe moved the money.
select lives_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', 'payout', 200, 't2') $q$,
  'second distinct payout (movement_ref t2) on same payment coexists with t1'
);
select results_eq(
  $q$ select count(*)::int from public.ledger_entries
       where payment_id::text = '00000000-0000-0000-0000-000000000001'
         and entry_type = 'payout' $q$,
  $q$ values (2) $q$,
  'both payout movements (t1, t2) recorded as distinct rows'
);

-- ── Retry idempotency still enforced: a TRUE duplicate of the business key ────
select throws_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', 'payout', 200, 't1') $q$,
  '23505',
  null,
  'duplicate (payment_id, payout, t1) blocked by widened UNIQUE — retry dedupe'
);

-- ── Singular-movement dedupe: refund discriminates on movement_ref='' ─────────
-- Both webhook refund writers share (payment_id,'refund',''), so the second is a
-- no-op (ON CONFLICT DO NOTHING) — proven here as the UNIQUE blocking the dupe.
select lives_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', 'refund', 50, '') $q$,
  'refund row with movement_ref='''' persists (does not collide with payouts)'
);
select throws_ok(
  $q$ insert into public.ledger_entries (payment_id, entry_type, amount, movement_ref)
      values ('00000000-0000-0000-0000-000000000001', 'refund', 75, '') $q$,
  '23505',
  null,
  'second refund (payment_id, refund, '''') blocked — cross-path refund dedupe'
);

select * from finish();

rollback;
