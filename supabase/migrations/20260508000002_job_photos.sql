-- ===========================================================================
-- Block C.1 · WorkerDoku P1+P2 — job_photos Tabelle (canonical truth)
-- ===========================================================================
-- Ersetzt die `Job.photoCount`-Zählerlogik durch eine 1:N-Relation. Worker
-- erfasst Fotos via Capacitor Camera, Client komprimiert via
-- preUploadPipeline (EXIF-Strip + JPEG q=0.92 + max 2560px), Upload nach
-- Storage `worker-doku-photos`, gefolgt von INSERT auf diese Tabelle.
--
-- Single Source of Truth für Foto-Count, Owner-Dashboard, Customer-Sicht.
-- Legacy `Job.photoCount` wird in Block C.3 als Schreib-Pfad entfernt
-- (Plan §5: „no second source of truth"). Während C.1+C.2 läuft Dual-Read
-- bewusst: Projection bevorzugt job_photos, fällt zurück auf Legacy nur
-- wenn job_photos leer ist (für Bestands-Daten).
-- ===========================================================================

create table public.job_photos (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  provider_id     uuid not null references public.providers(id) on delete cascade,
  -- Wer den Upload getrieben hat. Bei Stub-Workern (kein profile) ist die
  -- Owner-Backup-Variante: assigned_team_member_id ist null und
  -- uploaded_by ist die Owner-uid. Sonst worker-uid.
  uploaded_by     uuid not null references auth.users(id) on delete set null,
  -- Storage-Path innerhalb worker-doku-photos. Format
  -- `jobs/{job_id}/{client_uuid}.jpg`. Wird beim Lesen via
  -- supabase.storage.from('worker-doku-photos').createSignedUrl()
  -- aufgelöst — Repo-Layer vergibt TTL.
  storage_path    text not null,
  -- Client-side UUID v4 (vor Upload generiert). UNIQUE → Idempotenz bei
  -- Offline-Queue-Replay nach Reconnect.
  client_uuid     uuid not null,
  -- Optional EXIF-Metadaten nach Strip (nur Format/Geometrie, keine GPS).
  width_px        integer,
  height_px       integer,
  size_bytes      bigint,
  created_at      timestamptz not null default now(),
  -- Idempotenz-Key: pro (job_id, client_uuid) genau eine Row.
  unique (job_id, client_uuid)
);

create index idx_job_photos_job_id_created_at
  on public.job_photos (job_id, created_at desc);

create index idx_job_photos_provider_id_created_at
  on public.job_photos (provider_id, created_at desc);

create index idx_job_photos_uploaded_by_created_at
  on public.job_photos (uploaded_by, created_at desc);

alter table public.job_photos enable row level security;

-- ── RLS Policies ─────────────────────────────────────────────────────────
-- Reihenfolge wie in Block 7.2/Block-2-Hardening: Owner-All erst, dann
-- Worker-Same-Provider, dann Customer-Eigener-Job. Workflow-Layer-Guards
-- ergänzen die RLS — Memory feedback_workflow_layer_rbac_pflicht.

-- Owner: alles auf eigene Provider-Fotos
create policy job_photos_owner_all on public.job_photos
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

-- Worker: SELECT auf alle Fotos seines Providers (er sieht Team-Doku)
create policy job_photos_worker_select on public.job_photos
  for select
  to authenticated
  using (
    provider_id in (
      select provider_id from public.team_members
      where profile_id = auth.uid()
        and is_active = true
    )
  );

-- Worker: INSERT nur für Jobs, denen er als Member zugeordnet ist
-- (assigned_member_ids enthält seinen team_member-id). Verhindert
-- Worker-Cross-Job-Insertion.
create policy job_photos_worker_insert on public.job_photos
  for insert
  to authenticated
  with check (
    uploaded_by = auth.uid()
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

-- Worker: DELETE eigener Uploads innerhalb 24 h (Versehen-Schutz). Danach
-- nur Owner. Owner-Policy oben covers ohnehin.
create policy job_photos_worker_delete_recent on public.job_photos
  for delete
  to authenticated
  using (
    uploaded_by = auth.uid()
    and created_at > now() - interval '24 hours'
  );

-- Customer: SELECT auf Fotos zu eigenen Jobs. Gate auf Acceptance-Window
-- folgt in Block C.3 (separate Workflow-Logik mit job.status). MVP zeigt
-- Customer alle Fotos zu seinem Job — Dispute-Evidence-Use-Case ist
-- transparent gewollt.
create policy job_photos_customer_select on public.job_photos
  for select
  to authenticated
  using (
    job_id in (
      select id from public.jobs
      where customer_user_id = auth.uid()
         or customer_profile_id = auth.uid()
    )
  );

comment on table public.job_photos is
  'Block C · canonical truth for worker-documentation photos. 1:N to jobs. Replaces the legacy Job.photoCount counter. Storage in worker-doku-photos bucket, path jobs/{job_id}/{client_uuid}.jpg. RLS: owner sees all of provider, worker sees provider-wide for team awareness, worker inserts only for assigned jobs, worker may DELETE own upload within 24h, customer reads photos of own job (dispute-evidence-friendly).';

-- Realtime: Owner-Dashboard + Worker-Doku-Detail subscriben on INSERT
-- für Live-Status-Refresh. REPLICA IDENTITY DEFAULT reicht (DELETE-Filter
-- läuft auf provider_id, der Teil der PK-Lookup-Path-Spalten ist über
-- die Indexes; aber DELETE-Realtime ist hier nicht kritisch — wir filtern
-- nicht auf Sub-Felder).
alter publication supabase_realtime add table public.job_photos;
