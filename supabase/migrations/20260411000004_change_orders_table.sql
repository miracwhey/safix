-- =============================================================================
-- Migration: change_orders — Nachtrag as first-class domain entity (Block 1)
-- =============================================================================
-- Creates the `change_orders` table as the canonical persisted record of a
-- commercial scope/price change to an existing Job.
--
-- Domain role:
--   ChangeOrder is the Nachtrag object. It is NOT a loose note, chat message,
--   or UI card. It is the authoritative commercial document for scope changes
--   after a Job has been accepted.
--
-- Reference chain:
--   Offer (original) → Job → ChangeOrder → (amended payment if accepted)
--
-- A Job may have multiple ChangeOrders (sequential or parallel).
-- Only accepted ChangeOrders affect the canonical payment amount.
--
-- RLS policy:
--   - Both customer and craftsman can read change orders for their jobs
--   - Craftsman can insert/update
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.change_orders (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid          NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  source_offer_id   uuid          REFERENCES public.offers(id) ON DELETE SET NULL,
  craftsman_user_id uuid          NOT NULL,
  customer_user_id  uuid          NOT NULL,
  description       text          NOT NULL,
  price             text          NOT NULL,
  currency          text,
  gross_total       bigint,
  net_total         bigint,
  vat_rate          numeric(5,2),
  status            text          NOT NULL DEFAULT 'draft',
  sent_at           bigint,
  accepted_at       bigint,
  declined_at       bigint,
  created_at        bigint        NOT NULL,
  updated_at        bigint        NOT NULL
);

COMMENT ON TABLE public.change_orders IS
  'Canonical Nachtrag record. Commercial change proposal for a Job that has '
  'already been accepted. Created by the craftsman; accepted/declined by the '
  'customer. Only accepted ChangeOrders update the canonical payment amount.';

COMMENT ON COLUMN public.change_orders.job_id IS
  'FK to jobs.id — the job this change order modifies.';
COMMENT ON COLUMN public.change_orders.source_offer_id IS
  'FK to offers.id — the original accepted Offer the job was based on. '
  'Used to compute cost delta: change_order.gross_total - offer.gross_total.';
COMMENT ON COLUMN public.change_orders.status IS
  'draft | pending | accepted | declined | cancelled';
COMMENT ON COLUMN public.change_orders.gross_total IS
  'Gross total of the change in minor units (cents). '
  'Positive = additional cost. Negative = credit/reduction.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_change_orders_job_id
  ON public.change_orders (job_id);

CREATE INDEX IF NOT EXISTS idx_change_orders_craftsman_user_id
  ON public.change_orders (craftsman_user_id);

CREATE INDEX IF NOT EXISTS idx_change_orders_customer_user_id
  ON public.change_orders (customer_user_id);

-- RLS
ALTER TABLE public.change_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "change_orders_craftsman_read"
  ON public.change_orders FOR SELECT
  USING (craftsman_user_id = auth.uid());

CREATE POLICY "change_orders_customer_read"
  ON public.change_orders FOR SELECT
  USING (customer_user_id = auth.uid());

CREATE POLICY "change_orders_craftsman_insert"
  ON public.change_orders FOR INSERT
  WITH CHECK (craftsman_user_id = auth.uid());

CREATE POLICY "change_orders_craftsman_update"
  ON public.change_orders FOR UPDATE
  USING (craftsman_user_id = auth.uid());

-- Customer can accept/decline (update status only) via service-role workflow
-- or direct policy; for now allow customer update for acceptance workflow
CREATE POLICY "change_orders_customer_update"
  ON public.change_orders FOR UPDATE
  USING (customer_user_id = auth.uid());

-- Service role bypass
CREATE POLICY "change_orders_service_all"
  ON public.change_orders
  USING (auth.role() = 'service_role');
