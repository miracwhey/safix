-- Block D Slice 2 — M3 Rollback: restore original chat_messages_select_participant
-- and remove is_blocked_by_me helper function.
--
-- Use only if M3 must be reverted. After rollback, blocker-sees-blocked-sender
-- messages again (workflow inbound-throw is also gone post-M3, so blocker may
-- see messages they shouldn't until workflow is also rolled back).

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
  );

REVOKE EXECUTE ON FUNCTION public.is_blocked_by_me(uuid) FROM authenticated;
DROP FUNCTION IF EXISTS public.is_blocked_by_me(uuid);
