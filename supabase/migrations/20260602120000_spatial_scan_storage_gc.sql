-- 20260602120000 · Spatial · project-scans Storage GC + DSGVO-Cascade robustness
--
-- Replaces two BROKEN raw-SQL storage deleters with the Storage-HTTP-API
-- cron→Edge pattern (mirrors spatial-mesh-cleanup / spatial-parametric-cleanup).
--
-- Background — the defect (confirmed against prod 2026-06-02)
-- ----------------------------------------------------------
-- (1) Trigger `scans_purge_storage_after_delete` → `spatial_purge_scan_storage`
--     ran a raw `DELETE FROM storage.objects`. Supabase's `storage.protect_delete`
--     trigger RAISEs 42501 ("Direct deletion from storage tables is not allowed")
--     unless `storage.allow_delete_query='true'`. Net: EVERY scan hard-delete via
--     SQL/PostgREST failed. The only app caller is
--     SupabaseSpatialRepository.deleteScan().
-- (2) `spatial_storage_lifecycle` (nightly cron) did the same raw delete for
--     archived>90d assets — latent (0 archived>90d rows today, so the loop never
--     ran; cron showed "succeeded" = the (0,0) count tuple, not real success).
-- (3) Even bypassing protect_delete via the GUC is wrong: a raw
--     `DELETE FROM storage.objects` frees ONLY the metadata row — the S3 blob is
--     orphaned (feedback_supabase_storage_delete_leaks_blob). Only the Storage
--     HTTP API `.remove()` frees BOTH.
--
-- Fix
-- ---
-- • DROP the trigger + function (1) and the lifecycle cron + function (2).
--   Scan-row DELETE then succeeds (RLS + FK cascades unchanged); blobs become
--   orphans reaped by the new nightly Edge GC below.
-- • New `spatial-scan-cleanup` Edge Function (deployed out-of-band, verify_jwt
--   =false) discovers work via two SECDEF RPCs and removes via the Storage HTTP
--   API — exactly the mesh/parametric pattern:
--     - list_orphans:  project-scans blobs whose scan_id (path segment 2) is no
--                      longer in public.scans (deleted scan). Pure storage remove.
--     - list_expired:  assets of scans archived > retention_days (kind<>worldmap)
--                      — the lifecycle policy. Edge removes blob AND deletes the
--                      scan_assets row.
-- • Dispatch reuses `account_cascade_cleanup.shared_secret` (the SAME value the
--   prod Edge env's FIXUP_TRIGGER_SHARED_SECRET carries — empirically 200, not
--   401). We do NOT mint a new `spatial_*_cleanup.shared_secret`: that row was
--   never seeded for mesh, which is why mesh-cleanup is dormant
--   (feedback_fixup_shared_trigger_secret). The Edge URL is public, seeded as
--   `spatial_scan_cleanup.url`.
--
-- DSGVO account deletion (related): six FKs to profiles/auth.users block
-- admin.deleteUser with NO ACTION/RESTRICT (scans.captured_by,
-- provider_presales_projects.created_by_user_id, spatial_share_audit.actor_user_id,
-- spatial_change_orders.proposer_id, spatial_pin_reviews.reviewed_by_user_id,
-- spatial_rescan_requests.requested_by_user_id). All six actor/owner columns are
-- NOT NULL → cannot anonymise; erasure (DELETE) is the only unblock. Section 8
-- adds a SECDEF RPC the Vercel route calls BEFORE admin.deleteUser. No FK
-- semantics changed (decision 2026-06-02). NOTE: the auth-cascade safety-net
-- trigger fires AFTER DELETE, so it cannot unblock — direct admin-console /
-- SQL deletion of a scan/asset-owning user stays RESTRICT-blocked by design.
--
-- Idempotent + reversible (down-section at the bottom).

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- ── 1. Remove the broken raw-SQL deleters ───────────────────────────────────
drop trigger  if exists scans_purge_storage_after_delete on public.scans;
drop function if exists public.spatial_purge_scan_storage();

