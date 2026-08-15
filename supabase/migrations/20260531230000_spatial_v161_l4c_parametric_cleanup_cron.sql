-- 20260531230000 · Spatial V1.6.1 · Block L4.c · Parametric-Blob Cleanup Cron
--
-- Storage retention for the PRIVATE `spatial-parametric` bucket — the scene-blob
-- store (`{sceneId}/parametric.json`, stable path, overwritten in place on edit).
--
-- Background
-- ----------
-- Customer/provider scene edits persist via a blob upsert + a pointer in
-- `spatial_scenes.parametric_storage_path` (BARE object name, 1:1 with
-- storage.objects.name — verified prod 2026-05-31). The blob is orphaned when:
--   (a) its scene row is deleted (cascade / customer action) — the path is no
--       longer referenced by any scene, but the S3 blob lingers; and
--   (b) legacy upload paths (`customer-uploads/…`, early scan ids) that no
--       current scene points at.
-- RLS stops reads but the blob keeps occupying paid storage. (Prod check
-- 2026-05-31: 60 objects, 35 referenced → 25 unreferenced; 21 older than the
-- 7-day grace, 4 within it.)
--
-- Architecture (Hybrid C — mirrors 20260527010000 mesh-cleanup 1:1)
-- -----------------------------------------------------------------
-- pg_cron → SECDEF dispatch fn (reads Vault for the Edge URL + shared secret,
-- fires async pg_net POST) → Edge Function `spatial-parametric-cleanup`, which
-- discovers orphans via a SECDEF RPC and removes them through the Storage HTTP
-- API. We deliberately do NOT `DELETE FROM storage.objects` — that leaks the S3
-- blob (feedback_supabase_storage_delete_leaks_blob). PostgREST does not expose
-- the `storage` schema, so discovery goes through the SECDEF RPC.
--
-- Auth: the Edge Function checks `x-fixup-trigger-secret` against its
-- `FIXUP_TRIGGER_SHARED_SECRET` env — the SAME shared secret account-cascade-
-- cleanup + mesh-cleanup use (all internal cron-only triggers). The dispatch fn
-- reads the Vault row `account_cascade_cleanup.shared_secret`, which holds that
-- env value (account-cascade runs in prod with it — empirically confirmed: a
-- manual dispatch returned HTTP 200, not 401). We do NOT use
-- `spatial_mesh_cleanup.shared_secret` — that row was never seeded, which is why
-- mesh-cleanup is dormant; we avoid repeating that mistake. The Edge URL is
-- public (not a secret) and seeded as `spatial_parametric_cleanup.url`.
--
-- Idempotent + reversible (down-section at the bottom).

-- ── 1. pg_cron + pg_net ────────────────────────────────────────────────────
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ── 2. Audit table (append-only · mirror mesh_cleanup_log) ──────────────────
create table if not exists public.parametric_cleanup_log (
  id            uuid primary key default gen_random_uuid(),
  ran_at        timestamptz not null default now(),
  source        text not null check (source in ('cron','manual')),
  files_deleted integer not null default 0,
  orphan_count  integer not null default 0,
  grace_days    integer not null default 7,
  duration_ms   integer,
  error_detail  text null
);

create index if not exists parametric_cleanup_log_ran_at_idx
  on public.parametric_cleanup_log (ran_at desc);

alter table public.parametric_cleanup_log enable row level security;

-- Append-only audit: RLS default-deny + explicit grant-layer REVOKE (defense in
-- depth, feedback_audit_table_revoke_writes). Only service_role writes.
revoke all on public.parametric_cleanup_log from anon, authenticated;
revoke insert, update, delete, truncate on public.parametric_cleanup_log from anon, authenticated;

comment on table public.parametric_cleanup_log is
  'Spatial V1.6.1 L4.c · Append-only audit for spatial-parametric orphan-cleanup '
  'runs. Service-role only (RLS default-deny + REVOKE writes). error_detail NULL '
  'on full success. source=cron when fired by pg_cron, manual otherwise.';

-- ── 3. SECDEF RPC · list orphan parametric blobs ───────────────────────────
-- Orphan = object in `spatial-parametric` whose BARE name is not referenced by
-- ANY spatial_scenes.parametric_storage_path AND is older than p_grace_days.
-- The grace window protects a fresh upload whose scene-pointer write is still
-- in flight / was retried next session (paths are days old; uploads minutes).
create or replace function public.spatial_parametric_cleanup_list_orphans(
  p_grace_days integer default 7,
  p_limit      integer default 500
)
returns table (object_name text)
language plpgsql
stable
security definer
set search_path = public, storage, extensions
as $$
declare
  v_grace  integer := greatest(0, coalesce(p_grace_days, 7));
  v_limit  integer := greatest(0, least(coalesce(p_limit, 500), 5000));
  v_cutoff timestamptz := now() - make_interval(days => v_grace);
