-- =============================================================================
-- Migration: Payments & Ledger Entries – canonical table schema
-- =============================================================================
-- Creates public.payments and public.ledger_entries as the authoritative
-- schema source for the FixUp payment lifecycle.
--
-- These tables are referenced by:
--   SupabasePaymentRepository  (src/lib/payments/repository)
--   SupabaseLedgerRepository   (src/lib/payments/ledger/repository)
--   api/stripe-webhook.ts      (service-role reconciliation)
--
-- Column names match the field mappings in the repository row-type
-- definitions exactly, so no translation layer is needed.
--
-- All statements use IF NOT EXISTS so the migration is idempotent and safe
-- to run on a database where the tables were created manually beforehand.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. PAYMENTS TABLE
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payments (
  -- App-generated primary key, e.g. "payment_job-123"
  id               text            PRIMARY KEY,

  -- Foreign key to public.jobs (text ID, not a Postgres FK for flexibility)
  job_id           text            NOT NULL,

  -- Payment lifecycle status. Mirrors the PaymentState union in coreTypes.ts.
  -- Allowed values: deposit_required | deposit_paid | in_escrow |
  --                 work_in_progress | release_pending | released |
  --                 disputed | refunded
  status           text            NOT NULL DEFAULT 'deposit_required',

  -- Agreed total amount in EUR (e.g. 2000.00)
  total_amount     numeric(12, 2)  NOT NULL DEFAULT 0,

  -- 25 % deposit portion of total_amount
  deposit_amount   numeric(12, 2)  NOT NULL DEFAULT 0,

  -- 75 % final portion of total_amount
  final_amount     numeric(12, 2)  NOT NULL DEFAULT 0,

  -- Stripe PaymentIntent ID (pi_*) or equivalent provider reference.
  -- NULL until the escrow has been created via the provider API.
  provider_ref     text,

  -- Stripe PaymentIntent client_secret.
  -- Used by the frontend Stripe.js flow to authorize the payment.
  -- NULL when not applicable or after the escrow is captured.
  client_secret    text,

  -- Unix timestamps in milliseconds (bigint, not timestamptz)
  created_at       bigint          NOT NULL,
  updated_at       bigint          NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2. PAYMENTS – indexes
-- ---------------------------------------------------------------------------

-- Fast lookup by job (primary read pattern for SupabasePaymentRepository)
CREATE INDEX IF NOT EXISTS idx_payments_job_id
  ON public.payments (job_id);

-- Fast lookup by Stripe PaymentIntent ID (stripe-webhook.ts reconciliation)
CREATE INDEX IF NOT EXISTS idx_payments_provider_ref
  ON public.payments (provider_ref)
  WHERE provider_ref IS NOT NULL;

-- Fast lookup by status (admin / finance queries)
CREATE INDEX IF NOT EXISTS idx_payments_status
  ON public.payments (status);

-- ---------------------------------------------------------------------------
-- 3. LEDGER ENTRIES TABLE
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ledger_entries (
  -- App-generated primary key, e.g. "ledger_payment_job-123_payout_1700000000"
  id           text            PRIMARY KEY,

  -- Foreign key to public.payments
  payment_id   text            NOT NULL,

  -- Foreign key to public.jobs (denormalised for query convenience)
  job_id       text            NOT NULL,

  -- Entry type. Mirrors LedgerEntryType in ledgerTypes.ts.
  -- Allowed values: escrow_created | deposit_paid | final_paid |
  --                 platform_fee | payout | refund |
  --                 dispute_hold | dispute_resolved_release | dispute_resolved_refund
  type         text            NOT NULL,

  -- Amount in EUR (always positive; the entry type conveys the direction)
  amount       numeric(12, 2)  NOT NULL,

  -- ISO currency code. Always 'EUR' in the current implementation.
  currency     text            NOT NULL DEFAULT 'EUR',

  -- Unix timestamp in milliseconds
  created_at   bigint          NOT NULL,

  -- Optional human-readable note for the entry, e.g. "Auszahlung an Betrieb"
  note         text,

  -- Dispute ID for dispute-related entries (dispute_hold, dispute_resolved_*)
  dispute_id   text
);

-- ---------------------------------------------------------------------------
-- 4. LEDGER ENTRIES – indexes
-- ---------------------------------------------------------------------------

-- Fast lookup by payment (primary read pattern, getForPayment)
CREATE INDEX IF NOT EXISTS idx_ledger_entries_payment_id
  ON public.ledger_entries (payment_id);

-- Fast lookup by job (getForJob, used by UI selectors)
CREATE INDEX IF NOT EXISTS idx_ledger_entries_job_id
  ON public.ledger_entries (job_id);

-- Fast lookup by type (finance KPI queries)
CREATE INDEX IF NOT EXISTS idx_ledger_entries_type
  ON public.ledger_entries (type);

-- Fast lookup by dispute (dispute resolution queries)
CREATE INDEX IF NOT EXISTS idx_ledger_entries_dispute_id
  ON public.ledger_entries (dispute_id)
  WHERE dispute_id IS NOT NULL;
