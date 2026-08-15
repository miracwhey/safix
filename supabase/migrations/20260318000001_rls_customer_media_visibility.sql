-- ---------------------------------------------------------------------------
-- AppStore Readiness: Customer media visibility fixes
--
-- Problem A — media_artifacts customer blind spot:
--   `media_artifacts_select_own` only grants SELECT access via the
--   craftsman_user_id path.  Customers have zero access to job artifacts
--   (progress photos, completion photos) uploaded by their craftsman.
--   CustomerProjectDetailScreen and CustomerWorkProofSummaryCard always
--   render empty for customers in production.
--
-- Fix A: Replace the policy so customers (via jobs.customer_user_id) can
--   also read artifacts belonging to their jobs.
--
-- Problem B — media_uploads counterparty blind spot:
--   `media_uploads_select_participant` (migration 20260317000010) only
--   widens access for entity_type='dispute'.  For entity_type='job' and
--   entity_type='project', the SELECT path is restricted to the file owner
--   (owner_user_id = auth.uid()).  The counterparty (customer viewing
--   craftsman job photos, or vice versa) cannot query these DB rows.
--   Since the storage bucket is public, direct URL renders succeed, but
--   any DB-driven media grid returns empty for the counterparty.
--
-- Fix B: Extend media_uploads_select_participant to also grant job/project
--   entity media access to all participants on the underlying job.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. Widen media_artifacts SELECT to include customers
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS media_artifacts_select_own ON public.media_artifacts;

CREATE POLICY media_artifacts_select_participant ON public.media_artifacts
  FOR SELECT USING (
    -- Direct job ownership (craftsman or customer)
    (job_id IS NOT NULL AND job_id IN (
      SELECT id FROM public.jobs
      WHERE craftsman_user_id = auth.uid()::text
         OR customer_user_id  = auth.uid()::text
    ))
    -- Dispute-linked artifacts: accessible to all dispute participants
    OR (dispute_id IS NOT NULL AND dispute_id IN (
      SELECT d.id
      FROM   public.disputes d
      JOIN   public.jobs     j ON j.id = d.job_id
      WHERE  d.raised_by          = auth.uid()::text
         OR  j.craftsman_user_id  = auth.uid()::text
         OR  j.customer_user_id   = auth.uid()::text
    ))
  );

-- ---------------------------------------------------------------------------
-- B. Extend media_uploads SELECT for job/project counterparty access
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS media_uploads_select_participant ON public.media_uploads;

CREATE POLICY media_uploads_select_participant ON public.media_uploads
  FOR SELECT USING (
    -- Own uploads are always readable
    owner_user_id = auth.uid()::text
    OR
    -- Job media is readable by all participants on the underlying job
    (
      entity_type = 'job'
      AND entity_id IN (
        SELECT id FROM public.jobs
        WHERE craftsman_user_id = auth.uid()::text
           OR customer_user_id  = auth.uid()::text
      )
    )
    OR
    -- Project media is readable by all participants on the underlying job
    (
      entity_type = 'project'
      AND entity_id IN (
        SELECT project_id FROM public.jobs
        WHERE craftsman_user_id = auth.uid()::text
           OR customer_user_id  = auth.uid()::text
      )
    )
    OR
    -- Dispute evidence is readable by all parties to the dispute's job
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
