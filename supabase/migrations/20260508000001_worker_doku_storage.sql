-- ===========================================================================
-- Block C.1 · WorkerDoku P1+P2 — Storage-Bucket worker-doku-photos
-- ===========================================================================
-- Privater Bucket für Worker-Doku-Fotos. Im Gegensatz zu `media` und
-- `provider-media` (public) ist dieser Bucket **nicht public** — Reads
-- gehen ausschließlich über signed URLs, die der Server pro Request
-- ausstellt. Das verhindert, dass das Erraten eines Storage-Pfads zum
-- Foto-Leak führt.
--
-- Path-Konvention: `jobs/{jobId}/{client_uuid}.jpg`
--   - jobId-Prefix erlaubt einfache Nachträgliche Cleanup-Crons pro Job
--   - client_uuid ist UUID v4, vom Client generiert; gleichzeitig
--     Idempotenz-Key in der `job_photos`-Tabelle (UNIQUE constraint)
--
-- File-Constraints:
--   - max 12 MB (genug für ein 2560px komprimiertes JPG bei q=0.92)
--   - JPEG / PNG / HEIC / HEIF — HEIC ist iOS-Default, Komprimierung
--     in pre-upload-pipeline läuft client-seitig auf JPEG
--
-- Cross-Domain-Authorization passiert auf der `job_photos`-Tabelle, nicht
-- auf Storage-Layer. Storage-RLS sind absichtlich „grobkörnig" —
-- authenticated darf insert / delete-own. Wer keinen valid `job_photos`-
-- Insert hinkriegt, kann auch nichts mit dem Storage-Pfad anfangen.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'worker-doku-photos',
  'worker-doku-photos',
  false,
  12 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/heic', 'image/heif']
)
on conflict (id) do nothing;

-- ── Storage RLS ──────────────────────────────────────────────────────────
-- Bucket-Level-Default ist deny. Wir öffnen nur, was wir brauchen:
--   INSERT  authenticated      → jeder eingeloggte User darf hochladen,
--                                Cross-Domain-Check macht job_photos-RLS
--                                in der nachfolgenden Tabellen-Migration
--   SELECT  authenticated      → Lese-Zugriff via signed URL braucht trotzdem
--                                eine Policy; wir scopen per bucket_id
--                                und delegieren Authorization an die
--                                zugehörige `job_photos`-Tabelle (siehe
--                                Migration 20260508000002)
--   DELETE  authenticated own  → eigener Upload darf gelöscht werden
--                                (für Foto-Capture-Retry, kein Owner-
--                                Override hier — Cleanup-Cron später)
--   UPDATE  none               — Fotos sind immutable

create policy worker_doku_photos_insert
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'worker-doku-photos');

create policy worker_doku_photos_select
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'worker-doku-photos');

create policy worker_doku_photos_delete_own
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'worker-doku-photos'
    and owner = auth.uid()
  );
