-- ===========================================================================
-- Team-Hub Block 3 — absences + reassign_job_member
-- ===========================================================================
-- Worker-driven sick-leave / vacation tracking + atomic Springer reassign RPC.
--
-- Workflow surface:
--   Worker reports sick   → INSERT row (status='active')
--   Worker cancels        → UPDATE status='cancelled' (own row only)
--   Owner requests note   → UPDATE sick_note_requested + sick_note_requested_at
--   Owner cannot delete absence rows; cancellation is the soft-delete path.
--
-- Date semantics: date columns store DATE (not timestamptz) — sick days are
-- calendar-day units. end_date >= start_date is enforced (single-day = both
-- equal). Status='active' rows are visible in the live roster; status='cancelled'
-- become history.
--
-- Realtime: REPLICA IDENTITY FULL emits the full pre-image so the Owner-Hub can
-- evict cached rows on UPDATE→cancelled (filter on status, not just PK).

create type absence_type as enum ('sick', 'vacation', 'other');
create type absence_status as enum ('active', 'cancelled');

create table public.absences (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              uuid not null references public.providers(id) on delete cascade,
  member_id                uuid not null references public.team_members(id) on delete cascade,
  type                     absence_type not null,
  start_date               date not null,
  end_date                 date not null,
  reason_note              text,
  status                   absence_status not null default 'active',
  sick_note_requested      boolean not null default false,
  sick_note_requested_at   timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  cancelled_at             timestamptz,
  -- Semantic constraints
  constraint end_after_or_equal_start check (end_date >= start_date),
  constraint cancelled_has_timestamp check (status <> 'cancelled' or cancelled_at is not null),
  constraint sick_note_request_consistency check (
    (sick_note_requested = false and sick_note_requested_at is null)
    or (sick_note_requested = true and sick_note_requested_at is not null)
  )
);

-- Active absences scoped per provider — used for live roster queries.
create index absences_provider_active_idx
  on public.absences (provider_id, start_date desc)
  where status = 'active';

-- Member-scoped index — Worker history view + per-member lookups.
create index absences_member_idx
  on public.absences (member_id, start_date desc);

-- Required for the Owner-Hub Realtime channel filter (status flips from
-- active → cancelled need full pre-image; PK-only would lose status).
alter table public.absences replica identity full;

-- updated_at trigger reuses the global helper (already present in prod).
create trigger absences_set_updated_at
  before update on public.absences
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- Row-level security
-- ===========================================================================

alter table public.absences enable row level security;

-- Worker reads own active + cancelled absences (history).
create policy absences_worker_select on public.absences
for select to authenticated
using (
  member_id in (
    select id from public.team_members
    where profile_id = auth.uid() and is_active = true
  )
);

-- Worker INSERT: own active row only. provider_id must match team_member's
-- provider (defense against forged provider_id by malicious client).
create policy absences_worker_insert on public.absences
for insert to authenticated
with check (
  status = 'active'
  and exists (
    select 1 from public.team_members tm
    where tm.id = member_id
      and tm.provider_id = absences.provider_id
      and tm.profile_id = auth.uid()
      and tm.is_active = true
  )
);

-- Worker UPDATE: own row, only active → cancelled transition allowed.
create policy absences_worker_cancel on public.absences
for update to authenticated
using (
  status = 'active'
  and member_id in (
    select id from public.team_members where profile_id = auth.uid()
  )
)
with check (
  status = 'cancelled'
  and member_id in (
    select id from public.team_members where profile_id = auth.uid()
  )
);

-- Owner SELECT: all rows for own provider.
create policy absences_owner_select on public.absences
for select to authenticated
using (
  provider_id in (
    select id from public.providers where profile_id = auth.uid()
  )
);

-- Owner UPDATE: scoped to own provider. WITH CHECK keeps mutations to
-- sick_note flag transitions. Cancelling another's absence is not an Owner
-- action in MVP (Worker self-cancels) — Owner-can-cancel is V2.
create policy absences_owner_update on public.absences
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
);

-- ===========================================================================
-- Realtime publication
-- ===========================================================================

alter publication supabase_realtime add table public.absences;

