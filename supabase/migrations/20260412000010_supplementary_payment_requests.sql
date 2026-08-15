-- Supplementary Payment Requests
--
-- Created when a ChangeOrder (Nachtrag) is accepted but the original payment
-- amounts are already locked (deposit paid or beyond).  Carries the additional
-- payment obligation that arises from the accepted cost delta.
--
-- RLS policy:
--   - Customer can read/update (acknowledge) their own requests.
--   - Craftsman can read and update (mark paid / waived) their own requests.
--   - No direct inserts from client: inserts go through service role (edge functions).
--     In V1 the client side creates rows directly via the authenticated Supabase client
--     (same pattern as change_orders) — adjust when backend endpoints are in place.

CREATE TABLE IF NOT EXISTS supplementary_payment_requests (
  id                  UUID         PRIMARY KEY,
  change_order_id     UUID         NOT NULL REFERENCES change_orders(id) ON DELETE CASCADE,
  job_id              UUID         NOT NULL,
  original_payment_id UUID         NOT NULL,
  customer_user_id    TEXT         NOT NULL,
  craftsman_user_id   TEXT         NOT NULL,
  amount_cents        INTEGER      NOT NULL CHECK (amount_cents > 0),
  currency            TEXT         NOT NULL DEFAULT 'EUR',
  status              TEXT         NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'acknowledged', 'paid', 'waived')),
  acknowledged_at     BIGINT,
  paid_at             BIGINT,
  waived_at           BIGINT,
  external_ref        TEXT,
  created_at          BIGINT       NOT NULL,
  updated_at          BIGINT       NOT NULL
);

-- Unique constraint: at most one supplementary request per ChangeOrder
CREATE UNIQUE INDEX IF NOT EXISTS supplementary_payment_requests_change_order_id_key
  ON supplementary_payment_requests (change_order_id);

-- Index for job-level queries (list all supplementary payments for a job)
CREATE INDEX IF NOT EXISTS supplementary_payment_requests_job_id_idx
  ON supplementary_payment_requests (job_id);

-- Index for customer-scoped queries
CREATE INDEX IF NOT EXISTS supplementary_payment_requests_customer_idx
  ON supplementary_payment_requests (customer_user_id);

-- Index for craftsman-scoped queries
CREATE INDEX IF NOT EXISTS supplementary_payment_requests_craftsman_idx
  ON supplementary_payment_requests (craftsman_user_id);

-- ── Row Level Security ──────────────────────────────────────────────────────

ALTER TABLE supplementary_payment_requests ENABLE ROW LEVEL SECURITY;

-- Customers: read their own requests; update to acknowledge (status only)
CREATE POLICY "supplementary_payment_requests_customer_read"
  ON supplementary_payment_requests
  FOR SELECT
  USING (auth.uid()::text = customer_user_id);

CREATE POLICY "supplementary_payment_requests_customer_update"
  ON supplementary_payment_requests
  FOR UPDATE
  USING (auth.uid()::text = customer_user_id);

-- Craftsmen: read and update (mark paid / waived) their own requests
CREATE POLICY "supplementary_payment_requests_craftsman_read"
  ON supplementary_payment_requests
  FOR SELECT
  USING (auth.uid()::text = craftsman_user_id);

CREATE POLICY "supplementary_payment_requests_craftsman_update"
  ON supplementary_payment_requests
  FOR UPDATE
  USING (auth.uid()::text = craftsman_user_id);

-- Insert: both parties may create rows (V1 — client-side workflow creates the row
-- immediately on ChangeOrder acceptance; no separate backend endpoint yet)
CREATE POLICY "supplementary_payment_requests_insert"
  ON supplementary_payment_requests
  FOR INSERT
  WITH CHECK (
    auth.uid()::text = craftsman_user_id
    OR auth.uid()::text = customer_user_id
  );
