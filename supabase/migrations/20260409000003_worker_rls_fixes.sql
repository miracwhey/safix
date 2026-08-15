-- Worker RLS fixes: jobs read access + message_thread_participants recursion
--
-- Fix 1: Allow workers (team_members) to SELECT jobs for their provider.
--   Previous policies only allowed customer_user_id or provider owners.
--   Workers have no providers row — they must be granted via team membership.
--
-- Fix 2: Rewrite mtp_select to break the circular dependency between
--   message_thread_participants ↔ message_threads RLS policies.
--   The old policy referenced message_threads which referenced
--   message_thread_participants → infinite recursion.

-- ── Fix 1: Jobs read access for workers ──────────────────────────────────────

CREATE POLICY "Jobs: read own team member"
  ON jobs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.provider_id = jobs.provider_id
        AND tm.profile_id = auth.uid()
        AND tm.is_active = true
    )
  );

-- ── Fix 2: message_thread_participants — break recursive RLS cycle ────────────

DROP POLICY IF EXISTS "mtp_select" ON message_thread_participants;

CREATE POLICY "mtp_select" ON message_thread_participants FOR SELECT
  USING (
    -- Worker: own participant row via team_members (no cross-table cycle)
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE (tm.id)::text = message_thread_participants.team_member_id
        AND tm.profile_id = auth.uid()
    )
    OR
    -- Owner: all participants for their company's threads
    EXISTS (
      SELECT 1 FROM message_threads mt
      JOIN providers p ON p.id = mt.provider_id
      WHERE mt.id = message_thread_participants.thread_id
        AND p.profile_id = auth.uid()
    )
  );
