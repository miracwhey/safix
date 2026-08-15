-- ===========================================================================
-- Team-Hub Block 2 — time_entries
-- ===========================================================================
-- Worker-driven, automatic time-tracking.
--
-- Two kinds:
--   * 'day' — full work day (no job_id, single active per member)
--   * 'job' — per-job timer (job_id required, single active per member)
--
-- Status lifecycle:
--   active  → closed (worker stops timer; ended_at + duration_minutes set)
--   closed  → rejected (owner rejects with reason)
--
-- Authoritative duration: duration_minutes is set when status flips to closed.
-- started_at + ended_at remain timestamps for audit; duration is owner-of-truth
-- for weekly aggregates (timezone-safe, no DST drift).

create type time_entry_kind as enum ('day', 'job');
create type time_entry_status as enum ('active', 'closed', 'rejected');

create table public.time_entries (
  id                uuid primary key default gen_random_uuid(),
  provider_id       uuid not null references public.providers(id) on delete cascade,
  member_id         uuid not null references public.team_members(id) on delete cascade,
  kind              time_entry_kind not null,
  job_id            uuid references public.jobs(id) on delete set null,
  started_at        timestamptz not null,
  ended_at          timestamptz,
  duration_minutes  integer,
  note              text,
  status            time_entry_status not null default 'active',
  rejected_reason   text,
  rejected_by       uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Semantic constraints
  constraint job_kind_requires_job_id check (kind = 'day' or job_id is not null),
  constraint day_kind_no_job_id check (kind = 'job' or job_id is null),
  constraint closed_has_end check (status <> 'closed' or (ended_at is not null and duration_minutes is not null)),
  constraint duration_positive check (duration_minutes is null or duration_minutes > 0),
  constraint end_after_start check (ended_at is null or ended_at > started_at),
  constraint rejected_has_reason check (status <> 'rejected' or rejected_reason is not null)
);

-- Single active 'day' timer per member (race-safe via unique partial index)
create unique index time_entries_active_day_unique
  on public.time_entries (member_id)
  where kind = 'day' and status = 'active';

-- Single active 'job' timer per member
create unique index time_entries_active_job_unique
  on public.time_entries (member_id)
  where kind = 'job' and status = 'active';

create index time_entries_provider_started_idx
  on public.time_entries (provider_id, started_at desc);

create index time_entries_member_started_idx
  on public.time_entries (member_id, started_at desc);

-- Owner-of-truth note: REPLICA IDENTITY FULL emits the full pre-image on
-- UPDATE/DELETE replication events. Required when subscribers want to filter
-- on non-PK columns (e.g. recent UPDATEs by member_id) — without it, default
-- (PK) only emits the primary key in the replication event.
alter table public.time_entries replica identity full;

-- updated_at trigger reuses the global helper (already present in prod)
create trigger time_entries_set_updated_at
  before update on public.time_entries
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- Row-level security
-- ===========================================================================

alter table public.time_entries enable row level security;

-- Worker reads own entries (matched via team_members.profile_id = auth.uid())
create policy time_entries_worker_select on public.time_entries
for select to authenticated
using (
  member_id in (
    select id from public.team_members
    where profile_id = auth.uid() and is_active = true
  )
);

-- Worker inserts own entries.
--   - kind='day' is unrestricted (any active worker can clock in)
--   - kind='job' requires job_id whose assigned_member_ids contains the worker's
--     team_member id (jsonb array containment check). The text cast aligns with
--     how the array is written elsewhere in the codebase.
create policy time_entries_worker_insert on public.time_entries
for insert to authenticated
with check (
  member_id in (
    select id from public.team_members
    where profile_id = auth.uid() and is_active = true
  )
  and (
    kind = 'day'
    or (
      job_id is not null
      and exists (
        select 1 from public.jobs j
        where j.id = job_id
          and j.assigned_member_ids ? (member_id::text)
      )
    )
  )
);

-- Worker closes own active entries (sets status='closed' + ended_at + duration_minutes).
-- WITH CHECK ensures the new status is 'closed' (not flipping to 'rejected', which
-- is owner-only).
create policy time_entries_worker_close on public.time_entries
for update to authenticated
using (
  status = 'active' and
  member_id in (
    select id from public.team_members where profile_id = auth.uid()
  )
)
with check (
  status = 'closed' and
  member_id in (
    select id from public.team_members where profile_id = auth.uid()
  )
);

-- Owner reads all entries for their provider
create policy time_entries_owner_select on public.time_entries
for select to authenticated
using (
  provider_id in (
    select id from public.providers where profile_id = auth.uid()
  )
);

-- Owner can flip status to 'rejected' (with reason) or 'closed' (re-confirm).
-- USING is owner-scoped; WITH CHECK keeps status within {closed, rejected}, so
-- the worker's active row cannot be mutated except by closing first.
create policy time_entries_owner_update on public.time_entries
for update to authenticated
using (
  provider_id in (
    select id from public.providers where profile_id = auth.uid()
  )
)
with check (
  provider_id in (
    select id from public.providers where profile_id = auth.uid()
  )
  and status in ('closed', 'rejected')
);

-- ===========================================================================
-- Realtime publication (Block-2 contract: Owner-Hub live Soll/Ist updates)
-- ===========================================================================
-- The supabase_realtime publication is currently scoped to public.jobs only.
-- Adding time_entries enables the Owner-Hub Soll/Ist bars to update within ~2s
-- when a Worker stops a timer.

alter publication supabase_realtime add table public.time_entries;

-- ===========================================================================
-- Comments
-- ===========================================================================

comment on table public.time_entries is
  'Worker time tracking: day-timer + per-job-timer rows. duration_minutes is the authoritative field for weekly aggregates.';
comment on column public.time_entries.kind is
  'day = full work day timer (no job_id). job = per-job timer (job_id required, must be assigned to member).';
comment on column public.time_entries.duration_minutes is
  'Authoritative duration. Set by close-workflow on status flip from active → closed. NULL while active.';
comment on column public.time_entries.rejected_reason is
  'Free-text reason from owner when status = rejected. Required by check constraint.';
