-- =============================================================================
-- Quote Domain Foundation — extends the offers table into a proper
-- Kostenvoranschlag / quote business object.
--
-- Adds:
--  • Structured price fields (gross/net/vat/labor/material/other)
--  • Scope & exclusion fields
--  • Conditions (payment terms, validity, cancellation)
--  • Context snapshots (project title, description, location)
--  • Versioning & locking timestamps
--  • Extended status values (draft, expired, superseded, cancelled)
--  • Line items (JSONB for future structured line-item support)
--
-- All new columns are nullable so existing rows remain valid.
-- =============================================================================

-- ── Expand status CHECK constraint ──────────────────────────────────────────
-- Drop old constraint and create a new one with the full status set.
ALTER TABLE public.offers DROP CONSTRAINT IF EXISTS offers_status_check;
ALTER TABLE public.offers
  ADD CONSTRAINT offers_status_check
  CHECK (status IN ('draft', 'pending', 'accepted', 'declined', 'expired', 'superseded', 'cancelled'));

-- ── Price structure ─────────────────────────────────────────────────────────
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS currency        TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS gross_total     BIGINT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS net_total       BIGINT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS vat_amount      BIGINT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS vat_rate        INTEGER;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS labor_cost      BIGINT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS material_cost   BIGINT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS other_cost      BIGINT;

-- ── Scope & exclusions ──────────────────────────────────────────────────────
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS scope_summary   TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS scope_included  TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS scope_excluded  TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS assumptions     TEXT;

-- ── Conditions ──────────────────────────────────────────────────────────────
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS payment_terms          TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS valid_until            TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS cancellation_terms     TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS escrow_required        BOOLEAN;

-- ── Context snapshots ───────────────────────────────────────────────────────
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS project_title_snapshot          TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS customer_description_snapshot   TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS location_snapshot               TEXT;

-- ── Versioning & notes ──────────────────────────────────────────────────────
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS version     INTEGER DEFAULT 1;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS notes       TEXT;
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS locked_at   BIGINT;

-- ── Project linkage ─────────────────────────────────────────────────────────
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS project_id  TEXT;

-- ── Line items (JSONB for future structured data) ───────────────────────────
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS line_items  JSONB;
