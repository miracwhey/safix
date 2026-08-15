-- =============================================================================
-- Offers table — structured business object for the Conversation → Offer → Job
-- core loop.
--
-- An offer is a formal price proposal created by a craftsman within a
-- conversation thread. On acceptance, a Job is created and linked back.
--
-- Lifecycle: pending → accepted | declined
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.offers (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  craftsman_user_id TEXT NOT NULL,
  price           TEXT NOT NULL,
  description     TEXT,
  timing_note     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
  updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
  accepted_at     BIGINT,
  declined_at     BIGINT,
  created_job_id  TEXT
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Fast lookup of offers belonging to a conversation
CREATE INDEX IF NOT EXISTS idx_offers_conversation_id
  ON public.offers (conversation_id);

-- Fast lookup by craftsman or customer
CREATE INDEX IF NOT EXISTS idx_offers_craftsman_user_id
  ON public.offers (craftsman_user_id);

CREATE INDEX IF NOT EXISTS idx_offers_customer_user_id
  ON public.offers (customer_user_id);

-- ---------------------------------------------------------------------------
-- Duplicate-offer protection (DB-level constraint)
-- Only one pending offer per conversation is allowed at any time.
-- Partial unique index: enforced only when status = 'pending'.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_offers_one_pending_per_conversation
  ON public.offers (conversation_id)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;

-- Both parties (craftsman and customer) can view their own offers
CREATE POLICY offers_select_own ON public.offers
  FOR SELECT USING (
    auth.uid() = craftsman_user_id::uuid
    OR auth.uid() = customer_user_id::uuid
  );

-- Only the craftsman can create offers
CREATE POLICY offers_insert_craftsman ON public.offers
  FOR INSERT WITH CHECK (
    auth.uid() = craftsman_user_id::uuid
  );

-- Both parties can update (craftsman may edit, customer accepts/declines)
CREATE POLICY offers_update_own ON public.offers
  FOR UPDATE USING (
    auth.uid() = craftsman_user_id::uuid
    OR auth.uid() = customer_user_id::uuid
  );
