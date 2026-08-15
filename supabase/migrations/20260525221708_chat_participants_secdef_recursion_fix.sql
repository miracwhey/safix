-- Spatial Hotfix Round 3 · chat_participants RLS infinite-recursion fix
--
-- Symptom: storage.objects INSERT to spatial-parametric (Customer Self-Scan
-- workflow Step 6) returnt 400 "new row violates row-level security policy".
-- Underlying Postgres error (postgres-log): "infinite recursion detected in
-- policy for relation chat_participants".
--
-- Root cause: chat_participants_select_self_or_owner + chat_participants_
-- insert_owner_or_self each reference `chat_participants` itself in their
-- EXISTS-subquery. Postgres applies RLS to that subquery → re-evaluates the
-- same policy → recursion.
--
-- Cascade impact: storage.objects has chat_customer_insert / chat_dispute_
-- insert / chat_internal_insert policies that ALSO `EXISTS (SELECT FROM
-- chat_participants ...)`. When ANY storage.objects INSERT happens (any
-- bucket!), Postgres evaluates ALL applicable INSERT-policies disjunctively
-- — if it touches the chat_participants subquery, recursion fires and the
-- whole INSERT aborts with the WITHCHECK violation text. That is why
-- spatial-parametric uploads (an unrelated bucket) currently return 0 rows
-- in storage.objects: every attempt crashed before reaching the
-- spatial_parametric_insert WITH CHECK.
--
-- Fix: Replace self-referencing EXISTS-subqueries with a SECURITY DEFINER
-- helper `chat_user_is_thread_admin(p_thread_id, p_uid, p_include_craftsman)`.
-- The helper runs as function-owner (postgres) which bypasses RLS, so the
-- chat_participants lookup is safe. SELECT-policy + INSERT-policy switched
-- to call the helper instead of the recursive subquery.

CREATE OR REPLACE FUNCTION public.chat_user_is_thread_admin(
  p_thread_id uuid,
  p_uid       uuid,
  p_include_craftsman boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $f$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_participants cp
    WHERE cp.thread_id = p_thread_id
      AND cp.user_id   = p_uid
      AND cp.left_at IS NULL
      AND (
        cp.role IN ('owner', 'admin')
        OR (p_include_craftsman AND cp.role = 'craftsman')
      )
  );
$f$;

REVOKE EXECUTE ON FUNCTION public.chat_user_is_thread_admin(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.chat_user_is_thread_admin(uuid, uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.chat_user_is_thread_admin(uuid, uuid, boolean) IS
  'Chat RLS helper: returns true if p_uid is active owner/admin (or optionally craftsman) of p_thread_id. SECDEF bypasses chat_participants self-recursion.';

DROP POLICY IF EXISTS chat_participants_select_self_or_owner ON public.chat_participants;
CREATE POLICY chat_participants_select_self_or_owner ON public.chat_participants
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.chat_user_is_thread_admin(thread_id, (SELECT auth.uid()), false)
  );

DROP POLICY IF EXISTS chat_participants_insert_owner_or_self ON public.chat_participants;
CREATE POLICY chat_participants_insert_owner_or_self ON public.chat_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    public.chat_user_is_thread_admin(thread_id, (SELECT auth.uid()), true)
    OR (
      user_id = (SELECT auth.uid())
      AND EXISTS (
        SELECT 1 FROM public.chat_threads ct
        WHERE ct.id = chat_participants.thread_id
          AND ct.channel_type IN ('assignment', 'team')
      )
    )
  );
