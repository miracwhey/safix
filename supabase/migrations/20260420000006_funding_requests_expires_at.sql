-- Migration: add expires_at column to funding_requests
-- Stores the Unix timestamp (ms) after which an unfunded request is considered expired.
-- Set to 14 days after creation by the service layer.
-- The expiry cron (api/cron/expire-funding-requests.ts) sweeps rows where
-- expires_at <= now() and status is not in terminal states.

ALTER TABLE funding_requests
  ADD COLUMN IF NOT EXISTS expires_at BIGINT NULL;

-- DB-side default: any insert path that omits expires_at gets 14 days from now.
-- App-layer writes override this (ensureFundingRequest, request-funding.ts).
-- Defense-in-depth against future insert paths that forget the field.
ALTER TABLE funding_requests
  ALTER COLUMN expires_at SET DEFAULT (EXTRACT(EPOCH FROM (NOW() + INTERVAL '14 days')) * 1000)::BIGINT;

-- Backfill: assign expires_at to all pre-existing non-terminal rows that have none.
-- Rows already past their 14-day window receive an expires_at in the past;
-- the cron and the synchronous initiate-funding guard will pick them up on next
-- access. Terminal rows (funded/cancelled/expired) are intentionally excluded.
UPDATE funding_requests
SET    expires_at = (EXTRACT(EPOCH FROM (created_at + INTERVAL '14 days')) * 1000)::BIGINT
WHERE  expires_at IS NULL
  AND  status NOT IN ('funded', 'cancelled', 'expired');

-- Partial index for efficient cron queries: only index rows that are still active.
CREATE INDEX IF NOT EXISTS idx_funding_requests_active_expires
  ON funding_requests (expires_at)
  WHERE status NOT IN ('funded', 'cancelled', 'expired');