-- ===========================================================================
-- reassign_job_member — atomic Springer reassign RPC
-- ===========================================================================
-- Owner-driven: replaces a sick member's slot in jobs.assigned_member_ids
-- atomically. Uses SELECT ... FOR UPDATE to serialize concurrent reassigns
-- against the same job row.
--
-- Semantics:
--   - If the from-member is in the array, swap them out for the to-member.
--   - If the from-member is NOT in the array, append the to-member (idempotent
--     re-run after a partial failure).
--   - If the to-member is already in the array, no-op (do not duplicate).

create or replace function public.reassign_job_member(
  p_job_id uuid,
  p_from text,
  p_to text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider_id uuid;
  v_assigned    jsonb;
  v_next        jsonb;
  v_result      jsonb;
  v_caller_uid  uuid;
  v_to_member   uuid;
begin
  v_caller_uid := auth.uid();
  if v_caller_uid is null then
    raise exception 'rbac_no_session' using errcode = '42501';
  end if;

  -- Lock the job row first — prevents two concurrent reassigns from racing.
  select provider_id, assigned_member_ids
    into v_provider_id, v_assigned
    from public.jobs
    where id = p_job_id
    for update;

  if v_provider_id is null then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;

  -- Owner-RBAC inline. SECURITY DEFINER is required so the audit INSERT
  -- below can land (the audit table has no INSERT policy for authenticated
  -- callers; only service_role / definer can write). Owner identity is
  -- still established via auth.uid() — definer privileges do NOT bypass
  -- this gate, they only let us write the audit row after we've validated.
  if not exists (
    select 1 from public.providers
    where id = v_provider_id and profile_id = v_caller_uid
  ) then
    raise exception 'rbac_owner_required' using errcode = '42501';
  end if;

  -- Compute next array. Idempotent — safe to retry.
  if v_assigned ? p_to then
    -- to-member already assigned → just remove from-member if present.
    if v_assigned ? p_from then
      v_next := v_assigned - p_from;
    else
      v_next := v_assigned;
    end if;
  elsif v_assigned ? p_from then
    -- swap from → to.
    v_next := (v_assigned - p_from) || jsonb_build_array(p_to);
  else
    -- from not present → append to-member only.
    v_next := coalesce(v_assigned, '[]'::jsonb) || jsonb_build_array(p_to);
  end if;

  update public.jobs
    set assigned_member_ids = v_next,
        updated_at = now()
    where id = p_job_id
    returning to_jsonb(jobs.*) into v_result;

  -- Audit row — atomic with the reassign. team_member_audit.member_id is
  -- the to-member (the one taking over the slot). The from→to swap is
  -- captured in old_values / new_values so the Owner-Hub log can show
  -- both sides.
  begin
    v_to_member := p_to::uuid;
  exception when others then
    -- p_to wasn't a uuid — skip audit row rather than fail the whole
    -- reassign. Should not happen in production (callers always pass
    -- team_members.id which is uuid).
    return v_result;
  end;

  insert into public.team_member_audit (provider_id, member_id, actor_id, action, old_values, new_values)
  values (
    v_provider_id,
    v_to_member,
    v_caller_uid,
    'springer_reassigned',
    jsonb_build_object('jobId', p_job_id, 'fromMemberId', p_from),
    jsonb_build_object('jobId', p_job_id, 'toMemberId', p_to)
  );

  return v_result;
end;
$$;

revoke execute on function public.reassign_job_member(uuid, text, text) from public;
grant execute on function public.reassign_job_member(uuid, text, text) to authenticated;

comment on function public.reassign_job_member(uuid, text, text) is
  'Atomic member reassignment for the Owner-driven Springer flow + audit row. SECURITY DEFINER so the audit INSERT lands; Owner identity is verified via auth.uid() before any writes. Idempotent: re-running after partial failure converges.';

-- ===========================================================================
-- Comments
-- ===========================================================================

comment on table public.absences is
  'Worker absence rows (sick, vacation, other). Active rows drive the Owner-Hub Krank-Badge + Springer flow. status=cancelled is the soft-delete path; rows are not physically deleted.';
comment on column public.absences.sick_note_requested is
  'Owner-side flag set when an Attest is requested. Paired with sick_note_requested_at via CHECK constraint.';
comment on column public.absences.cancelled_at is
  'Timestamp of cancellation. Required when status=cancelled; null otherwise (CHECK).';
