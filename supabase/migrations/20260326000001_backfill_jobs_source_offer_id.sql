-- ============================================================================
-- Migration: Backfill jobs.source_offer_id from offers.created_job_id
-- ============================================================================
--
-- ROOT CAUSE:
-- When a job was created via inquiry conversion BEFORE an offer was accepted,
-- the acceptOfferWorkflow linked offer.created_job_id → job.id but did NOT
-- set job.source_offer_id back to the offer.  This left accepted jobs without
-- the reverse link, causing the escrow plan recovery path to dead-end with:
--   "Angebotszuordnung (source_offer_id) fehlt"
--
-- STRATEGY:
-- Use the strongest canonical mapping: offers.created_job_id = jobs.id
-- Only backfill where:
--   1. job.source_offer_id IS NULL (missing linkage)
--   2. offer.status = 'accepted' (only accepted offers create jobs)
--   3. offer.created_job_id = jobs.id (canonical reverse link)
--   4. Exactly ONE accepted offer points to the job (no ambiguity)
--
-- SAFETY:
-- - Idempotent: re-running this migration is a no-op (WHERE source_offer_id IS NULL)
-- - No duplicate creation: only updates existing rows
-- - No ambiguous recovery: subquery ensures exactly one matching offer
-- - Preserves existing valid linkage: only touches NULL source_offer_id
-- ============================================================================

UPDATE jobs
SET    source_offer_id = (
         SELECT o.id
         FROM   offers o
         WHERE  o.created_job_id = jobs.id
           AND  o.status = 'accepted'
       ),
       updated_at = now()
WHERE  source_offer_id IS NULL
  AND  (
         SELECT count(*)
         FROM   offers o
         WHERE  o.created_job_id = jobs.id
           AND  o.status = 'accepted'
       ) = 1;
