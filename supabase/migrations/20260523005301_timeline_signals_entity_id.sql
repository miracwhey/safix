-- Timeline · entity_id propagation for push-deep-link routing
--
-- Purpose:
--   Closes the C-10 customer-facing push UX gap: `createOfferFromSpatialQuote`
--   fires `ensureTimelineEvent({ jobId, type: 'offer_sent' })`. The bridge
--   converts that into a `notification_signals` row, the dispatch trigger
--   (`notification_signals_dispatch_push` from migration
--   20260509000002) embeds `NEW.entity_id` as `data.entityId` in the push
--   payload, and the FE/edge route-map resolves a deep-link from it.
--
--   Today `timeline_signals` has no column to carry the entity id, so the
--   bridge has nothing to propagate and `notification_signals.entity_id`
--   stays NULL — meaning the customer push for `offer_sent` arrives
--   without a deep-link, breaking the canonical-offer customer experience.
--
--   This migration adds the timeline-side column. The bridge change
--   (TS-side) populates `notification_signals.entity_id` from it; the
--   trigger + edge-side pipeline are already in place.
--
-- Design:
--   - `entity_id text` — matches `notification_signals.entity_id` shape so
--     no per-domain casts are needed. Values are domain entity ids (e.g.
--     `offers.id` for `offer_sent`, but kept open so future event types
--     can reuse the same column without a schema change).
--   - Nullable + NULL default — additive, no backfill, existing rows stay
--     valid. Bridge only reads it when present.
--   - Partial index for lookups where entity_id is present (rare today,
--     reserved for future "find timeline events touching entity X" UI).
--
-- What this migration does NOT do (by design):
--   - No FK to a specific table. `entity_id` is poly-domain by event type.
--     Validation (existence, type alignment) lives in the workflow layer.
--   - No update to existing rows.
--   - No new RLS policy. The existing
--     `timeline_signals_select_own` policy already covers any caller who
--     can read a timeline row (per-job, derived from `jobs.customer_user_id`
--     or `providers.profile_id`).
--
-- Production state (verified read-only against prod 2026-05-23):
--   `timeline_signals` has 4 columns (id, job_id, type, occurred_at). No
--   entity_id. RLS enabled with `timeline_signals_select_own` +
--   `timeline_signals_insert_own`.
--
-- External steps:
--   None. Additive schema, no env vars, no edge-function changes here.
--
-- Plan reference: ~/.claude/plans/spatial-c10-done-handover.md (offer_sent
-- push-deep-link gap — converted to a build block 2026-05-23).

ALTER TABLE public.timeline_signals
  ADD COLUMN IF NOT EXISTS entity_id text;

COMMENT ON COLUMN public.timeline_signals.entity_id IS
  'Optional poly-domain entity reference (e.g. offers.id for offer_sent). '
  'Propagated to notification_signals.entity_id by the FE bridge, then to '
  'push payload data.entityId by notification_signals_dispatch_push, then '
  'to deep-link route templates by the FE/edge pushRouteMap.';

CREATE INDEX IF NOT EXISTS timeline_signals_entity_id_idx
  ON public.timeline_signals (entity_id)
  WHERE entity_id IS NOT NULL;
