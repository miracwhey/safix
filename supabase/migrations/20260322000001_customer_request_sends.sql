-- Customer request send tracking
--
-- Records each request a customer sends to a provider.  Used to enforce a
-- daily send limit (currently 3 per day).
--
-- Columns:
--   id           – auto-increment primary key
--   user_id      – the customer's auth uid (references auth.users)
--   provider_id  – the provider/craftsman uid the request was sent to
--   sent_date    – calendar date (not timestamp) for easy daily grouping
--   created_at   – full timestamp for auditing

CREATE TABLE IF NOT EXISTS customer_request_sends (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID NOT NULL,
  provider_id UUID NOT NULL,
  sent_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the daily-count query: WHERE user_id = ? AND sent_date = ?
CREATE INDEX IF NOT EXISTS idx_customer_request_sends_user_date
  ON customer_request_sends (user_id, sent_date);

-- RLS: customers can only read/insert their own rows.
ALTER TABLE customer_request_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_request_sends_select
  ON customer_request_sends FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY customer_request_sends_insert
  ON customer_request_sends FOR INSERT
  WITH CHECK (auth.uid() = user_id);
