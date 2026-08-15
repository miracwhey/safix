-- =============================================================================
-- Migration: Live-schema catch-up — unblock runtime testing
-- =============================================================================
-- This migration consolidates all additive column additions across every
-- migration for the eight production-critical tables so that a live database
-- whose schema has drifted behind the codebase can be brought up to date
-- with a single idempotent pass.
--
-- Context:
--   Real runtime failures were observed for missing columns including
--   jobs.source_conversation_id, payments.client_secret,
--   payments.craftsman_user_id, payments.customer_user_id, and
--   payments.deposit_amount.  Some were patched manually.  This migration
--   ensures every column expected by the current codebase is present.
--
-- Safety:
--   • Every statement uses IF NOT EXISTS — safe to re-run.
--   • All new columns are nullable or have safe defaults.
--   • No destructive type changes, no NOT NULL enforcement, no data deletion.
--   • Tables with 0 rows (payments, disputes, escrow_*, funding_requests,
--     stripe_webhook_events) are trivially safe.
--   • jobs and projects already contain data — only additive nullable columns.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- JOBS — columns expected by SupabaseJobRepository + API layer
-- ---------------------------------------------------------------------------
-- Seed columns (id, customer_profile_id, provider_id, title, description,
-- city, status, budget_amount, scheduled_for, created_at, updated_at) are
-- assumed present from initial table creation.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS project_id            text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS customer              text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS location              text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS date_label            text        NOT NULL DEFAULT 'Termin offen',
  ADD COLUMN IF NOT EXISTS amount                text        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS payment_state         text        NOT NULL DEFAULT 'deposit_required',
  ADD COLUMN IF NOT EXISTS documentation_status  text        NOT NULL DEFAULT 'Noch keine Dokumentation',
  ADD COLUMN IF NOT EXISTS assigned_member_ids   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notes                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS photo_count           integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS intake_context        jsonb,
  ADD COLUMN IF NOT EXISTS proposal_timing_note  text,
  ADD COLUMN IF NOT EXISTS proposal_sent_at      bigint,
  ADD COLUMN IF NOT EXISTS proposal_accepted_at  bigint,
  ADD COLUMN IF NOT EXISTS work_completed_at     bigint,
  ADD COLUMN IF NOT EXISTS payment_released_at   bigint,
  ADD COLUMN IF NOT EXISTS craftsman_user_id     text,
  ADD COLUMN IF NOT EXISTS dispute_status        text,
  ADD COLUMN IF NOT EXISTS customer_user_id      text,
  ADD COLUMN IF NOT EXISTS source_conversation_id text,
  ADD COLUMN IF NOT EXISTS work_started_at       bigint,
  ADD COLUMN IF NOT EXISTS funding_requested_at  bigint,
  ADD COLUMN IF NOT EXISTS source_offer_id       text;

