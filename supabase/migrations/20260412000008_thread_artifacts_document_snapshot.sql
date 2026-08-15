-- Migration: thread_artifacts — Add commercial document snapshot fields
--
-- Adds three snapshot columns so offer artifact cards can render the
-- correct document type, version, and validity without loading the full
-- Offer entity from the offer repository.
--
-- snapshot_document_type  — 'binding_offer' | 'estimate' | 'diagnosis'
-- snapshot_version        — offer version integer (1, 2, …)
-- snapshot_valid_until    — ISO-8601 date string (e.g. '2026-04-30')

ALTER TABLE thread_artifacts
  ADD COLUMN IF NOT EXISTS snapshot_document_type TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_version       INTEGER,
  ADD COLUMN IF NOT EXISTS snapshot_valid_until   TEXT;

-- Back-fill existing offer artifact rows from the offers table.
-- Rows without a matching offer row remain NULL (safe default: treated
-- as 'binding_offer' / version 1 / no validity in the client).
UPDATE thread_artifacts ta
SET
  snapshot_document_type = o.document_type,
  snapshot_version       = o.version,
  snapshot_valid_until   = o.valid_until
FROM offers o
WHERE ta.artifact_type = 'offer'
  AND ta.offer_id = o.id
  AND ta.snapshot_document_type IS NULL;
