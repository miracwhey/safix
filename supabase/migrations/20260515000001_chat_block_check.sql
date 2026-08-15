-- Block D Slice 2 — M3: Silent Block Drop
--
-- Decision (asymmetric semantics, locked in plan
-- ~/.claude/plans/chat-architecture-block-d-slice-2-m3-silent-block-drop.md):
--   - Outbound block (current user blocked counterpart) → workflow throw, toast.
--     Unchanged by this migration.
--   - Inbound block (counterpart blocked current user) → silent RLS drop.
--     INSERT still succeeds (sender has no visibility into being blocked).
--     SELECT for the blocker filters out the row.
--
-- chat_attachments cascade is automatic: its SELECT policy JOINs chat_messages,
-- so attachment rows for hidden messages are unreachable.
--
-- Realtime broadcasts respect RLS (chat_messages already in supabase_realtime
-- publication with REPLICA IDENTITY FULL) — blocker never receives the INSERT
-- event.

-- 1) Helper function: SECURITY DEFINER point-lookup on user_blocks.
--    Strict-typed (uuid), STABLE, search_path locked, no dynamic SQL.
CREATE OR REPLACE FUNCTION public.is_blocked_by_me(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_blocks
    WHERE blocker_id = (SELECT auth.uid())
      AND blocked_id = target_user_id
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_blocked_by_me(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_blocked_by_me(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_blocked_by_me(uuid) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.is_blocked_by_me(uuid) TO authenticated;

COMMENT ON FUNCTION public.is_blocked_by_me(uuid) IS
  'Returns true if auth.uid() has blocked target_user_id. Used by chat_messages_select_participant policy for silent-drop semantics. SECURITY DEFINER bypasses user_blocks RLS to keep policy evaluation deterministic.';

-- 2) Rewrite chat_messages_select_participant.
--    Original USING body (verbatim from prod pg_policies.qual, sourced
--    2026-05-11 via supabase MCP execute_sql against project itdntawwuzqfwmcwnwjr):
--      EXISTS (SELECT 1
--        FROM (chat_participants cp JOIN chat_threads ct ON ct.id = cp.thread_id)
--        WHERE cp.thread_id = chat_messages.thread_id
--          AND cp.user_id = (SELECT auth.uid())
--          AND cp.left_at IS NULL
--          AND NOT (ct.channel_type = 'customer' AND cp.role = 'worker'))
--
--    M3 appends: AND NOT public.is_blocked_by_me(chat_messages.sender_user_id)

DROP POLICY IF EXISTS chat_messages_select_participant ON public.chat_messages;

CREATE POLICY chat_messages_select_participant
  ON public.chat_messages
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.chat_participants cp
      JOIN public.chat_threads ct ON ct.id = cp.thread_id
      WHERE cp.thread_id = chat_messages.thread_id
        AND cp.user_id = (SELECT auth.uid())
        AND cp.left_at IS NULL
        AND NOT (ct.channel_type = 'customer' AND cp.role = 'worker')
    )
    AND NOT public.is_blocked_by_me(chat_messages.sender_user_id)
  );