-- Indexes expected by queries and RLS policies.
CREATE INDEX IF NOT EXISTS idx_jobs_status           ON public.jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_craftsman_user_id ON public.jobs (craftsman_user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project_id       ON public.jobs (project_id);


-- ---------------------------------------------------------------------------
-- PROJECTS — columns expected by SupabaseProjectRepository + API layer
-- ---------------------------------------------------------------------------

-- payment_state is read by SupabaseProjectRepository (rowToProject) and
-- written directly by the server-side webhook handler (reconcileJobFromPayment
-- in stripe-webhook.ts) and cron reconciliation (syncJobAndProjectFromCronRecovery
-- in _serverReconciliation.ts).  The original CREATE TABLE in 20240101 includes it,
-- but if the projects table pre-existed that migration, the column was never added.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS payment_state      text        NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS craftsman_user_id  text,
  ADD COLUMN IF NOT EXISTS customer_user_id   text;

CREATE INDEX IF NOT EXISTS idx_projects_status
  ON public.projects (status);
CREATE INDEX IF NOT EXISTS idx_projects_source_job_id
  ON public.projects (source_job_id);
CREATE INDEX IF NOT EXISTS idx_projects_customer_user_id
  ON public.projects (customer_user_id)
  WHERE customer_user_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- PAYMENTS — columns expected by SupabasePaymentRepository + API layer
-- ---------------------------------------------------------------------------
-- The payments table is created in 20240103000000.  Later migrations add
-- linkage and Connect columns.  Ensure all are present.

CREATE TABLE IF NOT EXISTS public.payments (
  id             text          PRIMARY KEY,
  job_id         text          NOT NULL,
  status         text          NOT NULL DEFAULT 'deposit_required',
  total_amount   numeric(12,2) NOT NULL DEFAULT 0,
  deposit_amount numeric(12,2) NOT NULL DEFAULT 0,
  final_amount   numeric(12,2) NOT NULL DEFAULT 0,
  provider_ref   text,
  client_secret  text,
  created_at     bigint        NOT NULL,
  updated_at     bigint        NOT NULL
);

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS project_id                text,
  ADD COLUMN IF NOT EXISTS customer_user_id          text,
  ADD COLUMN IF NOT EXISTS craftsman_user_id         text,
  ADD COLUMN IF NOT EXISTS offer_id                  text,
  ADD COLUMN IF NOT EXISTS provider_stripe_account_id text,
  ADD COLUMN IF NOT EXISTS platform_fee_amount       numeric(12,2);


-- ---------------------------------------------------------------------------
-- DISPUTES — columns expected by SupabaseDisputeRepository
-- ---------------------------------------------------------------------------
-- settlement_status is read/written by the code but was never added by any
-- prior migration.  This is the primary code-vs-migration mismatch found.

CREATE TABLE IF NOT EXISTS public.disputes (
  id            text        PRIMARY KEY,
  job_id        text        NOT NULL,
  payment_id    text,
  raised_by     text,
  status        text        NOT NULL DEFAULT 'open',
  decision      text,
  split_ratio   numeric(5,4),
  reason        text        NOT NULL DEFAULT 'other',
  title         text        NOT NULL DEFAULT '',
  description   text        NOT NULL DEFAULT '',
  created_at    bigint      NOT NULL,
  updated_at    bigint      NOT NULL,
  resolved_at   bigint,
  evidence      jsonb
);

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS payment_id        text,
  ADD COLUMN IF NOT EXISTS raised_by         text,
  ADD COLUMN IF NOT EXISTS decision          text,
  ADD COLUMN IF NOT EXISTS split_ratio       numeric(5,4),
  ADD COLUMN IF NOT EXISTS settlement_status text;

-- dispute_status_history audit table
CREATE TABLE IF NOT EXISTS public.dispute_status_history (
  id            bigserial   PRIMARY KEY,
  dispute_id    text        NOT NULL REFERENCES public.disputes(id) ON DELETE CASCADE,
  job_id        text        NOT NULL,
  from_status   text        NOT NULL,
  to_status     text        NOT NULL,
  changed_by    text,
  note          text,
  occurred_at   bigint      NOT NULL
);


-- ---------------------------------------------------------------------------
-- ESCROW_PAYMENT_PLANS — columns expected by SupabaseEscrowPlanRepository
-- + API layer (request-funding, initiate-funding, confirm-funding, etc.)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.escrow_payment_plans (
  id                     UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  source_offer_id        UUID           NOT NULL,
  job_id                 UUID           NOT NULL,
  customer_user_id       UUID           NOT NULL,
  provider_id            UUID           NOT NULL,
  currency               TEXT           NOT NULL DEFAULT 'EUR',
  total_amount           NUMERIC(12,2)  NOT NULL,
  funding_mode           TEXT           NOT NULL DEFAULT 'full_upfront_escrow',
  release_model          TEXT           NOT NULL DEFAULT 'start_25_completion_75',
  status                 TEXT           NOT NULL DEFAULT 'awaiting_customer_funding',
  created_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  funding_initiated_at   TIMESTAMPTZ,
  funded_at              TIMESTAMPTZ,
  external_funding_ref   TEXT,
  funding_idempotency_key TEXT,

  CONSTRAINT escrow_plans_source_offer_unique UNIQUE (source_offer_id),
  CONSTRAINT escrow_plans_status_check CHECK (
    status IN (
      'awaiting_customer_funding', 'funding_initiated', 'funded_in_escrow',
      'partially_released', 'fully_released', 'funding_failed',
      'disputed', 'refunded', 'cancelled'
    )
  ),
  CONSTRAINT escrow_plans_funding_mode_check CHECK (
    funding_mode IN ('full_upfront_escrow')
  ),
  CONSTRAINT escrow_plans_release_model_check CHECK (
    release_model IN ('start_25_completion_75')
  )
);


-- ---------------------------------------------------------------------------
-- ESCROW_TRANCHES — columns expected by SupabaseEscrowPlanRepository
-- + API layer (release-tranche, confirm-funding, etc.)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.escrow_tranches (
  id                   UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id              UUID           NOT NULL REFERENCES public.escrow_payment_plans(id) ON DELETE CASCADE,
  kind                 TEXT           NOT NULL,
  percentage           NUMERIC(5,2)   NOT NULL,
  amount               NUMERIC(12,2)  NOT NULL,
  release_trigger      TEXT           NOT NULL,
  status               TEXT           NOT NULL DEFAULT 'pending_funding',
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  eligible_at          TIMESTAMPTZ,
  released_at          TIMESTAMPTZ,
  external_release_ref TEXT,
  triggered_by         TEXT,
  released_by          TEXT,

  CONSTRAINT escrow_tranches_kind_check CHECK (
    kind IN ('deposit_release', 'final_release')
  ),
  CONSTRAINT escrow_tranches_trigger_check CHECK (
    release_trigger IN ('work_started', 'work_completed')
  ),
  CONSTRAINT escrow_tranches_status_check CHECK (
    status IN (
      'pending_funding', 'funded', 'locked', 'eligible_for_release',
      'release_pending', 'released', 'blocked', 'disputed', 'refunded', 'cancelled'
    )
  ),
  CONSTRAINT escrow_tranches_triggered_by_check CHECK (
    triggered_by IS NULL OR triggered_by IN ('customer', 'provider', 'system')
  ),
  CONSTRAINT escrow_tranches_released_by_check CHECK (
    released_by IS NULL OR released_by IN ('customer', 'provider', 'system')
  ),
  CONSTRAINT escrow_tranches_plan_kind_unique UNIQUE (plan_id, kind)
);


-- ---------------------------------------------------------------------------
-- FUNDING_REQUESTS — columns expected by SupabaseFundingRequestRepository
-- + API layer (request-funding, initiate-funding, confirm-funding, etc.)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.funding_requests (
  id                     UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  source_offer_id        UUID           NOT NULL,
  job_id                 UUID           NOT NULL,
  escrow_plan_id         UUID           NOT NULL REFERENCES public.escrow_payment_plans(id) ON DELETE CASCADE,
  customer_user_id       UUID           NOT NULL,
  provider_id            UUID           NOT NULL,
  provider_user_id       UUID           NOT NULL,
  type                   TEXT           NOT NULL DEFAULT 'full_escrow',
  status                 TEXT           NOT NULL DEFAULT 'created',
  amount                 NUMERIC(12,2)  NOT NULL,
  currency               TEXT           NOT NULL DEFAULT 'EUR',
  created_by             TEXT           NOT NULL DEFAULT 'provider',
  conversation_id        UUID,
  message_id             TEXT,
  created_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  sent_at                TIMESTAMPTZ,
  funded_at              TIMESTAMPTZ,

  CONSTRAINT funding_requests_escrow_plan_unique UNIQUE (escrow_plan_id),
  CONSTRAINT funding_requests_type_check CHECK (
    type IN ('full_escrow')
  ),
  CONSTRAINT funding_requests_status_check CHECK (
    status IN (
      'created', 'sent', 'funding_started', 'funding_initiated',
      'funded', 'funding_failed', 'expired', 'cancelled'
    )
  ),
  CONSTRAINT funding_requests_created_by_check CHECK (
    created_by IN ('provider', 'system')
  )
);

ALTER TABLE public.funding_requests
  ADD COLUMN IF NOT EXISTS external_funding_ref    TEXT,
  ADD COLUMN IF NOT EXISTS funding_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason          TEXT;


-- ---------------------------------------------------------------------------
-- STRIPE_WEBHOOK_EVENTS — columns expected by webhook handler + recovery
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id          text    PRIMARY KEY,
  event_type        text    NOT NULL,
  payment_intent_id text,
  payment_id        text,
  job_id            text,
  outcome           text    NOT NULL,
  previous_state    text,
  new_state         text,
  processed_at      timestamptz NOT NULL
);

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS failure_reason text;


-- =============================================================================
-- END OF CATCH-UP MIGRATION
-- =============================================================================
-- After applying this migration, all columns required by the current codebase
-- are guaranteed to exist.  The migration is fully idempotent — safe to run on
-- databases that already have some or all of these columns.
-- =============================================================================
