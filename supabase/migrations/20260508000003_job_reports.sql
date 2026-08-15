-- ===========================================================================
-- Block C.1 · WorkerDoku P1+P2 — job_reports Tabelle (canonical truth)
-- ===========================================================================
-- Ersetzt das `Job.notes[]`-Array durch eine 1:N-Relation. Worker schreibt
-- in einem BottomSheet einen Bericht (free-form text + optional
-- strukturierte Felder), Submit erzeugt einen INSERT.
--
-- Plan §5: MVP ein Report pro Job reicht für Modul-Status-Flip; Schema
-- erlaubt Multi-Report (kein UNIQUE auf job_id), das ist kostenlos und
-- macht spätere Updates flexibler (Worker korrigiert seinen eigenen
-- Bericht innerhalb des Edit-Window).
-- ===========================================================================

create table public.job_reports (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  provider_id     uuid not null references public.providers(id) on delete cascade,
  authored_by     uuid not null references auth.users(id) on delete set null,
  body            text not null,
  -- Structured payload für spätere Felder (Material verbraucht, Mängel etc.)
  -- ohne Schema-Migration. Default {} statt null um JSON-Reads zu vereinfachen.
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Body-Constraints: nicht-leer, sane upper bound (10 KB free-text).
  constraint job_reports_body_length
    check (length(trim(body)) >= 1 and length(body) <= 10000)
);

create index idx_job_reports_job_id_created_at
  on public.job_reports (job_id, created_at desc);

create index idx_job_reports_provider_id_created_at
  on public.job_reports (provider_id, created_at desc);

create index idx_job_reports_authored_by_created_at
  on public.job_reports (authored_by, created_at desc);

-- updated_at-Trigger: nutzt die existierende set_updated_at()-Funktion
-- aus Block 2 (memory `project_team_hub` confirms it exists in Prod).
create trigger job_reports_set_updated_at
  before update on public.job_reports
  for each row
  execute function public.set_updated_at();

alter table public.job_reports enable row level security;

-- ── RLS Policies ─────────────────────────────────────────────────────────

-- Owner: alles auf eigene Provider-Reports
create policy job_reports_owner_all on public.job_reports
  for all
  to authenticated
  using (
    provider_id in (
      select id from public.providers
      where profile_id = auth.uid()
    )
  )
  with check (
    provider_id in (
      select id from public.providers
      where profile_id = auth.uid()
    )
  );

-- Worker: SELECT auf alle Reports seines Providers (Team-Doku-Awareness)
create policy job_reports_worker_select on public.job_reports
  for select
  to authenticated
  using (
    provider_id in (
      select provider_id from public.team_members
      where profile_id = auth.uid()
        and is_active = true
    )
  );

-- Worker: INSERT nur für Jobs, denen er als Member zugeordnet ist.
create policy job_reports_worker_insert on public.job_reports
  for insert
  to authenticated
  with check (
    authored_by = auth.uid()
    and provider_id in (
      select tm.provider_id
      from public.team_members tm
      where tm.profile_id = auth.uid()
        and tm.is_active = true
    )
    and exists (
      select 1
      from public.jobs j
      join public.team_members tm
        on tm.profile_id = auth.uid()
       and tm.is_active = true
       and tm.provider_id = j.provider_id
      where j.id = job_id
        and (
          j.assigned_member_ids ? (tm.id::text)
          or j.assigned_team_member_id = tm.id
        )
    )
  );

-- Worker: UPDATE nur eigener Berichte innerhalb 24 h (post-fact Edit-
-- Window für Tippfehler / Ergänzungen).
create policy job_reports_worker_update_own on public.job_reports
  for update
  to authenticated
  using (
    authored_by = auth.uid()
    and created_at > now() - interval '24 hours'
  )
  with check (
    authored_by = auth.uid()
  );

-- Worker: DELETE eigener Reports innerhalb 24 h. Owner-DELETE läuft über
-- owner_all-Policy.
create policy job_reports_worker_delete_recent on public.job_reports
  for delete
  to authenticated
  using (
    authored_by = auth.uid()
    and created_at > now() - interval '24 hours'
  );

-- Customer: SELECT auf eigene Job-Reports. Wie bei Photos: Dispute-
-- Evidence-friendly, Acceptance-Gate kommt in C.3.
create policy job_reports_customer_select on public.job_reports
  for select
  to authenticated
  using (
    job_id in (
      select id from public.jobs
      where customer_user_id = auth.uid()
         or customer_profile_id = auth.uid()
    )
  );

comment on table public.job_reports is
  'Block C · canonical truth for worker-documentation reports. 1:N to jobs. Replaces the legacy Job.notes[] array. Free-form body + jsonb metadata for future structured fields. RLS: owner sees all of provider, worker sees provider-wide, worker inserts only for assigned jobs, worker may UPDATE/DELETE own report within 24h, customer reads reports of own job.';

alter publication supabase_realtime add table public.job_reports;
