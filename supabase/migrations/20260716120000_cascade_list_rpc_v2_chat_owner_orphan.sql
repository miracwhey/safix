-- 20260716120000 · DSGVO cascade list RPC v2 — fix chat-bucket race (Bug ① Submit-Nacht 02.07.)
--
-- Problem (verified in prod 2026-07-02): the trigger path (auth.users AFTER
-- DELETE → pg_net → Edge Function account-cascade-cleanup) lists chat buckets
-- via a JOIN on public.chat_participants. The FK cascade of the auth.users
-- DELETE removes those chat_participants rows BEFORE the async pg_net call
-- executes, so chat-customer / chat-internal / chat-dispute silently stay
-- unclean while the audit log still shows error_detail=null (looks green).
-- Concrete leftover: 16 blobs under chat-customer/dc729821-…/ from the
-- 7-account cleanup on 2026-07-02.
--
-- Fix — the chat selector becomes a union of three predicates:
--   1. Thread walk via chat_participants (unchanged; carries the synchronous
--      Vercel path api/delete-account.ts, which runs BEFORE the user row is
--      deleted and therefore still sees participants).
--   2. Ownership: storage.objects.owner / owner_id = user. Verified in prod:
--      owner has NO FK to auth.users (never nulled on user delete), and all
--      existing chat objects carry both owner and owner_id. This is what the
--      trigger path relies on — a user's own uploads remain attributable
--      after the cascade wiped the participant rows.
--   3. Orphaned thread folders: object path prefix looks like a UUID but no
--      matching public.chat_threads row exists. Chat buckets are strictly
--      thread-prefixed (see 20260527000002), so such blobs are unreachable
--      (bucket private, access is thread-RLS-based) — e.g. uploads by the
--      OTHER participant of a thread that was cascade-deleted. The UUID
--      regex guard prevents ever classifying non-thread paths as orphans.
--      Side effect (intended): every cascade run also sweeps historical
--      orphans, so filesRemoved in account_deletion_log may include blobs
--      not owned by the deleted user.
--
-- All other bucket selectors unchanged except worker-doku-photos / media,
-- which additionally match owner_id (text, no FK) alongside the deprecated
-- owner column — same semantics, robust against future Storage API versions
-- that stop populating owner.
--
-- Selector doc kept in sync with:
--   api/delete-account.ts · supabase/functions/account-cascade-cleanup/index.ts

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

  -- 2 owner-based buckets (owner uuid legacy column OR owner_id text)
  RETURN QUERY
    SELECT o.bucket_id::text, o.name::text
    FROM storage.objects o
    WHERE o.bucket_id IN ('worker-doku-photos', 'media')
    AND (o.owner = p_user_id OR o.owner_id = p_user_id::text);

  -- sick-notes (mid-segment match: providerId/userId/yyyy/file)
  RETURN QUERY
    SELECT o.bucket_id::text, o.name::text
    FROM storage.objects o
    WHERE o.bucket_id = 'sick-notes'
    AND o.name LIKE '%/' || p_user_id::text || '/%';

  -- 3 chat buckets: thread walk ∪ ownership ∪ orphaned thread folders
  RETURN QUERY
    SELECT DISTINCT o.bucket_id::text, o.name::text
    FROM storage.objects o
    WHERE o.bucket_id IN ('chat-customer', 'chat-internal', 'chat-dispute')
    AND (
      EXISTS (
        SELECT 1 FROM public.chat_participants cp
        WHERE cp.user_id = p_user_id
        AND (o.name LIKE cp.thread_id::text || '/%' OR o.name = cp.thread_id::text)
      )
      OR o.owner = p_user_id
      OR o.owner_id = p_user_id::text
      OR (
        split_part(o.name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND NOT EXISTS (
          SELECT 1 FROM public.chat_threads t
          WHERE t.id::text = split_part(o.name, '/', 1)
        )
      )
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.account_cascade_list_storage(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_cascade_list_storage(uuid) TO service_role;

COMMENT ON FUNCTION public.account_cascade_list_storage(uuid) IS
'DSGVO cascade list helper v2. Returns (bucket_id, name) for every storage.objects row attributable to the user across the 10 user-owned buckets. Chat buckets resolve via thread walk ∪ owner/owner_id ∪ orphaned-thread-folder sweep, so the async trigger path stays correct after chat_participants rows were cascade-deleted. SECURITY DEFINER bypasses storage-schema PostgREST exposure restriction. Service-role only. spatial-public-assets EXCLUDED (shared library, never user-owned).';

NOTIFY pgrst, 'reload schema';

-- Rollback: re-apply the function body from 20260527000002_phase_5_account_cascade_list_rpc.sql
