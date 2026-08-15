-- ===========================================================================
-- FU.6 — worker-doku-photos Storage-RLS Path-Scope
-- ===========================================================================
-- Die ursprüngliche Migration 20260508000001 hat Storage-RLS bewusst grob-
-- körnig gehalten (authenticated = INSERT / SELECT ohne Path-Match) und die
-- Authorization an die job_photos-Tabelle delegiert. Das ist korrekt für
-- INSERT (wer keinen valid job_photos-Row anlegen kann, kann auch nichts mit
-- dem Blob anfangen). Für SELECT reicht es jedoch nicht: jeder eingeloggte
-- User könnte Storage-Objekte lesen, wenn er den Pfad kennt oder errät.
--
-- FU.6 schließt diese Lücke:
--   SELECT  → EXISTS auf job_photos (storage_path = name) mit denselben
--             Rollen-Guards wie die job_photos-RLS (owner / worker-same-
--             provider / customer-eigener-Job).
--   INSERT  → foldername[1] = 'jobs' erzwingt das korrekte Pfad-Format;
--             volle Assignment-Prüfung bleibt bei job_photos (defense-in-
--             depth, kein second-source-of-truth).
--   DELETE  → unverändert (worker_doku_photos_delete_own, owner = auth.uid()).
-- ===========================================================================

-- Drop coarse-grained policies from 20260508000001
drop policy if exists worker_doku_photos_insert on storage.objects;
drop policy if exists worker_doku_photos_select on storage.objects;

-- INSERT: path-format enforcement only.
-- Full job-assignment check stays at job_photos layer (original design intent
-- preserved — no second authorization source).
create policy worker_doku_photos_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'worker-doku-photos'
    and (storage.foldername(name))[1] = 'jobs'
  );

-- SELECT: cross-check against job_photos row, role-scoped identical to
-- job_photos RLS (owner / worker-same-provider / customer-own-job).
-- Ensures a user can only read a storage object if a matching job_photos
-- row exists and they are authorized to see it.
create policy worker_doku_photos_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'worker-doku-photos'
    and exists (
      select 1
      from public.job_photos jp
      where jp.storage_path = name
        and (
          -- owner of the provider
          jp.provider_id in (
            select id from public.providers
            where profile_id = auth.uid()
          )
          or
          -- active worker of the same provider
          jp.provider_id in (
            select provider_id from public.team_members
            where profile_id = auth.uid()
              and is_active = true
          )
          or
          -- customer of that specific job
          jp.job_id in (
            select id from public.jobs
            where customer_user_id = auth.uid()
               or customer_profile_id = auth.uid()
          )
        )
    )
  );

-- Rollback reference (manual):
--   drop policy if exists worker_doku_photos_insert on storage.objects;
--   drop policy if exists worker_doku_photos_select on storage.objects;
--   create policy worker_doku_photos_insert on storage.objects
--     for insert to authenticated
--     with check (bucket_id = 'worker-doku-photos');
--   create policy worker_doku_photos_select on storage.objects
--     for select to authenticated
--     using (bucket_id = 'worker-doku-photos');
