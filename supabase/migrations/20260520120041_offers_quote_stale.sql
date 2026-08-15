-- Spatial Canonical · Phase 3 · Block 3.9 · QUOTE-STALE Data Model
--
-- Purpose:
--   The Re-Quote-Trigger (VF-2) needs a way to mark an existing pending offer
--   as "stale" when the customer significantly changes the scan basis AFTER
--   the offer was sent. Verify-Flow-Implementation-Spec §4 ("QUOTE-STALE Data
--   Model") locks the field shape.
--
--   A stale offer is NOT `superseded` (that is a fresh provider quote) and NOT
--   `expired` (time lapse). It stays formally `pending` — the customer could
--   still accept it — but is flagged so the provider sees their quote rests on
--   an out-of-date scan. Hence dedicated columns, NOT a new `status` value.
--
-- Columns (additive · NULLABLE / DEFAULT false — passive migration):
--   is_stale              boolean NOT NULL DEFAULT false
--   stale_reason          text NULL  CHECK in (measurement_changed,
--                                              high_severity_pin_added,
--                                              layout_changed)
--   stale_marked_at       timestamptz NULL
--   stale_source_scene_id uuid NULL references spatial_scenes(id)
--
-- Why passive (no extra confirm · CLAUDE.md "Passive steps · schema migrations"):
--   every column is additive with a safe default; no column dropped, no shipped
--   column altered, no backfill. RLS on `offers` is unchanged — `is_stale`
--   writes from the customer-verify workflow must route through a SECURITY
--   DEFINER RPC (a customer may not write a provider's offer columns directly).
--   That RPC is an ACTIVE step and is intentionally NOT created here — Phase 3
--   runs InMemory; the RPC lands with the Phase-5 wiring.
--
-- NOT applied to prod in Phase 3 — Phase 1-4 run on the InMemory repository.
--   Numbered into the canonical sequence for the Phase-5-Apply step.
--
-- Plan reference: spatial-v1-verify-flow-implementation-spec.md §4 / §3.9.

-- ── Columns ──────────────────────────────────────────────────────────────────

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS is_stale              boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stale_reason          text        NULL,
  ADD COLUMN IF NOT EXISTS stale_marked_at       timestamptz NULL,
  ADD COLUMN IF NOT EXISTS stale_source_scene_id uuid        NULL;

-- stale_reason is constrained to the three VF-2 trigger reasons.
ALTER TABLE public.offers
  DROP CONSTRAINT IF EXISTS offers_stale_reason_chk;
ALTER TABLE public.offers
  ADD  CONSTRAINT offers_stale_reason_chk
    CHECK (stale_reason IS NULL
           OR stale_reason IN ('measurement_changed',
                               'high_severity_pin_added',
                               'layout_changed'));

-- A stale offer must carry its reason + timestamp; a non-stale offer must not.
-- This keeps the four columns internally consistent regardless of write path.
ALTER TABLE public.offers
  DROP CONSTRAINT IF EXISTS offers_stale_consistency_chk;
ALTER TABLE public.offers
  ADD  CONSTRAINT offers_stale_consistency_chk
    CHECK (
      (is_stale = false
        AND stale_reason IS NULL
        AND stale_marked_at IS NULL)
      OR
      (is_stale = true
        AND stale_reason IS NOT NULL
        AND stale_marked_at IS NOT NULL)
    );

-- FK to the scene whose change triggered the stale flag (audit / provider
-- diff-link). ON DELETE SET NULL — deleting a scene must not block offer rows.
ALTER TABLE public.offers
  DROP CONSTRAINT IF EXISTS offers_stale_source_scene_id_fkey;
ALTER TABLE public.offers
  ADD  CONSTRAINT offers_stale_source_scene_id_fkey
    FOREIGN KEY (stale_source_scene_id)
    REFERENCES public.spatial_scenes(id)
    ON DELETE SET NULL;

-- Partial index — the provider quote-list filters on `is_stale = true`.
CREATE INDEX IF NOT EXISTS offers_is_stale_idx
  ON public.offers(is_stale)
  WHERE is_stale = true;

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.offers.is_stale IS
  'QUOTE-STALE (Verify-Flow §4): the scan basis was significantly changed by '
  'the customer after this offer was sent (VF-2 threshold). Offer stays '
  'formally pending; only pending offers are ever marked stale.';

COMMENT ON COLUMN public.offers.stale_reason IS
  'QUOTE-STALE: why the offer was marked stale — measurement_changed | '
  'high_severity_pin_added | layout_changed. NULL iff is_stale = false.';

COMMENT ON COLUMN public.offers.stale_marked_at IS
  'QUOTE-STALE: timestamp the offer was marked stale. NULL iff is_stale = false.';

COMMENT ON COLUMN public.offers.stale_source_scene_id IS
  'QUOTE-STALE: spatial_scenes.id whose customer-verify change triggered the '
  'stale flag. Audit + provider diff-link. ON DELETE SET NULL.';

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.offers_is_stale_idx;
-- ALTER TABLE public.offers
--   DROP CONSTRAINT IF EXISTS offers_stale_source_scene_id_fkey,
--   DROP CONSTRAINT IF EXISTS offers_stale_consistency_chk,
--   DROP CONSTRAINT IF EXISTS offers_stale_reason_chk,
--   DROP COLUMN IF EXISTS stale_source_scene_id,
--   DROP COLUMN IF EXISTS stale_marked_at,
--   DROP COLUMN IF EXISTS stale_reason,
--   DROP COLUMN IF EXISTS is_stale;
