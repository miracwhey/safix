-- =============================================================================
-- Block D Slice 1 Phase 1a — Chat Storage Buckets + RLS
-- =============================================================================
-- Buckets: chat-customer (private, 100 MB, image+video+pdf)
--          chat-internal (private, 200 MB, image+video+audio+pdf)
--          chat-dispute (reserviert für Slice 6, default-deny RLS)
-- Storage-Path-Schema: {providerId}/{threadId}/{messageId}/{filename}
-- RLS-Pattern: foldername(name)[2] = thread_id + chat_participants Membership
-- Pattern aus: 20260507000004_worker_doku_photos_path_rls.sql (intermediate)
--             + 20260507232817_sick_note_upload.sql
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1 — Bucket-INSERTs
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'chat-customer',
    'chat-customer',
    false,
    104857600,
    ARRAY['image/jpeg','image/jpg','image/png','image/heic','image/heif',
          'image/webp','image/gif','video/mp4','video/webm','video/quicktime',
          'application/pdf']
  ),
  (
    'chat-internal',
    'chat-internal',
    false,
    209715200,
    ARRAY['image/jpeg','image/jpg','image/png','image/heic','image/heif',
          'image/webp','image/gif','video/mp4','video/webm','video/quicktime',
          'audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/webm',
          'application/pdf']
  ),
  (
    'chat-dispute',
    'chat-dispute',
    false,
    209715200,
    ARRAY['image/jpeg','image/jpg','image/png','image/heic','image/heif',
          'image/webp','image/gif','video/mp4','video/webm','video/quicktime',
          'audio/mpeg','audio/mp4','application/pdf']
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- SECTION 2 — chat-customer RLS
-- =============================================================================
-- Path: {providerId}/{threadId}/{messageId}/{filename}
-- foldername(name)[1] = providerId
-- foldername(name)[2] = threadId
-- foldername(name)[3] = messageId

DROP POLICY IF EXISTS chat_customer_insert ON storage.objects;
CREATE POLICY chat_customer_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-customer'
    AND EXISTS (
      SELECT 1
      FROM public.chat_participants cp
      JOIN public.chat_threads      ct ON ct.id = cp.thread_id
      WHERE cp.thread_id::text  = (storage.foldername(name))[2]
        AND cp.user_id          = (SELECT auth.uid())
        AND cp.left_at          IS NULL
        AND ct.channel_type     = 'customer'
        AND cp.role             <> 'worker'
    )
  );

DROP POLICY IF EXISTS chat_customer_select ON storage.objects;
CREATE POLICY chat_customer_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-customer'
    AND EXISTS (
      SELECT 1
      FROM public.chat_participants cp
      JOIN public.chat_threads      ct ON ct.id = cp.thread_id
      WHERE cp.thread_id::text = (storage.foldername(name))[2]
        AND cp.user_id         = (SELECT auth.uid())
        AND cp.left_at         IS NULL
        AND ct.channel_type    = 'customer'
        AND cp.role            <> 'worker'
    )
  );

-- =============================================================================
-- SECTION 3 — chat-internal RLS (office/team/assignment)
-- =============================================================================

DROP POLICY IF EXISTS chat_internal_insert ON storage.objects;
CREATE POLICY chat_internal_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-internal'
    AND EXISTS (
      SELECT 1
      FROM public.chat_participants cp
      JOIN public.chat_threads      ct ON ct.id = cp.thread_id
      WHERE cp.thread_id::text = (storage.foldername(name))[2]
        AND cp.user_id         = (SELECT auth.uid())
        AND cp.left_at         IS NULL
        AND ct.channel_type    IN ('office','team','assignment')
    )
  );

DROP POLICY IF EXISTS chat_internal_select ON storage.objects;
CREATE POLICY chat_internal_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-internal'
    AND EXISTS (
      SELECT 1
      FROM public.chat_participants cp
      JOIN public.chat_threads      ct ON ct.id = cp.thread_id
      WHERE cp.thread_id::text = (storage.foldername(name))[2]
        AND cp.user_id         = (SELECT auth.uid())
        AND cp.left_at         IS NULL
        AND ct.channel_type    IN ('office','team','assignment')
    )
  );

-- =============================================================================
-- SECTION 4 — chat-dispute (Reservation, Slice 6 aktiviert)
-- =============================================================================
-- Keine Policy → default-deny für alle authenticated. service_role bypasst.

COMMIT;

-- =============================================================================
-- Section R — Reversal-Plan
-- =============================================================================
-- DROP POLICY IF EXISTS chat_customer_insert ON storage.objects;
-- DROP POLICY IF EXISTS chat_customer_select ON storage.objects;
-- DROP POLICY IF EXISTS chat_internal_insert ON storage.objects;
-- DROP POLICY IF EXISTS chat_internal_select ON storage.objects;
-- DELETE FROM storage.buckets WHERE id IN ('chat-customer','chat-internal','chat-dispute');
-- =============================================================================
