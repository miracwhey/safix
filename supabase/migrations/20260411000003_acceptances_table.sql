-- =============================================================================
-- Migration: acceptances — Abnahme as first-class domain entity (Block 1)
-- =============================================================================
-- Creates the `acceptances` table as the canonical persisted record of a
-- customer's formal decision to accept completed work.
--
-- Domain role:
--   Acceptance is the Abnahme object. It is NOT a job status flag and NOT
--   a UI card. It is the authoritative record that a customer has confirmed
--   work completion and explicitly released payment.
--
-- Reference chain:
--   Offer (Angebot) → Job (Auftrag) → Acceptance (Abnahme) → Payment (released)
--
-- RLS policy:
--   - Customer: can read own acceptances (customer_user_id = auth.uid())
--   - Craftsman: can read acceptances for their jobs (via job ownership)
--   - Insert/update: customer only
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.acceptances (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid          NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  payment_id        uuid          REFERENCES public.payments(id) ON DELETE SET NULL,
  source_offer_id   uuid          REFERENCES public.offers(id) ON DELETE SET NULL,
  customer_user_id  uuid          NOT NULL,
  status            text          NOT NULL DEFAULT 'pending',
  accepted_at       bigint,
  notes             text,
  created_at        bigint        NOT NULL,
  updated_at        bigint        NOT NULL
);

COMMENT ON TABLE public.acceptances IS
  'Canonical Abnahme record. Created when a customer formally accepts completed '
  'work and releases payment. One per job in terminal state. '
  'Created by: customerReleasePaymentWorkflow.';

COMMENT ON COLUMN public.acceptances.job_id IS
  'FK to jobs.id — the job whose completion this acceptance decision relates to.';
COMMENT ON COLUMN public.acceptances.payment_id IS
  'FK to payments.id — the payment released as part of this acceptance. '
  'May be null if payment record not yet synced at acceptance creation time.';
COMMENT ON COLUMN public.acceptances.source_offer_id IS
  'FK to offers.id — the accepted Offer that was the commercial basis for the job. '
  'Copied from job.source_offer_id at acceptance creation time.';
COMMENT ON COLUMN public.acceptances.status IS
  'pending | accepted | disputed';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_acceptances_job_id
  ON public.acceptances (job_id);

CREATE INDEX IF NOT EXISTS idx_acceptances_customer_user_id
  ON public.acceptances (customer_user_id);

-- Unique constraint: at most one non-disputed acceptance per job
CREATE UNIQUE INDEX IF NOT EXISTS uq_acceptances_job_accepted
  ON public.acceptances (job_id)
  WHERE status = 'accepted';

-- RLS
ALTER TABLE public.acceptances ENABLE ROW LEVEL SECURITY;

-- Customer can read and insert their own acceptances
CREATE POLICY "acceptances_customer_read"
  ON public.acceptances FOR SELECT
  USING (customer_user_id = auth.uid());

CREATE POLICY "acceptances_customer_insert"
  ON public.acceptances FOR INSERT
  WITH CHECK (customer_user_id = auth.uid());

CREATE POLICY "acceptances_customer_update"
  ON public.acceptances FOR UPDATE
  USING (customer_user_id = auth.uid());

-- Craftsman can read acceptances for jobs they own
-- (via craftsmanUserId on job — requires join; use a function-based policy)
CREATE POLICY "acceptances_craftsman_read"
  ON public.acceptances FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = acceptances.job_id
        AND j.craftsman_user_id = auth.uid()
    )
  );

-- Service role bypass (for server-side workflows)
CREATE POLICY "acceptances_service_all"
  ON public.acceptances
  USING (auth.role() = 'service_role');
