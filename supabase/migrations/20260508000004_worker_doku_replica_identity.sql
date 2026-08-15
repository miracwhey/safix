-- ===========================================================================
-- Block C.1 hot-fix · job_photos + job_reports · REPLICA IDENTITY FULL
-- ===========================================================================
-- Migration 20260508000002 / _000003 haben job_photos und job_reports an die
-- supabase_realtime Publication gehängt, aber REPLICA IDENTITY DEFAULT
-- gelassen. Das genügt für INSERT/UPDATE-Events, droppt aber DELETE-Events
-- silently, sobald der Subscriber server-side auf eine non-PK-Column
-- filtert.
--
-- jobPhotosLive.ts + jobReportsLive.ts registrieren genau das:
--   .on('postgres_changes', { event: 'DELETE', filter: 'job_id=eq.<id>' }, …)
--
-- Bei REPLICA IDENTITY DEFAULT enthält OLD nur die Primary-Key-Spalten (id),
-- so dass der Postgres-Logical-Replication-Stream `job_id` nicht kennt und
-- der Filter dem Server-Side-Matching nicht standhält → Worker-DELETE
-- innerhalb des 24h-Edit-Windows propagiert nicht zu Team-Members mit
-- offenem Detail-Screen.
--
-- Memory-Pflicht: feedback_postgres_replica_identity_realtime — exakt
-- dieser Fall ist dort dokumentiert.
--
-- Fix: REPLICA IDENTITY FULL kopiert die volle Row in OLD, sodass
-- non-PK-Filter funktionieren. Performance-Cost ist marginal (job_photos
-- + job_reports sind kleinvolumige Tabellen, kein hot-write-Pfad).

alter table public.job_photos replica identity full;
alter table public.job_reports replica identity full;

comment on table public.job_photos is
  'Worker-Doku Foto-Capture Append-Only — REPLICA IDENTITY FULL für DELETE-Realtime-Filter auf job_id (siehe Migration 20260508000004).';

comment on table public.job_reports is
  'Worker-Doku Berichte mit 24h-Edit-Window — REPLICA IDENTITY FULL für DELETE-Realtime-Filter auf job_id (siehe Migration 20260508000004).';
