-- Explicit WITH CHECK for calendar_entries_owner_update.
-- The original migration (20260408000002) omitted WITH CHECK, so PostgreSQL
-- applied the implicit default: the post-update row is re-evaluated against
-- the USING predicate.  Sending all fields via replace() — including
-- provider_id — caused permanent PGRST301/42501 rejections whenever the
-- post-update row did not satisfy the USING condition, producing an
-- unrecoverable SyncStatusBar banner on every app resume.
-- This migration makes WITH CHECK explicit and identical to USING, which is
-- the semantically correct policy for an owner-scoped status update.
DROP POLICY IF EXISTS calendar_entries_owner_update ON public.calendar_entries;
CREATE POLICY calendar_entries_owner_update ON public.calendar_entries
  FOR UPDATE
  USING (
    (provider_id IS NOT NULL AND provider_id IN (SELECT id FROM providers WHERE profile_id = auth.uid()))
    OR (provider_id IS NULL AND job_id IN (SELECT id FROM jobs WHERE craftsman_user_id = auth.uid()::text))
  )
  WITH CHECK (
    (provider_id IS NOT NULL AND provider_id IN (SELECT id FROM providers WHERE profile_id = auth.uid()))
    OR (provider_id IS NULL AND job_id IN (SELECT id FROM jobs WHERE craftsman_user_id = auth.uid()::text))
  );
