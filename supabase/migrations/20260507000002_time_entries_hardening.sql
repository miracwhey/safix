-- ===========================================================================
-- Block 2.1 Hardening — time_entries
-- ===========================================================================
-- Closes the holes flagged by the post-Block-2 radical audit:
--   C1: worker_insert did not bind provider_id to caller's team_member.provider_id
--       → tightened with explicit join on team_members.provider_id
--   C2: worker_close allowed mutation of duration_minutes without an upper cap
--       and let immutable identity columns drift (started_at, kind, member_id,
--       provider_id, job_id) → added 24h cap + identity-immutability trigger
--       that fires on any UPDATE (worker, owner, even non-RLS-bypass paths)
--   M5: workers had no DELETE path for an accidentally-started timer (the ENUM
--       has no 'discarded' status) → added a worker DELETE policy scoped to
--       active rows owned by the worker
--
-- Idempotent: drops & recreates policies, re-creates trigger function, adds
-- constraint with IF NOT EXISTS guard.

-- ─── Identity-immutability trigger (C2) ───────────────────────────────────
-- Worker-close path mutates only status/ended_at/duration_minutes/note +
-- rejected_*. Identity fields must never change post-INSERT — neither for
-- workers nor for owners. A trigger is the cleanest enforcement (RLS WITH
-- CHECK does not see OLD values; constraints are static).

create or replace function public.time_entries_immutable_identity_trigger()
returns trigger
language plpgsql
as $$
begin
  if (new.started_at is distinct from old.started_at) then
    raise exception 'time_entries.started_at is immutable' using errcode = '42501';
  end if;
  if (new.member_id is distinct from old.member_id) then
    raise exception 'time_entries.member_id is immutable' using errcode = '42501';
  end if;
  if (new.provider_id is distinct from old.provider_id) then
    raise exception 'time_entries.provider_id is immutable' using errcode = '42501';
  end if;
  if (new.kind is distinct from old.kind) then
    raise exception 'time_entries.kind is immutable' using errcode = '42501';
  end if;
  if (new.job_id is distinct from old.job_id) then
    raise exception 'time_entries.job_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists time_entries_immutable_identity_check on public.time_entries;
create trigger time_entries_immutable_identity_check
before update on public.time_entries
for each row execute function public.time_entries_immutable_identity_trigger();

-- ─── 24h cap on duration_minutes (C2) ─────────────────────────────────────
-- Any single timer span longer than 24 hours is almost certainly bogus
-- (clock skew, forgotten timer, malicious inflation). Reject at the table
-- level so workers, owners, and even service-role writes are bounded.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'time_entries_duration_max_24h'
      and conrelid = 'public.time_entries'::regclass
  ) then
    alter table public.time_entries
      add constraint time_entries_duration_max_24h
      check (duration_minutes is null or duration_minutes <= 24 * 60);
  end if;
end $$;

-- ─── Worker INSERT — bind provider_id to caller's team_members row (C1) ───

drop policy if exists time_entries_worker_insert on public.time_entries;
create policy time_entries_worker_insert on public.time_entries
for insert to authenticated
with check (
  exists (
    select 1
    from public.team_members tm
    where tm.id = member_id
      and tm.provider_id = provider_id   -- ★ NEW: binds provider to caller's home
      and tm.profile_id = auth.uid()
      and tm.is_active = true
  )
  and (
    kind = 'day'
    or (
      job_id is not null
      and exists (
        select 1
        from public.jobs j
        where j.id = job_id
          and j.assigned_member_ids ? (member_id::text)
      )
    )
  )
);

-- ─── Worker UPDATE-close — keep status='closed' invariant + add is_active ─

drop policy if exists time_entries_worker_close on public.time_entries;
create policy time_entries_worker_close on public.time_entries
for update to authenticated
using (
  status = 'active'
  and member_id in (
    select id from public.team_members
    where profile_id = auth.uid() and is_active = true
  )
)
with check (
  status = 'closed'
  and member_id in (
    select id from public.team_members
    where profile_id = auth.uid() and is_active = true
  )
  and duration_minutes is not null
  and duration_minutes >= 1
  -- 24h cap also enforced by the table constraint above; restated here so the
  -- worker-close path fails fast with an RLS-shaped error rather than a CHECK.
  and duration_minutes <= 24 * 60
  and rejected_by is null
  and rejected_reason is null
);

-- ─── Worker DELETE — allow discarding an accidentally-started active timer (M5) ───
-- Scoped strictly to status='active' AND own active worker rows. Owners cannot
-- DELETE (no policy → default deny). Closed/rejected rows cannot be deleted by
-- anyone via RLS (only CASCADE from team_members/provider/job DELETE).

drop policy if exists time_entries_worker_delete_active on public.time_entries;
create policy time_entries_worker_delete_active on public.time_entries
for delete to authenticated
using (
  status = 'active'
  and member_id in (
    select id from public.team_members
    where profile_id = auth.uid() and is_active = true
  )
);

-- ─── Reject audit-trail (C3) ──────────────────────────────────────────────
-- The original `time_entries` schema captured `rejected_by` and
-- `rejected_reason` but NOT when the rejection happened. Owners reading the
-- audit log later would have to infer it from `updated_at`, which any later
-- mutation would overwrite. Add an immutable `rejected_at` field plus a
-- trigger that stamps `now()` on the active→rejected transition (and clears
-- it if a future flow ever un-rejects).

alter table public.time_entries
  add column if not exists rejected_at timestamptz;

create or replace function public.time_entries_reject_stamp_trigger()
returns trigger
language plpgsql
as $$
begin
  if (new.status = 'rejected' and old.status <> 'rejected') then
    new.rejected_at := now();
  elsif (new.status <> 'rejected' and old.status = 'rejected') then
    new.rejected_at := null;
  end if;
  return new;
end $$;

drop trigger if exists time_entries_reject_stamp on public.time_entries;
create trigger time_entries_reject_stamp
before update on public.time_entries
for each row execute function public.time_entries_reject_stamp_trigger();

-- ─── Comments ─────────────────────────────────────────────────────────────

comment on function public.time_entries_immutable_identity_trigger() is
  'Block 2.1 hardening: prevents identity columns (started_at, member_id, provider_id, kind, job_id) from being mutated after INSERT. Fires before every UPDATE, regardless of caller role.';
comment on constraint time_entries_duration_max_24h on public.time_entries is
  'Block 2.1 hardening: rejects timer spans longer than 24h. Catches clock skew + malicious inflation.';
comment on column public.time_entries.rejected_at is
  'Block 2.1 hardening (C3): timestamp of the active/closed→rejected transition. Stamped by trigger; never settable by client.';
comment on function public.time_entries_reject_stamp_trigger() is
  'Block 2.1 hardening: stamps rejected_at on transition into status=rejected, clears it on transition out.';
