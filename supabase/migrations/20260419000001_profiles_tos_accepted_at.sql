-- Persistent ToS acceptance gate.
--
-- Records when a user explicitly accepted the Terms of Service and Privacy
-- Policy. NULL means the user has not yet accepted; the app gates all
-- authenticated routes behind this check and redirects to /tos-gate until
-- a non-null value is present.
--
-- App Store compliance: Apple and Google require a documented, user-initiated
-- acceptance step before the app collects or processes personal data.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMPTZ;
