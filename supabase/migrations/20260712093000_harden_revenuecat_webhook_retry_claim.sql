-- RevenueCat webhook retry claim hardening.
--
-- A status-bearing event is now claimed as `processing`, then finalized as
-- `processed` only after craftsman_subscriptions was updated. Failed attempts
-- and expired processing leases can be atomically reclaimed by a retry of the
-- same RevenueCat event ID. Do not apply without the normal SQL/pgTAP review.

-- The former handler wrote `processed` optimistically before the subscription
-- update. A row with no processed_at never reached a terminal success state,
-- so make it safely reclaimable under the new protocol.
UPDATE public.revenuecat_webhook_events
SET
  outcome = 'failed',
  outcome_reason = COALESCE(outcome_reason, 'legacy_unfinalized_claim'),
  processed_at = now()
WHERE outcome = 'processed'
  AND processed_at IS NULL;

ALTER TABLE public.revenuecat_webhook_events
  DROP CONSTRAINT IF EXISTS rc_webhook_events_outcome_check;

ALTER TABLE public.revenuecat_webhook_events
  ADD CONSTRAINT rc_webhook_events_outcome_check
  CHECK (outcome IN ('processing', 'processed', 'duplicate', 'failed', 'skipped'));

DROP INDEX IF EXISTS public.idx_rc_webhook_events_outcome;

CREATE INDEX idx_rc_webhook_events_outcome
  ON public.revenuecat_webhook_events (outcome)
  WHERE outcome IN ('processing', 'failed', 'skipped');
