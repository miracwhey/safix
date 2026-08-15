-- Phase 5 Spatial V1.6 · DSGVO cascade list RPC
--
-- PostgREST does not expose the `storage` schema by default, so the Vercel-Route
-- (api/delete-account.ts) and Edge-Function (account-cascade-cleanup) cannot do
-- `admin.schema('storage').from('objects')` directly — those calls return
-- "Invalid schema: storage" (verified via smoke test 2026-05-26).
--
-- This SECURITY DEFINER function reads storage.objects for the deleting user
-- across all user-owned buckets in one round-trip and returns the (bucket_id,
-- name) pairs. The caller groups by bucket and removes via
-- `admin.storage.from(bucket).remove(paths)` (which goes through the Storage
-- HTTP API, not PostgREST, and works fine).
--
-- Service-role only (revoked from anon+authenticated). spatial-public-assets
-- is EXCLUDED — shared assets, never user-owned, must never be deleted as part
-- of an account deletion.
--
-- Bucket selectors (kept in sync with api/delete-account.ts +
-- supabase/functions/account-cascade-cleanup/index.ts):
--   project-scans / spatial-mesh-snapshots / spatial-parametric / spatial-annotation-photos
--      → name LIKE '<userId>/%'
--   worker-doku-photos / media
--      → owner = userId
--   sick-notes
--      → name LIKE '%/<userId>/%' (path schema providerId/userId/yyyy/file)
--   chat-customer / chat-internal / chat-dispute
--      → join chat_participants(thread_id) where user_id = userId
--        and storage.objects.name LIKE thread_id || '/%'

CREATE OR REPLACE FUNCTION public.account_cascade_list_storage(p_user_id uuid)
RETURNS TABLE (bucket_id text, name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, extensions
AS $$
BEGIN
  -- 4 user-prefixed buckets (path[1] = userId)
  RETURN QUERY
    SELECT o.bucket_id::text, o.name::text
    FROM storage.objects o
    WHERE o.bucket_id IN (
      'project-scans',
      'spatial-mesh-snapshots',
      'spatial-parametric',
      'spatial-annotation-photos'
    )
    AND o.name LIKE p_user_id::text || '/%';

  -- 2 owner-based buckets (owner column = userId)
  RETURN QUERY
    SELECT o.bucket_id::text, o.name::text
    FROM storage.objects o
    WHERE o.bucket_id IN ('worker-doku-photos', 'media')
    AND o.owner = p_user_id;

  -- sick-notes (mid-segment match: providerId/userId/yyyy/file)
  RETURN QUERY
    SELECT o.bucket_id::text, o.name::text
    FROM storage.objects o
    WHERE o.bucket_id = 'sick-notes'
    AND o.name LIKE '%/' || p_user_id::text || '/%';

  -- 3 chat buckets (thread-prefixed; enumerate via chat_participants)
  RETURN QUERY
    SELECT DISTINCT o.bucket_id::text, o.name::text
    FROM storage.objects o
    JOIN public.chat_participants cp
      ON cp.user_id = p_user_id
      AND o.bucket_id IN ('chat-customer', 'chat-internal', 'chat-dispute')
      AND (o.name LIKE cp.thread_id::text || '/%' OR o.name = cp.thread_id::text);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.account_cascade_list_storage(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_cascade_list_storage(uuid) TO service_role;

COMMENT ON FUNCTION public.account_cascade_list_storage(uuid) IS
'Phase 5 Spatial V1.6 · DSGVO cascade list helper. Returns (bucket_id, name) for every storage.objects row attributable to the user across the 10 user-owned buckets. SECURITY DEFINER bypasses storage-schema PostgREST exposure restriction. Service-role only. spatial-public-assets EXCLUDED (shared library, never user-owned).';

NOTIFY pgrst, 'reload schema';

-- Rollback:
-- DROP FUNCTION IF EXISTS public.account_cascade_list_storage(uuid);
