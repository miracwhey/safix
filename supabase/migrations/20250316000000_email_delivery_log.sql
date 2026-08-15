-- Migration: email_delivery_log
-- Stores transactional email delivery attempts for observability and debugging.
-- Written server-side using the service-role key (no client-side RLS needed).

CREATE TABLE IF NOT EXISTS email_delivery_log (
  id                  BIGSERIAL PRIMARY KEY,
  job_id              TEXT        NOT NULL,
  notification_type   TEXT        NOT NULL,
  recipient_user_id   TEXT        NOT NULL,
  recipient_role      TEXT        NOT NULL CHECK (recipient_role IN ('customer', 'craftsman')),
  recipient_email     TEXT,
  success             BOOLEAN     NOT NULL,
  error_message       TEXT,
  provider_message_id TEXT,
  sent_at             BIGINT      NOT NULL
);

-- Index for looking up delivery history for a given job
CREATE INDEX IF NOT EXISTS idx_email_delivery_log_job_id
  ON email_delivery_log (job_id);

-- Index for querying failed deliveries (monitoring / operator diagnostics)
CREATE INDEX IF NOT EXISTS idx_email_delivery_log_success
  ON email_delivery_log (success)
  WHERE success = false;

-- Table-level comment
COMMENT ON TABLE email_delivery_log IS
  'Transactional email delivery attempts. Written by the server-side /api/send-notification-email endpoint using the service-role key. Not exposed to client-side RLS.';
