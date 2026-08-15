-- =============================================================================
-- Offer Reference — adds the human-readable offer reference column.
--
-- NOTE: offer_mode was already added by 20260411000005_offers_offer_mode.sql.
-- This migration only adds offer_ref (the ADD COLUMN IF NOT EXISTS for
-- offer_mode is safe but a no-op on a fresh DB with 20260411000005 applied).
--
-- offer_ref: human-readable offer reference, e.g. 'KV-2026-A3F2B1C9'.
--   Generated client-side at offer creation time.
-- =============================================================================

-- ── offer_mode (no-op if already added by 20260411000005) ────────────────────
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS offer_mode TEXT
    CHECK (offer_mode IN ('binding', 'estimate'));

-- ── offer_ref ────────────────────────────────────────────────────────────────
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS offer_ref TEXT;
