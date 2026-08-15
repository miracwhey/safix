-- ---------------------------------------------------------------------------
-- Final Audit Fix: Dispute evidence cross-party read + operator write access
--
-- Problem A (Bug #3b — CRITICAL):
--   The media_uploads SELECT policy `media_uploads_select_own` only allows a
--   user to read their own uploads (owner_user_id = auth.uid()).  This blocks
--   the other party and the operator from viewing dispute evidence, making the
--   dispute evidence review system structurally broken.
--
-- Fix A: Replace the single-owner SELECT policy with one that also grants
--   read access to dispute evidence for all participants of the dispute's
--   underlying job (craftsman, customer, and operator).
--
-- Problem B (Bug #6 — HIGH):
--   The disputes UPDATE policy `disputes_update_own` has no operator bypass.
--   An operator attempting to advance a dispute through review stages has their
--   Supabase UPDATE silently rejected when their account is not the craftsman
--   or customer on the job.  The in-memory state advances but the DB retains
--   the old status, so all operator actions are lost on reload.
--
-- Fix B: Replace the `disputes_update_own` policy with one that also allows
--   updates from profiles where is_operator = true.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. Widen media_uploads SELECT for dispute evidence
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS media_uploads_select_own ON public.media_uploads;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'media_uploads'
      AND policyname = 'media_uploads_select_participant'
  ) THEN
    CREATE POLICY media_uploads_select_participant ON public.media_uploads
      FOR SELECT USING (
        -- Own uploads are always readable
        owner_user_id = auth.uid()::text
        OR
        -- Dispute evidence is readable by all parties to the dispute's job
        -- (the uploader, the counterparty, and the operator reviewing the case)
        (
          entity_type = 'dispute'
          AND entity_id IN (
            SELECT d.id
            FROM   public.disputes d
            JOIN   public.jobs     j ON j.id = d.job_id
            WHERE  d.raised_by        = auth.uid()::text
               OR  j.craftsman_user_id = auth.uid()::text
               OR  j.customer_user_id  = auth.uid()::text
               OR  EXISTS (
                     SELECT 1 FROM public.profiles p
                     WHERE p.id = auth.uid()::text AND p.is_operator = true
                   )
          )
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- B. Add operator bypass to disputes UPDATE policy
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS disputes_update_own ON public.disputes;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'disputes'
      AND policyname = 'disputes_update_own'
  ) THEN
    CREATE POLICY disputes_update_own ON public.disputes
      FOR UPDATE USING (
        raised_by = auth.uid()::text
        OR job_id IN (
          SELECT id FROM public.jobs
          WHERE craftsman_user_id = auth.uid()::text
             OR customer_user_id  = auth.uid()::text
        )
        OR EXISTS (
          SELECT 1 FROM public.profiles
          WHERE id = auth.uid()::text AND is_operator = true
        )
      );
  END IF;
END $$;