do $$
begin
  perform cron.unschedule('spatial_storage_lifecycle_nightly')
  where exists (select 1 from cron.job where jobname = 'spatial_storage_lifecycle_nightly');
exception when others then null;
end $$;
drop function if exists public.spatial_storage_lifecycle();

-- ── 2. Audit table (append-only · mirror mesh_cleanup_log) ───────────────────
create table if not exists public.scan_cleanup_log (
  id            uuid primary key default gen_random_uuid(),
  ran_at        timestamptz not null default now(),
  source        text not null check (source in ('cron','manual')),
  files_deleted integer not null default 0,
  bytes_freed   bigint  not null default 0,
  orphan_count  integer not null default 0,
  expired_count integer not null default 0,
  rows_pruned   integer not null default 0,
  duration_ms   integer,
  error_detail  text null
);

create index if not exists scan_cleanup_log_ran_at_idx
  on public.scan_cleanup_log (ran_at desc);

alter table public.scan_cleanup_log enable row level security;

-- Append-only audit · RLS default-deny + grant-layer REVOKE (defense in depth,
-- feedback_audit_table_revoke_writes). Service-role writes only.
revoke all on public.scan_cleanup_log from anon, authenticated;
revoke insert, update, delete, truncate on public.scan_cleanup_log from anon, authenticated;

comment on table public.scan_cleanup_log is
  'Spatial · Append-only audit for project-scans storage GC runs (orphan + '
  'archived-expired). Service-role only (RLS default-deny + REVOKE writes). '
  'rows_pruned = scan_assets rows deleted in the expired pass. error_detail '
  'NULL on full success. source=cron when fired by pg_cron, manual otherwise.';

-- ── 3. SECDEF RPC · list orphan scan blobs ───────────────────────────────────
-- Orphan = object in `project-scans` whose scan_id (path segment 2 of the
-- canonical `<userId>/<scanId>/<kind>/<sha>.<ext>` layout) is no longer present
-- in public.scans (the scan was deleted; scan_assets rows cascaded but the blob
-- lingered). Conservative: ONLY well-formed `<uuid>/<uuid>/…` paths are
-- considered, so legacy/malformed objects are left for manual review rather than
-- silently removed. No grace window: the scan row always precedes its blobs
-- (uploadScanAsset needs an existing scanId), so a present blob with an absent
-- scan can only mean the scan was deleted.
create or replace function public.spatial_scan_cleanup_list_orphans(
  p_limit integer default 500
)
returns table (object_name text, size_bytes bigint)
language plpgsql
stable
security definer
set search_path = public, storage, extensions
as $$
declare
  v_limit integer := greatest(0, least(coalesce(p_limit, 500), 5000));
begin
  return query
    select
      o.name::text                                  as object_name,
      coalesce((o.metadata->>'size')::bigint, 0)    as size_bytes
    from storage.objects o
    where o.bucket_id = 'project-scans'
      and o.name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/'
      and not exists (
        select 1 from public.scans s
        where s.id::text = split_part(o.name, '/', 2)
      )
    order by o.created_at asc nulls first
    limit v_limit;
end;
$$;

revoke execute on function public.spatial_scan_cleanup_list_orphans(integer)
  from public, anon, authenticated;
grant  execute on function public.spatial_scan_cleanup_list_orphans(integer)
  to service_role;

comment on function public.spatial_scan_cleanup_list_orphans(integer) is
  'Spatial · Lists project-scans blobs whose scan_id (path segment 2) no longer '
  'exists in public.scans. Well-formed <uuid>/<uuid>/ paths only. Returns '
  '(object_name, size_bytes) capped at p_limit (default 500, max 5000). '
  'Service-role only. Drives the spatial-scan-cleanup Edge Function.';

