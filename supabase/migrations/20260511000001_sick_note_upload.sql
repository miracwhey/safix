-- ===========================================================================
-- Sick-note document upload for absences (Block A)
-- ===========================================================================
-- Workers can upload an AU-Bescheinigung (photo or PDF) when reporting sick
-- or when the owner requests a Krankschein afterwards.
--
-- Storage layout: sick-notes/{providerId}/{memberId}/{absenceId}.{ext}
-- Bucket is private; signed URLs (1h TTL) are generated server-side for owner
-- access.
--
-- RLS strategy:
--   - Worker: INSERT + UPDATE + SELECT own files (scoped by member_id folder)
--   - Owner:  SELECT all files under own provider_id folder
--   - Absence row UPDATE: separate permissive policy so workers can set
--     sick_note_url without triggering the status=cancelled check constraint
--     on the existing absences_worker_cancel policy.

-- ── absences: new columns ──────────────────────────────────────────────────

alter table public.absences
  add column if not exists sick_note_url          text,
  add column if not exists sick_note_submitted_at  timestamptz;

-- Both fields must be set together.
alter table public.absences
  add constraint sick_note_upload_consistency check (
    (sick_note_url is null and sick_note_submitted_at is null)
    or (sick_note_url is not null and sick_note_submitted_at is not null)
  );

comment on column public.absences.sick_note_url is
  'Supabase Storage path (sick-notes bucket) of the uploaded AU-Bescheinigung. Null until worker submits.';
comment on column public.absences.sick_note_submitted_at is
  'Timestamp when the sick note was first uploaded. Required when sick_note_url is set (CHECK).';

-- ── RLS: worker can set sick_note_url on own active absence ───────────────
-- This is a separate permissive policy from absences_worker_cancel.
-- absences_worker_cancel requires WITH CHECK status='cancelled'.
-- This policy requires WITH CHECK status='active' so both co-exist via OR.

create policy absences_worker_sick_note_update on public.absences
for update to authenticated
using (
  status = 'active'
  and member_id in (
    select id from public.team_members
    where profile_id = auth.uid() and is_active = true
  )
)
with check (
  status = 'active'
  and member_id in (
    select id from public.team_members
    where profile_id = auth.uid() and is_active = true
  )
);

-- ── Storage: sick-notes bucket ─────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sick-notes',
  'sick-notes',
  false,
  10485760,
  array[
    'image/jpeg', 'image/jpg', 'image/png',
    'image/heic', 'image/heif', 'image/webp',
    'application/pdf'
  ]
)
on conflict (id) do nothing;

-- Worker: INSERT own file under {providerId}/{memberId}/{filename}
create policy sick_notes_worker_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'sick-notes'
  and (storage.foldername(name))[1] in (
    select tm.provider_id::text
    from public.team_members tm
    where tm.profile_id = auth.uid() and tm.is_active = true
  )
  and (storage.foldername(name))[2] in (
    select tm.id::text
    from public.team_members tm
    where tm.profile_id = auth.uid() and tm.is_active = true
  )
);

-- Worker: UPDATE (replace) own file
create policy sick_notes_worker_update on storage.objects
for update to authenticated
using (
  bucket_id = 'sick-notes'
  and (storage.foldername(name))[2] in (
    select tm.id::text
    from public.team_members tm
    where tm.profile_id = auth.uid() and tm.is_active = true
  )
)
with check (
  bucket_id = 'sick-notes'
  and (storage.foldername(name))[2] in (
    select tm.id::text
    from public.team_members tm
    where tm.profile_id = auth.uid() and tm.is_active = true
  )
);

-- Worker: SELECT own files
create policy sick_notes_worker_select on storage.objects
for select to authenticated
using (
  bucket_id = 'sick-notes'
  and (storage.foldername(name))[2] in (
    select tm.id::text
    from public.team_members tm
    where tm.profile_id = auth.uid() and tm.is_active = true
  )
);

-- Owner: SELECT all files under own provider folder
create policy sick_notes_owner_select on storage.objects
for select to authenticated
using (
  bucket_id = 'sick-notes'
  and (storage.foldername(name))[1] in (
    select p.id::text
    from public.providers p
    where p.profile_id = auth.uid()
  )
);
