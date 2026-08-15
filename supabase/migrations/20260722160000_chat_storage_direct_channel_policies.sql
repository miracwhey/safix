-- Chat-Storage: direct-Channel-Abdeckung + UPDATE/DELETE-Symmetrie
--
-- Root Cause (Prod-Logs 2026-07-22): bucketForChannel() routet
-- channel_type='direct' nach chat-internal; chat_internal_insert/select auf
-- storage.objects kennen aber nur office/team/assignment. Jeder
-- Attachment-Upload (Voice/Foto/Video/Doku) und jeder Signed-URL-Read in
-- Direct-Threads scheitert deshalb mit 400 (RLS-Violation) — Text geht durch,
-- weil chat_messages/chat_attachments participant-basiert und channel-agnostisch
-- gesichert sind.
--
-- Zusätzlich fehlten auf den drei Chat-Buckets UPDATE-Policies (Retry-Upsert
-- auf stabilem storagePath unmöglich) und DELETE-Policies (Blob-Cleanup via
-- storage.remove() no-opt still: Supabase meldet Erfolg, löscht aber nichts).
-- UPDATE/DELETE sind auf eigene Objekte (owner_id) beschränkt.

-- ── chat-internal: insert/select um 'direct' erweitern ──────────────────────

drop policy if exists chat_internal_insert on storage.objects;
create policy chat_internal_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-internal'
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type in ('office', 'team', 'assignment', 'direct')
    )
  );

drop policy if exists chat_internal_select on storage.objects;
create policy chat_internal_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-internal'
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type in ('office', 'team', 'assignment', 'direct')
    )
  );

-- ── UPDATE-Policies (Retry-Upsert eigener pending-Blobs) ────────────────────

drop policy if exists chat_internal_update on storage.objects;
create policy chat_internal_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'chat-internal'
    and owner_id = (select auth.uid()::text)
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type in ('office', 'team', 'assignment', 'direct')
    )
  )
  with check (
    bucket_id = 'chat-internal'
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type in ('office', 'team', 'assignment', 'direct')
    )
  );

drop policy if exists chat_customer_update on storage.objects;
create policy chat_customer_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'chat-customer'
    and owner_id = (select auth.uid()::text)
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type = 'customer'
        and cp.role <> 'worker'
    )
  )
  with check (
    bucket_id = 'chat-customer'
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type = 'customer'
        and cp.role <> 'worker'
    )
  );

drop policy if exists chat_dispute_update on storage.objects;
create policy chat_dispute_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'chat-dispute'
    and owner_id = (select auth.uid()::text)
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type = 'dispute'
    )
  )
  with check (
    bucket_id = 'chat-dispute'
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type = 'dispute'
    )
  );

-- ── DELETE-Policies (Cleanup eigener Blobs: Orphan-Cleanup, Discard, Redact) ─

drop policy if exists chat_internal_delete on storage.objects;
create policy chat_internal_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat-internal'
    and owner_id = (select auth.uid()::text)
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type in ('office', 'team', 'assignment', 'direct')
    )
  );

drop policy if exists chat_customer_delete on storage.objects;
create policy chat_customer_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat-customer'
    and owner_id = (select auth.uid()::text)
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type = 'customer'
        and cp.role <> 'worker'
    )
  );

drop policy if exists chat_dispute_delete on storage.objects;
create policy chat_dispute_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat-dispute'
    and owner_id = (select auth.uid()::text)
    and exists (
      select 1
      from public.chat_participants cp
      join public.chat_threads ct on ct.id = cp.thread_id
      where cp.thread_id::text = (storage.foldername(objects.name))[2]
        and cp.user_id = (select auth.uid())
        and cp.left_at is null
        and ct.channel_type = 'dispute'
    )
  );