-- ── 4. SECDEF RPC · list archived-expired scan assets ────────────────────────
-- The retention policy formerly in spatial_storage_lifecycle: scan_assets of
-- scans archived more than p_retention_days ago, excluding the worldmap blob
-- (kept for relocalization). Tied to ARCHIVED status — never raw blob age — so
-- assets of an active scan are never touched. Returns the scan_assets.storage_
-- path (always non-null) plus the blob size; the Edge removes the blob via the
-- Storage HTTP API AND deletes the scan_assets row (see edge fn expired pass).
create or replace function public.spatial_scan_cleanup_list_expired(
  p_retention_days integer default 90,
  p_limit          integer default 500
)
returns table (object_name text, size_bytes bigint)
language plpgsql
stable
security definer
set search_path = public, storage, extensions
as $$
declare
  v_retention integer := greatest(1, coalesce(p_retention_days, 90));
  v_limit     integer := greatest(0, least(coalesce(p_limit, 500), 5000));
  v_cutoff    timestamptz := now() - make_interval(days => v_retention);
begin
  return query
    select
      sa.storage_path::text                         as object_name,
      coalesce((o.metadata->>'size')::bigint, 0)    as size_bytes
    from public.scan_assets sa
    join public.scans s on s.id = sa.scan_id
    left join storage.objects o
      on o.bucket_id = 'project-scans' and o.name = sa.storage_path
    where s.status = 'archived'
      and s.archived_at is not null
      and s.archived_at < v_cutoff
      and sa.kind <> 'worldmap'
    order by s.archived_at asc
    limit v_limit;
end;
$$;

revoke execute on function public.spatial_scan_cleanup_list_expired(integer, integer)
  from public, anon, authenticated;
grant  execute on function public.spatial_scan_cleanup_list_expired(integer, integer)
  to service_role;

comment on function public.spatial_scan_cleanup_list_expired(integer, integer) is
  'Spatial · Lists scan_assets storage paths for scans archived > '
  'p_retention_days (default 90, kind<>worldmap). Tied to archived status, not '
  'raw blob age. Returns (object_name=storage_path, size_bytes) capped at '
  'p_limit (default 500, max 5000). Service-role only. Replaces '
  'spatial_storage_lifecycle. The Edge fn removes blob + deletes the row.';

-- ── 4b. DSGVO account-erasure RPC (unblock admin.deleteUser) ─────────────────
-- Deletes the rows a user owns/authored across the six tables whose NOT NULL FK
-- to profiles/auth.users (RESTRICT or NO ACTION) would otherwise abort
-- admin.auth.admin.deleteUser. Called by api/delete-account.ts AFTER the
-- Storage HTTP API blob cleanup and BEFORE deleteUser. Ordered children→parents;
-- the only intra-set cascade is scans.presales_project_id → presales_projects
-- (so presales delete reaps its scans before the captured_by sweep mops up the
-- rest). Runs as definer (service_role grant) so it bypasses the append-only
-- REVOKEs on spatial_share_audit. A still-active dispute lock on a change order
-- (spatial_change_orders_dispute_lock_guard) will RAISE here and abort deletion
-- — intentional: data under an open dispute is a legitimate retention hold.
create or replace function public.account_cascade_delete_owned_rows(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := '{}'::jsonb;
  n integer;
begin
  if p_user_id is null then
    raise exception 'account_cascade_delete_owned_rows: p_user_id is required'
      using errcode = '22023';
  end if;

  delete from public.spatial_pin_reviews where reviewed_by_user_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('spatial_pin_reviews', n);

  delete from public.spatial_change_orders where proposer_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('spatial_change_orders', n);

  delete from public.spatial_rescan_requests where requested_by_user_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('spatial_rescan_requests', n);

  delete from public.spatial_share_audit where actor_user_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('spatial_share_audit', n);

  -- cascades scans referencing presales_project_id (ON DELETE CASCADE)
  delete from public.provider_presales_projects where created_by_user_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('provider_presales_projects', n);

  delete from public.scans where captured_by = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('scans', n);

  return v;
end;
$$;

revoke execute on function public.account_cascade_delete_owned_rows(uuid)
  from public, anon, authenticated;
grant  execute on function public.account_cascade_delete_owned_rows(uuid)
  to service_role;

comment on function public.account_cascade_delete_owned_rows(uuid) is
  'DSGVO · Deletes the rows a user owns/authored across the six tables whose '
  'NOT NULL FK to profiles/auth.users blocks admin.deleteUser (scans, '
  'provider_presales_projects, spatial_share_audit, spatial_change_orders, '
  'spatial_pin_reviews, spatial_rescan_requests). Service-role only. Called by '
  'api/delete-account.ts before admin.deleteUser. Returns per-table delete counts.';

-- ── 5. Seed the Edge URL into Vault (public value, idempotent) ───────────────
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'spatial_scan_cleanup.url') then
    perform vault.create_secret(
      'https://itdntawwuzqfwmcwnwjr.supabase.co/functions/v1/spatial-scan-cleanup',
      'spatial_scan_cleanup.url',
      'Spatial · Edge URL for project-scans storage GC cron dispatch'
    );
  end if;
