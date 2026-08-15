-- =============================================================================
-- projects: SELECT access for projects shared into a chat thread
-- =============================================================================
--
-- Context: the chat-cutover "project attach" feature lets a CUSTOMER attach one
-- of their projects into a customer↔craftsman chat thread as an artifact_card
-- chat message (message_type='artifact_card', artifact_type='Project',
-- artifact_id=<projects.id as text>). The recipient craftsman renders the card
-- via a LIVE getProjectById() lookup (no snapshot is persisted on the message).
--
-- Problem: the existing "Projects: read own" SELECT policy grants a craftsman
-- read only on projects where craftsman_user_id = auth.uid(),
-- customer_profile_id = auth.uid(), or that are linked to one of their jobs via
-- source_job_id. A customer's builder/inquiry-origin project (craftsman_user_id
-- NULL, no source_job_id) is therefore invisible to the recipient craftsman, so
-- the card renders a permanent loading skeleton. This policy grants the read.
--
-- Security: ADDITIVE (SELECT policies are OR'd) and tightly scoped. The grant
-- requires that the artifact_card was sent BY THE PROJECT OWNER
-- (m.sender_user_id = projects.customer_profile_id). Without this guard a
-- craftsman could self-grant read on ANY project by inserting an artifact_card
-- referencing an arbitrary artifact_id into a thread they participate in (the
-- chat_messages INSERT policy does not validate artifact_id) — a privilege
-- escalation. Tying the grant to the owner's own send closes that hole: a
-- craftsman's forged card carries sender_user_id = craftsman ≠
-- customer_profile_id and grants nothing. Only an active participant
-- (left_at IS NULL) of the exact thread the owner attached into gains access.
-- The EXISTS subquery runs under the caller's own chat_messages /
-- chat_participants RLS (participant-scoped), so it can only match threads the
-- caller legitimately reads — fail-closed otherwise.
--
-- Schema note (verified against prod, not the drifted migration files):
--   projects.id              = uuid   → compared to chat_messages.artifact_id
--                                       (text) via projects.id::text
--   projects.customer_profile_id = uuid (populated on every project row;
--                                        customer_user_id is only partially
--                                        populated, so it is NOT used here)
--   chat_messages.sender_user_id / .thread_id, chat_participants.user_id = uuid
--
-- Idempotent: guarded by pg_policies existence check; safe to re-run.
-- Rollback: DROP POLICY IF EXISTS projects_select_shared_in_chat_thread ON public.projects;
--           DROP INDEX  IF EXISTS public.chat_messages_project_artifact_idx;
-- =============================================================================

-- Supporting index for the correlated EXISTS lookup below. Partial so it stays
-- tiny (only project artifact_cards) and also serves any future dedup checks.
CREATE INDEX IF NOT EXISTS chat_messages_project_artifact_idx
  ON public.chat_messages (artifact_id)
  WHERE message_type = 'artifact_card'
    AND artifact_type = 'Project'
    AND deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'projects'
      AND policyname = 'projects_select_shared_in_chat_thread'
  ) THEN
    CREATE POLICY projects_select_shared_in_chat_thread ON public.projects
      FOR SELECT USING (
        EXISTS (
          SELECT 1
          FROM public.chat_messages m
          JOIN public.chat_participants p ON p.thread_id = m.thread_id
          WHERE m.message_type = 'artifact_card'
            AND m.artifact_type = 'Project'
            AND m.artifact_id = projects.id::text
            AND m.deleted_at IS NULL
            -- Only the project owner's OWN attach grants access (anti-escalation).
            AND m.sender_user_id = projects.customer_profile_id
            -- Caller must be an active participant of that thread.
            AND p.user_id = auth.uid()
            AND p.left_at IS NULL
        )
      );
  END IF;
END $$;
