-- =====================================================================
-- Stripe Webhook Events — Party-Read RLS + job_id Index + Write-REVOKE
-- =====================================================================
-- Block N13.RLS — closes the live-data gap where the Reconciliation
-- Detail's "Stripe-Statushistorie" block always renders empty for
-- end-users.
--
-- Root cause:
--   `stripe_webhook_events` has RLS ENABLED (since
--   20240102000000_stripe_webhook_events.sql) but ZERO policies.
--   Default-deny → every authenticated SELECT returns 0 rows.
--   Service-role inserts (Stripe webhook handler) bypass RLS.
--
-- Pre-deploy schema verification (against prod via MCP, 2026-05-03):
--   • RLS enabled, 0 policies                    ✅ confirmed gap
--   • table currently empty (0 rows)             ✅ no migration risk
--   • indices: payment_intent_id, processed_at,  ✅ no job_id index
--     event_id (unique), processing_status
--   • column types: job_id is TEXT, jobs.id UUID → cast required
--   • operator check: profiles.is_operator       ✅ matches existing
--     dispute_select_own_side policy pattern
--
-- Pattern source: dispute_history_select_own_side
--   (20260429000001_dispute_alignment_v2.sql:180+)
-- =====================================================================

-- 1) SELECT policy — job parties (customer + provider owner +
--    assigned-provider owner) can read events tied to their job;
--    operators can read everything.
CREATE POLICY stripe_webhook_events_select_party
  ON public.stripe_webhook_events
  FOR SELECT
  TO authenticated
  USING (
    job_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.jobs j
        WHERE j.id::text = stripe_webhook_events.job_id
          AND (
            j.customer_user_id = auth.uid()
            OR j.provider_id IN (
              SELECT pr.id FROM public.providers pr
              WHERE pr.profile_id = auth.uid()
            )
            OR j.assigned_provider_id IN (
              SELECT pr.id FROM public.providers pr
              WHERE pr.profile_id = auth.uid()
            )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = auth.uid()
          AND p.is_operator = true
      )
    )
  );

-- 2) Index for the loader filter (.eq('job_id', …)); the table is
--    write-heavy (every Stripe webhook event lands here) and the
--    loader is hit per Detail-Page render.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_job_id
  ON public.stripe_webhook_events (job_id)
  WHERE job_id IS NOT NULL;

-- 3) Defense-in-Depth — explicit REVOKE of write privileges from
--    anon + authenticated (RLS already blocks via default-deny on
--    INSERT/UPDATE/DELETE since no policies exist; this hardens
--    against accidental future policy additions and matches the
--    pattern used for company_code audit + invoice immutability).
--
--    Service-role and postgres roles retain full access (Stripe
--    webhook handler runs under service_role).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.stripe_webhook_events
  FROM anon, authenticated;

COMMENT ON POLICY stripe_webhook_events_select_party
  ON public.stripe_webhook_events IS
  'N13.RLS: Job parties (customer/provider/assigned-provider) and '
  'operators can read webhook events tied to their job. Other '
  'authenticated users see []. Service-role bypasses RLS for inserts.';
