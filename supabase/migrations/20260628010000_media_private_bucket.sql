-- ===========================================================================
-- M3 S1 — media-private bucket: participant-scoped private media storage
-- ===========================================================================
--
-- PROBLEM:
--   All entity media (project/dispute/job/message) currently lands in the
--   public `media` bucket, making CDN URLs world-readable with no access
--   control beyond knowing the URL. This exposes dispute evidence, job
--   progress photos, and project images to any actor who can construct or
--   guess a path.
--
-- FIX (Option A — split bucket):
--   New private bucket `media-private` receives uploads for entityType in
--   (project, dispute, job, message). Reads require a 1-hour signed URL
--   issued by the caller's session. The public `media` bucket and all its
--   policies are UNTOUCHED — discovery content (profile avatars, portfolio,
--   showcase, builder, reels) remains public.
--
-- STORAGE PATH (unchanged layout):
--   {entityType}/{entityId}/{uuid}.{ext}
--   e.g. project/proj-abc/9f3d1c2e.jpg
--        dispute/dispute-xyz/evidence.png
--        job/job-123/progress-a4b8c.mp4
--        message/{threadId}/attachment.jpg
--
-- RLS PATTERN:
--   INSERT: authenticated + foldername[1] in (project,dispute,job,message)
--   SELECT: participant-scoped per prefix via EXISTS lookups
--   service_role: full access (bypasses RLS by default; explicit policy for
--                 edge functions and internal tooling)
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS media_private_insert         ON storage.objects;
--   DROP POLICY IF EXISTS media_private_select_dispute ON storage.objects;
--   DROP POLICY IF EXISTS media_private_select_job     ON storage.objects;
--   DROP POLICY IF EXISTS media_private_select_project ON storage.objects;
--   DROP POLICY IF EXISTS media_private_select_message ON storage.objects;
--   DROP POLICY IF EXISTS media_private_service_role   ON storage.objects;
--   DELETE FROM storage.buckets WHERE id = 'media-private';
--   -- Then revert src/lib/media/mediaUploadService.ts to public `media` bucket.
--
-- GOTCHAS APPLIED:
--   • storage.foldername(name)[1] = first path segment = entityType
--   • storage.foldername(name)[2] = second path segment = entityId (as text)
--   • disputes.id is text; jobs.id is text; projects.id is text → direct =
--   • chat_participants.thread_id is uuid → thread_id::text = foldername[2]
--   • projects.customer_user_id and projects.craftsman_user_id are text
--   • jobs.customer_user_id is uuid; jobs.craftsman_user_id is text
--   • service_role bypasses RLS by default in Supabase/PG but explicit policy
--     ensures correctness if superuser bypasses are ever tightened
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SECTION 1 — Create bucket
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media-private',
  'media-private',
  false,           -- private: objects are NOT accessible via CDN without a signed URL
  209715200,       -- 200 MiB — mirrors the `media` bucket limit
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/webm',
    'video/quicktime'
    -- poster frames (.poster.jpg) reuse the image/jpeg entry above
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION 2 — storage.objects RLS policies
-- ---------------------------------------------------------------------------

-- ── INSERT ────────────────────────────────────────────────────────────────────
-- Any authenticated user may upload to the four private prefixes.
-- Party-scoping for the entity_id level is enforced at the media_uploads layer
-- (media_uploads_insert_party_scoped policy) — defense-in-depth, not a second
-- source of truth.

DROP POLICY IF EXISTS media_private_insert ON storage.objects;

CREATE POLICY media_private_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'media-private'
    AND (storage.foldername(name))[1] IN ('project', 'dispute', 'job', 'message')
  );

-- ── SELECT — dispute/{id} ─────────────────────────────────────────────────────
-- Mirrors disputes_select_own_side exactly:
--   opened_by_profile_id | customer_profile_id | provider owner |
--   active team member of provider | operator.

DROP POLICY IF EXISTS media_private_select_dispute ON storage.objects;

CREATE POLICY media_private_select_dispute
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'media-private'
    AND (storage.foldername(name))[1] = 'dispute'
    AND EXISTS (
      SELECT 1
      FROM public.disputes d
      WHERE d.id = (storage.foldername(storage.objects.name))[2]   -- disputes.id is text
        AND (
          d.opened_by_profile_id = auth.uid()
          OR d.customer_profile_id = auth.uid()
          OR d.provider_id IN (
            SELECT pv.id FROM public.providers pv
            WHERE pv.profile_id = auth.uid()
          )
          OR d.provider_id IN (
            SELECT tm.provider_id FROM public.team_members tm
            WHERE tm.profile_id = auth.uid()
              AND tm.is_active = true
          )
          OR EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.is_operator = true
          )
        )
    )
  );

-- ── SELECT — job/{id} ─────────────────────────────────────────────────────────
-- Participants: customer (customer_user_id uuid or customer_profile_id uuid),
--              craftsman (craftsman_user_id text or via provider_id → providers).

DROP POLICY IF EXISTS media_private_select_job ON storage.objects;

CREATE POLICY media_private_select_job
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'media-private'
    AND (storage.foldername(name))[1] = 'job'
    AND EXISTS (
      SELECT 1
      FROM public.jobs j
      WHERE j.id = (storage.foldername(storage.objects.name))[2]   -- jobs.id is text
        AND (
          j.customer_user_id = auth.uid()           -- uuid column
          OR j.customer_profile_id = auth.uid()     -- uuid column
          OR j.craftsman_user_id = auth.uid()::text -- text column
          OR EXISTS (
            SELECT 1 FROM public.providers pv
            WHERE pv.id = j.provider_id
              AND pv.profile_id = auth.uid()
          )
        )
    )
  );

-- ── SELECT — project/{id} ─────────────────────────────────────────────────────
-- Participants: customer (customer_user_id text) or craftsman (craftsman_user_id text).
-- Both columns are text on the projects table (verified via live_schema_catchup).

DROP POLICY IF EXISTS media_private_select_project ON storage.objects;

CREATE POLICY media_private_select_project
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'media-private'
    AND (storage.foldername(name))[1] = 'project'
    AND EXISTS (
      SELECT 1
      FROM public.projects pr
      WHERE pr.id = (storage.foldername(storage.objects.name))[2]     -- projects.id is text
        AND (
          pr.customer_user_id = auth.uid()::text       -- text column
          OR pr.craftsman_user_id = auth.uid()::text   -- text column
        )
    )
  );

-- ── SELECT — message/{threadId} ───────────────────────────────────────────────
-- entityId for message uploads is the chat thread UUID.
-- Participant check via chat_participants (left_at IS NULL = still in thread).

DROP POLICY IF EXISTS media_private_select_message ON storage.objects;

CREATE POLICY media_private_select_message
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'media-private'
    AND (storage.foldername(name))[1] = 'message'
    AND EXISTS (
      SELECT 1
      FROM public.chat_participants cp
      WHERE cp.thread_id::text = (storage.foldername(storage.objects.name))[2]
        AND cp.user_id = auth.uid()
        AND cp.left_at IS NULL
    )
  );

-- ── service_role ──────────────────────────────────────────────────────────────
-- Explicit full-access policy for internal tooling, Edge Functions, and pg_cron
-- cleanup jobs that must enumerate or purge private objects.

DROP POLICY IF EXISTS media_private_service_role ON storage.objects;

CREATE POLICY media_private_service_role
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'media-private')
  WITH CHECK (bucket_id = 'media-private');

-- ---------------------------------------------------------------------------
-- SECTION 3 — PostgREST schema cache reload
-- (defensive; storage policy changes are picked up without this, but
--  belt-and-suspenders consistent with project convention)
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