begin
  return query
    select o.name::text
    from storage.objects o
    where o.bucket_id = 'spatial-parametric'
      and o.created_at is not null
      and o.created_at < v_cutoff
      and not exists (
        select 1 from public.spatial_scenes s
        where s.parametric_storage_path = o.name
      )
    order by o.created_at asc
    limit v_limit;
end;
$$;

revoke execute on function public.spatial_parametric_cleanup_list_orphans(integer, integer)
  from public, anon, authenticated;
grant execute on function public.spatial_parametric_cleanup_list_orphans(integer, integer)
  to service_role;

comment on function public.spatial_parametric_cleanup_list_orphans(integer, integer) is
  'Spatial V1.6.1 L4.c · Lists spatial-parametric blobs not referenced by any '
  'spatial_scenes.parametric_storage_path and older than p_grace_days (default 7). '
  'Capped at p_limit (default 500, max 5000). Service-role only. Drives the '
  'spatial-parametric-cleanup Edge Function''s Storage HTTP API removes.';

-- ── 4. Seed the Edge URL into Vault (public value, idempotent) ─────────────
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'spatial_parametric_cleanup.url') then
    perform vault.create_secret(
      'https://itdntawwuzqfwmcwnwjr.supabase.co/functions/v1/spatial-parametric-cleanup',
      'spatial_parametric_cleanup.url',
      'Spatial L4.c · Edge URL for parametric-cleanup cron dispatch'
    );
  end if;
end $$;

-- ── 5. Dispatch fn (pg_cron tick → Vault → pg_net POST) ────────────────────
create or replace function public.spatial_parametric_cleanup_dispatch()
returns bigint
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_url        text;
  v_secret     text;
  v_request_id bigint;
  v_lock       boolean;
begin
  -- Re-entry guard: skip if a previous tick is still in flight.
  v_lock := pg_try_advisory_lock(hashtext('spatial_parametric_cleanup'));
  if not v_lock then
    raise notice 'spatial-parametric-cleanup: skipped (concurrent run)';
    return null;
  end if;

  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'spatial_parametric_cleanup.url' limit 1;
    -- The shared FIXUP_TRIGGER_SHARED_SECRET value — account-cascade seeds it in
    -- the prod Edge env, so its vault row carries the exact value the Edge checks.
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'account_cascade_cleanup.shared_secret' limit 1;
  exception when others then
    raise notice 'spatial-parametric-cleanup: vault unavailable (%, %) — skipping', sqlstate, sqlerrm;
    return null;
  end;

  if v_url is null or v_secret is null then
    raise notice 'spatial-parametric-cleanup: vault entries missing — skipping';
    return null;
  end if;

  begin
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body    := jsonb_build_object('source', 'cron', 'grace_days', 7, 'max_files', 500),
      timeout_milliseconds := 30000
    ) into v_request_id;
  exception when others then
    raise notice 'spatial-parametric-cleanup: pg_net.http_post failed (%, %)', sqlstate, sqlerrm;
    return null;
  end;

  return v_request_id;
end;
$$;

revoke execute on function public.spatial_parametric_cleanup_dispatch()
  from public, anon, authenticated;

comment on function public.spatial_parametric_cleanup_dispatch() is
  'Spatial V1.6.1 L4.c · pg_cron dispatch — looks up Vault (parametric url + '
  'reused mesh shared_secret) and fires async pg_net POST to the '
  'spatial-parametric-cleanup Edge Function. Returns the pg_net request_id '
  '(NULL on skip). EXCEPTION WHEN OTHERS so cron is never marked failed.';

-- ── 6. Schedule daily 03:50 UTC (after mesh 03:47; idempotent reschedule) ──
do $$
begin
  perform cron.unschedule('spatial_parametric_cleanup_nightly')
  where exists (select 1 from cron.job where jobname = 'spatial_parametric_cleanup_nightly');
exception when others then null;
end $$;

select cron.schedule(
  'spatial_parametric_cleanup_nightly',
  '50 3 * * *',
  $job$ select public.spatial_parametric_cleanup_dispatch(); $job$
);

notify pgrst, 'reload schema';

-- ── Rollback (manual) ──────────────────────────────────────────────────────
-- select cron.unschedule('spatial_parametric_cleanup_nightly');
-- drop function if exists public.spatial_parametric_cleanup_dispatch();
-- drop function if exists public.spatial_parametric_cleanup_list_orphans(integer, integer);
-- drop table if exists public.parametric_cleanup_log;
-- -- (leave Vault secret spatial_parametric_cleanup.url; harmless)
-- notify pgrst, 'reload schema';
