-- ===========================================================================
-- Block FU.5 · Owner-Notes — eigene 1:N-Tabelle
-- ===========================================================================
-- Ersetzt das mixed Job.notes[]-Array für den Owner-Pfad. Worker-Seite
-- schreibt in job_reports (Block C); Owner schreibt hier.
--
-- Schema spiegelt job_reports: id, job_id, authored_by, body, metadata,
-- created_at/updated_at. Kein provider_id — Owner ist direkt via jobs.
-- ===========================================================================

create table public.owner_notes (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  authored_by     uuid not null references auth.users(id) on delete set null,
  body            text not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint owner_notes_body_length
    check (length(trim(body)) >= 1 and length(body) <= 10000)
);

create index idx_owner_notes_job_id_created_at
  on public.owner_notes (job_id, created_at desc);

create index idx_owner_notes_authored_by_created_at
  on public.owner_notes (authored_by, created_at desc);

create trigger owner_notes_set_updated_at
  before update on public.owner_notes
  for each row
  execute function public.set_updated_at();

alter table public.owner_notes enable row level security;

-- ── RLS Policies ─────────────────────────────────────────────────────────

-- Owner: CRUD auf eigene Job-Notizen (Job muss zum eigenen Provider gehören)
create policy owner_notes_owner_all on public.owner_notes
  for all
  to authenticated
  using (
    job_id in (
      select j.id from public.jobs j
      join public.providers p on p.id = j.provider_id
      where p.profile_id = auth.uid()
    )
  )
  with check (
    authored_by = auth.uid()
    and job_id in (
      select j.id from public.jobs j
      join public.providers p on p.id = j.provider_id
      where p.profile_id = auth.uid()
    )
  );

-- Worker: SELECT auf Notizen für Jobs des eigenen Providers (Doku-Awareness)
create policy owner_notes_worker_select on public.owner_notes
  for select
  to authenticated
  using (
    job_id in (
      select j.id from public.jobs j
      join public.team_members tm
        on tm.provider_id = j.provider_id
       and tm.profile_id = auth.uid()
       and tm.is_active = true
    )
  );

comment on table public.owner_notes is
  'Block FU.5 · Owner-side documentation notes. 1:N to jobs. Owner writes (own-provider guard); workers read. Mirrors job_reports pattern. Replaces legacy Job.notes[] for owner documentation path.';

alter table public.owner_notes replica identity full;

alter publication supabase_realtime add table public.owner_notes;
