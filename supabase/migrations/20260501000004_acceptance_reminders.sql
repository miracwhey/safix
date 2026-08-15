-- Block 7.2.1e — Acceptance reminder cron
--
-- Adds an idempotency-flag JSONB column on `acceptances` so the
-- `/api/cron/acceptance-reminder` endpoint can mark each per-row reminder
-- as sent without doubling up across cron ticks or pod restarts.
--
-- Forward-only and additive: no constraint changes, no policy changes, no
-- column drops. Default `'{}'::jsonb` makes the column safe for every
-- existing row without a backfill.
--
-- No new index: pre-deploy verification (2026-05-01) confirmed prod already
-- has `idx_acceptances_pending_expires ON acceptances (expires_at) WHERE
-- status='pending' AND expires_at IS NOT NULL`, which already serves the
-- cron's `status='pending' AND expires_at <= now()` predicate. Adding a
-- second `(status, expires_at)` partial index would be pure redundancy.

ALTER TABLE public.acceptances
  ADD COLUMN IF NOT EXISTS reminders_sent jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.acceptances.reminders_sent IS
  'Block 7.2.1e — idempotency flags per reminder threshold. Keys: customer_24h, customer_60h, worker_acceptance, worker_auto_release. Set to true after a successful insert into notification_signals so the next cron tick skips the row.';
