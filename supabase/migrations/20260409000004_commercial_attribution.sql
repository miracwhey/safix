-- Commercial Attribution Model
--
-- Establishes the three-layer commercial attribution model:
--   Layer 2 (this table)  — customer↔craftsman commercial relationship
--   Layer 3 (columns below) — per-job/project explicit commercial origin copy
--
-- The UNIQUE constraint on (customer_user_id, craftsman_user_id) enforces that
-- commercial_origin is written once per pair and never silently overridden.
-- First write wins. This makes take-rate classification tamper-resistant.

-- ────────────────────────────────────────────────────────────────────────────
-- Layer 2: durable commercial relationship table
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_provider_relationships (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Supabase auth.users UUID of the customer.
  customer_user_id  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Supabase auth.users UUID of the craftsman/company owner.
  -- Consistent with jobs.craftsman_user_id, conversations.craftsman_user_id,
  -- and ratings.provider_user_id — no join to providers table required.
  craftsman_user_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The durable commercial origin that drives fee/commission logic.
  --   merchant_brought  — craftsman brought this customer into FixUp (5% fee)
  --   platform_acquired — FixUp acquired this customer organically (9% fee)
  -- Never changed after the first write for this pair.
  commercial_origin TEXT        NOT NULL
    CHECK (commercial_origin IN ('merchant_brought', 'platform_acquired')),

  -- Context detail about how the relationship was established.
  -- Audit-only. Does NOT override commercial_origin.
  --   invite        — craftsman sent an invite link (guided_entry path='invited')
  --   reel          — customer discovered craftsman via an Explore reel
  --   search        — customer found craftsman via category/text search or profile browse
  --   referral      — customer was referred by another user
  --   manual_import — craftsman imported an existing customer manually
  --   unknown       — origin not determinable at relationship creation time
  origin_context    TEXT
    CHECK (origin_context IN ('invite', 'reel', 'search', 'referral', 'manual_import', 'unknown')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One record per unique customer↔craftsman pair. First write wins.
  -- Prevents silent commercial_origin overrides via duplicate inserts.
  CONSTRAINT customer_provider_relationships_unique
    UNIQUE (customer_user_id, craftsman_user_id)
);

-- Indexes for the two canonical lookup patterns
CREATE INDEX IF NOT EXISTS idx_cpr_customer
  ON customer_provider_relationships (customer_user_id);

CREATE INDEX IF NOT EXISTS idx_cpr_craftsman
  ON customer_provider_relationships (craftsman_user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE customer_provider_relationships ENABLE ROW LEVEL SECURITY;

-- Craftsman can read relationships where they are the craftsman.
CREATE POLICY "craftsman_read_own_relationships"
  ON customer_provider_relationships
  FOR SELECT
  USING (craftsman_user_id = auth.uid());

-- Customer can read their own relationships.
CREATE POLICY "customer_read_own_relationships"
  ON customer_provider_relationships
  FOR SELECT
  USING (customer_user_id = auth.uid());

-- Authenticated users may insert new relationship records.
-- Application logic controls what is inserted (inference + ON CONFLICT DO NOTHING).
CREATE POLICY "authenticated_insert_relationships"
  ON customer_provider_relationships
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ────────────────────────────────────────────────────────────────────────────
-- Layer 3: explicit commercial origin copy on jobs and projects
--
-- Stamped at job/project creation from the layer-2 relationship lookup.
-- Stripe/fee logic reads this column — it never re-infers from mutable state.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS commercial_origin TEXT
    CHECK (commercial_origin IN ('merchant_brought', 'platform_acquired'));

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS commercial_origin TEXT
    CHECK (commercial_origin IN ('merchant_brought', 'platform_acquired'));

CREATE INDEX IF NOT EXISTS idx_jobs_commercial_origin
  ON jobs (commercial_origin)
  WHERE commercial_origin IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_commercial_origin
  ON projects (commercial_origin)
  WHERE commercial_origin IS NOT NULL;
