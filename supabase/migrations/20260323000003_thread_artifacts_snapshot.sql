-- ============================================================================
-- Migration: thread_artifacts snapshot hardening
-- ============================================================================
--
-- Adds minimal display snapshot columns to the thread_artifacts table so
-- that business-card rendering in the thread screen does not depend on
-- secondary repository hydration timing.
--
-- Before this migration, the thread card was only visible once the separate
-- project/offer/job/payment repository had loaded the referenced entity.
-- After this migration, the card renders immediately from snapshot data
-- stored in the artifact row itself.
--
-- ── New Columns ───────────────────────────────────────────────────────────

ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS snapshot_title       TEXT;
ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS snapshot_status      TEXT;
ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS snapshot_price       TEXT;
ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS snapshot_summary     TEXT;
ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS snapshot_phase_label TEXT;

-- ── Backfill: Project artifact snapshots from projects table ──────────────
-- Populate snapshot_title and snapshot_status for existing project artifacts
-- from the canonical projects table.

UPDATE thread_artifacts ta
SET
  snapshot_title  = p.title,
  snapshot_status = p.status
FROM projects p
WHERE ta.artifact_type = 'project'
  AND ta.project_id = p.id
  AND ta.snapshot_title IS NULL;

-- ── Backfill: Offer artifact snapshots from offers table ──────────────────
-- Populate snapshot_price and snapshot_phase_label for existing offer
-- artifacts from the canonical offers table.

UPDATE thread_artifacts ta
SET
  snapshot_price       = o.price,
  snapshot_summary     = o.description,
  snapshot_phase_label = CASE
    WHEN ta.phase = 'sent'     THEN 'Angebot liegt vor'
    WHEN ta.phase = 'accepted' THEN 'Angebot angenommen'
    WHEN ta.phase = 'declined' THEN 'Angebot abgelehnt'
    WHEN ta.phase = 'payment_due' THEN 'Anzahlung fällig'
    ELSE 'Angebot liegt vor'
  END
FROM offers o
WHERE ta.artifact_type = 'offer'
  AND ta.offer_id = o.id
  AND ta.snapshot_price IS NULL;