end $$;

-- ── 6. Dispatch fn (pg_cron tick → Vault → pg_net POST) ──────────────────────
create or replace function public.spatial_scan_cleanup_dispatch()
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
  v_lock := pg_try_advisory_lock(hashtext('spatial_scan_cleanup'));
  if not v_lock then
    raise notice 'spatial-scan-cleanup: skipped (concurrent run)';
    return null;
  end if;

  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'spatial_scan_cleanup.url' limit 1;
    -- Reuse the account-cascade shared secret — it holds the exact value the
    -- prod Edge env's FIXUP_TRIGGER_SHARED_SECRET carries. We do NOT use a
    -- spatial_*_cleanup.shared_secret row (never seeded → dormant, the mesh
    -- mistake — feedback_fixup_shared_trigger_secret).
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'account_cascade_cleanup.shared_secret' limit 1;
  exception when others then
    raise notice 'spatial-scan-cleanup: vault unavailable (%, %) — skipping', sqlstate, sqlerrm;
    return null;
  end;

  if v_url is null or v_secret is null then
    raise notice 'spatial-scan-cleanup: vault entries missing — skipping';
    return null;
  end if;

  begin
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body    := jsonb_build_object('source', 'cron', 'retention_days', 90, 'max_files', 500),
      timeout_milliseconds := 30000
    ) into v_request_id;
  exception when others then
    raise notice 'spatial-scan-cleanup: pg_net.http_post failed (%, %)', sqlstate, sqlerrm;
    return null;
  end;

  return v_request_id;
end;
$$;

revoke execute on function public.spatial_scan_cleanup_dispatch()
  from public, anon, authenticated;

comment on function public.spatial_scan_cleanup_dispatch() is
  'Spatial · pg_cron dispatch — looks up Vault (spatial_scan_cleanup.url + '
  'reused account_cascade_cleanup.shared_secret) and fires async pg_net POST to '
  'the spatial-scan-cleanup Edge Function. Returns the pg_net request_id (NULL '
  'on skip). EXCEPTION WHEN OTHERS so cron is never marked failed.';

-- ── 7. Schedule daily 03:42 UTC (between lifecycle 03:37 and mesh 03:47) ─────
do $$
begin
  perform cron.unschedule('spatial_scan_cleanup_nightly')
  where exists (select 1 from cron.job where jobname = 'spatial_scan_cleanup_nightly');
exception when others then null;
end $$;

select cron.schedule(
  'spatial_scan_cleanup_nightly',
  '42 3 * * *',
  $job$ select public.spatial_scan_cleanup_dispatch(); $job$
);

notify pgrst, 'reload schema';

-- ── Rollback (manual) ────────────────────────────────────────────────────────
-- select cron.unschedule('spatial_scan_cleanup_nightly');
-- drop function if exists public.account_cascade_delete_owned_rows(uuid);
-- drop function if exists public.spatial_scan_cleanup_dispatch();
-- drop function if exists public.spatial_scan_cleanup_list_expired(integer, integer);
-- drop function if exists public.spatial_scan_cleanup_list_orphans(integer);
-- drop table if exists public.scan_cleanup_log;
-- -- (the dropped trigger spatial_purge_scan_storage + spatial_storage_lifecycle
-- --  were broken; do NOT recreate. Leave Vault secret spatial_scan_cleanup.url.)
-- notify pgrst, 'reload schema';
